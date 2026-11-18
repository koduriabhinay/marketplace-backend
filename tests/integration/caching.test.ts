import { Redis } from 'ioredis';
import { MemoryCache, RedisCache, type Cache } from '../../src/cache/cache';
import { ListingCache } from '../../src/cache/listingCache';
import { testPool } from '../db';
import { asCustomer, asSeller, createListing, testClient } from '../helpers';
import { describeWithRedis, testRedis, TEST_REDIS_URL } from '../infra';

let redis: Redis | undefined;
beforeAll(async () => {
  if (TEST_REDIS_URL) redis = await testRedis();
});
afterAll(async () => {
  await redis?.quit();
});

const backends: [string, () => Promise<Cache>][] = [['memory', async () => new MemoryCache()]];
if (TEST_REDIS_URL) {
  backends.push([
    'redis',
    async () => {
      await redis!.flushdb();
      return new RedisCache(redis!);
    },
  ]);
}

/** Changes a row behind the API's back, so only a cache hit can still return the old value. */
const sneakyUpdate = (id: string, title: string) =>
  testPool().query('UPDATE listings SET title = $2 WHERE id = $1', [id, title]);

describe.each(backends)('Listing cache (%s)', (_name, makeCache) => {
  async function setup() {
    const client = testClient({ cache: await makeCache() });
    const seller = await asSeller(client);
    const listing = await createListing(client, seller, { title: 'Original title', stock: 5 });
    return { client, seller, listing };
  }

  it('serves repeat reads from the cache (cache-aside)', async () => {
    const { client, listing } = await setup();
    await client.get(`/api/v1/listings/${listing.id}`).expect(200); // miss: loads and stores

    await sneakyUpdate(listing.id, 'Changed in the database');
    const res = await client.get(`/api/v1/listings/${listing.id}`).expect(200);
    expect(res.body.data.title).toBe('Original title'); // hit: Postgres wasn't asked
  });

  it('invalidates on update and delete through the API', async () => {
    const { client, seller, listing } = await setup();
    await client.get(`/api/v1/listings/${listing.id}`).expect(200);

    await client
      .patch(`/api/v1/listings/${listing.id}`)
      .set('Authorization', seller.auth)
      .send({ title: 'Updated title' })
      .expect(200);
    expect((await client.get(`/api/v1/listings/${listing.id}`)).body.data.title).toBe('Updated title');

    await client.delete(`/api/v1/listings/${listing.id}`).set('Authorization', seller.auth).expect(204);
    await client.get(`/api/v1/listings/${listing.id}`).expect(404);
  });

  it('invalidates when an order or a cancellation changes stock', async () => {
    const { client, listing } = await setup();
    const customer = await asCustomer(client);
    await client.get(`/api/v1/listings/${listing.id}`).expect(200);

    const order = await client
      .post('/api/v1/orders')
      .set('Authorization', customer.auth)
      .send({ items: [{ listingId: listing.id, quantity: 2 }] })
      .expect(201);
    expect((await client.get(`/api/v1/listings/${listing.id}`)).body.data.stock).toBe(3);

    await client.post(`/api/v1/orders/${order.body.data.id}/cancel`).set('Authorization', customer.auth).expect(200);
    expect((await client.get(`/api/v1/listings/${listing.id}`)).body.data.stock).toBe(5);
  });

  it('caches browse results and drops them all when any listing changes', async () => {
    const { client, seller, listing } = await setup();
    const browse = () => client.get(`/api/v1/listings?sellerId=${seller.sellerId}`).expect(200);
    expect((await browse()).body.pagination.total).toBe(1);

    await sneakyUpdate(listing.id, 'Sneaky');
    expect((await browse()).body.data[0].title).toBe('Original title'); // cached

    await createListing(client, seller); // bumps the list generation
    const fresh = await browse();
    expect(fresh.body.pagination.total).toBe(2);
    expect(fresh.body.data.map((l: { title: string }) => l.title)).toContain('Sneaky');
  });

  it('never caches "not found", so a listing can appear right after a miss', async () => {
    const { client, seller } = await setup();
    const id = '11111111-1111-4111-8111-111111111111';
    await client.get(`/api/v1/listings/${id}`).expect(404);
    await testPool().query(
      `INSERT INTO listings (id, seller_id, title, price_cents, stock) VALUES ($1, $2, 'Late arrival', 100, 1)`,
      [id, seller.sellerId],
    );
    await client.get(`/api/v1/listings/${id}`).expect(200);
  });

  it('ownership checks read the database, never the cache', async () => {
    const { client, seller, listing } = await setup();
    const other = await asSeller(client);
    await client.get(`/api/v1/listings/${listing.id}`).expect(200); // cached with the old owner
    await testPool().query('UPDATE listings SET seller_id = $2 WHERE id = $1', [listing.id, other.sellerId]);

    await client.patch(`/api/v1/listings/${listing.id}`).set('Authorization', seller.auth).send({ stock: 1 }).expect(403);
  });
});

