import { describe, expect, it } from 'vitest';

import { aggregateP95, median, percentile, summarise } from './percentile.ts';

describe('TST-04 nearest-rank percentiles', () => {
  it('TST-04 p95 of 20 samples is the 19th sorted value', () => {
    const samples = Array.from({ length: 20 }, (_, i) => 20 - i);
    expect(percentile(samples, 0.95)).toBe(19);
  });

  it('TST-04 p95 of fewer than 20 samples equals the maximum', () => {
    expect(percentile([3, 1, 2], 0.95)).toBe(3);
  });

  it('TST-04 summary reports min, p50, p95, p99 and max', () => {
    const s = summarise(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s).toEqual({ n: 100, min: 1, p50: 50, p95: 95, p99: 99, max: 100 });
  });

  it('TST-04 rejects an empty sample and an out-of-range quantile', () => {
    expect(() => percentile([], 0.5)).toThrow(RangeError);
    expect(() => percentile([1], 0)).toThrow(RangeError);
    expect(() => summarise([])).toThrow(RangeError);
  });

  it('TST-05 median-of-runs takes the median of per-run p95 values', () => {
    const runs = [
      [10, 20],
      [30, 40],
      [50, 60],
    ];
    expect(aggregateP95(runs, 'median-of-runs')).toBe(40);
    expect(median([5, 1, 3])).toBe(3);
  });

  it('TST-04 pooled aggregation takes the p95 over all samples', () => {
    expect(aggregateP95([[1, 2], [], [3, 100]], 'pooled')).toBe(100);
    expect(() => aggregateP95([[], []], 'pooled')).toThrow(RangeError);
  });
});
