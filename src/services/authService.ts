import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { env } from '../config/env';
import { decrypt, encrypt } from '../auth/encryption';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/passwords';
import { generateRefreshToken, hashToken, signAccessToken, signMfaToken, verifyMfaToken } from '../auth/tokens';
import { checkTotp, newTotpSecret, totpUri } from '../auth/totp';
import type { AuthUser } from '../auth/types';
import { PG, pgCode, withTransaction } from '../db/pool';
import { ConflictError, UnauthorizedError, UnprocessableError } from '../lib/errors';
import { PgRefreshTokenRepository } from '../repositories/postgres/refreshTokens';
import { PgUserRepository, type UserRecord } from '../repositories/postgres/users';
import type { LoginInput, RegisterInput } from '../schemas/auth';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export type LoginResult = TokenPair | { mfaRequired: true; mfaToken: string };

const INVALID_LOGIN = 'Invalid email or password';

const toAuthUser = (u: UserRecord): AuthUser => ({
  id: u.id,
  role: u.role,
  sellerId: u.sellerId,
  customerId: u.customerId,
});

/** What the API returns about the logged-in user: never the hash or the TOTP secret. */
export const publicUser = (u: UserRecord) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  sellerId: u.sellerId,
  customerId: u.customerId,
  twoFactorEnabled: u.totpEnabled,
  createdAt: u.createdAt,
});

export class AuthService {
  private readonly users: PgUserRepository;
  private readonly tokens: PgRefreshTokenRepository;

  constructor(private readonly pool: Pool) {
    this.users = new PgUserRepository(pool);
    this.tokens = new PgRefreshTokenRepository(pool);
  }

  async register(input: RegisterInput) {
    try {
      const user = await this.users.registerWithProfile({
        userId: randomUUID(),
        profileId: randomUUID(),
        name: input.name,
        email: input.email,
        passwordHash: await hashPassword(input.password),
        role: input.role,
      });
      return { user: publicUser(user), ...(await this.issueTokens(user, randomUUID())) };
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE_VIOLATION) throw new ConflictError('An account with this email already exists');
      throw err;
    }
  }

  /** Used by the create-admin CLI and tests; admins are never self-registered over HTTP. */
  async createAdmin(email: string, password: string) {
    const user = await this.users.registerWithProfile({
      userId: randomUUID(),
      profileId: randomUUID(),
      name: 'Administrator',
      email: email.toLowerCase(),
      passwordHash: await hashPassword(password),
      role: 'admin',
    });
    return publicUser(user);
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const user = await this.users.findByEmail(input.email);
    // Always run bcrypt, even for unknown emails, and give one generic error for both
    // cases, so neither timing nor wording reveals which emails have accounts.
    const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedError(INVALID_LOGIN);

    if (user.totpEnabled) return { mfaRequired: true, mfaToken: signMfaToken(user.id) };
    return this.issueTokens(user, randomUUID());
  }

  async verifyMfa(mfaToken: string, code: string) {
    const user = await this.users.findById(verifyMfaToken(mfaToken));
    if (!user?.totpEnabled || !user.totpSecretEnc) throw new UnauthorizedError('Invalid or expired MFA token');
    await this.consumeCode(user, code);
    return this.issueTokens(user, randomUUID());
  }

  /**
   * Refresh token rotation with reuse detection:
   *  - each refresh token works once and is replaced by a new one;
   *  - if an already-used token shows up again, someone copied it (the real user or the
   *    attacker already rotated it), so the whole login "family" is revoked and both
   *    parties must log in again.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const outcome = await withTransaction(this.pool, async (client) => {
      const record = await this.tokens.findByHashForUpdate(client, hashToken(refreshToken));
      if (!record) return { error: 'Invalid refresh token' } as const;
      if (record.revokedAt) {
        await this.tokens.revokeFamily(record.familyId, client);
        return { error: 'Refresh token reuse detected; please log in again' } as const;
      }
      if (record.expiresAt.getTime() <= Date.now()) return { error: 'Refresh token expired' } as const;

      const user = await this.users.findById(record.userId, client);
      if (!user) return { error: 'Invalid refresh token' } as const;

      const next = this.newRefreshToken(user.id, record.familyId);
      await this.tokens.insert(next.row, client);
      await this.tokens.markReplaced(client, record.id, next.row.id);
      return { pair: this.pair(user, next.token) } as const;
    });
    // Thrown after COMMIT so the family revocation above is saved, not rolled back.
    if ('error' in outcome) throw new UnauthorizedError(outcome.error);
    return outcome.pair;
  }

  /** Logout revokes the whole session family; the short-lived access token just expires. */
  async logout(refreshToken: string) {
    await withTransaction(this.pool, async (client) => {
      const record = await this.tokens.findByHashForUpdate(client, hashToken(refreshToken));
      if (record) await this.tokens.revokeFamily(record.familyId, client);
    });
  }

  async me(userId: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedError();
    return publicUser(user);
  }

  /** Step 1: create a secret. The user scans the QR/URI in an authenticator app. */
  async setupTotp(userId: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedError();
    if (user.totpEnabled) throw new ConflictError('Two-factor authentication is already enabled');
    const secret = newTotpSecret();
    await this.users.setTotpSecret(user.id, encrypt(secret));
    return { secret, otpauthUri: totpUri(secret, user.email) };
  }

  /** Step 2: prove the app works by sending a current code; only then is 2FA switched on. */
  async enableTotp(userId: string, code: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedError();
    if (user.totpEnabled) throw new ConflictError('Two-factor authentication is already enabled');
    if (!user.totpSecretEnc) throw new UnprocessableError('Start setup first with POST /auth/2fa/setup');
    await this.consumeCode(user, code);
    await this.users.setTotpEnabled(user.id, true);
    // Security-sensitive change: sign out every other session.
    await this.tokens.revokeAllForUser(user.id);
    return this.issueTokens(user, randomUUID());
  }

  async disableTotp(userId: string, code: string) {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedError();
    if (!user.totpEnabled) throw new ConflictError('Two-factor authentication is not enabled');
    await this.consumeCode(user, code);
    await this.users.setTotpEnabled(user.id, false);
  }

  private async consumeCode(user: UserRecord, code: string) {
    const step = checkTotp(decrypt(user.totpSecretEnc!), code);
    if (step === null || !(await this.users.consumeTotpStep(user.id, step))) {
      throw new UnauthorizedError('Invalid or already used code');
    }
  }

  private newRefreshToken(userId: string, familyId: string) {
    const token = generateRefreshToken();
    return {
      token,
      row: {
        id: randomUUID(),
        userId,
        familyId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      },
    };
  }

  private async issueTokens(user: UserRecord, familyId: string): Promise<TokenPair> {
    const next = this.newRefreshToken(user.id, familyId);
    await this.tokens.insert(next.row);
    return this.pair(user, next.token);
  }

  private pair(user: UserRecord, refreshToken: string): TokenPair {
    return {
      accessToken: signAccessToken(toAuthUser(user)),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    };
  }
}
