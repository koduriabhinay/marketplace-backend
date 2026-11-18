import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decrypt, encrypt } from '../../src/auth/encryption';
import { signAccessToken, signMfaToken, verifyAccessToken, verifyMfaToken } from '../../src/auth/tokens';
import { loadEnv } from '../../src/config/env';
import { base32Decode, base32Encode, checkTotp, currentStep, newTotpSecret, totpAt, totpUri } from '../../src/auth/totp';
import { LocalImageStorage, sniffImageType } from '../../src/storage/imageStorage';

describe('encryption at rest', () => {
  it('round-trips and uses a fresh IV every time', () => {
    const a = encrypt('JBSWY3DPEHPK3PXP');
    const b = encrypt('JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detects tampering', () => {
    const [iv, tag, data] = encrypt('secret').split('.');
    const flipped = Buffer.from(data!, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decrypt([iv, tag, flipped.toString('base64')].join('.'))).toThrow();
    expect(() => decrypt('garbage')).toThrow(/Malformed/);
  });
});

describe('tokens', () => {
  const user = { id: 'u1', role: 'seller' as const, sellerId: 's1', customerId: null };

  it('access and MFA tokens are not interchangeable', () => {
    expect(verifyAccessToken(signAccessToken(user))).toEqual(user);
    expect(verifyMfaToken(signMfaToken('u1'))).toBe('u1');
    expect(() => verifyAccessToken(signMfaToken('u1'))).toThrow(/access token/);
    expect(() => verifyMfaToken(signAccessToken(user))).toThrow(/MFA token/);
  });
});

describe('secrets configuration', () => {
  it('refuses to start in production with development secrets', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET, ENCRYPTION_KEY must be set in production/);
  });

  it('reads secrets from *_FILE paths (Docker/Kubernetes secrets)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
    writeFileSync(path.join(dir, 'jwt'), 'a'.repeat(48) + '\n');
    writeFileSync(path.join(dir, 'key'), 'b'.repeat(64));
    const env = loadEnv({
      NODE_ENV: 'production',
      JWT_SECRET_FILE: path.join(dir, 'jwt'),
      ENCRYPTION_KEY_FILE: path.join(dir, 'key'),
    });
    expect(env.JWT_SECRET).toBe('a'.repeat(48));
    expect(env.ENCRYPTION_KEY).toBe('b'.repeat(64));
  });

  it('validates secret strength and parses CORS origins', () => {
    expect(() => loadEnv({ JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ ENCRYPTION_KEY: 'xyz' })).toThrow(/ENCRYPTION_KEY/);
    expect(loadEnv({ CORS_ORIGINS: 'https://a.com, https://b.com' }).CORS_ORIGINS).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });
});

describe('image storage', () => {
  it('sniffs types from magic bytes and rejects everything else', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))?.type).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImageType(Buffer.from('%PDF-1.7 ....'))).toBeNull();
  });

  it('refuses storage keys that could escape the upload folder', async () => {
    const storage = new LocalImageStorage(mkdtempSync(path.join(os.tmpdir(), 'up-')));
    await expect(storage.save('../../etc/passwd', Buffer.from('x'))).rejects.toThrow(/Invalid storage key/);
    await expect(storage.remove('../x')).rejects.toThrow(/Invalid storage key/);
  });
});

describe('TOTP (RFC 6238)', () => {
  // Official RFC 6238 Appendix B test vectors for SHA-1 (8 digits there; we use the last 6).
  const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC test vector at t=%i', (t, code) => {
    expect(totpAt(RFC_SECRET, Math.floor(t / 30))).toBe(code);
  });

  it('accepts one step of clock drift either way, and nothing further', () => {
    const secret = newTotpSecret();
    const now = Date.now();
    const step = currentStep(now);
    expect(checkTotp(secret, totpAt(secret, step), now)).toBe(step);
    expect(checkTotp(secret, totpAt(secret, step - 1), now)).toBe(step - 1);
    expect(checkTotp(secret, totpAt(secret, step + 1), now)).toBe(step + 1);
    expect(checkTotp(secret, totpAt(secret, step + 2), now)).toBeNull();
    expect(checkTotp(secret, '12345', now)).toBeNull();
  });

  it('round-trips base32 and rejects invalid characters', () => {
    const buf = Buffer.from('hello world, totp');
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(() => base32Decode('abc1')).toThrow(/base32/);
    expect(totpUri('ABC', 'a@b.com')).toBe(
      'otpauth://totp/Marketplace:a%40b.com?secret=ABC&issuer=Marketplace&algorithm=SHA1&digits=6&period=30',
    );
  });
});
