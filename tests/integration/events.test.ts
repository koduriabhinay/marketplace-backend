import { randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import type { MessageBroker } from '../../src/messaging/broker';
import type { DomainEvent } from '../../src/messaging/events';
import { MemoryBroker } from '../../src/messaging/memoryBroker';
import { OutboxRelay } from '../../src/messaging/outboxRelay';
import { RabbitBroker } from '../../src/messaging/rabbitBroker';
import { testPool } from '../db';
import { asCustomer, asSeller, createListing, testClient } from '../helpers';
import { describeWithRabbit, TEST_RABBITMQ_URL } from '../infra';

async function placeOrder(quantity = 2, stock = 5) {
  const client = testClient();
  const seller = await asSeller(client);
  const customer = await asCustomer(client);
  const listing = await createListing(client, seller, { stock, priceCents: 1000 });
  const res = await client
    .post('/api/v1/orders')
    .set('Authorization', customer.auth)
    .send({ items: [{ listingId: listing.id, quantity }] });
  return { client, seller, customer, listing, res };
}

const outbox = async () =>
  (
    await testPool().query<{ event_type: string; aggregate_id: string; payload: Record<string, unknown>; published_at: Date | null; attempts: number; last_error: string | null }>(
      'SELECT event_type, aggregate_id, payload, published_at, attempts, last_error FROM outbox_events ORDER BY created_at',
    )
  ).rows;

describe('Transactional outbox', () => {
  it('records order.placed in the same transaction as the order', async () => {
    const { seller, customer, listing, res } = await placeOrder();
    expect(res.status).toBe(201);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: 'order.placed', aggregate_id: res.body.data.id, published_at: null });
    expect(rows[0]!.payload).toEqual({
      orderId: res.body.data.id,
      customerId: customer.customerId,
      status: 'placed',
      totalCents: 2000,
      currency: 'USD',
      items: [{ listingId: listing.id, sellerId: seller.sellerId, quantity: 2, unitPriceCents: 1000 }],
    });
  });

  it('records order.cancelled when an order is cancelled', async () => {
    const { client, customer, res } = await placeOrder();
    await client.post(`/api/v1/orders/${res.body.data.id}/cancel`).set('Authorization', customer.auth).expect(200);
    expect((await outbox()).map((r) => r.event_type)).toEqual(['order.placed', 'order.cancelled']);
  });

  it('writes no event when the order fails (rolled back together)', async () => {
    const { res } = await placeOrder(10, 1);
    expect(res.status).toBe(409);
    expect(await outbox()).toHaveLength(0);
  });
});

describe('Outbox relay', () => {
  it('publishes unpublished events in order and marks them published', async () => {
    const { client, customer, res } = await placeOrder();
    await client.post(`/api/v1/orders/${res.body.data.id}/cancel`).set('Authorization', customer.auth).expect(200);

    const broker = new MemoryBroker();
    const relay = new OutboxRelay(testPool(), broker);
    expect(await relay.relayOnce()).toBe(2);
    expect(broker.published.map((e) => e.type)).toEqual(['order.placed', 'order.cancelled']);
    expect(broker.published[0]!.data).toMatchObject({ orderId: res.body.data.id });
    expect((await outbox()).every((r) => r.published_at !== null)).toBe(true);

    expect(await relay.relayOnce()).toBe(0); // nothing left
  });

  it('leaves events unpublished when the broker is down, and catches up later', async () => {
    await placeOrder();
    let up = false;
    const flaky: MessageBroker = {
      publish: async () => {
        if (!up) throw new Error('connection refused');
      },
      subscribe: async () => {},
      check: async () => {},
      close: async () => {},
    };
    const relay = new OutboxRelay(testPool(), flaky);
    expect(await relay.relayOnce()).toBe(0);
    expect(await outbox()).toEqual([
      expect.objectContaining({ published_at: null, attempts: 1, last_error: 'connection refused' }),
    ]);

    up = true;
    expect(await relay.relayOnce()).toBe(1);
    expect((await outbox())[0]).toMatchObject({ attempts: 2, last_error: null });
  });

  it('several relays running at once never publish the same event twice (SKIP LOCKED)', async () => {
    const { client, seller } = await placeOrder(1, 50);
    const customer = await asCustomer(client);
    const listing = await createListing(client, seller, { stock: 50 });
    for (let i = 0; i < 9; i++) {
      await client
        .post('/api/v1/orders')
        .set('Authorization', customer.auth)
        .send({ items: [{ listingId: listing.id, quantity: 1 }] })
        .expect(201);
    }
    const broker = new MemoryBroker();
    const relays = Array.from({ length: 4 }, () => new OutboxRelay(testPool(), broker, 3));
    let total = 0;
    for (let round = 0; round < 5; round++) {
      total += (await Promise.all(relays.map((r) => r.relayOnce()))).reduce((a, b) => a + b, 0);
    }
    expect(total).toBe(10);
    expect(new Set(broker.published.map((e) => e.id)).size).toBe(10);
  });
});

