import { createRedis } from './cache/cache';
import { env } from './config/env';
import { createPool } from './db/pool';
import { logger } from './lib/logger';
import { createApp } from './app';

let shuttingDown = false;
const pool = createPool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
});
// Optional: without REDIS_URL the cache and rate limits are per-process (fine for one instance).
const redis = env.REDIS_URL
  ? createRedis({ url: env.REDIS_URL, commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS })
  : undefined;
redis?.on('error', (err) => logger.warn({ err: err.message }, 'Redis error'));
if (!redis) logger.warn('REDIS_URL not set: using in-process cache and rate limits');

const app = createApp({ pool, redis, isShuttingDown: () => shuttingDown });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Marketplace API listening');
});

// Server-level timeouts: drop slow or idle clients instead of leaking sockets.
server.requestTimeout = env.REQUEST_TIMEOUT_MS + 5_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 65_000; // longer than typical load balancer idle timeouts

/**
 * Graceful shutdown: on SIGTERM (Docker/Kubernetes stop) fail readiness, stop accepting
 * new connections, let in-flight requests finish, close the DB pool, then exit.
 * Force-exit after a deadline.
 */
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  const force = setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  force.unref();

  server.close(async (err) => {
    try {
      await pool.end();
      await redis?.quit();
    } catch (closeErr) {
      logger.error({ err: closeErr }, 'Error closing connections');
    }
    if (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
    logger.info('Shutdown complete');
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  shutdown('unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
