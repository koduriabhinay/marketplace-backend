import { testPool } from '../db';
import { createCustomer, createListing, createSeller, testClient } from '../helpers';

const MISSING = '00000000-0000-4000-8000-000000000000';

async function setup(stock = 10, priceCents = 2499) {
  const client = testClient();
  const seller = await createSeller(client);
  const customer = await createCustomer(client);
  const listing = await createListing(client, seller.id, { stock, priceCents });
  return { client, seller, customer, listing };
}

const stockOf = async (id: string) =>
  (await testPool().query<{ stock: number }>('SELECT stock FROM listings WHERE id = $1', [id])).rows[0]!.stock;

describe('Orders API', () => {
  it('places an order: 201, totals, line items and stock decremented', async () => {
    const { client, customer, listing } = await setup(10, 2499);

    const res = await client
      .post('/api/v1/orders')
      .send({ customerId: customer.id, items: [{ listingId: listing.id, quantity: 3 }] })
      .expect(201);

    expect(res.body.data).toMatchObject({
      customerId: customer.id,
      status: 'placed',
      totalCents: 7497,
      items: [{ listingId: listing.id, quantity: 3, unitPriceCents: 2499 }],
    });
    expect(res.headers.location).toBe(`/api/v1/orders/${res.body.data.id}`);
    expect(await stockOf(listing.id)).toBe(7);
  });

  it('orders several listings at once and totals them', async () => {
    const { client, seller, customer, listing } = await setup(5, 1000);
    const other = await createListing(client, seller.id, { stock: 5, priceCents: 250 });

    const res = await client
      .post('/api/v1/orders')
      .send({
        customerId: customer.id,
        items: [
          { listingId: listing.id, quantity: 2 },
          { listingId: other.id, quantity: 4 },
        ],
      })
      .expect(201);
    expect(res.body.data.totalCents).toBe(2 * 1000 + 4 * 250);
    expect(res.body.data.items).toHaveLength(2);
  });

  it('keeps the price paid even if the listing price changes later', async () => {
    const { client, customer, listing } = await setup(10, 2499);
    const { body } = await client
      .post('/api/v1/orders')
      .send({ customerId: customer.id, items: [{ listingId: listing.id, quantity: 1 }] })
      .expect(201);

    await client.patch(`/api/v1/listings/${listing.id}`).send({ priceCents: 9999 }).expect(200);

    const order = await client.get(`/api/v1/orders/${body.data.id}`).expect(200);
    expect(order.body.data.items[0].unitPriceCents).toBe(2499);
    expect(order.body.data.totalCents).toBe(2499);
  });

  it('returns 409 with details when stock is insufficient, and changes nothing', async () => {
    const { client, customer, listing } = await setup(2);
    const res = await client
      .post('/api/v1/orders')
      .send({ customerId: customer.id, items: [{ listingId: listing.id, quantity: 3 }] })
      .expect(409);

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
    const scarce = await createListing(client, seller.id, { stock: 1 });

    await client
      .post('/api/v1/orders')
      .send({
        customerId: customer.id,
        items: [
          { listingId: listing.id, quantity: 2 },
          { listingId: scarce.id, quantity: 2 },
        ],
      })
      .expect(409);
    expect(await stockOf(listing.id)).toBe(5);
    expect(await stockOf(scarce.id)).toBe(1);
  });

  it('returns 422 for unknown, deleted or inactive listings and unknown customers', async () => {
    const { client, seller, customer, listing } = await setup();
    const inactive = await createListing(client, seller.id, { status: 'inactive' });
    const deleted = await createListing(client, seller.id);
    await client.delete(`/api/v1/listings/${deleted.id}`).expect(204);

    for (const listingId of [MISSING, inactive.id, deleted.id]) {
      await client
        .post('/api/v1/orders')
        .send({ customerId: customer.id, items: [{ listingId, quantity: 1 }] })
        .expect(422);
    }

    const res = await client
      .post('/api/v1/orders')
      .send({ customerId: MISSING, items: [{ listingId: listing.id, quantity: 1 }] })
      .expect(422);
    expect(res.body.error.message).toMatch(/Customer/);
    expect(await stockOf(listing.id)).toBe(10);
  });

  it.each([
    ['no items', { items: [] }],
    ['zero quantity', { items: [{ listingId: MISSING, quantity: 0 }] }],
    [
      'duplicate listing ids',
      {
        items: [
          { listingId: MISSING, quantity: 1 },
          { listingId: MISSING, quantity: 1 },
        ],
      },
    ],
  ])('returns 400 for %s', async (_label, body) => {
    const { client, customer } = await setup();
    await client
      .post('/api/v1/orders')
      .send({ customerId: customer.id, ...body })
      .expect(400);
  });

  it('prevents overselling under concurrent orders (race condition)', async () => {
    const { client, customer, listing } = await setup(5);

    // 20 customers try to buy 1 unit each at the same moment; only 5 units exist.
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        client
          .post('/api/v1/orders')
          .send({ customerId: customer.id, items: [{ listingId: listing.id, quantity: 1 }] }),
      ),
    );

    const statuses = attempts.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 409)).toHaveLength(15);
    expect(await stockOf(listing.id)).toBe(0);
  });

  it('cancels an order once, returning its stock', async () => {
    const { client, customer, listing } = await setup(4);
    const { body } = await client
      .post('/api/v1/orders')
      .send({ customerId: customer.id, items: [{ listingId: listing.id, quantity: 3 }] })
      .expect(201);
    expect(await stockOf(listing.id)).toBe(1);

    const cancelled = await client.post(`/api/v1/orders/${body.data.id}/cancel`).expect(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(await stockOf(listing.id)).toBe(4);

    await client.post(`/api/v1/orders/${body.data.id}/cancel`).expect(409);
    expect(await stockOf(listing.id)).toBe(4);
    await client.post(`/api/v1/orders/${MISSING}/cancel`).expect(404);
  });

  it('cancels safely under concurrent requests (no double restock)', async () => {
    const { client, customer, listing } = await setup(4);
    const { body } = await client
      .post('/api/v1/orders')
      .send({ customerId: customer.id, items: [{ listingId: listing.id, quantity: 2 }] })
      .expect(201);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.post(`/api/v1/orders/${body.data.id}/cancel`)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await stockOf(listing.id)).toBe(4);
  });

  it('gets and lists orders with filters and pagination', async () => {
    const { client, customer, listing } = await setup(10);
    const other = await createCustomer(client);
    const place = (customerId: string) =>
      client
        .post('/api/v1/orders')
        .send({ customerId, items: [{ listingId: listing.id, quantity: 1 }] })
        .expect(201);

    const first = await place(customer.id);
    await place(customer.id);
    await place(other.id);
    await client.post(`/api/v1/orders/${first.body.data.id}/cancel`).expect(200);

    await client.get(`/api/v1/orders/${first.body.data.id}`).expect(200);
    await client.get(`/api/v1/orders/${MISSING}`).expect(404);

    const mine = await client.get(`/api/v1/orders?customerId=${customer.id}`).expect(200);
    expect(mine.body.pagination.total).toBe(2);

    const placed = await client.get(`/api/v1/orders?customerId=${customer.id}&status=placed`).expect(200);
    expect(placed.body.pagination.total).toBe(1);

    const paged = await client.get('/api/v1/orders?limit=2&offset=0').expect(200);
    expect(paged.body.data).toHaveLength(2);
    expect(paged.body.pagination.total).toBe(3);
  });
});
