import type { Redis } from 'ioredis';
import { createRedis } from '../src/cache/cache';

/**
 * Redis and RabbitMQ are optional locally: suites that need the real thing run when
 * TEST_REDIS_URL / TEST_RABBITMQ_URL are set (always in CI) and are reported as skipped
 * otherwise. Everything else runs against the in-process fallbacks.
 */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
export const TEST_RABBITMQ_URL = process.env.TEST_RABBITMQ_URL;

export const describeWithRedis = TEST_REDIS_URL ? describe : describe.skip;
export const describeWithRabbit = TEST_RABBITMQ_URL ? describe : describe.skip;

export async function testRedis(): Promise<Redis> {
  const redis = createRedis({ url: TEST_REDIS_URL!, commandTimeoutMs: 2_000 });
  // enableOfflineQueue is off, so wait for the connection before sending commands.
  if (redis.status !== 'ready') await new Promise((resolve) => redis.once('ready', resolve));
  return redis;
}
