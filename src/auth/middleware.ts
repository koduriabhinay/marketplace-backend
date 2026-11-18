import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../lib/errors';
import { verifyAccessToken } from './tokens';
import type { Role } from './types';

/**
 * Reads "Authorization: Bearer <token>". Access tokens travel in a header, never a cookie,
 * so a malicious site can't make the browser send them automatically: that keeps every
 * API route immune to CSRF by design. (The website's refresh-token cookie is only sent to
 * /auth/refresh and /auth/logout, which have their own CSRF checks: see auth/cookies.ts.)
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new UnauthorizedError();
  req.user = verifyAccessToken(header.slice('Bearer '.length).trim());
  next();
};

/** Role-based access control: the user must hold one of the listed roles. */
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) throw new UnauthorizedError();
    if (!roles.includes(req.user.role)) throw new ForbiddenError();
    next();
  };
