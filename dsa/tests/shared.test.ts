/**
 * The shared test and benchmark helpers of dsa/ (specs/08-dsa/data-structures.md §3.4, §4.0,
 * §7.1): the mulberry32 PRNG, the nearest-rank sampler, the bytes-per-entry probe and DsaError.
 * These are not structures, so they run now, independent of any IMPLEMENTED flag.
 */
import { describe, expect, it, vi } from 'vitest';

import { DsaError, NotImplementedError } from '../src/_shared/errors.ts';
import { measureBytesPerEntry } from '../src/_shared/mem.ts';
import { mulberry32, randomInt } from '../src/_shared/prng.ts';
import { percentile, sampleOps } from '../src/_shared/sampler.ts';
import { expectDsaError } from './helpers.ts';

describe('dsa/_shared', () => {
  it('DSA-GEN-06 mulberry32 is deterministic per seed and yields floats in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const xs = Array.from({ length: 1_000 }, () => a());
    expect(Array.from({ length: 1_000 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 1_000 }, () => c())).not.toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    const mean = xs.reduce((sum, x) => sum + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    const rand = mulberry32(7);
    const ints = Array.from({ length: 1_000 }, () => randomInt(rand, 6));
    expect(new Set(ints)).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });

  it('DSA-GEN-09 percentile is nearest-rank and rejects q outside (0, 1]', () => {
    const samples = Float64Array.from([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]);
    expect(percentile(samples, 0.5)).toBe(5);
    expect(percentile(samples, 0.95)).toBe(10);
    expect(percentile(samples, 0.1)).toBe(1);
    expect(percentile(samples, 1)).toBe(10);
    expect(percentile(new Float64Array(0), 0.5)).toBeNaN();
    expect(() => percentile(samples, 0)).toThrow(RangeError);
    expect(() => percentile(samples, 1.5)).toThrow(RangeError);
  });

  it('DSA-GEN-09 sampleOps times batches after the warm-up and reports nanoseconds per operation', () => {
    let clock = 0;
    const seen: number[] = [];
    const result = sampleOps((i) => seen.push(i), {
      batches: 4,
      batch: 10,
      warmup: 2,
      // Every clock read advances 500 ns, so each timed batch lasts 500 ns: 50 ns per operation.
      nowNs: () => (clock += 500),
    });
    expect(seen).toHaveLength((2 + 4) * 10);
    expect(seen[59]).toBe(59);
    expect(result).toEqual({ samples: 4, batch: 10, meanNs: 50, p50Ns: 50, p95Ns: 50, p99Ns: 50 });
    expect(() =>
      sampleOps(() => undefined, { batches: 0, batch: 1, warmup: 0, nowNs: () => 0 }),
    ).toThrow(RangeError);
  });

  it('DSA-GEN-09 measureBytesPerEntry reports null without an exposed gc and a per-entry delta with one', () => {
    const plain = measureBytesPerEntry(1_000, () => new Float64Array(1_000));
    expect(plain.value).toHaveLength(1_000);
    if ((globalThis as { gc?: unknown }).gc === undefined)
      expect(plain.bytesPerEntryMeasured).toBeNull();
    expect(measureBytesPerEntry(0, () => 1).bytesPerEntryMeasured).toBeNull();

    const gc = vi.fn();
    vi.stubGlobal('gc', gc);
    try {
      const probed = measureBytesPerEntry(1_000, () => new Float64Array(1_000));
      expect(gc).toHaveBeenCalledTimes(2);
      expect(typeof probed.bytesPerEntryMeasured).toBe('number');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('DSA-GEN-08 DsaError carries its code and NotImplementedError names the module and owner', () => {
    const error = new DsaError('RANGE', 'bad key');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DsaError');
    expect(error.code).toBe('RANGE');
    expect(error.message).toBe('bad key');
    const todo = new NotImplementedError('dsa/heap', 'R1');
    expect(todo.module).toBe('dsa/heap');
    expect(todo.name).toBe('NotImplementedError');
    expect(todo.message).toBe(
      'TODO(R1): implement from first principles — see specs/08-dsa/data-structures.md',
    );
    expectDsaError(() => {
      throw todo;
    }, 'NOT_IMPLEMENTED');
  });
});
