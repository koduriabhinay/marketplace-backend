import { env } from './config/env';
import { logger } from './lib/logger';
import { createApp } from './app';

let shuttingDown = false;
const app = createApp({ isShuttingDown: () => shuttingDown });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Marketplace API listening');
});

// Server-level timeouts: drop slow or idle clients instead of leaking sockets.
server.requestTimeout = env.REQUEST_TIMEOUT_MS + 5_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 65_000; // longer than typical load balancer idle timeouts

/**
 * Graceful shutdown: on SIGTERM (Docker/Kubernetes stop) fail readiness, stop accepting
 * new connections, let in-flight requests finish, then exit. Force-exit after a deadline.
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

  server.close((err) => {
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
