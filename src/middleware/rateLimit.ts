import { rateLimit } from 'express-rate-limit';

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
  skipSuccessfulRequests?: boolean;
}

/**
 * Fixed-window rate limiter keyed by client IP (the real IP, thanks to `trust proxy`).
 * Counters live in this process's memory: fine for one instance, but with several
 * instances each keeps its own count. Phase 4 moves the store to Redis so the limit is
 * shared across every instance.
 */
export function createRateLimiter(opts: RateLimitOptions) {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    skipSuccessfulRequests: opts.skipSuccessfulRequests ?? false,
    standardHeaders: 'draft-8', // RateLimit + RateLimit-Policy headers
    legacyHeaders: false,
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
