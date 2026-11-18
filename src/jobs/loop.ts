import { logger } from '../lib/logger';
import { backoffDelay } from '../lib/retry';

export interface PollingLoop {
  stop(): Promise<void>;
}

/**
 * Runs `tick` forever: immediately again while it finds work (returns > 0), otherwise
 * after `intervalMs`. Errors are logged and retried with backoff instead of crashing the
 * worker. stop() waits for the current tick to finish (graceful shutdown).
 */
export function startPollingLoop(name: string, intervalMs: number, tick: () => Promise<number>): PollingLoop {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  let failures = 0;

  const done = (async () => {
    while (!stopped) {
      let delay = intervalMs;
      try {
        const worked = await tick();
        failures = 0;
        if (worked > 0) delay = 0;
      } catch (err) {
        failures++;
        delay = Math.max(intervalMs, backoffDelay(failures, { baseMs: intervalMs, maxMs: 30_000 }));
        logger.error({ err, loop: name, failures, retryInMs: delay }, 'Background loop failed');
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, delay);
      });
    }
  })();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      wake?.();
      await done;
    },
  };
}
