/**
 * Playwright projects of the harness (spec §3.3; TST-02, TST-13): `e2e`, `a11y`, `perf` and the
 * `visual` gallery check, all on Google Chrome stable (`channel: 'chrome'`), one worker, JUnit per
 * project. The root playwright.config.ts still points only at tests/e2e; until it is replaced by
 * this file (a root-config change for R5), run:
 *
 *   pnpm exec playwright test -c tests/playwright.config.ts --project e2e
 *   pnpm exec playwright test -c tests/playwright.config.ts --project a11y
 *   pnpm exec playwright test -c tests/playwright.config.ts --project perf      (lab-spec runner)
 *   PLOTINIUM_GALLERY_URL=http://localhost:5173 pnpm exec playwright test -c tests/playwright.config.ts --project visual
 *
 * Storage and offline tests launch their own persistent context (support/os.ts), so IndexedDB,
 * OPFS and the Service Worker survive a reboot. The system under test is the Compose stack at
 * http://localhost:4717 (PLOTINIUM_PORT or PLOTINIUM_BASE_URL override it).
 */
import { defineConfig, devices } from '@playwright/test';

import { baseUrl } from './support/env.ts';

const onCI = process.env['CI'] !== undefined;
const junit = process.env['PLAYWRIGHT_JUNIT_OUTPUT_FILE'] ?? '../test-results/junit/playwright.xml';
const chrome = { ...devices['Desktop Chrome'], channel: 'chrome' };

export default defineConfig({
  outputDir: '../test-results/playwright',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  forbidOnly: onCI,
  // A retry that passes marks the test flaky (spec §3.14); perf never retries inside Playwright.
  retries: onCI ? 1 : 0,
  reporter: [
    ['list'],
    ['junit', { outputFile: junit }],
    ['html', { open: 'never', outputFolder: '../playwright-report' }],
  ],
  use: {
    baseURL: baseUrl(),
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'e2e', testDir: './e2e', testMatch: '**/*.spec.ts', use: chrome },
    { name: 'a11y', testDir: './a11y', testMatch: '**/*.spec.ts', use: chrome },
    {
      name: 'perf',
      testDir: './performance',
      testMatch: '**/*.spec.ts',
      retries: 0,
      use: { ...chrome, headless: false },
    },
    {
      name: 'visual',
      testDir: './visual',
      testMatch: '**/*.spec.ts',
      use: { ...chrome, reducedMotion: 'reduce' },
    },
  ],
});
