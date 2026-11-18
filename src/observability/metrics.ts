import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics. Prometheus scrapes GET /metrics every few seconds and stores the
 * numbers as time series; Grafana graphs them and alert rules fire on them.
 *
 * What we measure follows the RED method for request-driven services:
 *   Rate (requests/s), Errors (5xx rate), Duration (latency histogram, so p95/p99)
 * plus saturation of the things that run out first: DB connections, the outbox backlog.
 *
 * Label values must come from a small fixed set (route templates like
 * /api/v1/listings/:id, never raw URLs with IDs), or every distinct value becomes a new
 * time series and Prometheus runs out of memory ("cardinality explosion").
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry }); // CPU, memory, event-loop lag, GC

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpInFlight = new Gauge({
  name: 'http_requests_in_flight',
  help: 'Requests currently being handled',
  registers: [registry],
});

export const cacheRequests = new Counter({
  name: 'cache_requests_total',
  help: 'Cache lookups by result',
  labelNames: ['cache', 'result'] as const, // result: hit | miss | error | bypass
  registers: [registry],
});

export const replicaReads = new Counter({
  name: 'db_replica_reads_total',
  help: 'Catalog reads by where they were served from',
  labelNames: ['target'] as const, // replica | primary_recent_write | primary_fallback
  registers: [registry],
});

export const rateLimited = new Counter({
  name: 'rate_limited_requests_total',
  help: 'Requests rejected with 429',
  labelNames: ['limiter'] as const,
  registers: [registry],
});

export const idempotentReplays = new Counter({
  name: 'idempotent_replays_total',
  help: 'Requests answered from a stored idempotent response',
  registers: [registry],
});

export const outboxPublished = new Counter({
  name: 'outbox_events_published_total',
  help: 'Events relayed from the outbox to the broker',
  registers: [registry],
});

export const webhookDeliveries = new Counter({
  name: 'webhook_deliveries_total',
  help: 'Webhook delivery attempts by outcome',
  labelNames: ['result'] as const, // succeeded | failed | dead | deferred
  registers: [registry],
});

export const jobRuns = new Counter({
  name: 'scheduled_job_runs_total',
  help: 'Scheduled job runs by outcome',
  labelNames: ['job', 'result'] as const, // ran | skipped_locked | failed
  registers: [registry],
});

const trackedPools = new Map<string, Pool>();

new Gauge({
  name: 'db_pool_connections',
  help: 'Postgres pool connections by state',
  labelNames: ['pool', 'state'] as const,
  registers: [registry],
  collect() {
    this.reset();
    for (const [name, pool] of trackedPools) {
      this.set({ pool: name, state: 'total' }, pool.totalCount);
      this.set({ pool: name, state: 'idle' }, pool.idleCount);
      // Requests waiting for a free connection: the first sign the pool is too small.
      this.set({ pool: name, state: 'waiting' }, pool.waitingCount);
    }
  },
});

/** Exposes a pool's connection counts as metrics. */
export function trackPool(name: string, pool: Pool) {
  trackedPools.set(name, pool);
}

/**
 * Gauge computed on each scrape by a query, e.g. "how many outbox events are waiting".
 * Registered once per process.
 */
let outboxGauge: Gauge | undefined;
export function trackOutboxBacklog(pool: Pool) {
  outboxGauge ??= new Gauge({
    name: 'outbox_unpublished_events',
    help: 'Events waiting in the outbox (should stay near 0)',
    registers: [registry],
    async collect() {
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL',
      );
      this.set(rows[0]!.n);
    },
  });
}

/** Records RED metrics for every request, labelled by route template. */
export const httpMetrics: RequestHandler = (req, res, next) => {
  if (req.path === '/metrics') return next();
  const end = httpDuration.startTimer();
  httpInFlight.inc();
  res.on('close', () => {
    httpInFlight.dec();
    const route = req.route ? `${req.baseUrl}${req.route.path as string}` : 'unmatched';
    end({ method: req.method, route, status_code: String(res.statusCode) });
  });
  next();
};

export const metricsHandler: RequestHandler = async (_req, res) => {
  res.setHeader('Content-Type', registry.contentType);
  res.end(await registry.metrics());
};
