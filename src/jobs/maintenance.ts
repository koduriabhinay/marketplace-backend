import type { Pool } from 'pg';
import type { ScheduledJob } from './scheduler';

const HOUR = 60 * 60_000;

const affected = async (pool: Pool, sql: string) => (await pool.query(sql)).rowCount ?? 0;

/** Housekeeping that keeps tables from growing forever. */
export const maintenanceJobs: ScheduledJob[] = [
  {
    // A whole login family goes once every token in it is long expired or revoked.
    name: 'purge-refresh-tokens',
    everyMs: HOUR,
    run: (pool) =>
      affected(
        pool,
        `DELETE FROM refresh_tokens WHERE family_id IN (
           SELECT family_id FROM refresh_tokens GROUP BY family_id
           HAVING max(expires_at) < now() - interval '7 days'
               OR bool_and(revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')
         )`,
      ),
  },
  {
    // Clients retry within minutes; a day is plenty. In-progress keys older than 15 min
    // belong to a request whose process died, so let the client try again.
    name: 'purge-idempotency-keys',
    everyMs: HOUR,
    run: (pool) =>
      affected(
        pool,
        `DELETE FROM idempotency_keys
          WHERE (status = 'completed' AND created_at < now() - interval '24 hours')
             OR (status = 'in_progress' AND created_at < now() - interval '15 minutes')`,
      ),
  },
  {
    name: 'prune-outbox',
    everyMs: 6 * HOUR,
    run: (pool) =>
      affected(pool, `DELETE FROM outbox_events WHERE published_at < now() - interval '7 days'`),
  },
  {
    name: 'prune-webhook-deliveries',
    everyMs: 6 * HOUR,
    run: (pool) =>
      affected(
        pool,
        `DELETE FROM webhook_deliveries
          WHERE status IN ('succeeded', 'dead') AND updated_at < now() - interval '30 days'`,
      ),
  },
];
