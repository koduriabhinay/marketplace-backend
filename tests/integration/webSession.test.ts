import { PASSWORD, asSeller, createListing, testClient, uniqueEmail, type Client } from '../helpers';

/** What the website sends: cookie transport, from its own origin. */
const WEB = { 'X-Auth-Transport': 'cookie', 'Sec-Fetch-Site': 'same-origin' };

/** The Set-Cookie line for the refresh cookie, and the value to send back. */
function refreshCookieOf(res: { headers: Record<string, unknown> }) {
  const lines = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const line = lines.find((l) => l.startsWith('mp_refresh='));
  return { line, cookie: line?.split(';')[0] };
}

async function webRegister(client: Client) {
  const res = await client
    .post('/api/v1/auth/register')
    .set(WEB)
    .send({ email: uniqueEmail('web'), password: PASSWORD, name: 'Web Shopper', role: 'customer' })
    .expect(201);
  return { res, ...refreshCookieOf(res) };
}

describe('Website sessions: refresh token in an httpOnly cookie', () => {
  it('sets a locked-down cookie and keeps the refresh token out of the body', async () => {
    const { res, line } = await webRegister(testClient());
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/SameSite=Strict/);
    expect(line).toMatch(/Path=\/api\/v1\/auth/);
    expect(line).toMatch(/Max-Age=2592000/);
  });

  it('API clients are unchanged: token in the body, no cookie', async () => {
    const res = await testClient()
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('api'), password: PASSWORD, name: 'Api Client', role: 'customer' })
      .expect(201);
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
    expect(refreshCookieOf(res).line).toBeUndefined();
  });

  it('refreshes from the cookie, rotates it, and detects reuse of the old one', async () => {
    const client = testClient();
    const first = await webRegister(client);

    const refreshed = await client.post('/api/v1/auth/refresh').set(WEB).set('Cookie', first.cookie!).expect(200);
    expect(refreshed.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshed.body.data.refreshToken).toBeUndefined();
    const second = refreshCookieOf(refreshed);
    expect(second.cookie).not.toBe(first.cookie);

    // Replaying the old cookie is token theft: the session dies and the cookie is cleared.
    const reuse = await client.post('/api/v1/auth/refresh').set(WEB).set('Cookie', first.cookie!).expect(401);
    expect(reuse.body.error.message).toMatch(/reuse/);
    expect(refreshCookieOf(reuse).line).toMatch(/Expires=Thu, 01 Jan 1970/);
    await client.post('/api/v1/auth/refresh').set(WEB).set('Cookie', second.cookie!).expect(401);
  });

  it('logs in and verifies the session via the cookie, then logout clears it', async () => {
    const client = testClient();
    const email = uniqueEmail('web');
    await client.post('/api/v1/auth/register').send({ email, password: PASSWORD, name: 'Web User', role: 'seller' }).expect(201);

    const login = await client.post('/api/v1/auth/login').set(WEB).send({ email, password: PASSWORD }).expect(200);
    expect(login.body.data.refreshToken).toBeUndefined();
    const { cookie } = refreshCookieOf(login);

    const out = await client.post('/api/v1/auth/logout').set(WEB).set('Cookie', cookie!).expect(204);
    expect(refreshCookieOf(out).line).toMatch(/Expires=Thu, 01 Jan 1970/);
    await client.post('/api/v1/auth/refresh').set(WEB).set('Cookie', cookie!).expect(401);
    // Logging out with no session is still fine (idempotent).
    await client.post('/api/v1/auth/logout').set(WEB).expect(204);
  });

  it('refuses cookie requests from other sites (CSRF)', async () => {
    const client = testClient();
    const { cookie } = await webRegister(client);
    await client
      .post('/api/v1/auth/refresh')
      .set({ 'X-Auth-Transport': 'cookie', 'Sec-Fetch-Site': 'cross-site' })
      .set('Cookie', cookie!)
      .expect(403);
    await client
      .post('/api/v1/auth/refresh')
      .set({ 'X-Auth-Transport': 'cookie', Origin: 'https://evil.example' })
      .set('Cookie', cookie!)
      .expect(403);
    // Without the custom header the cookie is ignored entirely: a body token is required.
    await client.post('/api/v1/auth/refresh').set('Cookie', cookie!).send({}).expect(400);
  });

  it("a first visit with no cookie gets 401 without using up the failed-login budget", async () => {
    const client = testClient({ rateLimits: { authMax: 2 } });
    for (let i = 0; i < 5; i++) {
      const res = await client.post('/api/v1/auth/refresh').set(WEB).expect(401);
      expect(res.body.error.message).toBe('No active session');
    }
    const login = await client.post('/api/v1/auth/login').send({ email: uniqueEmail('nobody'), password: 'wrong' });
    expect(login.status).toBe(401); // not 429: the cookie-less refreshes weren't counted
  });

  it('rejects a body token in cookie mode (one transport per request)', async () => {
    const client = testClient();
    const { cookie } = await webRegister(client);
    await client
      .post('/api/v1/auth/refresh')
      .set(WEB)
      .set('Cookie', cookie!)
      .send({ refreshToken: 'x'.repeat(40) })
      .expect(400);
  });
});

describe('Listing thumbnails (primaryImageUrl)', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

  it('is null without images, then the first upload, also in cached catalog pages', async () => {
    const client = testClient();
    const seller = await asSeller(client);
    const listing = await createListing(client, seller);
    expect(listing.primaryImageUrl).toBeNull();

    // Warm the cache, then upload: the cached copies must not keep the old thumbnail.
    await client.get(`/api/v1/listings/${listing.id}`).expect(200);
    await client.get('/api/v1/listings').query({ sellerId: seller.sellerId }).expect(200);

    const first = await client
      .post(`/api/v1/listings/${listing.id}/images`)
      .set('Authorization', seller.auth)
      .attach('image', PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(201);
    await client
      .post(`/api/v1/listings/${listing.id}/images`)
      .set('Authorization', seller.auth)
      .attach('image', PNG, { filename: 'b.png', contentType: 'image/png' })
      .expect(201);

    const one = await client.get(`/api/v1/listings/${listing.id}`).expect(200);
    expect(one.body.data.primaryImageUrl).toBe(first.body.data.url);
    const page = await client.get('/api/v1/listings').query({ sellerId: seller.sellerId }).expect(200);
    expect(page.body.data[0].primaryImageUrl).toBe(first.body.data.url);
  });
});
