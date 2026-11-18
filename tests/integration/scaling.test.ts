import { Pool } from 'pg';
import { createPool } from '../../src/db/pool';
import { replicaUrl } from '../globalSetup';
import { testPool } from '../db';
import { asSeller, createListing, testClient } from '../helpers';

/**
 * The "replica" here is a separate database that receives NO replication, which lets us
 * see exactly which reads go where, and simulates the worst case of replication lag.
 */
let replica: Pool;
beforeAll(() => {
  replica = createPool({ connectionString: replicaUrl(), max: 5, statementTimeoutMs: 10_000 });
});
beforeEach(() =>
  replica.query('TRUNCATE listing_images, refresh_tokens, users, order_items, orders, listings, customers, sellers CASCADE'),
);
afterAll(() => replica.end());

/** Copies a row to the replica, as replication eventually would. */
async function replicate(listingId: string) {
  const { rows } = await testPool().query('SELECT * FROM listings WHERE id = $1', [listingId]);
  const seller = await testPool().query('SELECT * FROM sellers WHERE id = $1', [rows[0].seller_id]);
  const s = seller.rows[0];
  await replica.query('INSERT INTO sellers (id, name, email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [s.id, s.name, s.email]);
  const l = rows[0];
  await replica.query(
    `INSERT INTO listings (id, seller_id, title, description, price_cents, stock, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [l.id, l.seller_id, l.title, l.description, l.price_cents, l.stock, l.status],
  );
}

describe('Read replica routing', () => {
  it('serves catalog reads from the replica once nothing was recently written', async () => {
    const client = testClient({ readPool: replica, replicaLagGraceSeconds: 0 });
    const seller = await asSeller(client);
    const listing = await createListing(client, seller);

    // Not replicated yet: the replica doesn't have it (this is what lag looks like).
    await client.get(`/api/v1/listings/${listing.id}`).expect(404);
    await replicate(listing.id);
    await client.get(`/api/v1/listings/${listing.id}`).expect(200);
    expect((await client.get('/api/v1/listings').expect(200)).body.pagination.total).toBe(1);
  });

  it('reads your own writes: recently written data skips the lagging replica', async () => {
    const client = testClient({ readPool: replica, replicaLagGraceSeconds: 60 });
    const seller = await asSeller(client);
    const listing = await createListing(client, seller, { title: 'Brand new' });

    // The replica has nothing, yet the seller sees their new listing straight away.
    const res = await client.get(`/api/v1/listings/${listing.id}`).expect(200);
    expect(res.body.data.title).toBe('Brand new');
    expect((await client.get('/api/v1/listings').expect(200)).body.pagination.total).toBe(1);
  });

  it('writes and permission checks always use the primary', async () => {
    const client = testClient({ readPool: replica, replicaLagGraceSeconds: 0 });
    const seller = await asSeller(client);
    const listing = await createListing(client, seller);
    await client
      .patch(`/api/v1/listings/${listing.id}`)
      .set('Authorization', seller.auth)
      .send({ stock: 1 })
      .expect(200);
  });

  it('falls back to the primary when the replica is down, and reports it in /ready', async () => {
    const dead = createPool({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', max: 1, statementTimeoutMs: 1_000 });
    try {
      const client = testClient({ readPool: dead, replicaLagGraceSeconds: 0 });
      const seller = await asSeller(client);
      const listing = await createListing(client, seller);
      await client.get(`/api/v1/listings/${listing.id}`).expect(200);

      const ready = await client.get('/ready').expect(200);
      expect(ready.body.checks).toContainEqual({ name: 'replica', ok: false, required: false });
    } finally {
      await dead.end();
    }
  });
});

describe('Prometheus metrics', () => {
  it('exposes RED metrics labelled by route template, plus pool and cache metrics', async () => {
    const client = testClient();
    const seller = await asSeller(client);
    const listing = await createListing(client, seller);
    await client.get(`/api/v1/listings/${listing.id}`).expect(200);
    await client.get(`/api/v1/listings/${listing.id}`).expect(200);
    await client.get('/api/v1/nope').expect(404);

    const res = await client.get('/metrics').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    const body = res.text;
    expect(body).toMatch(/http_request_duration_seconds_count\{method="GET",route="\/api\/v1\/listings\/:id",status_code="200"\} \d+/);
    expect(body).toMatch(/route="unmatched",status_code="404"/);
    expect(body).not.toContain(listing.id); // no IDs in labels (cardinality)
    expect(body).toMatch(/db_pool_connections\{pool="primary",state="total"\}/);
    expect(body).toMatch(/cache_requests_total\{cache="listings",result="hit"\} [1-9]/);
    expect(body).toMatch(/process_cpu_seconds_total/);
  });

  it('counts rate-limited requests per limiter', async () => {
    const client = testClient({ rateLimits: { max: 1 } });
    await client.get('/api/v1/listings').expect(200);
    await client.get('/api/v1/listings').expect(429);
    const body = (await client.get('/metrics')).text;
    expect(body).toMatch(/rate_limited_requests_total\{limiter="api"\} [1-9]/);
  });

  it('can be switched off', async () => {
    await testClient({ metrics: false }).get('/metrics').expect(404);
  });
});
