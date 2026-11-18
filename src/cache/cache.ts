import { Redis } from 'ioredis';

/**
 * A small key/value cache. Values are strings (callers JSON-encode), every entry has a
 * TTL, so a bug in invalidation can only ever serve stale data for a bounded time.
 */
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(keys: string[]): Promise<void>;
  /** Atomically increments an integer key (creating it at 1). */
  incr(key: string): Promise<number>;
  ping(): Promise<void>;
}

/**
 * In-process fallback for local development and tests. Each process has its own copy,
 * so with several API instances one instance's invalidation would not reach the others:
 * that's exactly why production uses Redis.
 */
export class MemoryCache implements Cache {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async del(keys: string[]) {
    for (const k of keys) this.store.delete(k);
  }

  async incr(key: string) {
    const next = Number((await this.get(key)) ?? 0) + 1;
    this.store.set(key, { value: String(next), expiresAt: Number.POSITIVE_INFINITY });
    return next;
  }

  async ping() {}
}

export class RedisCache implements Cache {
  constructor(private readonly redis: Redis) {}

  get(key: string) {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number) {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async del(keys: string[]) {
    if (keys.length) await this.redis.del(...keys);
  }

  incr(key: string) {
    return this.redis.incr(key);
  }

  async ping() {
    await this.redis.ping();
  }
}

export interface RedisOptions {
  url: string;
  commandTimeoutMs: number;
}

/**
 * Redis client tuned to fail fast. If Redis is down, a cache read should give up in
 * milliseconds and fall back to Postgres, not queue up and stall every request:
 *  - commandTimeout: a single command can't hang the request.
 *  - enableOfflineQueue false: while disconnected, commands fail immediately instead of
 *    piling up in memory waiting for a reconnect.
 *  - maxRetriesPerRequest 1: don't retry a command over and over inside one request.
 * The client itself keeps reconnecting in the background with capped backoff.
 */
export function createRedis(opts: RedisOptions): Redis {
  return new Redis(opts.url, {
    commandTimeout: opts.commandTimeoutMs,
    connectTimeout: 2_000,
    disconnectTimeout: 500,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    lazyConnect: false,
  });
}
