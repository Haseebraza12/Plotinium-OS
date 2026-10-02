/**
 * Playwright configuration for the end-to-end suite (spec §15.3; C14).
 *
 * - Real Google Chrome stable (`channel: 'chrome'`), because the gates are defined on current
 *   stable Chrome, not on Playwright's bundled Chromium. Install it once with
 *   `pnpm exec playwright install chrome`.
 * - Storage and offline tests use `chromium.launchPersistentContext` inside the test itself, so
 *   IndexedDB, OPFS and the Service Worker survive a reboot of the page.
 * - The system under test is the Compose stack: `docker compose up -d --wait`, then
 *   http://localhost:4717 (PLOTINIUM_PORT overrides the port; PLOTINIUM_BASE_URL overrides the
 *   whole URL, for example to run against staging).
 */
import { defineConfig, devices } from '@playwright/test';

const port = process.env['PLOTINIUM_PORT'] ?? '4717';
const baseURL = process.env['PLOTINIUM_BASE_URL'] ?? `http://localhost:${port}`;
const onCI = process.env['CI'] !== undefined;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: onCI,
  retries: onCI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'e2e',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
});
