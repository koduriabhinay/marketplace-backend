import { migrate } from '../../src/db/migrate';
import { createPool, withTransaction } from '../../src/db/pool';
import { testPool } from '../db';
import { asSeller, createListing, testClient } from '../helpers';

describe('Database layer', () => {
  it('migrations are idempotent: a second run applies nothing', async () => {
    expect(await migrate(testPool())).toEqual([]);
    const { rows } = await testPool().query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toContain('001_initial_schema.sql');
  });

  it('rolls back a transaction when the callback throws', async () => {
    await expect(
      withTransaction(testPool(), async (c) => {
        await c.query(
          "INSERT INTO sellers (id, name, email) VALUES ('11111111-1111-4111-8111-111111111111', 'Temp', 'temp@example.com')",
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await testPool().query('SELECT count(*)::int AS n FROM sellers');
    expect(rows[0].n).toBe(0);
  });

  it('treats SQL injection payloads as plain data', async () => {
    const client = testClient();
    const evil = "Robert'); DROP TABLE sellers; --";
    const evilEmail = "x'; DROP TABLE users; --@example.com";
    const seller = await asSeller(client, { name: "Robert O'Brien; DROP TABLE sellers" });
    await client.post('/api/v1/auth/login').send({ email: evilEmail, password: evil }).expect(400);
    await client.post('/api/v1/auth/login').send({ email: 'a@example.com', password: evil }).expect(401);

    const res = await client.get(`/api/v1/sellers/${seller.sellerId}`).expect(200);
    expect(res.body.data.name).toBe("Robert O'Brien; DROP TABLE sellers");
    // The table still exists and holds exactly our row.
    const { rows } = await testPool().query('SELECT count(*)::int AS n FROM sellers');
    expect(rows[0].n).toBe(1);
  });

  it('the stock CHECK constraint is a last line of defence against negative stock', async () => {
    const client = testClient();
    const seller = await asSeller(client);
    const listing = await createListing(client, seller, { stock: 1 });
    await expect(
      testPool().query('UPDATE listings SET stock = stock - 2 WHERE id = $1', [listing.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('uses the partial index for live listings by seller', async () => {
    const client = await testPool().connect();
    try {
      // Tiny test tables make a sequential scan cheapest, so force the planner to show
      // which index it WOULD use on real data volumes.
      await client.query('SET enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM listings
          WHERE seller_id = '11111111-1111-4111-8111-111111111111' AND deleted_at IS NULL
          ORDER BY created_at DESC`,
      );
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('listings_seller_live_idx');
    } finally {
      await client.query('RESET enable_seqscan');
      client.release();
    }
  });

  it('migrates an empty database from scratch', async () => {
    const dbName = `marketplace_migrate_${process.pid}`;
    const admin = testPool();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${dbName}`;
    const fresh = createPool({ connectionString: url.toString(), max: 2, statementTimeoutMs: 10_000 });
    try {
      const logged: string[] = [];
      expect(await migrate(fresh, (m) => logged.push(m))).toEqual([
        '001_initial_schema.sql',
        '002_auth_and_images.sql',
        '003_events_webhooks_idempotency.sql',
      ]);
      expect(logged).toEqual([
        'applied 001_initial_schema.sql',
        'applied 002_auth_and_images.sql',
        'applied 003_events_webhooks_idempotency.sql',
      ]);
      const { rows } = await fresh.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        'customers',
        'idempotency_keys',
        'listing_images',
        'listings',
        'order_items',
        'orders',
        'outbox_events',
        'refresh_tokens',
        'schema_migrations',
        'sellers',
        'users',
        'webhook_deliveries',
        'webhook_endpoints',
      ]);
    } finally {
      await fresh.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    }
  });
});
