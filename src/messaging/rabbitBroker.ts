import amqp, { type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { logger } from '../lib/logger';
import { retry, withTimeout } from '../lib/retry';
import { EXCHANGE, MAX_HANDLER_ATTEMPTS, type EventHandler, type MessageBroker } from './broker';
import type { DomainEvent } from './events';

const DEAD_LETTER_EXCHANGE = `${EXCHANGE}.dead`;
const PUBLISH_CONFIRM_TIMEOUT_MS = 5_000;

export interface RabbitOptions {
  url: string;
  /** Messages each consumer may hold unacknowledged at once (back-pressure). */
  prefetch?: number;
  /** Delay before a failed message is retried. */
  retryDelayMs?: number;
  /** Called if the connection drops. The worker exits and is restarted by Docker/Kubernetes. */
  onConnectionLost?: (err?: Error) => void;
}

/**
 * RabbitMQ topology:
 *
 *   publisher ──► marketplace.events (topic) ──"order.*"──► <queue> ──► consumer
 *                                                             │  ▲
 *                                       handler failed (n<5)  ▼  │ after retryDelayMs (TTL)
 *                                                        <queue>.retry
 *                                       handler failed 5 times │
 *                                                             ▼
 *                         marketplace.events.dead ──► <queue>.dead  (inspect, fix, replay)
 *
 * - Durable exchange and queues plus persistent messages survive a broker restart.
 * - Publisher confirms: publish() resolves only once RabbitMQ has taken responsibility for
 *   the message. Until then the outbox row stays unpublished, so nothing is lost.
 * - Manual acks: a message is removed only after the handler succeeds. If the worker
 *   crashes mid-handler, RabbitMQ redelivers it to another consumer.
 * - prefetch limits in-flight messages per consumer, so a slow consumer isn't flooded.
 */
export class RabbitBroker implements MessageBroker {
  private closed = false;

  private constructor(
    private readonly connection: ChannelModel,
    private readonly publishChannel: ConfirmChannel,
    private readonly opts: RabbitOptions,
  ) {}

  static async connect(opts: RabbitOptions): Promise<RabbitBroker> {
    const connection = await retry(() => amqp.connect(opts.url, { timeout: 5_000 }), {
      retries: 8,
      baseMs: 250,
      maxMs: 5_000,
      onRetry: (err, attempt, delayMs) => logger.warn({ err, attempt, delayMs }, 'RabbitMQ connect failed, retrying'),
    });
    const publishChannel = await connection.createConfirmChannel();
    await publishChannel.assertExchange(EXCHANGE, 'topic', { durable: true });
    await publishChannel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });

    const broker = new RabbitBroker(connection, publishChannel, opts);
    connection.on('error', (err) => logger.error({ err }, 'RabbitMQ connection error'));
    connection.on('close', (err?: Error) => {
      if (broker.closed) return;
      broker.closed = true;
      logger.error({ err }, 'RabbitMQ connection lost');
      opts.onConnectionLost?.(err);
    });
    return broker;
  }

  async publish(event: DomainEvent) {
    const body = Buffer.from(JSON.stringify(event));
    const confirmed = new Promise<void>((resolve, reject) => {
      this.publishChannel.publish(
        EXCHANGE,
        event.type,
        body,
        {
          persistent: true,
          contentType: 'application/json',
          messageId: event.id,
          type: event.type,
          timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
        },
        (err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve()),
      );
    });
    await withTimeout(confirmed, PUBLISH_CONFIRM_TIMEOUT_MS, 'RabbitMQ publish confirm');
  }

  async subscribe(queue: string, patterns: string[], handler: EventHandler) {
    const ch = await this.connection.createChannel();
    await ch.prefetch(this.opts.prefetch ?? 10);
    const deadQueue = `${queue}.dead`;
    const retryQueue = `${queue}.retry`;

    await ch.assertQueue(deadQueue, { durable: true });
    await ch.bindQueue(deadQueue, DEAD_LETTER_EXCHANGE, queue);
    await ch.assertQueue(queue, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE, 'x-dead-letter-routing-key': queue },
    });
    // Messages wait here for retryDelayMs, then expire back into the main queue.
    await ch.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        'x-message-ttl': this.opts.retryDelayMs ?? 5_000,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': queue,
      },
    });
    for (const p of patterns) await ch.bindQueue(queue, EXCHANGE, p);

    await ch.consume(queue, (msg) => {
      if (msg) void this.handle(ch, queue, msg, handler);
    });
  }

  private async handle(ch: Channel, queue: string, msg: ConsumeMessage, handler: EventHandler) {
    let event: DomainEvent;
    try {
      event = JSON.parse(msg.content.toString('utf8')) as DomainEvent;
    } catch (err) {
      // A message we can't parse will never succeed: straight to the dead-letter queue.
      logger.error({ err, queue }, 'Unparseable message dead-lettered');
      ch.nack(msg, false, false);
      return;
    }
    try {
      await handler(event);
      ch.ack(msg);
    } catch (err) {
      const attempts = Number(msg.properties.headers?.['x-attempts'] ?? 1);
      if (attempts >= MAX_HANDLER_ATTEMPTS) {
        logger.error({ err, queue, eventId: event.id, attempts }, 'Event dead-lettered');
        ch.nack(msg, false, false);
        return;
      }
      logger.warn({ err, queue, eventId: event.id, attempts }, 'Event handler failed, will retry');
      ch.sendToQueue(`${queue}.retry`, msg.content, {
        ...msg.properties,
        persistent: true,
        headers: { ...msg.properties.headers, 'x-attempts': attempts + 1 },
      });
      ch.ack(msg);
    }
  }

  async check() {
    if (this.closed) throw new Error('RabbitMQ connection is closed');
    await this.publishChannel.checkExchange(EXCHANGE);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.connection.close();
  }
}
