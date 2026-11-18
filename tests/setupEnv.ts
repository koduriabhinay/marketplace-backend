import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
// Tests always run against a dedicated database that gets truncated between tests.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://marketplace:marketplace@localhost:5432/marketplace_test';
// Fast hashing in tests only (production default is 12 rounds).
process.env.BCRYPT_ROUNDS = '4';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `marketplace-test-uploads-${process.pid}`);
// Generous limits so normal tests never trip them; rate-limit tests set their own.
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
