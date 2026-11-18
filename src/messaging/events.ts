import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Order } from '../schemas/order';

/**
 * The envelope every domain event travels in, on the broker and in webhook bodies.
 * `id` is unique per event, so every consumer can de-duplicate: delivery is
 * at-least-once, so the same event can arrive more than once.
 */
export interface DomainEvent<T = unknown> {
  id: string;
  type: EventType;
  occurredAt: string;
  data: T;
}

export const EVENT_TYPES = ['order.placed', 'order.cancelled'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface OrderEventData {
  orderId: string;
  customerId: string;
  status: Order['status'];
  totalCents: number;
  currency: 'USD';
  items: { listingId: string; sellerId: string; quantity: number; unitPriceCents: number }[];
}

/**
 * Writes an event to the outbox using the caller's transaction client, so the event is
 * committed or rolled back together with the change it describes.
 */
export async function recordOrderEvent(client: PoolClient, type: EventType, order: Order) {
  const { rows } = await client.query<{ id: string; seller_id: string }>(
    'SELECT id, seller_id FROM listings WHERE id = ANY($1::uuid[])',
    [order.items.map((i) => i.listingId)],
  );
  const sellerOf = new Map(rows.map((r) => [r.id, r.seller_id]));
  const data: OrderEventData = {
    orderId: order.id,
    customerId: order.customerId,
    status: order.status,
    totalCents: order.totalCents,
    currency: order.currency,
    items: order.items.map((i) => ({ ...i, sellerId: sellerOf.get(i.listingId)! })),
  };
  await client.query(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'order', $2, $3, $4)`,
    [randomUUID(), order.id, type, data],
  );
}
