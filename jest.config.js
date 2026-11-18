/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  setupFiles: ['<rootDir>/tests/setupEnv.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setupDb.ts'],
  globalSetup: '<rootDir>/tests/globalSetup.ts',
  // Test files share one database, so they run one at a time.
  maxWorkers: 1,
  collectCoverageFrom: ['src/**/*.ts', '!src/server.ts', '!src/db/migrateCli.ts'],
  coverageThreshold: { global: { branches: 80, functions: 90, lines: 90, statements: 90 } },
};
