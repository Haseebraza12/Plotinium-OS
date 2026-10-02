/**
 * Per-op sampler (spec §3.11.2): absolute p95 budgets for operations well above timer resolution
 * (trie ≤ 1 ms, prediction ≤ 5 ms, syscall ≤ 1 ms, Q1-Q5 ≤ 10 ms, page-in).
 *
 * Samples go into a Float64Array; the first `warmupPct` percent are discarded; percentiles are
 * nearest-rank (§5.1). n ≥ 1,000 for micro-operations and n ≥ 100 for heavy ones. The clock is
 * `performance.now()`, which is 5 µs resolution in a cross-origin-isolated page and sub-µs in Node.
 */
import { summarise, type Summary } from '../support/percentile.ts';

export type Clock = () => number;

export interface SampleOptions {
  /** Measured samples kept after warm-up. */
  n: number;
  /** Extra leading samples discarded, as a percentage of n. Default 10. */
  warmupPct?: number;
  clock?: Clock;
}

export const MIN_MICRO_SAMPLES = 1000;
export const MIN_HEAVY_SAMPLES = 100;

function counts(opts: SampleOptions): { warm: number; n: number } {
  if (!Number.isInteger(opts.n) || opts.n < 1)
    throw new RangeError(`sample count must be a positive integer, got ${opts.n}`);
  const pct = opts.warmupPct ?? 10;
  if (!(pct >= 0 && pct < 100)) throw new RangeError(`warm-up percentage out of range: ${pct}`);
  return { warm: Math.ceil((opts.n * pct) / 100), n: opts.n };
}

/** Times `op` synchronously; returns the kept samples in ms. */
export function sampleSync(op: (i: number) => unknown, opts: SampleOptions): Float64Array {
  const { warm, n } = counts(opts);
  const clock = opts.clock ?? (() => performance.now());
  for (let i = 0; i < warm; i++) op(i);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t0 = clock();
    op(warm + i);
    out[i] = clock() - t0;
  }
  return out;
}

/** Times an asynchronous `op` (a syscall round trip, a page-in); returns kept samples in ms. */
export async function sampleAsync(
  op: (i: number) => Promise<unknown>,
  opts: SampleOptions,
): Promise<Float64Array> {
  const { warm, n } = counts(opts);
  const clock = opts.clock ?? (() => performance.now());
  for (let i = 0; i < warm; i++) await op(i);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t0 = clock();
    await op(warm + i);
    out[i] = clock() - t0;
  }
  return out;
}

export function summary(samples: Float64Array): Summary {
  return summarise(samples);
}
