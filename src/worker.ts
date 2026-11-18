import { createServer } from 'node:http';
import { env } from './config/env';
import { createPool } from './db/pool';
import { registry, trackOutboxBacklog, trackPool } from './observability/metrics';
import { logger } from './lib/logger';
import type { MessageBroker } from './messaging/broker';
import { MemoryBroker } from './messaging/memoryBroker';
import { RabbitBroker } from './messaging/rabbitBroker';
import { createWorker } from './worker/createWorker';

/**
 * Worker entry point: `npm run worker` (or the `worker` service in docker compose).
 * Runs separately from the API so each can be scaled and restarted on its own.
 */
let shuttingDown = false;

const pool = createPool({
  connectionString: env.DATABASE_URL,
  max: Math.min(env.DB_POOL_MAX, 5),
  statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
});

async function main() {
  let broker: MessageBroker;
  if (env.RABBITMQ_URL) {
    broker = await RabbitBroker.connect({
      url: env.RABBITMQ_URL,
      // Crash-only: if the broker connection drops, exit and let Docker/Kubernetes restart
      // us with a clean connection, rather than trying to patch up half-broken state.
      onConnectionLost: () => void shutdown('rabbitmq-connection-lost', 1),
    });
  } else {
    logger.warn('RABBITMQ_URL not set: using the in-process broker (fine for local development only)');
    broker = new MemoryBroker();
  }

  const worker = createWorker({
    pool,
    broker,
    outboxPollMs: env.OUTBOX_POLL_MS,
    webhookPollMs: env.WEBHOOK_POLL_MS,
    dispatcher: {
      timeoutMs: env.WEBHOOK_TIMEOUT_MS,
      maxAttempts: env.WEBHOOK_MAX_ATTEMPTS,
      allowInsecureUrls: env.WEBHOOK_ALLOW_INSECURE,
    },
  });
  await worker.start();
  trackPool('worker', pool);
  trackOutboxBacklog(pool);

  // Tiny health server so the orchestrator can probe the worker like any other service.
  const health = createServer((req, res) => {
    const reply = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.url === '/health') return reply(200, { status: 'ok' });
    if (req.url === '/metrics') {
      registry.metrics().then(
        (body) => res.writeHead(200, { 'content-type': registry.contentType }).end(body),
        () => reply(500, { status: 'error' }),
      );
      return;
    }
    if (req.url === '/ready') {
      if (shuttingDown) return reply(503, { status: 'shutting_down' });
      Promise.all([pool.query('SELECT 1'), broker.check()]).then(
        () => reply(200, { status: 'ready' }),
        () => reply(503, { status: 'not_ready' }),
      );
      return;
    }
    reply(404, { status: 'not_found' });
  });
  health.listen(env.WORKER_PORT, () => logger.info({ port: env.WORKER_PORT }, 'Worker started'));

  stopWorker = async () => {
    await worker.stop();
    await broker.close().catch((err: unknown) => logger.error({ err }, 'Error closing broker'));
    health.close();
  };
}

let stopWorker: () => Promise<void> = async () => {};

async function shutdown(signal: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Worker shutting down');
  const force = setTimeout(() => process.exit(1), env.SHUTDOWN_TIMEOUT_MS);
  force.unref();
  try {
    await stopWorker();
    await pool.end();
  } catch (err) {
    logger.error({ err }, 'Error during worker shutdown');
    code = 1;
  }
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  void shutdown('unhandledRejection', 1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Worker failed to start');
  void shutdown('startup-failure', 1);
});
