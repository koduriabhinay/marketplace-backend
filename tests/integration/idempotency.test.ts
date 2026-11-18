import { testPool } from '../db';
import { asCustomer, asSeller, createListing, testClient, type Actor, type Client } from '../helpers';

async function setup(stock = 10) {
  const client = testClient();
  const seller = await asSeller(client);
  const customer = await asCustomer(client);
  const listing = await createListing(client, seller, { stock });
  return { client, customer, listing };
}

const placeOrder = (client: Client, who: Actor, body: object, key?: string) => {
  const req = client.post('/api/v1/orders').set('Authorization', who.auth);
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};

const orderCount = async () => (await testPool().query('SELECT count(*)::int AS n FROM orders')).rows[0].n;

describe('Idempotency keys on POST /orders', () => {
  it('a retried request with the same key returns the original response and creates one order', async () => {
    const { client, customer, listing } = await setup();
    const body = { items: [{ listingId: listing.id, quantity: 1 }] };

    const first = await placeOrder(client, customer, body, 'checkout-0001').expect(201);
    const retry = await placeOrder(client, customer, body, 'checkout-0001').expect(201);

    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(retry.headers.location).toBe(first.headers.location);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(await orderCount()).toBe(1);
  });

  it('without a key, every request is a new order (the key is opt-in)', async () => {
    const { client, customer, listing } = await setup();
    const body = { items: [{ listingId: listing.id, quantity: 1 }] };
    await placeOrder(client, customer, body).expect(201);
    await placeOrder(client, customer, body).expect(201);
    expect(await orderCount()).toBe(2);
  });

  it('rejects reusing a key for a different request with 422', async () => {
    const { client, customer, listing } = await setup();
    await placeOrder(client, customer, { items: [{ listingId: listing.id, quantity: 1 }] }, 'checkout-0002').expect(201);
    const res = await placeOrder(
      client,
      customer,
      { items: [{ listingId: listing.id, quantity: 2 }] },
      'checkout-0002',
    ).expect(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('runs concurrent duplicates once: one order, the rest replay or are told to retry', async () => {
    const { client, customer, listing } = await setup();
    const body = { items: [{ listingId: listing.id, quantity: 1 }] };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => placeOrder(client, customer, body, 'checkout-0003')),
    );

    expect(await orderCount()).toBe(1);
    for (const r of results) {
      expect([201, 409]).toContain(r.status);
      if (r.status === 409) {
        expect(r.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
        expect(r.headers['retry-after']).toBe('1');
      }
    }
    // Once the first finishes, a retry gets the stored result.
    await placeOrder(client, customer, body, 'checkout-0003').expect(201);
  });

  it('keys belong to one user: the same key from another user is a separate request', async () => {
    const { client, customer, listing } = await setup();
    const other = await asCustomer(client);
    const body = { items: [{ listingId: listing.id, quantity: 1 }] };
    await placeOrder(client, customer, body, 'shared-key-123').expect(201);
    const res = await placeOrder(client, other, body, 'shared-key-123').expect(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(await orderCount()).toBe(2);
  });

  it('replays business errors (409 out of stock) but lets you retry after a 400', async () => {
    const { client, customer, listing } = await setup(1);
    const tooMany = { items: [{ listingId: listing.id, quantity: 5 }] };
    await placeOrder(client, customer, tooMany, 'checkout-0004').expect(409);
    const replay = await placeOrder(client, customer, tooMany, 'checkout-0004').expect(409);
    expect(replay.headers['idempotent-replayed']).toBe('true');

    // Invalid input means nothing happened, so the key isn't burned.
    await placeOrder(client, customer, { items: [] }, 'checkout-0005').expect(400);
    await placeOrder(client, customer, { items: [{ listingId: listing.id, quantity: 1 }] }, 'checkout-0005').expect(201);
  });

  it('validates the key format', async () => {
    const { client, customer, listing } = await setup();
    const body = { items: [{ listingId: listing.id, quantity: 1 }] };
    await placeOrder(client, customer, body, 'short').expect(400);
    await placeOrder(client, customer, body, 'has spaces in it').expect(400);
  });

  it('a key stuck in progress (process died mid-request) answers 409 until it is cleaned up', async () => {
    const { client, customer, listing } = await setup();
    const body = { items: [{ listingId: listing.id, quantity: 1 }] };
    await placeOrder(client, customer, body, 'checkout-0006').expect(201);
    await testPool().query(
      "UPDATE idempotency_keys SET status = 'in_progress', response_status = NULL WHERE key = 'checkout-0006'",
    );
    await placeOrder(client, customer, body, 'checkout-0006').expect(409);
  });
});
