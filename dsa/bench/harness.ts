/**
 * Shared micro-benchmark harness for dsa/ (specs/08-dsa/data-structures.md §7; quality spec §3.4).
 *
 * Vitest 5 runs `*.bench.ts` files in a dedicated "<project> (bench)" project: a benchmark is a
 * test that destructures `bench` from its context and awaits `bench(name, fn).run(RUN)`.
 *
 *   pnpm exec vitest bench --project 'dsa (bench)'           all sizes (nightly)
 *   PLT_BENCH_SIZES=1000,10000 pnpm exec vitest bench ...    the pull-request sizes (§7.2)
 *   PLT_BENCH_OUT=docs/evidence/dsa ...                        append §7.3 JSON lines per record
 *
 * Operations far below the timer resolution run BATCH times per timed call (§7.1), so ns/op is
 * latency / BATCH. Every file is gated with `describe.runIf(IMPLEMENTED)` (C16) and builds its
 * fixtures inside the test body, never at collection time, so an unimplemented structure is never
 * constructed.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Bench, BenchResult, BenchRunOptions } from 'vitest';

import type { DsaStats } from '../src/_shared/errors.ts';

export type Structure =
  | 'tree'
  | 'trie'
  | 'heap'
  | 'dag'
  | 'lru'
  | 'hashtable'
  | 'ringbuffer'
  | 'bloom'
  | 'zorder'
  | 'interval';

export type ShapeClass = 'O(1)' | 'O(log n)' | 'O(P+k)' | 'O(d)' | 'O(V+E)' | 'O(n)';

/** One line of docs/evidence/dsa/<structure>/<date>-<runner>.jsonl (§7.3). */
export interface DsaBenchRecord {
  structure: Structure;
  variant?: string;
  op: string;
  n: number;
  samples: number;
  batch: number;
  meanNs: number;
  p50Ns: number;
  p95Ns: number;
  p99Ns: number;
  bytesPerEntryMeasured: number | null;
  bytesPerEntryAllocated: number | null;
  bytesPerEntryUsed: number | null;
  shape: { expected: ShapeClass; ratio: number; limit: number; pass: boolean } | null;
  budget: { metric: string; limit: number; value: number; pass: boolean; hard: boolean } | null;
  env: {
    node: string;
    v8: string;
    cpu: string;
    os: string;
    runner: 'lab' | 'gha' | 'dev';
    commit: string;
    date: string;
    seed: number;
  };
}

/** The workload seed of every structure (§7.1: mulberry32(42)). */
export const SEED = 42;

/** Operations per timed call for sub-microsecond operations (§7.1). */
export const BATCH = 1_000;

function parseSizes(raw: string | undefined): number[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const sizes = raw.split(',').map((s) => Number(s.trim()));
  return sizes.every((n) => Number.isInteger(n) && n > 0) ? sizes : undefined;
}

/** n = 10^3, 10^4 and 10^5 (§7.1), or PLT_BENCH_SIZES. */
export const SIZES: readonly number[] = parseSizes(process.env['PLT_BENCH_SIZES']) ?? [
  1_000, 10_000, 100_000,
];

/** Window-sized structures (S9, S10) use n = 10, 10^2 and 10^3 (§7.1). */
export const WINDOW_SIZES: readonly number[] = [10, 100, 1_000];

/** Run options for every `bench(...).run(RUN)`: samples are kept so p95 can be computed. */
export const RUN: BenchRunOptions = { time: 250, warmupTime: 50, retainSamples: true };

/** Per-benchmark function options: keep samples for the nearest-rank p95. */
export const KEEP_SAMPLES = { retainSamples: true } as const;

/** Nearest-rank percentile of already sorted samples (ms), in ns per operation. */
function rankNs(sorted: readonly number[], q: number, batch: number): number {
  if (sorted.length === 0) return Number.NaN;
  const value = sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
  return (value * 1e6) / batch;
}

export interface Timing {
  readonly n: number;
  readonly samples: number;
  readonly batch: number;
  readonly meanNs: number;
  readonly p50Ns: number;
  readonly p95Ns: number;
  readonly p99Ns: number;
}

/** Convert a Vitest bench result whose function ran `batch` operations per call. */
export function timing(n: number, result: BenchResult, batch: number): Timing {
  const samples: readonly number[] = result.latency.samples ?? [];
  return {
    n,
    samples: samples.length,
    batch,
    meanNs: (result.latency.mean * 1e6) / batch,
    p50Ns: (result.latency.p50 * 1e6) / batch,
    p95Ns: rankNs(samples, 0.95, batch),
    p99Ns: (result.latency.p99 * 1e6) / batch,
  };
}

/** Shape assertion input: t(largest n) / t(smallest n) on the mean (§7.2). */
export function shapeRatio(
  points: readonly Timing[],
  pick: (t: Timing) => number = (t) => t.meanNs,
): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return Number.NaN;
  return pick(last) / pick(first);
}

