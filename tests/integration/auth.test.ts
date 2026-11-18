import jwt from 'jsonwebtoken';
import { currentStep, totpAt } from '../../src/auth/totp';
import { testPool } from '../db';
import { PASSWORD, asCustomer, asSeller, testClient, uniqueEmail, type Client } from '../helpers';

const bearer = (t: string) => `Bearer ${t}`;

/** A TOTP code for the step AFTER the current one: still accepted (clock-drift window), and never a replay of a code used a moment ago. */
const nextCode = (secret: string) => totpAt(secret, currentStep() + 1);
const currentCode = (secret: string) => totpAt(secret, currentStep());

async function enable2fa(client: Client, token: string) {
  const setup = await client.post('/api/v1/auth/2fa/setup').set('Authorization', bearer(token)).expect(200);
  const { secret, otpauthUri } = setup.body.data;
  expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/Marketplace:/);
  const enabled = await client
    .post('/api/v1/auth/2fa/enable')
    .set('Authorization', bearer(token))
    .send({ code: currentCode(secret) })
    .expect(200);
  return { secret: secret as string, tokens: enabled.body.data };
}

describe('Auth: registration and login', () => {
  it('registers, returns tokens, and never exposes the password hash', async () => {
    const client = testClient();
    const res = await client
      .post('/api/v1/auth/register')
      .send({ email: 'New@Example.com', password: PASSWORD, name: 'New Shop', role: 'seller' })
      .expect(201);

    const { user, accessToken, refreshToken, tokenType, expiresIn } = res.body.data;
    expect(user).toMatchObject({ email: 'new@example.com', role: 'seller', twoFactorEnabled: false });
    expect(user.sellerId).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
    expect({ tokenType, expiresIn }).toEqual({ tokenType: 'Bearer', expiresIn: 900 });
    expect(refreshToken).toEqual(expect.any(String));

    const me = await client.get('/api/v1/auth/me').set('Authorization', bearer(accessToken)).expect(200);
    expect(me.body.data.id).toBe(user.id);

    const { rows } = await testPool().query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/); // bcrypt, not plain text
  });

  it('rejects weak passwords, duplicate emails and admin self-registration', async () => {
    const client = testClient();
    const base = { email: uniqueEmail('x'), name: 'Some Name', role: 'customer' };
    await client.post('/api/v1/auth/register').send({ ...base, password: 'short' }).expect(400);
    await client.post('/api/v1/auth/register').send({ ...base, password: 'é'.repeat(40) }).expect(400); // > 72 bytes
    await client.post('/api/v1/auth/register').send({ ...base, password: PASSWORD, role: 'admin' }).expect(400);

    await client.post('/api/v1/auth/register').send({ ...base, password: PASSWORD }).expect(201);
    const dup = await client
      .post('/api/v1/auth/register')
      .send({ ...base, email: base.email.toUpperCase(), password: PASSWORD })
      .expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('logs in with the right password and gives one generic error otherwise', async () => {
    const client = testClient();
    const user = await asCustomer(client);

    const ok = await client.post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
    expect(ok.body.data.accessToken).toEqual(expect.any(String));

    const wrongPassword = await client
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'not the password at all' })
      .expect(401);
    const unknownEmail = await client
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: PASSWORD })
      .expect(401);
    // Same message either way: the endpoint can't be used to discover registered emails.
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });
});

describe('Auth: access tokens', () => {
  it('rejects missing, malformed, tampered, expired and wrong-algorithm tokens', async () => {
    const client = testClient();
    const user = await asCustomer(client);
    const me = (header?: string) => {
      const req = client.get('/api/v1/auth/me');
      return header ? req.set('Authorization', header) : req;
    };

    await me().expect(401);
    await me('Basic abc').expect(401);
    await me(bearer('not.a.jwt')).expect(401);

    const [h, p, s] = user.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), role: 'admin' }))
      .toString('base64url');
    await me(bearer(`${h}.${forged}.${s}`)).expect(401); // signature no longer matches

    const expired = jwt.sign({ role: 'customer' }, process.env.JWT_SECRET ?? 'dev-only-jwt-secret-change-me-0123456789abcdef', {
      subject: user.userId,
      issuer: 'marketplace-api',
      audience: 'access',
      expiresIn: -10,
    });
    await me(bearer(expired)).expect(401);

    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    await me(bearer(none)).expect(401); // "alg: none" attack
  });
});

