import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool';
import { recordOrderEvent } from '../../messaging/events';
import { ConflictError, InsufficientStockError, NotFoundError, UnprocessableError } from '../../lib/errors';
import type { CreateOrderInput, ListOrdersQuery, Order } from '../../schemas/order';
import type { OrderRepository } from '../types';
import { buildWhere, iso, page } from './sql';

interface OrderRow {
  id: string;
  customer_id: string;
  status: Order['status'];
  total_cents: number;
  currency: 'USD';
  created_at: Date;
  updated_at: Date;
  items: { listingId: string; quantity: number; unitPriceCents: number }[];
}

// Items are aggregated into a JSON array in the same query: one round trip per order
// read instead of one query per order (avoids the N+1 query problem).
const SELECT_ORDERS = `
  SELECT o.id, o.customer_id, o.status, o.total_cents, o.currency, o.created_at, o.updated_at,
         COALESCE(
           json_agg(json_build_object(
             'listingId', i.listing_id, 'quantity', i.quantity, 'unitPriceCents', i.unit_price_cents
           ) ORDER BY i.listing_id) FILTER (WHERE i.listing_id IS NOT NULL),
           '[]'
         ) AS items
  FROM orders o
  LEFT JOIN order_items i ON i.order_id = o.id`;

const toOrder = (r: OrderRow): Order => ({
  id: r.id,
  customerId: r.customer_id,
  status: r.status,
  totalCents: r.total_cents,
  currency: r.currency,
  items: r.items,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

interface LockedListing {
  id: string;
  price_cents: number;
  stock: number;
  status: string;
  deleted_at: Date | null;
}

export class PgOrderRepository implements OrderRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Placing an order is a classic race condition: two buyers read "stock = 1" at the same
   * moment and both buy it. We prevent that with a transaction and row locks:
   *
   *  1. SELECT ... FOR UPDATE locks every listing in the order. A concurrent order for the
   *     same listing waits here until we COMMIT or ROLLBACK, then sees the new stock.
   *  2. Locks are taken in a fixed order (ORDER BY id) so two orders touching the same
   *     listings can never deadlock by locking them in opposite orders.
   *  3. Stock is checked and decremented inside the same transaction, and the CHECK
   *     (stock >= 0) constraint is a final safety net if the code is ever wrong.
   *  4. The price is read under the lock and copied onto the order line.
   */
  async place(id: string, input: CreateOrderInput): Promise<Order> {
    return withTransaction(this.pool, async (client) => {
      const ids = input.items.map((i) => i.listingId);
      const { rows: locked } = await client.query<LockedListing>(
        `SELECT id, price_cents, stock, status, deleted_at
           FROM listings WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [ids],
      );
      const byId = new Map(locked.map((l) => [l.id, l]));

      const unavailable = ids.filter((lid) => {
        const l = byId.get(lid);
        return !l || l.deleted_at !== null || l.status !== 'active';
      });
      if (unavailable.length) {
        throw new UnprocessableError(`Listings not available for purchase: ${unavailable.join(', ')}`);
      }

      const short = input.items
        .map((i) => ({ listingId: i.listingId, requested: i.quantity, available: byId.get(i.listingId)!.stock }))
        .filter((s) => s.requested > s.available);
      if (short.length) throw new InsufficientStockError(short);

      const qtys = input.items.map((i) => i.quantity);
      const prices = input.items.map((i) => byId.get(i.listingId)!.price_cents);
      const total = input.items.reduce((sum, i, idx) => sum + i.quantity * prices[idx]!, 0);

      await client.query(
        `UPDATE listings l SET stock = l.stock - v.qty, updated_at = now()
           FROM unnest($1::uuid[], $2::int[]) AS v(id, qty)
          WHERE l.id = v.id`,
        [ids, qtys],
      );
      await client.query(
        'INSERT INTO orders (id, customer_id, total_cents, currency) VALUES ($1, $2, $3, $4)',
        [id, input.customerId, total, 'USD'],
      );
      await client.query(
        `INSERT INTO order_items (order_id, listing_id, quantity, unit_price_cents)
         SELECT $1, * FROM unnest($2::uuid[], $3::int[], $4::int[])`,
        [id, ids, qtys, prices],
      );
      const order = (await this.findWith(client, id))!;
      await recordOrderEvent(client, 'order.placed', order);
      return order;
    });
  }

  async findById(id: string) {
    return this.findWith(this.pool, id);
  }

  async list(q: ListOrdersQuery) {
    const { clause, values } = buildWhere(
      [],
      [
        ['o.customer_id', q.customerId],
        ['o.status', q.status],
      ],
    );
    const limitParam = `$${values.length + 1}`;
    const offsetParam = `$${values.length + 2}`;
    const [data, count] = await Promise.all([
      this.pool.query<OrderRow>(
        `${SELECT_ORDERS} ${clause} GROUP BY o.id
         ORDER BY o.created_at DESC, o.id LIMIT ${limitParam} OFFSET ${offsetParam}`,
        [...values, q.limit, q.offset],
      ),
      this.pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM orders o ${clause}`, values),
    ]);
    return page(data.rows.map(toOrder), count.rows[0]!.total, q);
  }

  /** Cancelling returns stock. The order row is locked so a double-cancel can't restock twice. */
  async cancel(id: string): Promise<Order> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM orders WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!rows[0]) throw new NotFoundError('Order', id);
      if (rows[0].status !== 'placed') throw new ConflictError(`Order is already ${rows[0].status}`);

      await client.query(
        `UPDATE listings l SET stock = l.stock + i.quantity, updated_at = now()
           FROM order_items i WHERE i.order_id = $1 AND l.id = i.listing_id`,
        [id],
      );
      await client.query("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1", [id]);
      const order = (await this.findWith(client, id))!;
      await recordOrderEvent(client, 'order.cancelled', order);
      return order;
    });
  }

  private async findWith(db: Pool | PoolClient, id: string): Promise<Order | null> {
    const { rows } = await db.query<OrderRow>(`${SELECT_ORDERS} WHERE o.id = $1 GROUP BY o.id`, [id]);
    return rows[0] ? toOrder(rows[0]) : null;
  }
}
