/**
 * Measurement methods named by `budgets.json` (spec §3.11.2, §4.1 `method`). Each key says which
 * harness produces the result and whether it runs in Chrome, in which case the result must carry
 * the Chrome version and channel (TST-06, TST-13).
 */
export interface Method {
  harness: string;
  browser: boolean;
}

export const METHODS = {
  'frame-trace': {
    harness: 'tests/performance/frame (Playwright CDP trace, spec §3.11.3)',
    browser: true,
  },
  'boot-harness': {
    harness: 'tests/performance/boot (boot record bootMs, 20 runs)',
    browser: true,
  },
  'resource-timing': {
    harness: 'boot test: Resource Timing entries before desktop-interactive',
    browser: true,
  },
  'boot-throttled': {
    harness: 'tests/e2e/boot-progress.spec.ts (E9, CDP throttling)',
    browser: true,
  },
  'bundle-budget': { harness: 'tools/bundle-budget.ts over web/dist', browser: false },
  'per-op-sampler': { harness: 'tests/performance/sampler.ts (nearest-rank p95)', browser: false },
  'browser-sampler': {
    harness: 'tests/performance/sampler.ts inside Chrome (cross-origin isolated)',
    browser: true,
  },
  'vitest-bench': { harness: 'Vitest bench (Tinybench) complexity curves', browser: false },
  unit: { harness: 'Vitest unit assertion', browser: false },
  'browser-test': { harness: 'Vitest browser project (real Chrome)', browser: true },
  integration: { harness: 'Vitest integration project (Compose PostgreSQL)', browser: false },
  e2e: { harness: 'Playwright e2e project', browser: true },
  starvation: { harness: 'PROC-04 starvation test (safe mode, no focused window)', browser: true },
  'load-test': { harness: 'Playwright perf project, 256 sleeping processes', browser: true },
  paging: {
    harness: 'tests/performance/paging (incompressible 5 MB pages, both tiers)',
    browser: true,
  },
  memhog: { harness: 'memhog --total 512M --procs 8 through the Terminal', browser: true },
  calibration: {
    harness: 'tests/performance/calibration (measureUserAgentSpecificMemory)',
    browser: true,
  },
  accumulators: { harness: 'window.__plt.perf accumulators during the drag run', browser: true },
  'fault-matrix': {
    harness: 'tests/fault-injection (spec §3.6 matrix, client and server)',
    browser: false,
  },
  'db-bench': { harness: 'db/bench Q1-Q5 with EXPLAIN (ANALYZE, BUFFERS)', browser: false },
  k6: { harness: 'tests/performance/k6 (custom Trend thresholds)', browser: false },
  'eval-rag': { harness: 'pnpm eval:rag (ai-eval, recorded embeddings)', browser: false },
  'eval-agt': { harness: 'pnpm eval:agt (ai-eval, replay; 3 live on release)', browser: false },
  'eval-inj': { harness: 'pnpm eval:inj (ai-eval, replay)', browser: false },
  'eval-pre': { harness: 'pnpm eval:pre (ai-eval)', browser: false },
  'rag-leak': { harness: 'rag-leak job (3 users x modes, chmod after indexing)', browser: false },
  'typing-simulator': {
    harness: 'browser test: create, modify, rename, delete a 50 KB file',
    browser: true,
  },
  'embed-drift': {
    harness: 'nightly live embedding of 10 fixture chunks in Chrome',
    browser: true,
  },
  'lab-harness': {
    harness: 'lab-only Playwright harness (launch latency, cost, time to plan)',
    browser: true,
  },
  'server-harness': {
    harness: 'server-side timing from the production VPS or local stack logs',
    browser: false,
  },
  coverage: { harness: 'Vitest coverage-v8 with the file-count check', browser: false },
  bringup: {
    harness: 'Playwright bringup project (clean clone to desktop-interactive)',
    browser: true,
  },
  'restore-drill': { harness: 'ops restore drill (weekly)', browser: false },
  'ci-report': {
    harness: 'GitHub Actions run metadata (wall time, minutes, flake report)',
    browser: false,
  },
} as const satisfies Record<string, Method>;

export type MethodKey = keyof typeof METHODS;

export function isKnownMethod(key: string): key is MethodKey {
  return Object.hasOwn(METHODS, key);
}

export function methodOf(key: string): Method | undefined {
  return isKnownMethod(key) ? METHODS[key] : undefined;
}
