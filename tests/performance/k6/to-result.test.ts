import { describe, expect, it } from 'vitest';

import { budget } from '../budgets.ts';
import { validatePerfResult } from '../result.ts';

import { k6TrendResult, type K6Summary } from './to-result.ts';

const base = {
  commit: 'a1f93c2',
  build: '0.3.0+a1f93c2',
  machine: {
    class: 'lab-spec' as const,
    cpu: 'Intel Core i5-12500',
    hwc: 12,
    ramGiB: 16,
    os: 'linux 6.8',
  },
  startedAt: '2026-10-20T21:30:00Z',
};

describe('VFS-09 k6 soak results', () => {
  it('VFS-09 the lock-grant p95 of a k6 summary becomes the VFS-09.lock-grant result', () => {
    const summary: K6Summary = {
      metrics: {
        lock_grant_ms: { type: 'trend', values: { med: 8, 'p(95)': 31.5, 'p(99)': 44, max: 70 } },
      },
      state: { testRunDurationMs: 300_000 },
    };
    const r = k6TrendResult(budget('VFS-09.lock-grant'), summary, 'lock_grant_ms', base, 12_000);
    expect(r).toMatchObject({ budgetId: 'VFS-09.lock-grant', value: 31.5, durationMs: 300_000 });
    expect(r.runs[0]).toEqual({ n: 12_000, p50: 8, p95: 31.5, p99: 44, max: 70, valid: true });
    expect(validatePerfResult(r, 'k6')).toEqual([]);
  });

  it('VFS-09 a summary without the metric is refused rather than reported as zero', () => {
    expect(() =>
      k6TrendResult(budget('VFS-09.lock-grant'), { metrics: {} }, 'lock_grant_ms', base, 1),
    ).toThrow(/no p\(95\)/);
    const sparse = k6TrendResult(
      budget('VFS-09.lock-grant'),
      { metrics: { m: { values: { 'p(95)': 5 } } } },
      'm',
      base,
      0,
    );
    expect(sparse.runs[0]).toEqual({ n: 1, p50: 5, p95: 5, p99: 5, max: 5, valid: true });
    expect(sparse.durationMs).toBe(0);
  });
});
