import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DomainEvent, OrderEventData } from '../messaging/events';

/**
 * Event consumer: turns an order event into one pending delivery per subscribed seller
 * endpoint. It does no HTTP itself, so it is fast and only fails if Postgres does.
 *
 * Idempotent: the UNIQUE (endpoint_id, event_id) constraint means a redelivered message
 * (at-least-once delivery) can't create a second webhook.
 *
 * Each seller only sees their own lines of the order, never another seller's items or the
 * order total across sellers.
 */
export class WebhookFanout {
  constructor(private readonly pool: Pool) {}

  async handle(event: DomainEvent): Promise<number> {
    const data = event.data as OrderEventData;
    const sellerIds = [...new Set(data.items.map((i) => i.sellerId))];
    const { rows: endpoints } = await this.pool.query<{ id: string; seller_id: string }>(
      `SELECT id, seller_id FROM webhook_endpoints
        WHERE seller_id = ANY($1::uuid[]) AND active AND $2 = ANY(events)`,
      [sellerIds, event.type],
    );

    let created = 0;
    for (const ep of endpoints) {
      const items = data.items
        .filter((i) => i.sellerId === ep.seller_id)
        .map(({ listingId, quantity, unitPriceCents }) => ({ listingId, quantity, unitPriceCents }));
      const payload = {
        id: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        data: { orderId: data.orderId, status: data.status, currency: data.currency, items },
      };
      const { rowCount } = await this.pool.query(
        `INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_type, payload)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
        [randomUUID(), ep.id, event.id, event.type, payload],
      );
      created += rowCount ?? 0;
    }
    return created;
  }
}
