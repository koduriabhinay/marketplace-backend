import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { MemoryCache, RedisCache, type Cache } from './cache/cache';
import { ListingCache } from './cache/listingCache';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { idempotency } from './middleware/idempotency';
import { createRateLimiter } from './middleware/rateLimit';
import { requestTimeout } from './middleware/requestTimeout';
import { createPgRepositories } from './repositories/postgres';
import { PgImageRepository } from './repositories/postgres/images';
import type { Repositories } from './repositories/types';
import { authRouter } from './routes/auth';
import { customersRouter } from './routes/customers';
import { healthRouter, type ReadinessCheck } from './routes/health';
import { listingsRouter } from './routes/listings';
import { ordersRouter } from './routes/orders';
import { sellersRouter } from './routes/sellers';
import { AuthService } from './services/authService';
import { CustomerService } from './services/customerService';
import { ImageService } from './services/imageService';
import { ListingService } from './services/listingService';
import { OrderService } from './services/orderService';
import { SellerService } from './services/sellerService';
import { LocalImageStorage, type ImageStorage } from './storage/imageStorage';
import { WebhookService } from './webhooks/webhookService';

export interface AppDeps {
  pool: Pool;
  repos?: Repositories;
  imageStorage?: ImageStorage;
  readinessChecks?: ReadinessCheck[];
  isShuttingDown?: () => boolean;
  requestTimeoutMs?: number;
  corsOrigins?: string[];
  rateLimits?: Partial<{ windowMs: number; max: number; authWindowMs: number; authMax: number }>;
  /** Shared Redis for the cache and rate limits. Without it, both are per-process. */
  redis?: Redis;
  /** Overrides the cache built from `redis` (tests). */
  cache?: Cache;
  cacheTtlSeconds?: number;
  allowInsecureWebhooks?: boolean;
}

/**
 * Builds the app from its dependencies (no listening, no globals), so tests can create an
 * isolated app per test against the test database.
 */
export function createApp(deps: AppDeps) {
  const repos = deps.repos ?? createPgRepositories(deps.pool);
  const storage = deps.imageStorage ?? new LocalImageStorage(env.UPLOAD_DIR);
  const { redis } = deps;
  const readinessChecks = deps.readinessChecks ?? [
    { name: 'postgres', check: async () => void (await deps.pool.query('SELECT 1')) },
    // Redis is reported but deliberately not required: without it the API still works
    // (cache misses go to Postgres, rate limits fail open), just slower.
  ];
  const cache = deps.cache ?? (redis ? new RedisCache(redis) : new MemoryCache());
  const listingCache = new ListingCache(cache, deps.cacheTtlSeconds ?? env.CACHE_TTL_SECONDS);
  const limits = {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    authWindowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    authMax: env.AUTH_RATE_LIMIT_MAX,
    ...deps.rateLimits,
  };

  const listingService = new ListingService(repos.listings, listingCache);
  const imageService = new ImageService(new PgImageRepository(deps.pool), storage, listingService);

  const app = express();
  app.disable('x-powered-by');
  // Number of proxies in front of us (Nginx in Phase 5). Needed so req.ip is the real
  // client, not the proxy: otherwise every user shares one rate-limit bucket.
  app.set('trust proxy', env.TRUST_PROXY);

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
  // CORS: only listed browser origins may call the API from JavaScript. Default: none.
  app.use(
    cors({
      origin: deps.corsOrigins ?? env.CORS_ORIGINS,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id', 'Location', 'RateLimit', 'RateLimit-Policy', 'Retry-After', 'Idempotent-Replayed'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: env.BODY_LIMIT }));

  app.use(healthRouter(readinessChecks, deps.isShuttingDown ?? (() => false), redis && cache));

  const api = express.Router();
  api.use(createRateLimiter({ name: 'api', windowMs: limits.windowMs, limit: limits.max, redis }));
  api.use(requestTimeout(deps.requestTimeoutMs ?? env.REQUEST_TIMEOUT_MS));
  api.use(
    '/auth',
    authRouter(new AuthService(deps.pool), {
      register: createRateLimiter({ name: 'register', windowMs: limits.authWindowMs, limit: limits.authMax, redis }),
      credentials: createRateLimiter({
        name: 'credentials',
        redis,
        windowMs: limits.authWindowMs,
        limit: limits.authMax,
        skipSuccessfulRequests: true,
      }),
    }),
  );
  const webhooks = new WebhookService(deps.pool, deps.allowInsecureWebhooks ?? env.WEBHOOK_ALLOW_INSECURE);
  api.use('/sellers', sellersRouter(new SellerService(repos.sellers), webhooks));
  api.use('/customers', customersRouter(new CustomerService(repos.customers)));
  api.use('/listings', listingsRouter(listingService, imageService, storage.root));
  api.use('/orders', ordersRouter(new OrderService(repos.orders, listingCache), idempotency(deps.pool)));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
