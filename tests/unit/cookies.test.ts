import type { Request } from 'express';
import { assertSameOrigin, parseCookies } from '../../src/auth/cookies';

const req = (headers: Record<string, string>, protocol = 'https') =>
  ({ protocol, host: headers.host, get: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;

describe('parseCookies', () => {
  it('reads name=value pairs, decodes values and keeps the first duplicate', () => {
    expect(parseCookies('a=1; mp_refresh=abc%3D%3D; b="quoted"; a=2')).toEqual({ a: '1', mp_refresh: 'abc==', b: 'quoted' });
  });

  it('ignores junk and bad encodings instead of throwing', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('novalue; =x; ok=%E0%A4%A')).toEqual({ ok: '%E0%A4%A' });
  });
});

describe('assertSameOrigin (CSRF check for cookie requests)', () => {
  it('trusts the browser-set Sec-Fetch-Site header first', () => {
    expect(() => assertSameOrigin(req({ 'sec-fetch-site': 'same-origin' }), [])).not.toThrow();
    expect(() => assertSameOrigin(req({ 'sec-fetch-site': 'cross-site' }), [])).toThrow(/Cross-site/);
    expect(() => assertSameOrigin(req({ 'sec-fetch-site': 'same-site' }), [])).toThrow(/Cross-site/);
  });

  it('falls back to Origin, which must be our own host or an allowed origin', () => {
    expect(() => assertSameOrigin(req({ origin: 'https://shop.test', host: 'shop.test' }), [])).not.toThrow();
    expect(() => assertSameOrigin(req({ origin: 'https://evil.test', host: 'shop.test' }), [])).toThrow(/Cross-site/);
    expect(() => assertSameOrigin(req({ origin: 'https://app.test', host: 'api.test' }), ['https://app.test'])).not.toThrow();
  });

  it('lets non-browser clients through (nothing to forge without a browser)', () => {
    expect(() => assertSameOrigin(req({}), [])).not.toThrow();
  });
});