describe('Auth: refresh tokens', () => {
  it('rotates on every refresh: the old token stops working', async () => {
    const client = testClient();
    const user = await asCustomer(client);

    const r1 = await client.post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken }).expect(200);
    expect(r1.body.data.refreshToken).not.toBe(user.refreshToken);
    await client.get('/api/v1/auth/me').set('Authorization', bearer(r1.body.data.accessToken)).expect(200);

    const r2 = await client.post('/api/v1/auth/refresh').send({ refreshToken: r1.body.data.refreshToken }).expect(200);
    expect(r2.body.data.refreshToken).not.toBe(r1.body.data.refreshToken);
  });

  it('detects reuse of an old refresh token and revokes the whole session family', async () => {
    const client = testClient();
    const user = await asCustomer(client);

    const rotated = await client.post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken }).expect(200);
    // An attacker replays the stolen original token...
    const reuse = await client.post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken }).expect(401);
    expect(reuse.body.error.message).toMatch(/reuse/i);
    // ...and now even the legitimate latest token is dead: everyone must log in again.
    await client.post('/api/v1/auth/refresh').send({ refreshToken: rotated.body.data.refreshToken }).expect(401);
  });

  it('only one of several concurrent refreshes with the same token wins', async () => {
    const client = testClient();
    const user = await asCustomer(client);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('rejects unknown and expired refresh tokens', async () => {
    const client = testClient();
    const user = await asCustomer(client);
    await client.post('/api/v1/auth/refresh').send({ refreshToken: 'x'.repeat(43) }).expect(401);

    await testPool().query("UPDATE refresh_tokens SET expires_at = now() - interval '1 second'");
    const res = await client.post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken }).expect(401);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  it('logout revokes the session; unknown tokens are a quiet no-op', async () => {
    const client = testClient();
    const user = await asCustomer(client);
    await client.post('/api/v1/auth/logout').send({ refreshToken: user.refreshToken }).expect(204);
    await client.post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken }).expect(401);
    await client.post('/api/v1/auth/logout').send({ refreshToken: 'y'.repeat(43) }).expect(204);
  });

  it('stores only a hash of each refresh token', async () => {
    const client = testClient();
    const user = await asCustomer(client);
    const { rows } = await testPool().query<{ token_hash: string }>('SELECT token_hash FROM refresh_tokens');
    expect(rows.map((r) => r.token_hash)).not.toContain(user.refreshToken);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Auth: two-factor authentication', () => {
  it('full flow: setup, enable, then login needs a code', async () => {
    const client = testClient();
    const seller = await asSeller(client);
    const { secret } = await enable2fa(client, seller.token);

    // The secret is encrypted at rest.
    const { rows } = await testPool().query('SELECT totp_secret_enc FROM users WHERE email = $1', [seller.email]);
    expect(rows[0].totp_secret_enc).not.toContain(secret);

    const step1 = await client.post('/api/v1/auth/login').send({ email: seller.email, password: PASSWORD }).expect(200);
    expect(step1.body.data).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    expect(step1.body.data.accessToken).toBeUndefined();

    // The MFA token is not an access token.
    await client.get('/api/v1/auth/me').set('Authorization', bearer(step1.body.data.mfaToken)).expect(401);

    await client
      .post('/api/v1/auth/2fa/verify')
      .send({ mfaToken: step1.body.data.mfaToken, code: '000000' })
      .expect(401);
    const code = nextCode(secret);
    const step2 = await client
      .post('/api/v1/auth/2fa/verify')
      .send({ mfaToken: step1.body.data.mfaToken, code })
      .expect(200);
    expect(step2.body.data.accessToken).toEqual(expect.any(String));

    // Each code works once: replaying it is refused.
    await client.post('/api/v1/auth/2fa/verify').send({ mfaToken: step1.body.data.mfaToken, code }).expect(401);

    const me = await client.get('/api/v1/auth/me').set('Authorization', bearer(step2.body.data.accessToken)).expect(200);
    expect(me.body.data.twoFactorEnabled).toBe(true);
  });

  it('enabling 2FA signs out other sessions', async () => {
    const client = testClient();
    const user = await asCustomer(client);
    await enable2fa(client, user.token);
    await client.post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken }).expect(401);
  });

  it('guards setup/enable/disable state transitions', async () => {
    const client = testClient();
    const user = await asCustomer(client);
    const auth = bearer(user.token);

    await client.post('/api/v1/auth/2fa/enable').set('Authorization', auth).send({ code: '123456' }).expect(422);
    await client.post('/api/v1/auth/2fa/disable').set('Authorization', auth).send({ code: '123456' }).expect(409);
    await client.post('/api/v1/auth/2fa/enable').set('Authorization', auth).send({ code: 'abc' }).expect(400);

    const { secret, tokens } = await enable2fa(client, user.token);
    const fresh = bearer(tokens.accessToken);
    await client.post('/api/v1/auth/2fa/setup').set('Authorization', fresh).expect(409);
    await client.post('/api/v1/auth/2fa/enable').set('Authorization', fresh).send({ code: nextCode(secret) }).expect(409);

    await client.post('/api/v1/auth/2fa/disable').set('Authorization', fresh).send({ code: '000000' }).expect(401);
    await client.post('/api/v1/auth/2fa/disable').set('Authorization', fresh).send({ code: nextCode(secret) }).expect(204);

    const login = await client.post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
    expect(login.body.data.accessToken).toEqual(expect.any(String));
  });

  it('rejects a garbage MFA token', async () => {
    await testClient().post('/api/v1/auth/2fa/verify').send({ mfaToken: 'z'.repeat(40), code: '123456' }).expect(401);
  });
});

describe('Auth: rate limiting', () => {
  it('blocks repeated failed logins with 429, without counting successes', async () => {
    const client = testClient({ rateLimits: { authMax: 3 } });
    const user = await asCustomer(testClient());
    const login = (password: string) => client.post('/api/v1/auth/login').send({ email: user.email, password });

    for (let i = 0; i < 5; i++) await login(PASSWORD).expect(200); // successes don't count
    for (let i = 0; i < 3; i++) await login('wrong password guess').expect(401);
    const blocked = await login(PASSWORD).expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['ratelimit-policy']).toBeDefined();
  });

  it('limits sign-ups and general API traffic per client', async () => {
    const signups = testClient({ rateLimits: { authMax: 2 } });
    for (let i = 0; i < 2; i++) await asCustomer(signups);
    await signups
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('c'), password: PASSWORD, name: 'Third Try', role: 'customer' })
      .expect(429);

    const api = testClient({ rateLimits: { max: 2 } });
    await api.get('/api/v1/listings').expect(200);
    await api.get('/api/v1/listings').expect(200);
    await api.get('/api/v1/listings').expect(429);
    await api.get('/health').expect(200); // health checks are never rate limited
  });
});
