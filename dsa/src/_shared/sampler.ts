/**
 * Per-operation sampler for absolute p95 budgets (specs/08-dsa/data-structures.md §7.1;
 * specs/13-quality/testing-and-performance.md §5.1). Vitest bench reports no p95, so shape and
 * budget assertions time batches of operations with this sampler.
 *
 * Percentiles are nearest-rank: for sorted samples x1 ≤ … ≤ xn, pq = x⌈q·n⌉.
 */

/** Nearest-rank percentile of `samples` (sorted in place). `q` in (0, 1]. */
export function percentile(samples: Float64Array, q: number): number {
  if (samples.length === 0) return Number.NaN;
  if (!(q > 0 && q <= 1)) throw new RangeError(`percentile q must be in (0, 1], got ${q}`);
  samples.sort();
  const rank = Math.ceil(q * samples.length);
  return samples[rank - 1] ?? Number.NaN;
}

export interface SampleOptions {
  /** Timed batches kept (≥ 1,000 for micro-operations, §7.1). */
  readonly batches: number;
  /** Operations per timed batch (1,000 for operations below the timer resolution). */
  readonly batch: number;
  /** Batches run first and discarded. */
  readonly warmup: number;
  /** A monotonic clock in nanoseconds (process.hrtime.bigint() in Node, performance.now()·1e6 in the browser). */
  readonly nowNs: () => number;
}

export interface SampleResult {
  readonly samples: number;
  readonly batch: number;
  readonly meanNs: number;
  readonly p50Ns: number;
  readonly p95Ns: number;
  readonly p99Ns: number;
}

/**
 * Time `op(i)` in batches and report nanoseconds per operation. `op` receives a running index so a
 * workload can walk a precomputed key array without allocating.
 */
export function sampleOps(op: (i: number) => void, options: SampleOptions): SampleResult {
  const { batches, batch, warmup, nowNs } = options;
  if (batches < 1 || batch < 1 || warmup < 0)
    throw new RangeError('batches and batch must be ≥ 1, warmup ≥ 0');
  let i = 0;
  for (let w = 0; w < warmup; w++) for (let j = 0; j < batch; j++) op(i++);
  const perOp = new Float64Array(batches);
  let total = 0;
  for (let b = 0; b < batches; b++) {
    const t0 = nowNs();
    for (let j = 0; j < batch; j++) op(i++);
    const ns = (nowNs() - t0) / batch;
    perOp[b] = ns;
    total += ns;
  }
  return {
    samples: batches,
    batch,
    meanNs: total / batches,
    p50Ns: percentile(perOp, 0.5),
    p95Ns: percentile(perOp, 0.95),
    p99Ns: percentile(perOp, 0.99),
  };
}
