/**
 * S5 LRU benchmarks (specs/08-dsa/data-structures.md §7, §8.6). Gated on IMPLEMENTED.
 * Workload: Zipf(s = 1) accesses over n keys; put/evict churn. Shape (§7.2): get (hit),
 * put+evict and pin/unpin grow at most 2× from 10^3 to 10^5; the array-LRU baseline grows linearly.
 * Absolute target: mean ≤ 0.5 µs.
 */
import { describe, it } from 'vitest';

import { measureBytesPerEntry } from '../src/_shared/mem.ts';
import { mulberry32 } from '../src/_shared/prng.ts';
import { IMPLEMENTED, LruCache } from '../src/lru/index.ts';
import { BATCH, measureCurve, recordMemory, SEED, SIZES } from './harness.ts';

/** BATCH keys drawn from Zipf(s = 1) over 0..n−1 by inverse CDF (binary search). */
function zipfKeys(n: number, rand: () => number): Int32Array {
  const cdf = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += 1 / (i + 1);
    cdf[i] = total;
  }
  return Int32Array.from({ length: BATCH }, () => {
    const u = rand() * total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((cdf[mid] ?? 0) < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  });
}

function buildCache(n: number, bounded: boolean): LruCache<number, number> {
  const cache = new LruCache<number, number>(bounded ? { capacity: n } : {});
  for (let k = 0; k < n; k++) cache.put(k, k);
  return cache;
}

/** Naive baseline for contrast (§7.1): an array LRU with indexOf + splice. */
class ArrayLru {
  private readonly keys: number[] = [];
  touch(key: number): void {
    const i = this.keys.indexOf(key);
    if (i >= 0) this.keys.splice(i, 1);
    this.keys.unshift(key);
  }
}

describe.runIf(IMPLEMENTED)('dsa/lru benchmarks (S5)', () => {
  it('MEM-02 get, put+evict and pin/unpin are flat from 10^3 to 10^5 while the array-LRU baseline grows linearly', async ({
    bench,
    expect,
  }) => {
    const get = await measureCurve(bench, {
      structure: 'lru',
      op: 'get (hit, Zipf)',
      batch: BATCH,
      shape: { expected: 'O(1)', limit: 2 },
      setup: (n) => {
        const cache = buildCache(n, false);
        const keys = zipfKeys(n, mulberry32(SEED));
        return () => {
          for (let i = 0; i < BATCH; i++) cache.get(keys[i] ?? 0);
        };
      },
    });
    const putEvict = await measureCurve(bench, {
      structure: 'lru',
      op: 'put+evict (bounded, new keys)',
      batch: BATCH,
      shape: { expected: 'O(1)', limit: 2 },
      setup: (n) => {
        const cache = buildCache(n, true);
        let next = n;
        return () => {
          for (let i = 0; i < BATCH; i++) cache.put(next++, i);
        };
      },
    });
    const pinUnpin = await measureCurve(bench, {
      structure: 'lru',
      op: 'pin+unpin',
      batch: BATCH,
      shape: { expected: 'O(1)', limit: 2 },
      setup: (n) => {
        const cache = buildCache(n, false);
        const keys = zipfKeys(n, mulberry32(SEED));
        return () => {
          for (let i = 0; i < BATCH; i++) {
            const k = keys[i] ?? 0;
            cache.pin(k);
            cache.unpin(k);
          }
        };
      },
    });
    const baseline = await measureCurve(bench, {
      structure: 'lru',
      op: 'touch (Zipf)',
      variant: 'baseline:array-lru',
      batch: 100,
      setup: (n) => {
        const lru = new ArrayLru();
        for (let k = n - 1; k >= 0; k--) lru.touch(k);
        const keys = zipfKeys(n, mulberry32(SEED));
        return () => {
          for (let i = 0; i < 100; i++) lru.touch(keys[i] ?? 0);
        };
      },
    });
    expect(get.ratio).toBeLessThanOrEqual(2);
    expect(putEvict.ratio).toBeLessThanOrEqual(2);
    expect(pinUnpin.ratio).toBeLessThanOrEqual(2);
    if (SIZES.length > 1) expect(baseline.ratio).toBeGreaterThan(get.ratio);
  });

  it('DSA-GEN-09 LRU bytes per entry at 10^3, 10^4 and 10^5 are recorded', ({ expect }) => {
    for (const n of SIZES) {
      const { value: cache, bytesPerEntryMeasured } = measureBytesPerEntry(n, () =>
        buildCache(n, false),
      );
      const rec = recordMemory('lru', n, bytesPerEntryMeasured, cache.stats());
      expect(rec.bytesPerEntryUsed).toBeGreaterThan(0);
    }
  });
});
