process.env.NODE_ENV = 'test';
// Tests always run against a dedicated database that gets truncated between tests.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://marketplace:marketplace@localhost:5432/marketplace_test';
