import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryBroker } from '../../src/messaging/memoryBroker';
import { verifyWebhook } from '../../src/webhooks/signature';
import { createWorker } from '../../src/worker/createWorker';
import { testPool } from '../db';
import { asAdmin, asCustomer, asSeller, createListing, MISSING, testClient, type Actor, type Client } from '../helpers';

/** A fake seller server that records what it receives and answers however we tell it to. */
interface Receiver {
  url: string;
  received: { headers: IncomingHttpHeaders; body: string }[];
  respond: (status: number) => void;
  hang: () => void;
  close: () => Promise<void>;
}

async function startReceiver(): Promise<Receiver> {
  let status = 200;
  let hang = false;
  const received: Receiver['received'] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      if (!hang) res.writeHead(status).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks`,
    received,
    respond: (s) => (status = s),
    hang: () => (hang = true),
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

let receiver: Receiver;
beforeEach(async () => {
  receiver = await startReceiver();
});
afterEach(() => receiver.close());

async function makeWorker(overrides: Partial<Parameters<typeof createWorker>[0]['dispatcher']> = {}) {
  const broker = new MemoryBroker();
  const worker = createWorker({
    pool: testPool(),
    broker,
    outboxPollMs: 10,
    webhookPollMs: 10,
    dispatcher: {
      timeoutMs: 500,
      maxAttempts: 3,
      allowInsecureUrls: true,
      backoff: { baseMs: 1_000, maxMs: 10_000 },
      ...overrides,
    },
  });
  await worker.subscribe();
  return { broker, worker };
}

const registerWebhook = (client: Client, seller: Actor, body: object = {}) =>
  client
    .post(`/api/v1/sellers/${seller.sellerId}/webhooks`)
    .set('Authorization', seller.auth)
    .send({ url: receiver.url, ...body });

async function setup() {
  const client = testClient();
  const seller = await asSeller(client);
  const customer = await asCustomer(client);
  const listing = await createListing(client, seller, { stock: 10, priceCents: 500 });
  const order = () =>
    client
      .post('/api/v1/orders')
      .set('Authorization', customer.auth)
      .send({ items: [{ listingId: listing.id, quantity: 1 }] })
      .expect(201);
  return { client, seller, customer, listing, order };
}

const deliveries = async () =>
  (
    await testPool().query<{ status: string; attempts: number; last_status_code: number | null; last_error: string | null; next_attempt_at: Date }>(
      'SELECT status, attempts, last_status_code, last_error, next_attempt_at FROM webhook_deliveries ORDER BY created_at',
    )
  ).rows;

/** Makes every pending delivery due now, as if the backoff delay had passed. */
const fastForward = () => testPool().query("UPDATE webhook_deliveries SET next_attempt_at = now() WHERE status = 'pending'");

describe('Webhook endpoints API', () => {
  it('a seller registers an endpoint and gets the signing secret exactly once', async () => {
    const { client, seller } = await setup();
    const res = await registerWebhook(client, seller).expect(201);
    expect(res.body.data).toMatchObject({
      sellerId: seller.sellerId,
      url: receiver.url,
      events: ['order.placed', 'order.cancelled'],
      active: true,
    });
    expect(res.body.data.secret).toMatch(/^whsec_/);
    expect(res.headers.location).toBe(`/api/v1/sellers/${seller.sellerId}/webhooks/${res.body.data.id}`);

    const list = await client.get(`/api/v1/sellers/${seller.sellerId}/webhooks`).set('Authorization', seller.auth).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].secret).toBeUndefined();

    const stored = await testPool().query('SELECT secret_enc FROM webhook_endpoints');
    expect(stored.rows[0].secret_enc).not.toContain(res.body.data.secret); // encrypted at rest
  });

  it('only the seller or an admin can manage endpoints', async () => {
    const { client, seller } = await setup();
    const other = await asSeller(client);
    const admin = await asAdmin(client);
    const created = await registerWebhook(client, seller).expect(201);
    const base = `/api/v1/sellers/${seller.sellerId}/webhooks`;

    await client.post(base).send({ url: receiver.url }).expect(401);
    await client.post(base).set('Authorization', other.auth).send({ url: receiver.url }).expect(403);
    await client.get(base).set('Authorization', other.auth).expect(403);
    await client.delete(`${base}/${created.body.data.id}`).set('Authorization', other.auth).expect(403);
    await client.get(base).set('Authorization', admin.auth).expect(200);

    await client.delete(`${base}/${created.body.data.id}`).set('Authorization', seller.auth).expect(204);
    await client.delete(`${base}/${created.body.data.id}`).set('Authorization', seller.auth).expect(404);
  });

  it('validates the URL and events, and caps endpoints per seller', async () => {
    const { client, seller } = await setup();
    await registerWebhook(client, seller, { url: 'ftp://example.com' }).expect(422);
    await registerWebhook(client, seller, { url: 'https://user:pw@example.com/x' }).expect(422);
    await registerWebhook(client, seller, { events: ['order.shipped'] }).expect(400);
    await registerWebhook(client, seller, { events: ['order.placed', 'order.placed'] }).expect(400);

    for (let i = 0; i < 5; i++) await registerWebhook(client, seller).expect(201);
    await registerWebhook(client, seller).expect(409);
  });

  it('requires https when insecure URLs are not allowed (production)', async () => {
    const client = testClient({ allowInsecureWebhooks: false });
    const seller = await asSeller(client);
    const res = await registerWebhook(client, seller).expect(422);
    expect(res.body.error.message).toMatch(/https/);
  });

  it('admins registering for a seller that does not exist get 422', async () => {
    const client = testClient();
    const admin = await asAdmin(client);
    await client.post(`/api/v1/sellers/${MISSING}/webhooks`).set('Authorization', admin.auth).send({ url: receiver.url }).expect(422);
  });
});

describe('Webhook delivery (worker)', () => {
  it('delivers a signed order.placed webhook with only that seller’s items', async () => {
    const { client, seller, order } = await setup();
    const endpoint = await registerWebhook(client, seller).expect(201);

    // A second seller in the same order must not see the first seller's lines.
    const other = await asSeller(client);
    const otherListing = await createListing(client, other, { stock: 3 });
    const customer = await asCustomer(client);
    const placed = await client
      .post('/api/v1/orders')
      .set('Authorization', customer.auth)
      .send({ items: [{ listingId: otherListing.id, quantity: 1 }, { listingId: (await order()).body.data.items[0].listingId, quantity: 2 }] })
      .expect(201);

    const { worker } = await makeWorker();
    expect(await worker.relay.relayOnce()).toBe(2);
    const result = await worker.dispatcher.dispatchDue();
    expect(result).toMatchObject({ succeeded: 2, failed: 0 });

    expect(receiver.received).toHaveLength(2);
    const last = receiver.received.find((r) => JSON.parse(r.body).data.orderId === placed.body.data.id)!;
    const body = JSON.parse(last.body);
    expect(body).toMatchObject({ type: 'order.placed', data: { orderId: placed.body.data.id, status: 'placed' } });
    expect(body.data.items).toHaveLength(1); // only this seller's line
    expect(body.data.totalCents).toBeUndefined();
    expect(last.headers['webhook-id']).toBe(body.id);
    expect(verifyWebhook(endpoint.body.data.secret, last.headers as never, last.body)).toBe(true);

    const log = await client
      .get(`/api/v1/sellers/${seller.sellerId}/webhooks/${endpoint.body.data.id}/deliveries`)
      .set('Authorization', seller.auth)
      .expect(200);
    expect(log.body.pagination.total).toBe(2);
    expect(log.body.data[0]).toMatchObject({ status: 'succeeded', attempts: 1, lastStatusCode: 200, nextAttemptAt: null });
  });

  it('only sends the event types an endpoint subscribed to', async () => {
    const { client, seller, customer, order } = await setup();
    await registerWebhook(client, seller, { events: ['order.cancelled'] }).expect(201);
    const placed = await order();
    await client.post(`/api/v1/orders/${placed.body.data.id}/cancel`).set('Authorization', customer.auth).expect(200);

    const { worker } = await makeWorker();
    await worker.relay.relayOnce();
    await worker.dispatcher.dispatchDue();
    expect(receiver.received.map((r) => JSON.parse(r.body).type)).toEqual(['order.cancelled']);
  });

  it('a redelivered event creates no duplicate webhook (idempotent consumer)', async () => {
    const { client, seller, order } = await setup();
    await registerWebhook(client, seller).expect(201);
    await order();
    const { worker, broker } = await makeWorker();
    await worker.relay.relayOnce();
    expect(await worker.fanout.handle(broker.published[0]!)).toBe(0); // second copy ignored
    expect(await deliveries()).toHaveLength(1);
  });

  it('retries failures with exponential backoff, then gives up (dead)', async () => {
    const { client, seller, order } = await setup();
    await registerWebhook(client, seller).expect(201);
    await order();
    receiver.respond(503);
    const { worker } = await makeWorker({ maxAttempts: 3 });
    await worker.relay.relayOnce();

    const before = Date.now();
    expect(await worker.dispatcher.dispatchDue()).toMatchObject({ failed: 1 });
    let [d] = await deliveries();
    expect(d).toMatchObject({ status: 'pending', attempts: 1, last_status_code: 503, last_error: 'HTTP 503' });
    // First retry is 0.5-1 s out (base 1 s, equal jitter).
    expect(d!.next_attempt_at.getTime() - before).toBeGreaterThanOrEqual(400);
    expect(await worker.dispatcher.dispatchDue()).toMatchObject({ failed: 0, succeeded: 0 }); // not due yet

    await fastForward();
    await worker.dispatcher.dispatchDue();
    await fastForward();
    expect(await worker.dispatcher.dispatchDue()).toMatchObject({ dead: 1 });
    [d] = await deliveries();
    expect(d).toMatchObject({ status: 'dead', attempts: 3 });
    expect(receiver.received).toHaveLength(3);
  });

  it('recovers when the endpoint comes back', async () => {
    const { client, seller, order } = await setup();
    await registerWebhook(client, seller).expect(201);
    await order();
    receiver.respond(500);
    const { worker } = await makeWorker();
    await worker.relay.relayOnce();
    await worker.dispatcher.dispatchDue();

    receiver.respond(204);
    await fastForward();
    expect(await worker.dispatcher.dispatchDue()).toMatchObject({ succeeded: 1 });
    expect((await deliveries())[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('times out a slow endpoint instead of waiting forever', async () => {
    const { client, seller, order } = await setup();
    await registerWebhook(client, seller).expect(201);
    await order();
    receiver.hang();
    const { worker } = await makeWorker({ timeoutMs: 100 });
    await worker.relay.relayOnce();

    const started = Date.now();
    expect(await worker.dispatcher.dispatchDue()).toMatchObject({ failed: 1 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await deliveries())[0]!.last_error).toBe('Timed out after 100 ms');
  });

  it('opens the circuit breaker after repeated failures and stops calling the endpoint', async () => {
    const { client, seller, order } = await setup();
    await registerWebhook(client, seller).expect(201);
    for (let i = 0; i < 4; i++) await order();
    receiver.respond(500);
    const { worker } = await makeWorker({ maxAttempts: 10, breaker: { failureThreshold: 2, cooldownMs: 60_000 } });
    await worker.relay.relayOnce();

    // Sent one at a time so the breaker sees the failures in sequence.
    expect(await worker.dispatcher.dispatchDue(1)).toMatchObject({ failed: 1 });
    expect(await worker.dispatcher.dispatchDue(1)).toMatchObject({ failed: 1 });
    expect(await worker.dispatcher.dispatchDue(2)).toMatchObject({ deferred: 2 });
    expect(receiver.received).toHaveLength(2); // the open breaker made no HTTP calls

    const pending = await deliveries();
    const deferred = pending.filter((d) => d.attempts === 0);
    expect(deferred).toHaveLength(2); // deferring doesn't use up an attempt
    for (const d of deferred) expect(d.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it('refuses to call internal addresses when insecure URLs are not allowed (SSRF)', async () => {
    const { client, seller, order } = await setup();
    await registerWebhook(client, seller).expect(201);
    // Simulate a seller who registered https://127.0.0.1/... (or a hostname that resolves there).
    await testPool().query("UPDATE webhook_endpoints SET url = 'https://127.0.0.1:1/hooks'");
    await order();
    const { worker } = await makeWorker({ allowInsecureUrls: false });
    await worker.relay.relayOnce();
    await worker.dispatcher.dispatchDue();
    expect((await deliveries())[0]!.last_error).toMatch(/private or reserved address/);
  });

  it('gives up on deliveries for a disabled endpoint', async () => {
    const { client, seller, order } = await setup();
    await registerWebhook(client, seller).expect(201);
    await order();
    const { worker } = await makeWorker();
    await worker.relay.relayOnce();
    await testPool().query('UPDATE webhook_endpoints SET active = false');
    expect(await worker.dispatcher.dispatchDue()).toMatchObject({ dead: 1 });
    expect((await deliveries())[0]!.last_error).toBe('Endpoint disabled');
  });

  it('the running worker processes the whole pipeline on its own', async () => {
    const { client, seller, order } = await setup();
    await registerWebhook(client, seller).expect(201);
    const { worker } = await makeWorker();
    await worker.start();
    try {
      await order();
      const end = Date.now() + 5_000;
      while (receiver.received.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      expect(receiver.received).toHaveLength(1);
    } finally {
      await worker.stop();
    }
  });
});
