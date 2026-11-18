import { Router, type RequestHandler } from 'express';
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

export function authRouter(service: AuthService, limiters: AuthLimiters) {
  const router = Router();

  router.post('/register', limiters.register, async (req, res) => {
    res.status(201).json({ data: await service.register(parse(registerSchema, req.body)) });
  });

  router.post('/login', limiters.credentials, async (req, res) => {
    res.json({ data: await service.login(parse(loginSchema, req.body)) });
  });

  router.post('/2fa/verify', limiters.credentials, async (req, res) => {
    const { mfaToken, code } = parse(mfaVerifySchema, req.body);
    res.json({ data: await service.verifyMfa(mfaToken, code) });
  });

  router.post('/refresh', limiters.credentials, async (req, res) => {
    res.json({ data: await service.refresh(parse(refreshSchema, req.body).refreshToken) });
  });

  router.post('/logout', async (req, res) => {
    await service.logout(parse(refreshSchema, req.body).refreshToken);
    res.status(204).end();
  });

  router.get('/me', authenticate, async (req, res) => {
    res.json({ data: await service.me(req.user!.id) });
  });

  router.post('/2fa/setup', authenticate, async (req, res) => {
    res.json({ data: await service.setupTotp(req.user!.id) });
  });

  router.post('/2fa/enable', authenticate, limiters.credentials, async (req, res) => {
    res.json({ data: await service.enableTotp(req.user!.id, parse(codeSchema, req.body).code) });
  });

  router.post('/2fa/disable', authenticate, limiters.credentials, async (req, res) => {
    await service.disableTotp(req.user!.id, parse(codeSchema, req.body).code);
    res.status(204).end();
  });

  return router;
}
