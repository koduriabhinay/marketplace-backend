import express from 'express';
import request from 'supertest';
import { createApp } from '../../src/app';
import { errorHandler } from '../../src/middleware/errorHandler';
import { requestTimeout } from '../../src/middleware/requestTimeout';
import { testClient } from '../helpers';

describe('Platform behaviour', () => {
  it('serves /health', async () => {
    const res = await testClient().get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('reports /ready based on dependency checks', async () => {
    await testClient({ readinessChecks: [{ name: 'db', check: async () => {} }] })
      .get('/ready')
      .expect(200);

    const res = await testClient({
      readinessChecks: [{ name: 'db', check: async () => { throw new Error('down'); } }],
    })
      .get('/ready')
      .expect(503);
    expect(res.body.checks).toEqual([{ name: 'db', ok: false }]);
  });

  it('fails /ready while shutting down', async () => {
    await testClient({ isShuttingDown: () => true }).get('/ready').expect(503);
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await testClient().get('/api/v1/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await testClient()
      .post('/api/v1/sellers')
      .set('content-type', 'application/json')
      .send('{"name":')
      .expect(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });

  it('returns 413 for oversized bodies', async () => {
    const res = await testClient()
      .post('/api/v1/sellers')
      .send({ name: 'x'.repeat(200_000), email: 'a@example.com' })
      .expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('echoes an incoming request id, or generates one', async () => {
    const echoed = await testClient().get('/health').set('x-request-id', 'abc-123');
    expect(echoed.headers['x-request-id']).toBe('abc-123');
    const generated = await testClient().get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers and hides the framework', async () => {
    const res = await testClient().get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('hides internal error details behind a generic 500', async () => {
    const app = express();
    app.get('/boom', () => {
      throw new Error('secret database password in message');
    });
    app.use(errorHandler);
    const res = await request(app).get('/boom').expect(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('answers 503 when a handler is too slow', async () => {
    const app = express();
    app.use(requestTimeout(20));
    app.get('/slow', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 60));
      if (!res.headersSent) res.json({ late: true });
    });
    const res = await request(app).get('/slow').expect(503);
    expect(res.body.error.code).toBe('REQUEST_TIMEOUT');
  });

  it('builds an app with default dependencies', () => {
    expect(createApp()).toBeDefined();
  });
});
