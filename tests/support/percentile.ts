/**
 * Nearest-rank percentiles and run aggregation (spec §5.1).
 *
 * p_q = x_ceil(q*n) over the sorted samples, so p95 of 20 boot runs is the 19th value and p95 of
 * fewer than 20 samples is the maximum.
 */
export interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function sortedCopy(samples: ArrayLike<number>): Float64Array {
  const out = Float64Array.from(samples);
  out.sort();
  return out;
}

/** Nearest-rank percentile of `samples`; `q` in (0, 1]. Throws on an empty sample. */
export function percentile(samples: ArrayLike<number>, q: number): number {
  if (samples.length === 0) throw new RangeError('percentile of an empty sample');
  if (!(q > 0 && q <= 1)) throw new RangeError(`quantile out of range: ${q}`);
  const sorted = sortedCopy(samples);
  return nearestRank(sorted, q);
}

function nearestRank(sorted: Float64Array, q: number): number {
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  const value = sorted[rank - 1];
  if (value === undefined) throw new RangeError('rank outside the sample');
  return value;
}

export function summarise(samples: ArrayLike<number>): Summary {
  if (samples.length === 0) throw new RangeError('summary of an empty sample');
  const sorted = sortedCopy(samples);
  return {
    n: sorted.length,
    min: nearestRank(sorted, Number.MIN_VALUE),
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    max: nearestRank(sorted, 1),
  };
}

/** Median as the nearest-rank p50 (the frame gate takes the median of three per-run p95s). */
export function median(samples: ArrayLike<number>): number {
  return percentile(samples, 0.5);
}

export type Aggregate = 'median-of-runs' | 'pooled';

/**
 * `median-of-runs` takes the median of each run's p95; `pooled` concatenates the samples and takes
 * the p95 of the pool.
 */
export function aggregateP95(runs: readonly (readonly number[])[], how: Aggregate): number {
  const nonEmpty = runs.filter((r) => r.length > 0);
  if (nonEmpty.length === 0) throw new RangeError('no samples in any run');
  if (how === 'median-of-runs') return median(nonEmpty.map((r) => percentile(r, 0.95)));
  return percentile(nonEmpty.flat(), 0.95);
}
