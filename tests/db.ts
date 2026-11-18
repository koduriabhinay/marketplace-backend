import type { Pool } from 'pg';
import { env } from '../src/config/env';
import { createPool } from '../src/db/pool';

let pool: Pool | undefined;

export function testPool(): Pool {
  pool ??= createPool({ connectionString: env.DATABASE_URL, max: 25, statementTimeoutMs: 10_000 });
  return pool;
}

/** Empties every table so each test starts from a known state. */
export async function resetDb() {
  await testPool().query('TRUNCATE listing_images, refresh_tokens, users, order_items, orders, listings, customers, sellers CASCADE');
}

export async function closeDb() {
  await pool?.end();
  pool = undefined;
}
