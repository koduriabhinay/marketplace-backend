import type { RequestHandler } from 'express';

/**
 * Answers 503 if a handler hasn't responded within `ms`, so a slow dependency can't hold
 * a client connection open forever. The handler's late response is safely ignored.
 */
export const requestTimeout =
  (ms: number): RequestHandler =>
  (req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        req.log?.warn({ timeoutMs: ms }, 'Request timed out');
        res.status(503).json({
          error: { code: 'REQUEST_TIMEOUT', message: 'Request timed out', requestId: String(req.id) },
        });
      }
    }, ms);
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
  };
