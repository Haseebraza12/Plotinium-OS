import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
export default defineConfig({
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  test: {
    coverage: { provider: 'v8', include: ['dsa/**'], thresholds: { lines: 70, 'dsa/**': { lines: 85, branches: 85 } } },
    projects: [
      { test: { name: 'unit', environment: 'node', include: ['dsa/**/*.test.ts'] } },
      { test: { name: 'bench', environment: 'node', include: ['dsa/**/*.bench.ts'], benchmark: { include: ['dsa/**/*.bench.ts'] } } },
      { server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
        test: { name: 'browser', include: ['tests/browser/**/*.test.ts'],
        browser: { enabled: true, headless: true, provider: playwright({ launchOptions: { executablePath: '/usr/bin/google-chrome' } }), instances: [{ browser: 'chromium' }] } } },
    ],
  },
});
