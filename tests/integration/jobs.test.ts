import { randomUUID } from 'node:crypto';
import { startPollingLoop } from '../../src/jobs/loop';
import { maintenanceJobs } from '../../src/jobs/maintenance';
import { Scheduler } from '../../src/jobs/scheduler';
import { testPool } from '../db';
import { asCustomer, testClient } from '../helpers';

const count = async (table: string) => (await testPool().query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

describe('Scheduler (cron jobs)', () => {
  it('runs a job on only one instance at a time (advisory lock)', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let runs = 0;
    const job = {
      name: 'slow-job',
      everyMs: 60_000,
      run: async () => {
        runs++;
        maxConcurrent = Math.max(maxConcurrent, ++concurrent);
        await new Promise((r) => setTimeout(r, 100));
        concurrent--;
        return 0;
      },
    };
    // Three "worker instances" fire the same job at the same moment.
    const instances = Array.from({ length: 3 }, () => new Scheduler(testPool(), [job]));
    const results = await Promise.all(instances.map((s) => s.runNow('slow-job')));

    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect(runs).toBe(1);
    expect(maxConcurrent).toBe(1);

    // The lock is released afterwards, so the next round runs again.
    expect((await instances[1]!.runNow('slow-job')).ran).toBe(true);
  });

  it('runs jobs on their interval and stops cleanly', async () => {
    let runs = 0;
    const scheduler = new Scheduler(testPool(), [{ name: 'tick', everyMs: 20, run: async () => ++runs }]);
    scheduler.start();
    await new Promise((r) => setTimeout(r, 150));
    await scheduler.stop();
    const after = runs;
    expect(after).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(runs).toBe(after);
  });

  it('rejects unknown jobs', async () => {
    await expect(new Scheduler(testPool(), []).runNow('nope')).rejects.toThrow(/Unknown job/);
  });
});

describe('Maintenance jobs', () => {
  const run = (name: string) => new Scheduler(testPool(), maintenanceJobs).runNow(name);

  it('purges idempotency keys after 24 h, and stuck in-progress keys after 15 min', async () => {
    const { userId } = await asCustomer(testClient());
    const insert = (key: string, status: string, age: string) =>
      testPool().query(
        `INSERT INTO idempotency_keys (user_id, key, request_method, request_path, request_hash, status, created_at)
         VALUES ($1, $2, 'POST', '/api/v1/orders', 'h', $3, now() - $4::interval)`,
        [userId, key, status, age],
      );
    await insert('fresh-completed', 'completed', '1 hour');
    await insert('old-completed', 'completed', '25 hours');
    await insert('fresh-inprogress', 'in_progress', '1 minute');
    await insert('stuck-inprogress', 'in_progress', '20 minutes');

    expect(await run('purge-idempotency-keys')).toEqual({ ran: true, affected: 2 });
    const left = await testPool().query('SELECT key FROM idempotency_keys ORDER BY key');
    expect(left.rows.map((r) => r.key)).toEqual(['fresh-completed', 'fresh-inprogress']);
  });

  it('purges whole refresh-token families once they are long expired or revoked', async () => {
    const client = testClient();
    await asCustomer(client); // creates one live token family
    const { rows } = await testPool().query('SELECT user_id FROM refresh_tokens LIMIT 1');
    const userId = rows[0].user_id;
    const family = randomUUID();
    const older = randomUUID();
    const newer = randomUUID();
    // A rotated chain: older -> newer, both expired weeks ago.
    await testPool().query(
      `INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, created_at)
       VALUES ($1, $3, $4, 'h-newer', now() - interval '20 days', now() - interval '50 days'),
              ($2, $3, $4, 'h-older', now() - interval '21 days', now() - interval '51 days')`,
      [newer, older, userId, family],
    );
    await testPool().query('UPDATE refresh_tokens SET replaced_by = $1, revoked_at = now() - interval \'30 days\' WHERE id = $2', [newer, older]);

    expect(await run('purge-refresh-tokens')).toEqual({ ran: true, affected: 2 });
    expect(await count('refresh_tokens')).toBe(1); // the live session survives
  });

  it('prunes old published outbox events and finished webhook deliveries', async () => {
    await testPool().query(
      `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, published_at)
       VALUES ($1, 'order', $1, 'order.placed', '{}', now() - interval '8 days'),
              ($2, 'order', $2, 'order.placed', '{}', now()),
              ($3, 'order', $3, 'order.placed', '{}', NULL)`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
    expect(await run('prune-outbox')).toEqual({ ran: true, affected: 1 });
    expect(await count('outbox_events')).toBe(2);
    expect(await run('prune-webhook-deliveries')).toEqual({ ran: true, affected: 0 });
  });
});

describe('Polling loop', () => {
  it('runs again immediately while there is work, survives errors, and stops gracefully', async () => {
    let calls = 0;
    const loop = startPollingLoop('test', 10, async () => {
      calls++;
      if (calls === 2) throw new Error('transient');
      return calls < 5 ? 1 : 0;
    });
    await new Promise((r) => setTimeout(r, 100));
    await loop.stop();
    const after = calls;
    expect(after).toBeGreaterThanOrEqual(5);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(after);
  });
});
