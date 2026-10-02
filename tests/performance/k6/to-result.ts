/**
 * Converts the k6 end-of-test summary (ws-soak.js handleSummary) into the result file of the
 * VFS-09.lock-grant budget, so k6 runs are judged by check-budgets like every other harness.
 */
import type { Budget } from '../budgets.schema.ts';
import type { PerfResult } from '../result.ts';

export interface K6TrendValues {
  avg?: number;
  min?: number;
  med?: number;
  max?: number;
  'p(90)'?: number;
  'p(95)'?: number;
  'p(99)'?: number;
}

export interface K6Summary {
  metrics: Record<
    string,
    { type?: string; values: K6TrendValues & { count?: number } } | undefined
  >;
  state?: { testRunDurationMs?: number };
}

export function k6TrendResult(
  b: Budget,
  summary: K6Summary,
  metric: string,
  base: Pick<PerfResult, 'commit' | 'build' | 'machine' | 'startedAt'>,
  samples: number,
): PerfResult {
  const values = summary.metrics[metric]?.values;
  const p95 = values?.['p(95)'];
  if (values === undefined || p95 === undefined)
    throw new Error(`k6 summary has no p(95) for ${metric}`);
  const p50 = values.med ?? p95;
  const p99 = values['p(99)'] ?? p95;
  const max = values.max ?? p99;
  return {
    ...base,
    budgetId: b.id,
    durationMs: summary.state?.testRunDurationMs ?? 0,
    runs: [{ n: Math.max(1, samples), p50, p95, p99, max, valid: true }],
    value: p95,
    verdict: 'report',
  };
}
