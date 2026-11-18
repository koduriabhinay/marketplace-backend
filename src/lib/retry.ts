export interface BackoffOptions {
  /** Delay before the first retry, in ms. */
  baseMs: number;
  /** Upper bound for any single delay, in ms. */
  maxMs: number;
}

/**
 * Exponential backoff with "full jitter": the delay before retry n is a random value
 * between 0 and min(maxMs, baseMs * 2^n). Doubling gives a struggling dependency room to
 * recover; the randomness spreads retries out so a thousand clients that failed at the
 * same moment don't all retry at the same moment (the "thundering herd").
 */
export function backoffDelay(attempt: number, opts: BackoffOptions, random: () => number = Math.random): number {
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

/**
 * "Equal jitter": half the exponential delay is guaranteed, the other half is random.
 * Used for scheduled retries (webhooks) where an almost-zero delay would waste an attempt.
 */
export function scheduledBackoffDelay(attempt: number, opts: BackoffOptions, random: () => number = Math.random) {
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

export interface RetryOptions extends BackoffOptions {
  /** How many times to retry after the first failure. */
  retries: number;
  /** Return false to stop retrying (e.g. for errors that will never succeed). */
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `fn`, retrying failures with exponential backoff and jitter. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const wait = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || opts.shouldRetry?.(err) === false) throw err;
      const delay = backoffDelay(attempt, opts);
      opts.onRetry?.(err, attempt + 1, delay);
      await wait(delay);
    }
  }
}

/** Rejects if `promise` hasn't settled within `ms`. The underlying work is not cancelled. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what = 'Operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class TimeoutError extends Error {
  override name = 'TimeoutError';
}
