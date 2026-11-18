import { defineConfig, devices } from '@playwright/test';

/**
 * Browser end-to-end test of the real site. By default it targets the full Docker stack
 * (Nginx on https://localhost:8443); point E2E_BASE_URL at http://localhost:5173 to run it
 * against `npm run dev` instead.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://localhost:8443',
    // The local stack uses a self-signed certificate. (scripts/smoke.mjs verifies that
    // certificate properly; here we're testing the website, not TLS.)
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
      },
    },
  ],
});
