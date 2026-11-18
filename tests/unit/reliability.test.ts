import { MemoryCache } from '../../src/cache/cache';
import { CircuitBreaker } from '../../src/lib/circuitBreaker';
import { backoffDelay, retry, scheduledBackoffDelay, TimeoutError, withTimeout } from '../../src/lib/retry';
import { topicMatches } from '../../src/messaging/broker';
import { signWebhook, verifyWebhook } from '../../src/webhooks/signature';
import {
  assertDeliverableUrl,
  assertWebhookUrlShape,
  isPrivateAddress,
  UnsafeUrlError,
} from '../../src/webhooks/urlSafety';

describe('backoff', () => {
  const opts = { baseMs: 100, maxMs: 1_000 };

  it('grows exponentially, is capped, and is randomised (full jitter)', () => {
    expect(backoffDelay(0, opts, () => 0.999)).toBe(99);
    expect(backoffDelay(3, opts, () => 0.999)).toBe(799);
    expect(backoffDelay(10, opts, () => 0.999)).toBe(999); // capped
    expect(backoffDelay(10, opts, () => 0)).toBe(0);
  });

  it('scheduled backoff always waits at least half the exponential delay', () => {
    expect(scheduledBackoffDelay(2, opts, () => 0)).toBe(200);
    expect(scheduledBackoffDelay(2, opts, () => 0.999)).toBe(399);
  });

  it('retries until success, then stops', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await retry(
      async () => {
        if (++calls < 3) throw new Error('flaky');
        return 'ok';
      },
      { retries: 5, ...opts, sleep: async (ms) => void delays.push(ms) },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it('gives up after the retry budget, or at once for non-retryable errors', async () => {
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('down'));
    };
    await expect(retry(failing, { retries: 2, ...opts, sleep: async () => {} })).rejects.toThrow('down');
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      retry(failing, { retries: 5, ...opts, sleep: async () => {}, shouldRetry: () => false }),
    ).rejects.toThrow('down');
    expect(calls).toBe(1);
  });

  it('withTimeout rejects slow work and passes fast work through', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'Slow thing')).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(Promise.resolve(42), 1_000)).resolves.toBe(42);
  });
});

describe('CircuitBreaker', () => {
  it('opens after N failures, half-opens after the cooldown, and closes on success', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000, now: () => now });

    for (let i = 0; i < 3; i++) {
      expect(b.tryAcquire()).toBe(true);
      b.onFailure();
    }
    expect(b.currentState).toBe('open');
    expect(b.tryAcquire()).toBe(false); // fails fast without calling the dependency
    expect(b.retryAt).toBe(1_000);

    now = 1_000;
    expect(b.currentState).toBe('half_open');
    expect(b.tryAcquire()).toBe(true); // one trial request
    expect(b.tryAcquire()).toBe(false); // ...and only one
    b.onSuccess();
    expect(b.currentState).toBe('closed');
    expect(b.retryAt).toBe(now);
  });

  it('a failed trial re-opens the breaker for another cooldown', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => now });
    b.tryAcquire();
    b.onFailure();
    now = 100;
    expect(b.tryAcquire()).toBe(true);
    b.onFailure();
    expect(b.currentState).toBe('open');
    now = 150;
    expect(b.tryAcquire()).toBe(false);
  });

  it('a success resets the consecutive-failure count', () => {
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100 });
    b.onFailure();
    b.onSuccess();
    b.onFailure();
    expect(b.currentState).toBe('closed');
  });
});

describe('topic routing', () => {
  it.each([
    ['order.*', 'order.placed', true],
    ['order.*', 'order.placed.v2', false],
    ['order.#', 'order.placed.v2', true],
    ['#', 'anything.at.all', true],
    ['order.placed', 'order.cancelled', false],
    ['*.placed', 'order.placed', true],
  ])('%s matches %s: %s', (pattern, key, expected) => {
    expect(topicMatches(pattern, key)).toBe(expected);
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = '{"hello":"world"}';
  const now = 1_700_000_000_000;
  const ts = now / 1000;
  const headers = { 'webhook-id': 'evt_1', 'webhook-timestamp': String(ts), 'webhook-signature': signWebhook(secret, 'evt_1', ts, body) };

  it('verifies a genuine webhook', () => {
    expect(verifyWebhook(secret, headers, body, { now })).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, a missing header, or an old timestamp (replay)', () => {
    expect(verifyWebhook(secret, headers, '{"hello":"mallory"}', { now })).toBe(false);
    expect(verifyWebhook('whsec_other', headers, body, { now })).toBe(false);
    expect(verifyWebhook(secret, { ...headers, 'webhook-signature': undefined }, body, { now })).toBe(false);
    expect(verifyWebhook(secret, headers, body, { now: now + 10 * 60_000 })).toBe(false);
  });

  it('accepts any of several signatures (secret rotation)', () => {
    const rotated = { ...headers, 'webhook-signature': `v1,bogus ${headers['webhook-signature']}` };
    expect(verifyWebhook(secret, rotated, body, { now })).toBe(true);
  });
});

describe('SSRF protection', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.20.0.5', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // cloud metadata
    ['::1', true],
    ['fd00::1', true],
    ['::ffff:10.0.0.1', true],
    ['not-an-ip', true],
    ['93.184.216.34', false],
    ['2606:4700::1111', false],
  ])('%s is private: %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });

  it('requires https and no credentials, unless insecure URLs are allowed', () => {
    expect(() => assertWebhookUrlShape('http://example.com/hook', false)).toThrow(/https/);
    expect(() => assertWebhookUrlShape('ftp://example.com', true)).toThrow(/https/);
    expect(() => assertWebhookUrlShape('https://user:pw@example.com', false)).toThrow(/credentials/);
    expect(() => assertWebhookUrlShape('not a url', false)).toThrow(/valid URL/);
    expect(assertWebhookUrlShape('http://localhost:9999/hook', true).port).toBe('9999');
  });

  it('blocks hosts that resolve to private addresses at delivery time', async () => {
    await expect(assertDeliverableUrl('https://127.0.0.1/hook', false)).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertDeliverableUrl('https://[::1]/hook', false)).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertDeliverableUrl('https://localhost/hook', false)).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertDeliverableUrl('https://93.184.216.34/hook', false)).resolves.toBeInstanceOf(URL);
  });
});

describe('MemoryCache', () => {
  it('expires entries after their TTL', async () => {
    let now = 0;
    const cache = new MemoryCache(() => now);
    await cache.set('k', 'v', 10);
    expect(await cache.get('k')).toBe('v');
    now = 10_000;
    expect(await cache.get('k')).toBeNull();
  });

  it('increments counters and deletes keys', async () => {
    const cache = new MemoryCache();
    expect(await cache.incr('n')).toBe(1);
    expect(await cache.incr('n')).toBe(2);
    await cache.del(['n']);
    expect(await cache.get('n')).toBeNull();
    await expect(cache.ping()).resolves.toBeUndefined();
  });
});
