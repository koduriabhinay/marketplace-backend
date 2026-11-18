import type { Pool } from 'pg';
import { startPollingLoop, type PollingLoop } from '../jobs/loop';
import { maintenanceJobs } from '../jobs/maintenance';
import { Scheduler, type ScheduledJob } from '../jobs/scheduler';
import type { MessageBroker } from '../messaging/broker';
import { OutboxRelay } from '../messaging/outboxRelay';
import { WebhookDispatcher, type DispatcherOptions } from '../webhooks/webhookDispatcher';
import { WebhookFanout } from '../webhooks/webhookFanout';

export const WEBHOOK_FANOUT_QUEUE = 'webhooks.fanout';

export interface WorkerDeps {
  pool: Pool;
  broker: MessageBroker;
  dispatcher: DispatcherOptions;
  outboxPollMs: number;
  webhookPollMs: number;
  jobs?: ScheduledJob[];
}

/**
 * The background worker: everything that shouldn't happen inside an HTTP request.
 *
 *   orders ──(same tx)──► outbox_events ──relay──► RabbitMQ ──► webhook fan-out consumer
 *                                                                     │
 *                                                       webhook_deliveries (pending)
 *                                                                     │
 *                                              dispatcher ──HTTPS──► seller endpoints
 *   + scheduled maintenance jobs (cron)
 *
 * The API never waits on any of this: placing an order commits and returns, and slow or
 * broken seller endpoints can't slow checkout down.
 */
export function createWorker(deps: WorkerDeps) {
  const relay = new OutboxRelay(deps.pool, deps.broker);
  const fanout = new WebhookFanout(deps.pool);
  const dispatcher = new WebhookDispatcher(deps.pool, deps.dispatcher);
  const scheduler = new Scheduler(deps.pool, deps.jobs ?? maintenanceJobs);
  let loops: PollingLoop[] = [];
  let subscribed = false;

  const subscribe = async () => {
    if (subscribed) return;
    subscribed = true;
    await deps.broker.subscribe(WEBHOOK_FANOUT_QUEUE, ['order.*'], async (event) => {
      await fanout.handle(event);
    });
  };

  return {
    relay,
    fanout,
    dispatcher,
    scheduler,
    /** Starts consuming events (start() does this too). */
    subscribe,

    async start() {
      await subscribe();
      loops = [
        startPollingLoop('outbox-relay', deps.outboxPollMs, () => relay.relayOnce()),
        startPollingLoop('webhook-dispatch', deps.webhookPollMs, async () => {
          const r = await dispatcher.dispatchDue();
          return r.succeeded + r.failed + r.dead;
        }),
      ];
      scheduler.start();
    },

    /** Graceful: finish the current batch, then stop. */
    async stop() {
      await Promise.all(loops.map((l) => l.stop()));
      loops = [];
      await scheduler.stop();
    },
  };
}
