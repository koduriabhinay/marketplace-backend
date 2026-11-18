import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { AppError, UnauthorizedError, ValidationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { idempotentReplays } from '../observability/metrics';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,255}$/;

interface StoredKey {
  request_method: string;
  request_path: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: unknown;
  response_location: string | null;
}

/**
 * Idempotency keys make a non-idempotent POST safe to retry.
 *
 * The problem: a client places an order, the network drops before the response arrives,
 * and the client can't know if the order went through. Retrying blindly could charge the
 * customer twice. So the client sends a unique `Idempotency-Key` header (a UUID it
 * generates per checkout) and reuses it on every retry:
 *
 *  - first request with a key: we record it as in_progress, run the handler, and save
 *    the response before sending it;
 *  - same key again: we replay the saved response (with `Idempotent-Replayed: true`)
 *    without running the handler again;
 *  - same key while the first is still running: 409 with Retry-After;
 *  - same key with a different body: 422, it's a client bug.
 *
 * Responses that say "nothing happened" (400 invalid input, 429, 5xx) aren't saved, so
 * the client can fix the problem and retry with the same key. A cron job removes keys
 * after 24 hours, and stuck in_progress keys (the process died mid-request) after 15 min.
 */
export function idempotency(pool: Pool): RequestHandler {
  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (key === undefined) return next();
    if (!KEY_PATTERN.test(key)) {
      throw new ValidationError([
        { path: ['Idempotency-Key'], message: 'Must be 8-255 characters of letters, digits, - or _' },
      ]);
    }
    if (!req.user) throw new UnauthorizedError();

    const userId = req.user.id;
    const hash = createHash('sha256')
      .update(JSON.stringify(req.body ?? null))
      .digest('hex');
    const path = req.originalUrl.split('?')[0]!;

    const inserted = await pool.query(
      `INSERT INTO idempotency_keys (user_id, key, request_method, request_path, request_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, key) DO NOTHING`,
      [userId, key, req.method, path, hash],
    );

    if (!inserted.rowCount) {
      const { rows } = await pool.query<StoredKey>(
        `SELECT request_method, request_path, request_hash, status, response_status, response_body, response_location
           FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
        [userId, key],
      );
      const stored = rows[0];
      if (!stored || stored.status === 'in_progress') {
        res.setHeader('Retry-After', '1');
        throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still in progress');
      }
      if (stored.request_hash !== hash || stored.request_method !== req.method || stored.request_path !== path) {
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request',
        );
      }
      idempotentReplays.inc();
      res.setHeader('Idempotent-Replayed', 'true');
      if (stored.response_location) res.location(stored.response_location);
      res.status(stored.response_status!).json(stored.response_body);
      return;
    }

    // Save the outcome BEFORE the client sees it, so a retry that arrives right after the
    // response is guaranteed to find a completed key.
    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      const keep = status < 500 && status !== 400 && status !== 429;
      const save = keep
        ? pool.query(
            `UPDATE idempotency_keys
                SET status = 'completed', response_status = $3, response_body = $4, response_location = $5,
                    completed_at = now()
              WHERE user_id = $1 AND key = $2`,
            [userId, key, status, JSON.stringify(body), res.getHeader('location') ?? null],
          )
        : pool.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2', [userId, key]);
      save
        .catch((err: unknown) => logger.error({ err, key }, 'Could not save idempotency result'))
        .finally(() => send(body));
      return res;
    };
    next();
  };
}
