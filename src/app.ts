import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestTimeout } from './middleware/requestTimeout';
import type { Pool } from 'pg';
import { createPgRepositories } from './repositories/postgres';
import type { Repositories } from './repositories/types';
import { customersRouter } from './routes/customers';
import { healthRouter, type ReadinessCheck } from './routes/health';
import { listingsRouter } from './routes/listings';
import { ordersRouter } from './routes/orders';
import { sellersRouter } from './routes/sellers';
import { CustomerService } from './services/customerService';
import { ListingService } from './services/listingService';
import { OrderService } from './services/orderService';
import { SellerService } from './services/sellerService';

export interface AppDeps {
  pool: Pool;
  repos?: Repositories;
  readinessChecks?: ReadinessCheck[];
  isShuttingDown?: () => boolean;
  requestTimeoutMs?: number;
}

/**
 * Builds the app from its dependencies (no listening, no globals), so tests can create a
 * app per test against the test database.
 */
export function createApp(deps: AppDeps) {
  const repos = deps.repos ?? createPgRepositories(deps.pool);
  const readinessChecks = deps.readinessChecks ?? [
    { name: 'postgres', check: async () => void (await deps.pool.query('SELECT 1')) },
  ];

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // we will sit behind Nginx in Phase 5

  app.use(
    pinoHttp({
      logger,
      // Reuse an upstream request ID (from a proxy/gateway) or mint one; echo it back.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
    }),
  );
  app.use(helmet());
  app.use(express.json({ limit: env.BODY_LIMIT }));

  app.use(healthRouter(readinessChecks, deps.isShuttingDown ?? (() => false)));

  const api = express.Router();
  api.use(requestTimeout(deps.requestTimeoutMs ?? env.REQUEST_TIMEOUT_MS));
  api.use('/sellers', sellersRouter(new SellerService(repos.sellers)));
  api.use('/customers', customersRouter(new CustomerService(repos.customers)));
  api.use('/listings', listingsRouter(new ListingService(repos.listings)));
  api.use('/orders', ordersRouter(new OrderService(repos.orders)));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
