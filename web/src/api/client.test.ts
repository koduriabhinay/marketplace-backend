import { api, ApiError, NetworkError, session } from './client';
import { json, mockApi } from '../test/utils';

afterEach(() => session.clear());

describe('api client', () => {
  it('asks for cookie transport and sends the bearer token', async () => {
    const { calls } = mockApi({ 'GET /auth/me': () => json(200, { data: { id: 'u1' } }) });
    session.start('token-1');
    await api('/auth/me');
    expect(calls[0]!.headers['x-auth-transport']).toBe('cookie');
    expect(calls[0]!.headers.authorization).toBe('Bearer token-1');
  });

  it('refreshes once on 401, shared by concurrent requests, then retries', async () => {
    let refreshes = 0;
    const { calls } = mockApi({
      'GET /orders': (c) => (c.headers.authorization === 'Bearer fresh' ? json(200, { data: [] }) : json(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } })),
      'POST /auth/refresh': () => {
        refreshes++;
        return json(200, { data: { accessToken: 'fresh', tokenType: 'Bearer', expiresIn: 900 } });
      },
    });
    session.start('stale');
    await Promise.all([api('/orders'), api('/orders'), api('/orders')]);
    expect(refreshes).toBe(1);
    expect(session.token).toBe('fresh');
    expect(calls.filter((c) => c.path === '/auth/refresh')[0]!.headers.authorization).toBeUndefined();
  });

  it('ends the session when the refresh fails', async () => {
    mockApi({
      'GET /orders': () => json(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } }),
      'POST /auth/refresh': () => json(401, { error: { code: 'UNAUTHORIZED', message: 'reuse detected' } }),
    });
    const ended = vi.fn();
    session.onEnded(ended);
    session.start('stale');
    await expect(api('/orders')).rejects.toMatchObject({ status: 401 });
    expect(ended).toHaveBeenCalled();
    expect(session.token).toBeNull();
    expect(session.mightExist).toBe(false);
    session.onEnded(null);
  });

  it('turns error bodies into ApiError with field errors and the request ID', async () => {
    mockApi({
      'POST /listings': () =>
        json(400, {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: [{ path: 'title', message: 'Too short' }],
            requestId: 'req-42',
          },
        }),
    });
    const err = await api('/listings', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).fieldErrors()).toEqual({ title: 'Too short' });
    expect((err as ApiError).requestId).toBe('req-42');
  });

  it('reports a failed connection as a NetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api('/listings')).rejects.toBeInstanceOf(NetworkError);
  });
});
