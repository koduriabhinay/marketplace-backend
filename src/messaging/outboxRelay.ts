import type { Pool } from 'pg';
import { withTransaction } from '../db/pool';
import { logger } from '../lib/logger';
import type { MessageBroker } from './broker';
import type { DomainEvent, EventType } from './events';

interface OutboxRow {
  id: string;
  event_type: EventType;
  payload: unknown;
  created_at: Date;
}

/**
 * Moves events from the outbox table to the broker (the "relay" half of the
 * transactional outbox pattern).
 *
 * - FOR UPDATE SKIP LOCKED: several workers can run the relay at once; each grabs a
 *   different batch instead of waiting on, or double-publishing, the same rows.
 * - Events go out oldest first, and a failure stops the batch so order is preserved.
 * - If we crash after publishing but before committing, the event is published again
 *   next time. That makes delivery at-least-once, which is why consumers de-duplicate by
 *   event id.
 */
export class OutboxRelay {
  constructor(
    private readonly pool: Pool,
    private readonly broker: MessageBroker,
    private readonly batchSize = 50,
  ) {}

  /** Publishes one batch. Returns how many events were published. */
  relayOnce(): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, event_type, payload, created_at FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY created_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      let published = 0;
      for (const row of rows) {
        const event: DomainEvent = {
          id: row.id,
          type: row.event_type,
          occurredAt: row.created_at.toISOString(),
          data: row.payload,
        };
        try {
          await this.broker.publish(event);
        } catch (err) {
          logger.warn({ err, eventId: row.id }, 'Outbox publish failed; will retry');
          await client.query('UPDATE outbox_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [
            row.id,
            String(err instanceof Error ? err.message : err).slice(0, 500),
          ]);
          break;
        }
        await client.query(
          'UPDATE outbox_events SET published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1',
          [row.id],
        );
        published++;
      }
      return published;
    });
  }
}
