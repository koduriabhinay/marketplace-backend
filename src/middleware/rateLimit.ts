import { rateLimit, type Store } from 'express-rate-limit';
import type { Redis } from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';

export interface RateLimitOptions {
  /** Unique per limiter: it namespaces the counters in Redis. */
  name: string;
  windowMs: number;
  limit: number;
  skipSuccessfulRequests?: boolean;
  /** Shared counter store. Without it, counts live in this process only. */
  redis?: Redis;
}

/**
 * Fixed-window rate limiter keyed by client IP (the real IP, thanks to `trust proxy`).
 *
 * With Redis, every API instance increments the same counter (atomically, via a Lua
 * script in rate-limit-redis), so "300 requests a minute" means 300 in total, not 300
 * per instance. Without Redis the counters are in memory: fine for one process.
 *
 * If Redis is unreachable the limiter lets requests through (fails open) rather than
 * taking the whole API down with it; the error is logged by the store.
 */
export function createRateLimiter(opts: RateLimitOptions) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    skipSuccessfulRequests: opts.skipSuccessfulRequests ?? false,
    standardHeaders: 'draft-8', // RateLimit + RateLimit-Policy headers
    legacyHeaders: false,
    identifier: opts.name,
    store: opts.redis ? redisStore(opts.redis, opts.name) : undefined,
    passOnStoreError: true,
    handler: (req, res, _next, options) => {
      res.status(options.statusCode).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please try again later',
          requestId: String(req.id ?? ''),
        },
      });
    },
  });
}

function redisStore(redis: Redis, name: string): Store {
  return new RedisStore({
    prefix: `rl:${name}:`,
    sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
  });
}
