import type { Cache } from '../cache/cache';
import { logger } from '../lib/logger';
import { replicaReads } from '../observability/metrics';

/**
 * Sends read-only queries to a read replica, without serving stale data right after a
 * write.
 *
 * A streaming replica applies the primary's changes a little later (usually milliseconds,
 * sometimes seconds under load). So a seller who edits a listing and immediately reloads
 * the page could read the OLD version from the replica, and worse, that old version could
 * be put back into the cache. To get "read your writes":
 *
 *  - every write marks what it touched as "recently written" for a grace period (in the
 *    shared cache, so every API instance sees it);
 *  - reads of recently written data go to the primary, everything else to the replica;
 *  - if the replica is down or errors, the read falls back to the primary.
 *
 * The primary still handles all writes, transactions, and permission checks.
 */
export class ReplicaRouter {
  constructor(
    private readonly cache: Cache,
    private readonly graceSeconds: number,
  ) {}

  async markWritten(keys: string[]) {
    if (this.graceSeconds <= 0) return;
    await Promise.all(
      keys.map((k) => this.cache.set(markerKey(k), '1', this.graceSeconds).catch(() => undefined)),
    );
  }

  async read<T>(key: string, fromReplica: () => Promise<T>, fromPrimary: () => Promise<T>): Promise<T> {
    if (await this.recentlyWritten(key)) {
      replicaReads.inc({ target: 'primary_recent_write' });
      return fromPrimary();
    }
    try {
      const value = await fromReplica();
      replicaReads.inc({ target: 'replica' });
      return value;
    } catch (err) {
      logger.warn({ err }, 'Read replica failed, falling back to the primary');
      replicaReads.inc({ target: 'primary_fallback' });
      return fromPrimary();
    }
  }

  private async recentlyWritten(key: string) {
    try {
      return (await this.cache.get(markerKey(key))) !== null;
    } catch {
      return true; // can't tell: be safe and read the primary
    }
  }
}

const markerKey = (key: string) => `replica:v1:written:${key}`;
