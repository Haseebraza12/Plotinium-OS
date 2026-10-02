/**
 * The benchmark harness (dsa/bench/harness.ts; specs/08-dsa/data-structures.md §7.1–§7.3). Its
 * pure parts are unit-tested here with a fake `bench` fixture, so a broken harness is caught on
 * every pull request rather than on the nightly benchmark run.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { Bench, BenchResult } from 'vitest';

import {
  bytesPerEntry,
  measureCurve,
  record,
  recordMemory,
  shape,
  shapeRatio,
  SIZES,
  timing,
} from '../bench/harness.ts';
import type { DsaBenchRecord, Timing } from '../bench/harness.ts';

/** A BenchResult with the latency fields the harness reads (milliseconds per call). */
function result(meanMs: number, samples: number[] = []): BenchResult {
  return {
    latency: {
      mean: meanMs,
      p50: meanMs,
      p99: meanMs * 2,
      samples: samples.length > 0 ? samples : undefined,
    },
  } as unknown as BenchResult;
}

const t = (n: number, meanNs: number): Timing => ({
  n,
  samples: 1,
  batch: 1,
  meanNs,
  p50Ns: meanNs,
  p95Ns: meanNs,
  p99Ns: meanNs,
});

describe('dsa/bench harness', () => {
  it('DSA-GEN-09 benchmarks run at n = 10^3, 10^4 and 10^5 by default', () => {
    if (process.env['PLT_BENCH_SIZES'] === undefined)
      expect(SIZES).toEqual([1_000, 10_000, 100_000]);
    else expect(SIZES.length).toBeGreaterThan(0);
  });

  it('DSA-GEN-09 timing converts milliseconds per batch into nanoseconds per operation with a nearest-rank p95', () => {
    const samples = Array.from({ length: 100 }, (_, i) => (i + 1) / 1_000); // 1..100 µs per call
    const out = timing(10_000, result(0.05, samples), 1_000);
    expect(out.n).toBe(10_000);
    expect(out.samples).toBe(100);
    expect(out.meanNs).toBeCloseTo(50, 6);
    expect(out.p50Ns).toBeCloseTo(50, 6);
    expect(out.p99Ns).toBeCloseTo(100, 6);
    expect(out.p95Ns).toBeCloseTo(95, 6);
    expect(timing(1, result(1), 1).p95Ns).toBeNaN(); // no samples retained
  });

  it('DSA-GEN-03 shapeRatio compares the largest n with the smallest', () => {
    expect(shapeRatio([t(1_000, 10), t(10_000, 12), t(100_000, 17)])).toBeCloseTo(1.7, 6);
    expect(shapeRatio([t(1_000, 10), t(100_000, 30)], (x) => x.p95Ns)).toBe(3);
    expect(shapeRatio([])).toBeNaN();
    expect(shape('O(log n)', 1.7, 3)).toEqual({
      expected: 'O(log n)',
      ratio: 1.7,
      limit: 3,
      pass: true,
    });
    expect(shape('O(1)', 2.5, 2).pass).toBe(false);
    expect(
      bytesPerEntry({ size: 10, capacity: 16, bytesAllocated: 480, bytesUsed: 240 }, 10),
    ).toEqual({ allocated: 48, used: 24 });
  });

  it('DSA-GEN-09 record builds a §7.3 line and appends it under PLT_BENCH_OUT/<structure>', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'plt-bench-'));
    vi.stubEnv('PLT_BENCH_OUT', dir);
    vi.stubEnv('PLT_BENCH_RUNNER', 'lab');
    try {
      const rec = record({
        structure: 'heap',
        variant: 'scheduler',
        op: 'pop+push',
        timing: t(256, 80),
        budget: { metric: 'mean ns', limit: 1_000, value: 80, pass: true, hard: false },
      });
      expect(rec).toMatchObject({
        structure: 'heap',
        variant: 'scheduler',
        op: 'pop+push',
        n: 256,
        meanNs: 80,
        shape: null,
      });
      expect(rec.env.runner).toBe('lab');
      expect(rec.env.seed).toBe(42);
      const files = readdirSync(path.join(dir, 'heap'));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}-lab\.jsonl$/);
      const line = JSON.parse(
        readFileSync(path.join(dir, 'heap', files[0] ?? ''), 'utf8').trim(),
      ) as DsaBenchRecord;
      expect(line.op).toBe('pop+push');

      const mem = recordMemory(
        'lru',
        1_000,
        null,
        { size: 1_000, capacity: 1_024, bytesAllocated: 64_000, bytesUsed: 32_000 },
        'bounded',
      );
      expect([
        mem.bytesPerEntryMeasured,
        mem.bytesPerEntryAllocated,
        mem.bytesPerEntryUsed,
        mem.variant,
      ]).toEqual([null, 64, 32, 'bounded']);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
    vi.stubEnv('PLT_BENCH_OUT', '');
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('PLT_BENCH_RUNNER', '');
    try {
      expect(record({ structure: 'trie', op: 'complete', timing: t(1, 1) }).env.runner).toBe('gha');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('DSA-GEN-03 measureCurve times every size, normalises by the batch and attaches the shape to the largest n', async () => {
    const calls: string[] = [];
    const fake = ((name: string, _options: unknown, fn: () => void) => ({
      run: () => {
        calls.push(name);
        fn();
        const n = Number(/n=(\d+)/.exec(name)?.[1]);
        return Promise.resolve(result(n / 1e6)); // 1 ns per element per call
      },
    })) as unknown as Bench;
    let built = 0;
    const curve = await measureCurve(fake, {
      structure: 'dag',
      op: 'build',
      variant: 'layered',
      sizes: [10, 1_000],
      batch: (n) => n,
      shape: { expected: 'O(V+E)', limit: 2 },
      setup: (n) => {
        built += n;
        return () => undefined;
      },
    });
    expect(built).toBe(1_010);
    expect(calls).toEqual(['dag build [layered] n=10', 'dag build [layered] n=1000']);
    expect(curve.timings.map((x) => x.meanNs)).toEqual([1, 1]);
    expect(curve.ratio).toBe(1);
    expect(curve.records[0]?.shape).toBeNull();
    expect(curve.records[1]?.shape).toEqual({ expected: 'O(V+E)', ratio: 1, limit: 2, pass: true });

    const single = await measureCurve(fake, {
      structure: 'dag',
      op: 'one',
      sizes: [5],
      batch: 1,
      setup: () => () => undefined,
    });
    expect(single.ratio).toBe(1);
  });
});
