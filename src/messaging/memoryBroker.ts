import { logger } from '../lib/logger';
import { MAX_HANDLER_ATTEMPTS, topicMatches, type EventHandler, type MessageBroker } from './broker';
import type { DomainEvent } from './events';

/**
 * In-process broker for tests and for running everything in one process locally.
 * Messages vanish on restart and can't reach other processes: never use it in production.
 */
export class MemoryBroker implements MessageBroker {
  private readonly queues = new Map<string, { patterns: string[]; handler: EventHandler }>();
  readonly published: DomainEvent[] = [];
  readonly deadLetters: { queue: string; event: DomainEvent; error: unknown }[] = [];

  async publish(event: DomainEvent) {
    this.published.push(event);
    for (const [queue, sub] of this.queues) {
      if (!sub.patterns.some((p) => topicMatches(p, event.type))) continue;
      await this.deliver(queue, sub.handler, event);
    }
  }

  async subscribe(queue: string, patterns: string[], handler: EventHandler) {
    this.queues.set(queue, { patterns, handler });
  }

  async check() {}
  async close() {
    this.queues.clear();
  }

  private async deliver(queue: string, handler: EventHandler, event: DomainEvent) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await handler(event);
      } catch (error) {
        if (attempt >= MAX_HANDLER_ATTEMPTS) {
          logger.error({ err: error, queue, eventId: event.id }, 'Event dead-lettered');
          this.deadLetters.push({ queue, event, error });
          return;
        }
      }
    }
  }
}
