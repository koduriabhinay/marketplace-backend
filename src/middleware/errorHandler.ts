import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, NotFoundError } from '../lib/errors';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
};

/**
 * One place turns every error into a consistent JSON shape:
 *   { error: { code, message, details?, requestId } }
 * Expected errors keep their status; anything else is logged in full and returned as a
 * generic 500 so internals (stack traces, SQL) never leak to clients.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = String(req.id ?? '');

  if (err instanceof AppError) {
    if (err.statusCode >= 500) req.log?.error({ err }, err.message);
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
    return;
  }

  // Upload problems from multer: too big is 413, anything else malformed is 400.
  if (err instanceof Error && err.name === 'MulterError') {
    const tooLarge = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_UPLOAD',
        message: tooLarge ? 'File is too large' : err.message,
        requestId,
      },
    });
    return;
  }

  // Malformed JSON and oversized bodies come from express.json() with a status attached.
  const status = (err as { status?: number; type?: string }).status;
  if (status === 400 || status === 413) {
    res.status(status).json({
      error: {
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'MALFORMED_JSON',
        message: status === 413 ? 'Request body is too large' : 'Request body is not valid JSON',
        requestId,
      },
    });
    return;
  }

  req.log?.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId },
  });
};
