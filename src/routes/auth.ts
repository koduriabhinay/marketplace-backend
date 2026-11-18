import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  assertSameOrigin,
  clearRefreshCookie,
  cookieSessionPrecheck,
  deliverTokens,
  refreshCookie,
  usesCookie,
} from '../auth/cookies';
import { authenticate } from '../auth/middleware';
import { parse } from '../lib/validate';
import { codeSchema, loginSchema, mfaVerifySchema, refreshSchema, registerSchema } from '../schemas/auth';
import type { AuthService } from '../services/authService';

export interface AuthLimiters {
  /** Counts every attempt: stops mass account creation. */
  register: RequestHandler;
  /** Counts only failures: stops password and 2FA-code guessing without punishing real users. */
  credentials: RequestHandler;
}

/** Cookie mode sends no body (or an empty one): the token comes from the cookie. */
const emptyBody = z.strictObject({}).optional();

export function authRouter(service: AuthService, limiters: AuthLimiters, allowedOrigins: string[] = []) {
  const router = Router();

  /** The refresh token from the body (API clients) or the cookie (the website). */
  const presentedRefreshToken = (req: Request): string | undefined => {
    if (!usesCookie(req)) return parse(refreshSchema, req.body).refreshToken;
    assertSameOrigin(req, allowedOrigins);
    parse(emptyBody, req.body);
    return refreshCookie(req);
  };

  router.post('/register', limiters.register, async (req, res) => {
    res.status(201).json({ data: deliverTokens(req, res, await service.register(parse(registerSchema, req.body))) });
  });

  router.post('/login', limiters.credentials, async (req, res) => {
    res.json({ data: deliverTokens(req, res, await service.login(parse(loginSchema, req.body))) });
  });

  router.post('/2fa/verify', limiters.credentials, async (req, res) => {
    const { mfaToken, code } = parse(mfaVerifySchema, req.body);
    res.json({ data: deliverTokens(req, res, await service.verifyMfa(mfaToken, code)) });
  });

  router.post('/refresh', cookieSessionPrecheck(allowedOrigins), limiters.credentials, async (req, res) => {
    const token = presentedRefreshToken(req)!; // cookie presence checked by the precheck
    try {
      res.json({ data: deliverTokens(req, res, await service.refresh(token)) });
    } catch (err) {
      // A dead session cookie is useless to keep: drop it so the browser stops sending it.
      if (usesCookie(req)) clearRefreshCookie(res);
      throw err;
    }
  });

  router.post('/logout', async (req, res) => {
    const token = presentedRefreshToken(req);
    if (token) await service.logout(token);
    if (usesCookie(req)) clearRefreshCookie(res);
    res.status(204).end();
  });

  router.get('/me', authenticate, async (req, res) => {
    res.json({ data: await service.me(req.user!.id) });
  });

  router.post('/2fa/setup', authenticate, async (req, res) => {
    res.json({ data: await service.setupTotp(req.user!.id) });
  });

  router.post('/2fa/enable', authenticate, limiters.credentials, async (req, res) => {
    res.json({ data: deliverTokens(req, res, await service.enableTotp(req.user!.id, parse(codeSchema, req.body).code)) });
  });

  router.post('/2fa/disable', authenticate, limiters.credentials, async (req, res) => {
    await service.disableTotp(req.user!.id, parse(codeSchema, req.body).code);
    res.status(204).end();
  });

  return router;
}