describe('ListingCache', () => {
  it('collapses concurrent misses into one database load (stampede protection)', async () => {
    const cache = new ListingCache(new MemoryCache(), 60);
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 20));
      return { id: 'x' } as never;
    };
    await Promise.all(Array.from({ length: 10 }, () => cache.getListing('x', load)));
    expect(loads).toBe(1);
  });

  it('falls back to the database when the cache is down', async () => {
    const broken: Cache = {
      get: () => Promise.reject(new Error('ECONNREFUSED')),
      set: () => Promise.reject(new Error('ECONNREFUSED')),
      del: () => Promise.reject(new Error('ECONNREFUSED')),
      incr: () => Promise.reject(new Error('ECONNREFUSED')),
      ping: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const client = testClient({ cache: broken });
    const seller = await asSeller(client);
    const listing = await createListing(client, seller);
    await client.get(`/api/v1/listings/${listing.id}`).expect(200);
    await client.get('/api/v1/listings').expect(200);
    await client.patch(`/api/v1/listings/${listing.id}`).set('Authorization', seller.auth).send({ stock: 2 }).expect(200);
  });
});

describe('Redis outage', () => {
  it('keeps the API up when Redis is unreachable (fails fast, degrades to Postgres)', async () => {
    // Nothing listens on port 1: every command fails immediately (no offline queue).
    // Same fail-fast settings as createRedis, but no reconnect loop to clean up after.
    const dead = new Redis('redis://127.0.0.1:1', {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 200,
      retryStrategy: () => null,
      disconnectTimeout: 10,
    });
    dead.on('error', () => {});
    // express-rate-limit logs each store error to the console as it fails open; expected here.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const client = testClient({ redis: dead });
      const seller = await asSeller(client);
      const listing = await createListing(client, seller);
      const started = Date.now();
      await client.get(`/api/v1/listings/${listing.id}`).expect(200);
      expect(Date.now() - started).toBeLessThan(1_000);

      const ready = await client.get('/ready').expect(200); // Redis is optional for readiness
      expect(ready.body.checks).toContainEqual({ name: 'redis', ok: false, required: false });
      expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/allowing request without rate-limiting/), expect.anything());
    } finally {
      consoleError.mockRestore();
      dead.disconnect();
    }
  });
});

describeWithRedis('Rate limits shared through Redis', () => {
  it('counts requests across every API instance', async () => {
    await redis!.flushdb();
    const limits = { max: 3, windowMs: 60_000 };
    // Two separate app instances, as if behind a load balancer.
    const a = testClient({ redis, rateLimits: limits });
    const b = testClient({ redis, rateLimits: limits });

    await a.get('/api/v1/listings').expect(200);
    await b.get('/api/v1/listings').expect(200);
    await a.get('/api/v1/listings').expect(200);
    const blocked = await b.get('/api/v1/listings').expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('reports Redis as healthy in readiness', async () => {
    const res = await testClient({ redis }).get('/ready').expect(200);
    expect(res.body.checks).toContainEqual({ name: 'redis', ok: true, required: false });
  });
});