describe('MemoryBroker', () => {
  const event = (type: DomainEvent['type'] = 'order.placed'): DomainEvent => ({
    id: randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    data: {},
  });

  it('routes by topic pattern and retries a failing handler before dead-lettering', async () => {
    const broker = new MemoryBroker();
    const got: string[] = [];
    let failures = 0;
    await broker.subscribe('placed-only', ['order.placed'], async (e) => void got.push(e.type));
    await broker.subscribe('always-fails', ['order.*'], async () => {
      failures++;
      throw new Error('boom');
    });

    await broker.publish(event('order.placed'));
    await broker.publish(event('order.cancelled'));
    expect(got).toEqual(['order.placed']);
    expect(failures).toBe(10); // 5 attempts per event
    expect(broker.deadLetters).toHaveLength(2);
    await broker.check();
    await broker.close();
  });
});

describeWithRabbit('RabbitMQ broker', () => {
  let broker: RabbitBroker;
  const queues: string[] = [];

  beforeAll(async () => {
    broker = await RabbitBroker.connect({ url: TEST_RABBITMQ_URL!, retryDelayMs: 50 });
  });

  afterAll(async () => {
    const conn = await amqp.connect(TEST_RABBITMQ_URL!);
    const ch = await conn.createChannel();
    for (const q of queues) for (const name of [q, `${q}.retry`, `${q}.dead`]) await ch.deleteQueue(name);
    await conn.close();
    await broker.close();
  });

  const queueName = () => {
    const q = `test.${randomUUID()}`;
    queues.push(q);
    return q;
  };
  const event = (): DomainEvent => ({
    id: randomUUID(),
    type: 'order.placed',
    occurredAt: new Date().toISOString(),
    data: { orderId: 'o1' },
  });
  const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > end) throw new Error('Timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('delivers a published event to a subscribed queue (with publisher confirms)', async () => {
    const received: DomainEvent[] = [];
    await broker.subscribe(queueName(), ['order.*'], async (e) => void received.push(e));
    const sent = event();
    await broker.publish(sent);
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual(sent);
    await broker.check();
  });

  it('retries a failing handler via the retry queue, then succeeds', async () => {
    let calls = 0;
    await broker.subscribe(queueName(), ['order.placed'], async () => {
      if (++calls < 3) throw new Error('transient');
    });
    await broker.publish(event());
    await waitFor(() => calls === 3);
  });

  it('dead-letters an event after 5 failed attempts', async () => {
    const q = queueName();
    let calls = 0;
    await broker.subscribe(q, ['order.placed'], async () => {
      calls++;
      throw new Error('permanent');
    });
    const sent = event();
    await broker.publish(sent);

    const conn = await amqp.connect(TEST_RABBITMQ_URL!);
    try {
      const ch = await conn.createChannel();
      let dead: amqp.GetMessage | false = false;
      await waitFor(async () => (dead = await ch.get(`${q}.dead`, { noAck: true })) !== false);
      expect(calls).toBe(5);
      expect(JSON.parse((dead as unknown as amqp.GetMessage).content.toString()).id).toBe(sent.id);
    } finally {
      await conn.close();
    }
  });

  it('relays outbox events end to end through RabbitMQ', async () => {
    const received: DomainEvent[] = [];
    await broker.subscribe(queueName(), ['order.*'], async (e) => void received.push(e));
    const { res } = await placeOrder();
    expect(await new OutboxRelay(testPool(), broker).relayOnce()).toBe(1);
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({ type: 'order.placed', data: { orderId: res.body.data.id } });
  });
});