/** Bytes per entry allocated and used, from a structure's `stats()` (§3.4 "Accounting"). */
export function bytesPerEntry(stats: DsaStats, n: number): { allocated: number; used: number } {
  return { allocated: stats.bytesAllocated / n, used: stats.bytesUsed / n };
}

function runnerKind(): 'lab' | 'gha' | 'dev' {
  const raw = process.env['PLT_BENCH_RUNNER'];
  if (raw === 'lab' || raw === 'gha') return raw;
  return process.env['GITHUB_ACTIONS'] === 'true' ? 'gha' : 'dev';
}

export interface RecordInput {
  structure: Structure;
  variant?: string;
  op: string;
  timing: Timing;
  bytes?: { measured: number | null; allocated: number | null; used: number | null };
  shape?: DsaBenchRecord['shape'];
  budget?: DsaBenchRecord['budget'];
}

/** Build a §7.3 record and append it to PLT_BENCH_OUT/<structure>/<date>-<runner>.jsonl if set. */
export function record(input: RecordInput): DsaBenchRecord {
  const date = new Date().toISOString();
  const runner = runnerKind();
  const rec: DsaBenchRecord = {
    structure: input.structure,
    ...(input.variant === undefined ? {} : { variant: input.variant }),
    op: input.op,
    n: input.timing.n,
    samples: input.timing.samples,
    batch: input.timing.batch,
    meanNs: input.timing.meanNs,
    p50Ns: input.timing.p50Ns,
    p95Ns: input.timing.p95Ns,
    p99Ns: input.timing.p99Ns,
    bytesPerEntryMeasured: input.bytes?.measured ?? null,
    bytesPerEntryAllocated: input.bytes?.allocated ?? null,
    bytesPerEntryUsed: input.bytes?.used ?? null,
    shape: input.shape ?? null,
    budget: input.budget ?? null,
    env: {
      node: process.version,
      v8: process.versions.v8,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      os: `${os.platform()} ${os.release()}`,
      runner,
      commit: process.env['GITHUB_SHA'] ?? process.env['PLT_COMMIT'] ?? 'unknown',
      date,
      seed: SEED,
    },
  };
  const out = process.env['PLT_BENCH_OUT'];
  if (out !== undefined && out !== '') {
    const dir = path.join(out, input.structure);
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      path.join(dir, `${date.slice(0, 10)}-${runner}.jsonl`),
      `${JSON.stringify(rec)}\n`,
    );
  }
  return rec;
}

/** A shape entry for a record: `ratio ≤ limit` passes. */
export function shape(
  expected: ShapeClass,
  ratio: number,
  limit: number,
): NonNullable<DsaBenchRecord['shape']> {
  return { expected, ratio, limit, pass: ratio <= limit };
}

export interface CurveSpec {
  structure: Structure;
  op: string;
  variant?: string;
  sizes?: readonly number[];
  /** Operations per call of the function returned by `setup` (per size when a function). */
  batch: number | ((n: number) => number);
  /** Builds the fixture for size n (outside the timed region) and returns the timed function. */
  setup: (n: number) => () => void;
  /** Expected class and limit of t(largest n) / t(smallest n); attached to the largest-n record. */
  shape?: { expected: ShapeClass; limit: number };
}

export interface Curve {
  readonly timings: readonly Timing[];
  /** t(largest n) / t(smallest n) on the mean; 1 when only one size runs. */
  readonly ratio: number;
  readonly records: readonly DsaBenchRecord[];
}

/** Time one operation at every size and record it (§7.3); the caller asserts the shape. */
export async function measureCurve(bench: Bench, spec: CurveSpec): Promise<Curve> {
  const sizes = spec.sizes ?? SIZES;
  const timings: Timing[] = [];
  for (const n of sizes) {
    const fn = spec.setup(n);
    const label = `${spec.structure} ${spec.op}${spec.variant === undefined ? '' : ` [${spec.variant}]`} n=${n}`;
    const result = await bench(label, KEEP_SAMPLES, fn).run(RUN);
    timings.push(timing(n, result, typeof spec.batch === 'function' ? spec.batch(n) : spec.batch));
  }
  const ratio = timings.length > 1 ? shapeRatio(timings) : 1;
  const records = timings.map((t, i) =>
    record({
      structure: spec.structure,
      ...(spec.variant === undefined ? {} : { variant: spec.variant }),
      op: spec.op,
      timing: t,
      ...(spec.shape !== undefined && i === timings.length - 1
        ? { shape: shape(spec.shape.expected, ratio, spec.shape.limit) }
        : {}),
    }),
  );
  return { timings, ratio, records };
}

/** Record bytes per entry for a structure built at size n (DSA-GEN-09). */
export function recordMemory(
  structure: Structure,
  n: number,
  measured: number | null,
  stats: DsaStats,
  variant?: string,
): DsaBenchRecord {
  const { allocated, used } = bytesPerEntry(stats, n);
  return record({
    structure,
    ...(variant === undefined ? {} : { variant }),
    op: 'memory',
    timing: { n, samples: 0, batch: 0, meanNs: 0, p50Ns: 0, p95Ns: 0, p99Ns: 0 },
    bytes: { measured, allocated, used },
  });
}
