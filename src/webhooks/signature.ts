import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures (the same scheme as the Standard Webhooks spec, used by many APIs).
 *
 * We sign `${id}.${timestamp}.${body}` with HMAC-SHA256 and the endpoint's secret. The
 * receiver recomputes it to prove that:
 *  - the request really came from us (only we and they know the secret), and
 *  - the body wasn't altered.
 * The timestamp is signed too, so a captured request can't be replayed days later: the
 * receiver rejects anything older than a few minutes.
 */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${mac}`;
}

export interface WebhookHeaders {
  'webhook-id'?: string;
  'webhook-timestamp'?: string;
  'webhook-signature'?: string;
}

/** What a seller's server should do with an incoming webhook. */
export function verifyWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: string,
  { toleranceSeconds = 300, now = Date.now() } = {},
): boolean {
  const id = headers['webhook-id'];
  const ts = Number(headers['webhook-timestamp']);
  const sig = headers['webhook-signature'];
  if (!id || !sig || !Number.isInteger(ts)) return false;
  if (Math.abs(now / 1000 - ts) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, id, ts, body));
  // A header may carry several space-separated signatures during secret rotation.
  return sig.split(' ').some((candidate) => {
    const got = Buffer.from(candidate);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
