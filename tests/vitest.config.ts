/**
 * Vitest configuration for the cross-package harness in tests/ (spec §3.2).
 *
 * The root vitest.config.ts only has a `property` project for this folder, so the harness's own
 * tests and the database-gated suites would otherwise run nowhere. Until the W5 migration to the
 * six projects of spec §3.2 folds these into the root config, run them with:
 *
 *   pnpm exec vitest run --config tests/vitest.config.ts                       every project
 *   pnpm exec vitest run --config tests/vitest.config.ts --project harness     pure helper tests
 *   DATABASE_URL=postgres://… pnpm exec vitest run --config tests/vitest.config.ts --project integration
 *
 * `integration` holds tests/integration and tests/fault-injection (spec §3.2 include list); every
 * suite that needs PostgreSQL skips itself when DATABASE_URL is unset, so a plain run stays green
 * and reports them as skipped (T-3: skipped is never verified).
 */
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('./', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const NEVER = ['**/node_modules/**', '**/dist/**', '**/coverage/**'];

export default defineConfig({
  // Paths below (coverage globs, report directory) are relative to the repository root, whatever
  // directory the command is started from.
  root: repoRoot,
  test: {
    passWithNoTests: true,
    environment: 'node',
    projects: [
      {
        extends: true as const,
        test: {
          name: 'harness',
          root: here,
          include: [
            'support/**/*.test.ts',
            'fixtures/**/*.test.ts',
            'performance/**/*.test.ts',
            'a11y/**/*.test.ts',
            'e2e/**/*.test.ts',
            'visual/**/*.test.ts',
          ],
          exclude: NEVER,
        },
      },
      {
        extends: true as const,
        test: {
          name: 'property',
          root: `${here}property`,
          include: ['**/*.test.ts'],
          exclude: NEVER,
        },
      },
      {
        extends: true as const,
        test: {
          name: 'integration',
          root: here,
          include: ['integration/**/*.test.ts', 'fault-injection/**/*.test.ts'],
          exclude: NEVER,
          globalSetup: ['integration/global-setup.ts'],
          pool: 'forks',
          maxWorkers: 2,
          // Runs after the pure projects: Vitest needs a separate group for a different maxWorkers.
          sequence: { groupOrder: 1 },
          // Seeding tree1000 and running the matrix takes seconds per case on a laptop.
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/tests',
      reporter: ['text-summary', 'json-summary'],
      include: ['tests/**/*.ts'],
      exclude: [
        ...NEVER,
        '**/*.{test,spec,bench}.ts',
        '**/*.d.ts',
        'tests/fixtures/**',
        'tests/vitest.config.ts',
        'tests/playwright.config.ts',
      ],
    },
  },
});
