import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { encrypt } from '../auth/encryption';
import { assertCanManageSeller } from '../auth/policies';
import type { AuthUser } from '../auth/types';
import { PG, pgCode } from '../db/pool';
import { ConflictError, NotFoundError, UnprocessableError } from '../lib/errors';
import { iso, page } from '../repositories/postgres/sql';
import type { Pagination } from '../schemas/common';
import type { CreateWebhookInput, WebhookDelivery, WebhookEndpoint } from '../schemas/webhook';
import { assertWebhookUrlShape, UnsafeUrlError } from './urlSafety';

export const MAX_ENDPOINTS_PER_SELLER = 5;

interface EndpointRow {
  id: string;
  seller_id: string;
  url: string;
  events: string[];
  active: boolean;
  created_at: Date;
}

const toEndpoint = (r: EndpointRow): WebhookEndpoint => ({
  id: r.id,
  sellerId: r.seller_id,
  url: r.url,
  events: r.events,
  active: r.active,
  createdAt: iso(r.created_at)!,
});

/** Sellers manage their own webhook endpoints (the API side; delivery happens in the worker). */
export class WebhookService {
  constructor(
    private readonly pool: Pool,
    private readonly allowInsecureUrls: boolean,
  ) {}

  /** The signing secret is returned once, here, and never again. */
  async register(user: AuthUser, sellerId: string, input: CreateWebhookInput) {
    assertCanManageSeller(user, sellerId);
    try {
      assertWebhookUrlShape(input.url, this.allowInsecureUrls);
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw new UnprocessableError(err.message);
      throw err;
    }
    const { rows: count } = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM webhook_endpoints WHERE seller_id = $1',
      [sellerId],
    );
    if (count[0]!.n >= MAX_ENDPOINTS_PER_SELLER) {
      throw new ConflictError(`A seller can have at most ${MAX_ENDPOINTS_PER_SELLER} webhook endpoints`);
    }

    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    try {
      const { rows } = await this.pool.query<EndpointRow>(
        `INSERT INTO webhook_endpoints (id, seller_id, url, secret_enc, events)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, seller_id, url, events, active, created_at`,
        [randomUUID(), sellerId, input.url, encrypt(secret), input.events],
      );
      return { ...toEndpoint(rows[0]!), secret };
    } catch (err) {
      if (pgCode(err) === PG.FOREIGN_KEY_VIOLATION) throw new UnprocessableError(`Seller ${sellerId} does not exist`);
      throw err;
    }
  }

  async list(user: AuthUser, sellerId: string) {
    assertCanManageSeller(user, sellerId);
    const { rows } = await this.pool.query<EndpointRow>(
      `SELECT id, seller_id, url, events, active, created_at FROM webhook_endpoints
        WHERE seller_id = $1 ORDER BY created_at`,
      [sellerId],
    );
    return rows.map(toEndpoint);
  }

  async remove(user: AuthUser, sellerId: string, id: string) {
    assertCanManageSeller(user, sellerId);
    const { rowCount } = await this.pool.query('DELETE FROM webhook_endpoints WHERE id = $1 AND seller_id = $2', [
      id,
      sellerId,
    ]);
    if (!rowCount) throw new NotFoundError('Webhook endpoint', id);
  }

  /** Delivery log, newest first: what sellers look at when "my webhook didn't arrive". */
  async deliveries(user: AuthUser, sellerId: string, id: string, p: Pagination) {
    assertCanManageSeller(user, sellerId);
    const { rows: owner } = await this.pool.query('SELECT 1 FROM webhook_endpoints WHERE id = $1 AND seller_id = $2', [
      id,
      sellerId,
    ]);
    if (!owner.length) throw new NotFoundError('Webhook endpoint', id);

    const [data, count] = await Promise.all([
      this.pool.query<{
        id: string;
        event_id: string;
        event_type: string;
        status: WebhookDelivery['status'];
        attempts: number;
        next_attempt_at: Date;
        last_status_code: number | null;
        last_error: string | null;
        created_at: Date;
        delivered_at: Date | null;
      }>(
        `SELECT id, event_id, event_type, status, attempts, next_attempt_at, last_status_code, last_error,
                created_at, delivered_at
           FROM webhook_deliveries WHERE endpoint_id = $1
          ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
        [id, p.limit, p.offset],
      ),
      this.pool.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM webhook_deliveries WHERE endpoint_id = $1',
        [id],
      ),
    ]);
    const deliveries: WebhookDelivery[] = data.rows.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      eventType: r.event_type,
      status: r.status,
      attempts: r.attempts,
      nextAttemptAt: r.status === 'pending' ? iso(r.next_attempt_at) : null,
      lastStatusCode: r.last_status_code,
      lastError: r.last_error,
      createdAt: iso(r.created_at)!,
      deliveredAt: iso(r.delivered_at),
    }));
    return page(deliveries, count.rows[0]!.total, p);
  }
}
