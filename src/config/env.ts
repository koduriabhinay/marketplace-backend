import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Development-only defaults for secrets. They make `npm run dev` and tests work out of the
 * box, and production refuses to start if any of them is still in use.
 */
const DEV_SECRETS = {
  JWT_SECRET: 'dev-only-jwt-secret-change-me-0123456789abcdef',
  ENCRYPTION_KEY: '0'.repeat(64),
} as const;

/** Secrets can be passed as FOO_FILE=/run/secrets/foo (Docker/Kubernetes secrets). */
const SECRET_KEYS = ['DATABASE_URL', 'JWT_SECRET', 'ENCRYPTION_KEY'] as const;

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );

/**
 * All configuration comes from environment variables and is validated once at startup.
 * A missing or malformed value crashes the process immediately (fail fast) instead of
 * surfacing as a confusing bug later.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BODY_LIMIT: z.string().default('100kb'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),

  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string')
    .default('postgres://marketplace:marketplace@localhost:5432/marketplace'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  JWT_SECRET: z.string().min(32, 'must be at least 32 characters').default(DEV_SECRETS.JWT_SECRET),
  JWT_ISSUER: z.string().default('marketplace-api'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  /** 32-byte key as 64 hex chars, used to encrypt 2FA secrets at rest. */
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex characters (32 bytes)')
    .default(DEV_SECRETS.ENCRYPTION_KEY),

  CORS_ORIGINS: csv,
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
});

export type Env = z.infer<typeof envSchema>;

function resolveSecretFiles(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved = { ...source };
  for (const key of SECRET_KEYS) {
    const file = source[`${key}_FILE`];
    if (file && !source[key]) resolved[key] = readFileSync(file, 'utf8').trim();
  }
  return resolved;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(resolveSecretFiles(source));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    const insecure = (Object.keys(DEV_SECRETS) as (keyof typeof DEV_SECRETS)[]).filter(
      (k) => env[k] === DEV_SECRETS[k],
    );
    if (insecure.length) {
      throw new Error(`Invalid environment configuration: ${insecure.join(', ')} must be set in production`);
    }
  }
  return env;
}

export const env = loadEnv();
