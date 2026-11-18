import type { DomainEvent } from './events';

export type EventHandler = (event: DomainEvent) => Promise<void>;

/**
 * Publish/subscribe for domain events. Routing keys are event types ("order.placed"),
 * and subscriptions use AMQP topic patterns: "*" matches one word, "#" zero or more
 * ("order.*" gets every order event).
 */
export interface MessageBroker {
  /** Resolves only once the broker has durably accepted the event. */
  publish(event: DomainEvent): Promise<void>;
  /**
   * Consumes events from a named, durable queue. Several worker processes subscribing to
   * the same queue share the work (competing consumers); each event goes to one of them.
   */
  subscribe(queue: string, patterns: string[], handler: EventHandler): Promise<void>;
  check(): Promise<void>;
  close(): Promise<void>;
}

export const EXCHANGE = 'marketplace.events';
/** A handler that keeps failing is retried this many times in total, then dead-lettered. */
export const MAX_HANDLER_ATTEMPTS = 5;

export function topicMatches(pattern: string, key: string): boolean {
  const p = pattern.split('.');
  const k = key.split('.');
  const match = (i: number, j: number): boolean => {
    if (i === p.length) return j === k.length;
    if (p[i] === '#') return match(i + 1, j) || (j < k.length && match(i, j + 1));
    if (j === k.length) return false;
    return (p[i] === '*' || p[i] === k[j]) && match(i + 1, j + 1);
  };
  return match(0, 0);
}
