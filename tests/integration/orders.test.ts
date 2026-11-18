import { testPool } from '../db';
import { MISSING, asAdmin, asCustomer, asSeller, createListing, testClient, type Actor, type Client } from '../helpers';

async function setup(stock = 10, priceCents = 2499) {
  const client = testClient();
  const seller = await asSeller(client);
  const customer = await asCustomer(client);
  const listing = await createListing(client, seller, { stock, priceCents });
  return { client, seller, customer, listing };
}

type Item = { listingId: string; quantity: number };
const order = (client: Client, who: Actor, items: Item[], extra: Record<string, unknown> = {}) =>
  client.post('/api/v1/orders').set('Authorization', who.auth).send({ items, ...extra });

const stockOf = async (id: string) =>
  (await testPool().query<{ stock: number }>('SELECT stock FROM listings WHERE id = $1', [id])).rows[0]!.stock;

describe('Orders API', () => {
  it('a customer places an order: 201, totals, line items and stock decremented', async () => {
    const { client, customer, listing } = await setup(10, 2499);

    const res = await order(client, customer, [{ listingId: listing.id, quantity: 3 }]).expect(201);

    expect(res.body.data).toMatchObject({
      customerId: customer.customerId,
      status: 'placed',
      totalCents: 7497,
      items: [{ listingId: listing.id, quantity: 3, unitPriceCents: 2499 }],
    });
    expect(res.headers.location).toBe(`/api/v1/orders/${res.body.data.id}`);
    expect(await stockOf(listing.id)).toBe(7);
  });

  it('requires login, and only customers (or admins) can order', async () => {
    const { client, seller, listing } = await setup();
    const items = [{ listingId: listing.id, quantity: 1 }];
    await client.post('/api/v1/orders').send({ items }).expect(401);
    await order(client, seller, items).expect(403);
  });

  it('a customer cannot order on behalf of someone else; an admin can', async () => {
    const { client, customer, listing } = await setup();
    const other = await asCustomer(client);
    const admin = await asAdmin(client);
    const items = [{ listingId: listing.id, quantity: 1 }];

    await order(client, customer, items, { customerId: other.customerId }).expect(403);
    await order(client, admin, items).expect(422); // admin must say who for
    const res = await order(client, admin, items, { customerId: other.customerId }).expect(201);
    expect(res.body.data.customerId).toBe(other.customerId);
    await order(client, admin, items, { customerId: MISSING }).expect(422);
  });

  it('orders several listings at once and totals them', async () => {
    const { client, seller, customer, listing } = await setup(5, 1000);
    const other = await createListing(client, seller, { stock: 5, priceCents: 250 });

    const res = await order(client, customer, [
      { listingId: listing.id, quantity: 2 },
      { listingId: other.id, quantity: 4 },
    ]).expect(201);
    expect(res.body.data.totalCents).toBe(2 * 1000 + 4 * 250);
    expect(res.body.data.items).toHaveLength(2);
  });

  it('keeps the price paid even if the listing price changes later', async () => {
    const { client, seller, customer, listing } = await setup(10, 2499);
    const { body } = await order(client, customer, [{ listingId: listing.id, quantity: 1 }]).expect(201);

    await client
      .patch(`/api/v1/listings/${listing.id}`)
      .set('Authorization', seller.auth)
      .send({ priceCents: 9999 })
      .expect(200);

    const res = await client.get(`/api/v1/orders/${body.data.id}`).set('Authorization', customer.auth).expect(200);
    expect(res.body.data.items[0].unitPriceCents).toBe(2499);
    expect(res.body.data.totalCents).toBe(2499);
  });

  it('returns 409 with details when stock is insufficient, and changes nothing', async () => {
    const { client, customer, listing } = await setup(2);
    const res = await order(client, customer, [{ listingId: listing.id, quantity: 3 }]).expect(409);

    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: [{ listingId: listing.id, requested: 3, available: 2 }],
    });
    expect(await stockOf(listing.id)).toBe(2);
    const { rows } = await testPool().query('SELECT count(*)::int AS n FROM orders');
    expect(rows[0].n).toBe(0);
  });

  it('rolls back the whole order if any one item is short', async () => {
    const { client, seller, customer, listing } = await setup(5);
    const scarce = await createListing(client, seller, { stock: 1 });

    await order(client, customer, [
      { listingId: listing.id, quantity: 2 },
      { listingId: scarce.id, quantity: 2 },
    ]).expect(409);
    expect(await stockOf(listing.id)).toBe(5);
    expect(await stockOf(scarce.id)).toBe(1);
  });

  it('returns 422 for unknown, deleted or inactive listings', async () => {
    const { client, seller, customer, listing } = await setup();
    const inactive = await createListing(client, seller, { status: 'inactive' });
    const deleted = await createListing(client, seller);
    await client.delete(`/api/v1/listings/${deleted.id}`).set('Authorization', seller.auth).expect(204);

    for (const listingId of [MISSING, inactive.id, deleted.id]) {
      await order(client, customer, [{ listingId, quantity: 1 }]).expect(422);
    }
    expect(await stockOf(listing.id)).toBe(10);
  });

  it.each([
    ['no items', []],
    ['zero quantity', [{ listingId: MISSING, quantity: 0 }]],
    [
      'duplicate listing ids',
      [
        { listingId: MISSING, quantity: 1 },
        { listingId: MISSING, quantity: 1 },
      ],
    ],
  ])('returns 400 for %s', async (_label, items) => {
    const { client, customer } = await setup();
    await order(client, customer, items as Item[]).expect(400);
  });

  it('prevents overselling under concurrent orders (race condition)', async () => {
    const { client, customer, listing } = await setup(5);

    // 20 checkout requests hit the same listing at the same moment; only 5 units exist.
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => order(client, customer, [{ listingId: listing.id, quantity: 1 }])),
    );

    const statuses = attempts.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 409)).toHaveLength(15);
    expect(await stockOf(listing.id)).toBe(0);
  });

  it('cancels an order once, returning its stock', async () => {
    const { client, customer, listing } = await setup(4);
    const { body } = await order(client, customer, [{ listingId: listing.id, quantity: 3 }]).expect(201);
    expect(await stockOf(listing.id)).toBe(1);

    const cancel = () => client.post(`/api/v1/orders/${body.data.id}/cancel`).set('Authorization', customer.auth);
    const cancelled = await cancel().expect(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(await stockOf(listing.id)).toBe(4);

    await cancel().expect(409);
    expect(await stockOf(listing.id)).toBe(4);
    await client.post(`/api/v1/orders/${MISSING}/cancel`).set('Authorization', customer.auth).expect(404);
  });

  it('cancels safely under concurrent requests (no double restock)', async () => {
    const { client, customer, listing } = await setup(4);
    const { body } = await order(client, customer, [{ listingId: listing.id, quantity: 2 }]).expect(201);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        client.post(`/api/v1/orders/${body.data.id}/cancel`).set('Authorization', customer.auth),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await stockOf(listing.id)).toBe(4);
  });

  it('customers only see and cancel their own orders (IDOR protection)', async () => {
    const { client, customer, listing } = await setup(10);
    const intruder = await asCustomer(client);
    const { body } = await order(client, customer, [{ listingId: listing.id, quantity: 1 }]).expect(201);

    // Guessing another customer's order id reveals nothing: 404, same as a missing order.
    await client.get(`/api/v1/orders/${body.data.id}`).set('Authorization', intruder.auth).expect(404);
    await client.post(`/api/v1/orders/${body.data.id}/cancel`).set('Authorization', intruder.auth).expect(404);

    // Asking to filter by someone else's id is silently scoped back to your own orders.
    const list = await client
      .get(`/api/v1/orders?customerId=${customer.customerId}`)
      .set('Authorization', intruder.auth)
      .expect(200);
    expect(list.body.pagination.total).toBe(0);
  });

  it('lists orders with filters and pagination; sellers cannot list orders', async () => {
    const { client, seller, customer, listing } = await setup(10);
    const other = await asCustomer(client);
    const admin = await asAdmin(client);
    const items = [{ listingId: listing.id, quantity: 1 }];

    const first = await order(client, customer, items).expect(201);
    await order(client, customer, items).expect(201);
    await order(client, other, items).expect(201);
    await client.post(`/api/v1/orders/${first.body.data.id}/cancel`).set('Authorization', customer.auth).expect(200);

    const mine = await client.get('/api/v1/orders').set('Authorization', customer.auth).expect(200);
    expect(mine.body.pagination.total).toBe(2);
    const placed = await client.get('/api/v1/orders?status=placed').set('Authorization', customer.auth).expect(200);
    expect(placed.body.pagination.total).toBe(1);

    const all = await client.get('/api/v1/orders?limit=2').set('Authorization', admin.auth).expect(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.pagination.total).toBe(3);
    await client.get(`/api/v1/orders/${first.body.data.id}`).set('Authorization', admin.auth).expect(200);

    await client.get('/api/v1/orders').set('Authorization', seller.auth).expect(403);
  });
});
