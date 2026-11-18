import type { Pool } from 'pg';
import { decrypt } from '../auth/encryption';
import { CircuitBreakerRegistry } from '../lib/circuitBreaker';
import { logger } from '../lib/logger';
import { scheduledBackoffDelay, type BackoffOptions } from '../lib/retry';
import { signWebhook } from './signature';
import { assertDeliverableUrl } from './urlSafety';

export interface DispatcherOptions {
  timeoutMs: number;
  maxAttempts: number;
  allowInsecureUrls: boolean;
  backoff?: BackoffOptions;
  breaker?: { failureThreshold: number; cooldownMs: number };
  /** How long a claimed delivery is hidden from other workers while we send it. */
  leaseMs?: number;
  fetch?: typeof fetch;
}

interface ClaimedDelivery {
  id: string;
  endpoint_id: string;
  event_id: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret_enc: string;
  active: boolean;
}

export interface DispatchResult {
  succeeded: number;
  failed: number;
  dead: number;
  /** Not attempted because the endpoint's circuit breaker is open. */
  deferred: number;
}

/**
 * Sends due webhook deliveries (runs in the worker).
 *
 * Reliability features, all in one place:
 *  - Timeout: every request is aborted after timeoutMs, so a slow endpoint can't hold a
 *    worker forever.
 *  - Retries with exponential backoff + jitter: 30 s, 1 min, 2 min, 4 min ... capped at 6 h.
 *    After maxAttempts the delivery is marked dead (and visible in the delivery log).
 *  - Circuit breaker per endpoint: after repeated failures we stop calling that endpoint
 *    for a while instead of burning attempts and worker time on it.
 *  - Leases: claiming a batch pushes next_attempt_at forward atomically, so two workers
 *    never send the same delivery at the same time (SKIP LOCKED skips rows another worker
 *    is claiming right now).
 *  - SSRF checks and no redirects (see urlSafety.ts).
 */
export class WebhookDispatcher {
  private readonly breakers: CircuitBreakerRegistry;
  private readonly backoff: BackoffOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly pool: Pool,
    private readonly opts: DispatcherOptions,
  ) {
    this.breakers = new CircuitBreakerRegistry(opts.breaker ?? { failureThreshold: 5, cooldownMs: 60_000 });
    this.backoff = opts.backoff ?? { baseMs: 30_000, maxMs: 6 * 60 * 60_000 };
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async dispatchDue(limit = 20): Promise<DispatchResult> {
    const leaseSeconds = (this.opts.leaseMs ?? this.opts.timeoutMs * 2) / 1000;
    const { rows } = await this.pool.query<ClaimedDelivery>(
      `WITH due AS (
         SELECT id FROM webhook_deliveries
          WHERE status = 'pending' AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE webhook_deliveries d
          SET next_attempt_at = now() + make_interval(secs => $2), updated_at = now()
         FROM due, webhook_endpoints e
        WHERE d.id = due.id AND e.id = d.endpoint_id
       RETURNING d.id, d.endpoint_id, d.event_id, d.payload, d.attempts, e.url, e.secret_enc, e.active`,
      [limit, leaseSeconds],
    );

    const result: DispatchResult = { succeeded: 0, failed: 0, dead: 0, deferred: 0 };
    await Promise.all(rows.map(async (d) => void (result[await this.deliver(d)] += 1)));
    return result;
  }

  private async deliver(d: ClaimedDelivery): Promise<keyof DispatchResult> {
    if (!d.active) return this.markDead(d, null, 'Endpoint disabled');

    const breaker = this.breakers.get(d.endpoint_id);
    if (!breaker.tryAcquire()) {
      await this.pool.query(
        `UPDATE webhook_deliveries SET next_attempt_at = to_timestamp($2 / 1000.0), updated_at = now() WHERE id = $1`,
        [d.id, breaker.retryAt],
      );
      return 'deferred';
    }

    let statusCode: number | null = null;
    let error: string;
    try {
      const url = await assertDeliverableUrl(d.url, this.opts.allowInsecureUrls);
      const body = JSON.stringify(d.payload);
      const timestamp = Math.floor(Date.now() / 1000);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'marketplace-webhooks/1.0',
          'webhook-id': d.event_id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signWebhook(decrypt(d.secret_enc), d.event_id, timestamp, body),
        },
      });
      statusCode = res.status;
      await res.body?.cancel(); // we don't need the response body; free the socket
      if (res.status >= 200 && res.status < 300) {
        breaker.onSuccess();
        await this.pool.query(
          `UPDATE webhook_deliveries
              SET status = 'succeeded', attempts = attempts + 1, last_status_code = $2, last_error = NULL,
                  delivered_at = now(), updated_at = now()
            WHERE id = $1`,
          [d.id, res.status],
        );
        return 'succeeded';
      }
      error = `HTTP ${res.status}`;
    } catch (err) {
      // AbortSignal.timeout() rejects with a DOMException named TimeoutError.
      const e = err as { name?: string; message?: string };
      error = e?.name === 'TimeoutError' ? `Timed out after ${this.opts.timeoutMs} ms` : String(e?.message ?? err);
    }

    breaker.onFailure();
    const attempts = d.attempts + 1;
    if (attempts >= this.opts.maxAttempts) return this.markDead(d, statusCode, error);

    const delayMs = scheduledBackoffDelay(attempts - 1, this.backoff);
    await this.pool.query(
      `UPDATE webhook_deliveries
          SET attempts = $2, last_status_code = $3, last_error = $4,
              next_attempt_at = now() + make_interval(secs => $5), updated_at = now()
        WHERE id = $1`,
      [d.id, attempts, statusCode, error.slice(0, 500), delayMs / 1000],
    );
    logger.warn({ deliveryId: d.id, attempts, error, retryInMs: delayMs }, 'Webhook delivery failed');
    return 'failed';
  }

  private async markDead(d: ClaimedDelivery, statusCode: number | null, error: string): Promise<'dead'> {
    await this.pool.query(
      `UPDATE webhook_deliveries
          SET status = 'dead', attempts = attempts + 1, last_status_code = $2, last_error = $3, updated_at = now()
        WHERE id = $1`,
      [d.id, statusCode, error.slice(0, 500)],
    );
    logger.error({ deliveryId: d.id, error }, 'Webhook delivery gave up');
    return 'dead';
  }
}
