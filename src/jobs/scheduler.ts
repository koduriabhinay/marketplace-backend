import type { Pool } from 'pg';
import { logger } from '../lib/logger';

export interface ScheduledJob {
  name: string;
  everyMs: number;
  run: (pool: Pool) => Promise<number>;
}

const LOCK_NAMESPACE = 727_002;

/**
 * Cron-style scheduled jobs that are safe to run on many instances.
 *
 * With 3 worker replicas, a plain setInterval would run every job 3 times. Each run first
 * takes a Postgres advisory lock named after the job (pg_try_advisory_lock): one
 * instance gets it and runs the job, the others skip this round. If that instance dies,
 * Postgres releases its lock with the connection, so another instance takes over next time.
 *
 * (In Kubernetes you might use a CronJob instead; the lock still protects you if two
 * runs overlap.)
 */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    private readonly pool: Pool,
    private readonly jobs: ScheduledJob[],
  ) {}

  start() {
    for (const job of this.jobs) {
      const t = setInterval(() => {
        const p = this.runNow(job.name).catch((err: unknown) => logger.error({ err, job: job.name }, 'Job failed'));
        this.running.add(p);
        void p.finally(() => this.running.delete(p));
      }, job.everyMs);
      this.timers.push(t);
    }
  }

  /** Runs a job once if no other instance is running it. */
  async runNow(name: string): Promise<{ ran: boolean; affected?: number }> {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new Error(`Unknown job ${name}`);

    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked',
        [LOCK_NAMESPACE, name],
      );
      if (!rows[0]!.locked) return { ran: false };
      try {
        const started = Date.now();
        const affected = await job.run(this.pool);
        logger.info({ job: name, affected, durationMs: Date.now() - started }, 'Scheduled job finished');
        return { ran: true, affected };
      } finally {
        await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [LOCK_NAMESPACE, name]);
      }
    } finally {
      client.release();
    }
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.allSettled([...this.running]);
  }
}
