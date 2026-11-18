import { loadEnv } from '../../src/config/env';

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces numeric strings', () => {
    expect(loadEnv({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('fails fast on invalid values', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/Invalid environment configuration: PORT/);
    expect(() => loadEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});

describe('loadEnv: Phase 4 settings', () => {
  it('treats Redis and RabbitMQ as optional, and validates their URLs', () => {
    const env = loadEnv({ REDIS_URL: '', RABBITMQ_URL: '' });
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.RABBITMQ_URL).toBeUndefined();
    expect(loadEnv({ REDIS_URL: 'redis://localhost:6379' }).REDIS_URL).toBe('redis://localhost:6379');
    expect(() => loadEnv({ REDIS_URL: 'http://localhost' })).toThrow(/REDIS_URL/);
    expect(() => loadEnv({ RABBITMQ_URL: 'redis://x' })).toThrow(/RABBITMQ_URL/);
  });

  it('parses booleans and refuses insecure webhooks in production', () => {
    expect(loadEnv({ WEBHOOK_ALLOW_INSECURE: 'true' }).WEBHOOK_ALLOW_INSECURE).toBe(true);
    expect(loadEnv({}).WEBHOOK_ALLOW_INSECURE).toBe(false);
    expect(() =>
      loadEnv({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(40),
        ENCRYPTION_KEY: 'a'.repeat(64),
        WEBHOOK_ALLOW_INSECURE: 'true',
      }),
    ).toThrow(/WEBHOOK_ALLOW_INSECURE must be false/);
  });
});

describe('loadEnv: Phase 5 settings', () => {
  it('makes the read replica optional and validates it', () => {
    expect(loadEnv({}).DATABASE_READ_URL).toBeUndefined();
    expect(loadEnv({ DATABASE_READ_URL: 'postgres://r@replica:5432/db' }).DATABASE_READ_URL).toContain('replica');
    expect(() => loadEnv({ DATABASE_READ_URL: 'mysql://x' })).toThrow(/DATABASE_READ_URL/);
    expect(loadEnv({}).REPLICA_LAG_GRACE_SECONDS).toBe(5);
  });

  it('enables metrics by default and lets you turn them off', () => {
    expect(loadEnv({}).METRICS_ENABLED).toBe(true);
    expect(loadEnv({ METRICS_ENABLED: 'false' }).METRICS_ENABLED).toBe(false);
  });
});
