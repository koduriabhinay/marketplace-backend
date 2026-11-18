import { Pool } from 'pg';
import { migrate } from '../src/db/migrate';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://marketplace:marketplace@localhost:5432/marketplace_test';

/** A second, independent database that plays the part of a read replica in tests. */
export function replicaUrl() {
  const url = new URL(TEST_DB_URL);
  url.pathname = `${url.pathname}_replica`;
  return url.toString();
}

/** Runs once before all test files: bring the test database schemas up to date. */
export default async function globalSetup() {
  const pool = new Pool({ connectionString: TEST_DB_URL });
  try {
    await migrate(pool);
    const name = new URL(replicaUrl()).pathname.slice(1);
    const { rowCount } = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await pool.query(`CREATE DATABASE "${name}"`);
  } finally {
    await pool.end();
  }
  const replica = new Pool({ connectionString: replicaUrl() });
  try {
    await migrate(replica);
  } finally {
    await replica.end();
  }
}
