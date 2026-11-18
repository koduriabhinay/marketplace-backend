import { Pool, type PoolClient } from 'pg';
import { logger } from '../lib/logger';

export interface PoolOptions {
  connectionString: string;
  max: number;
  statementTimeoutMs: number;
}

/**
 * One pool per process. Opening a TCP + auth handshake per query is slow, so the pool
 * keeps a bounded set of connections open and lends them out. `max` caps how many the
 * app can hold: N app instances × max must stay under Postgres's max_connections.
 */
export function createPool(opts: PoolOptions): Pool {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000, // fail fast if the pool is exhausted or DB unreachable
    statement_timeout: opts.statementTimeoutMs, // server kills runaway queries
    application_name: 'marketplace-api',
  });
  // An idle client erroring (e.g. DB restarted) must not crash the process.
  pool.on('error', (err) => logger.error({ err }, 'Idle Postgres client error'));
  return pool;
}

/**
 * Runs `fn` inside BEGIN/COMMIT on a single connection, rolling back on any error.
 * Everything in `fn` must use the `client` it is given, not the pool.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres error codes we translate into HTTP responses. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
} as const;

export const pgCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
