import { Pool } from 'pg';
import { migrate } from '../src/db/migrate';

/** Runs once before all test files: bring the test database schema up to date. */
export default async function globalSetup() {
  const pool = new Pool({
    connectionString:
      process.env.TEST_DATABASE_URL ?? 'postgres://marketplace:marketplace@localhost:5432/marketplace_test',
  });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
