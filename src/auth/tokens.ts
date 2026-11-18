import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { UnauthorizedError } from '../lib/errors';
import type { AuthUser } from './types';

const ALGORITHM = 'HS256';

/**
 * Access tokens are short-lived (15 min) signed JWTs. The API trusts them without a DB
 * lookup, which keeps every instance stateless; the short lifetime limits the damage if
 * one leaks. `aud` separates them from MFA tokens so one can't be used as the other.
 */
export function signAccessToken(user: AuthUser): string {
  return jwt.sign(
    { role: user.role, sellerId: user.sellerId, customerId: user.customerId },
    env.JWT_SECRET,
    {
      algorithm: ALGORITHM,
      subject: user.id,
      issuer: env.JWT_ISSUER,
      audience: 'access',
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    },
  );
}

export function verifyAccessToken(token: string): AuthUser {
  try {
    const p = jwt.verify(token, env.JWT_SECRET, {
      algorithms: [ALGORITHM], // never let the token choose its own algorithm ("alg: none")
      issuer: env.JWT_ISSUER,
      audience: 'access',
    }) as jwt.JwtPayload;
    return {
      id: String(p.sub),
      role: p.role,
      sellerId: p.sellerId ?? null,
      customerId: p.customerId ?? null,
    };
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }
}

/** Issued after a correct password when 2FA is on: proves step one, valid for 5 minutes. */
export function signMfaToken(userId: string): string {
  return jwt.sign({}, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    subject: userId,
    issuer: env.JWT_ISSUER,
    audience: 'mfa',
    expiresIn: 300,
  });
}

export function verifyMfaToken(token: string): string {
  try {
    const p = jwt.verify(token, env.JWT_SECRET, {
      algorithms: [ALGORITHM],
      issuer: env.JWT_ISSUER,
      audience: 'mfa',
    }) as jwt.JwtPayload;
    return String(p.sub);
  } catch {
    throw new UnauthorizedError('Invalid or expired MFA token');
  }
}

/** Refresh tokens are opaque random strings, not JWTs, so they can be revoked server-side. */
export const generateRefreshToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
