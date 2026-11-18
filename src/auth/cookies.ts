import type { Request, RequestHandler, Response } from 'express';
import { env } from '../config/env';
import { ForbiddenError, UnauthorizedError } from '../lib/errors';

/**
 * Refresh tokens for the website live in a cookie the page's JavaScript can't read.
 *
 * API clients (mobile apps, scripts, tests) keep using the JSON body as before. A browser
 * opts in by sending `X-Auth-Transport: cookie`; then the refresh token is set as a cookie
 * and left out of the response body, so an XSS bug can steal at most a 15-minute access
 * token that lives in memory, never the 30-day refresh token.
 *
 *  - HttpOnly:        JavaScript can't read it.
 *  - Secure:          only sent over HTTPS (production).
 *  - SameSite=Strict: never sent on requests started by another site (CSRF).
 *  - Path:            only sent to the auth endpoints, not with every API call or image.
 */
export const REFRESH_COOKIE = 'mp_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
export const AUTH_TRANSPORT_HEADER = 'x-auth-transport';

export const usesCookie = (req: Request) => req.get(AUTH_TRANSPORT_HEADER) === 'cookie';

/** Minimal Cookie header parser (RFC 6265 pairs); we only ever read one cookie. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const raw of header.split(';')) {
    const part = raw.trim();
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

export const refreshCookie = (req: Request): string | undefined => parseCookies(req.headers.cookie)[REFRESH_COOKIE];

export function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  });
}

/**
 * A cookie is sent automatically by the browser, so a request that relies on it must
 * prove it comes from our own pages (CSRF defence in depth on top of SameSite=Strict):
 *  - it carries the custom X-Auth-Transport header, which a cross-site form or image
 *    can't set, and a cross-site fetch can't send without a CORS preflight we'd refuse;
 *  - Sec-Fetch-Site (set by the browser, unforgeable by page script) must be same-origin;
 *  - otherwise, the Origin header must be our own host or an allowed CORS origin.
 */
export function assertSameOrigin(req: Request, allowedOrigins: string[]) {
  const site = req.get('sec-fetch-site');
  if (site !== undefined) {
    if (site !== 'same-origin') throw new ForbiddenError('Cross-site request refused');
    return;
  }
  const origin = req.get('origin');
  if (origin === undefined) return; // not a browser: nothing can be forged on its behalf
  // req.host is X-Forwarded-Host behind our trusted proxy (host:port as the browser saw it).
  const own = `${req.protocol}://${req.host}`;
  if (origin !== own && !allowedOrigins.includes(origin)) throw new ForbiddenError('Cross-site request refused');
}

/**
 * Runs before the credentials rate limiter on /refresh: a browser with no session cookie
 * (a first visit) has presented no credential, so it gets a 401 without using up the
 * failed-attempt budget meant for stopping token guessing.
 */
export const cookieSessionPrecheck =
  (allowedOrigins: string[]): RequestHandler =>
  (req, _res, next) => {
    if (usesCookie(req)) {
      assertSameOrigin(req, allowedOrigins);
      if (!refreshCookie(req)) throw new UnauthorizedError('No active session');
    }
    next();
  };

/** In cookie mode: move the refresh token from the body into the cookie. */
export function deliverTokens<T extends object>(req: Request, res: Response, result: T) {
  if (!usesCookie(req) || !('refreshToken' in result) || typeof result.refreshToken !== 'string') return result;
  setRefreshCookie(res, result.refreshToken);
  const rest: Record<string, unknown> = { ...result };
  delete rest.refreshToken;
  return rest as Omit<T, 'refreshToken'>;
}
