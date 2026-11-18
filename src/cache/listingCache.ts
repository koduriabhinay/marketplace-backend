import { createHash } from 'node:crypto';
import { logger } from '../lib/logger';
import type { Page } from '../schemas/common';
import type { Listing, ListListingsQuery } from '../schemas/listing';
import type { Cache } from './cache';

const PREFIX = 'listings:v1';
const itemKey = (id: string) => `${PREFIX}:item:${id}`;
const GENERATION_KEY = `${PREFIX}:list-generation`;

/**
 * Cache-aside for the public catalog, which is read far more often than it changes.
 *
 * Reads: look in the cache; on a miss, load from Postgres and store the result with a TTL.
 * Writes: change Postgres first, then invalidate.
 *
 *  - A single listing lives under one key, so it's invalidated by deleting that key.
 *  - Search/browse results could contain any listing, and there are endless filter
 *    combinations, so instead of finding and deleting them all we put a "generation"
 *    number in every list key and bump it on any write. Old entries are never read again
 *    and simply expire.
 *
 * The cache is an optimisation, never a dependency: if Redis errors or times out we log
 * it and serve from Postgres. Losing the cache makes us slower, not broken.
 */
export class ListingCache {
  /** Concurrent misses for the same key share one database load (stampede protection). */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly cache: Cache,
    private readonly ttlSeconds: number,
  ) {}

  getListing(id: string, load: () => Promise<Listing | null>) {
    return this.readThrough(itemKey(id), load);
  }

  async listListings(query: ListListingsQuery, load: () => Promise<Page<Listing>>) {
    const generation = (await this.safely(() => this.cache.get(GENERATION_KEY))) ?? '0';
    const hash = createHash('sha256').update(JSON.stringify(sortKeys(query))).digest('hex').slice(0, 32);
    return this.readThrough(`${PREFIX}:list:${generation}:${hash}`, load);
  }

  /** Call after any write that changes these listings (including their stock). */
  async invalidate(ids: string[]) {
    await this.safely(() => this.cache.del(ids.map(itemKey)));
    await this.safely(() => this.cache.incr(GENERATION_KEY));
  }

  private async readThrough<T>(key: string, load: () => Promise<T>): Promise<T> {
    const cached = await this.safely(() => this.cache.get(key));
    if (cached !== undefined && cached !== null) return JSON.parse(cached) as T;

    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = (async () => {
      try {
        const value = await load();
        // Don't cache "not found": a listing created a moment later must show up.
        if (value !== null) {
          await this.safely(() => this.cache.set(key, JSON.stringify(value), this.ttlSeconds));
        }
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  private async safely<T>(op: () => Promise<T>): Promise<T | undefined> {
    try {
      return await op();
    } catch (err) {
      logger.warn({ err }, 'Cache unavailable, falling back to the database');
      return undefined;
    }
  }
}

function sortKeys(obj: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
