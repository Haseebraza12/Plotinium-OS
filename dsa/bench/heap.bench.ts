/**
 * S3 binary heap benchmarks (specs/08-dsa/data-structures.md §7, §8.4). Gated on IMPLEMENTED.
 * Shape (§7.2): pop+push, changePriority and remove grow at most 3× from 10^3 to 10^5 (a log curve
 * gives about 1.7×); the sorted-array baseline grows linearly. Absolute target: mean ≤ 1 µs at 10^5.
 */
import { describe, it } from 'vitest';

import { measureBytesPerEntry } from '../src/_shared/mem.ts';
import { mulberry32 } from '../src/_shared/prng.ts';
import { BinaryHeap, IMPLEMENTED } from '../src/heap/index.ts';
import { BATCH, measureCurve, recordMemory, SEED, SIZES } from './harness.ts';

/** A heap of n handles 0..n−1 with uniform keys. */
function buildHeap(n: number, rand: () => number): BinaryHeap {
  const heap = new BinaryHeap(n);
  for (let h = 0; h < n; h++) heap.push(h, rand());
  return heap;
}

/** buildHeap plus BATCH precomputed operands. */
function fixture(n: number): { heap: BinaryHeap; handles: Int32Array; keys: Float64Array } {
  const rand = mulberry32(SEED);
  const heap = buildHeap(n, rand);
  const handles = Int32Array.from({ length: BATCH }, () => Math.floor(rand() * n));
  const keys = Float64Array.from({ length: BATCH }, () => rand());
  return { heap, handles, keys };
}

/** Naive baseline for contrast (§7.1): a sorted array with binary-search insert and shift. */
class SortedArrayQueue {
  private readonly keys: number[] = [];
  push(key: number): void {
    let lo = 0;
    let hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.keys[mid] ?? 0) < key) lo = mid + 1;
      else hi = mid;
    }
    this.keys.splice(lo, 0, key);
  }
  pop(): number | undefined {
    return this.keys.shift();
  }
}

describe.runIf(IMPLEMENTED)('dsa/heap benchmarks (S3)', () => {
  it('PROC-02 pop+push and changePriority grow at most 3x from 10^3 to 10^5', async ({
    bench,
    expect,
  }) => {
    const popPush = await measureCurve(bench, {
      structure: 'heap',
      op: 'pop+push',
      batch: BATCH,
      shape: { expected: 'O(log n)', limit: 3 },
      setup: (n) => {
        const { heap, keys } = fixture(n);
        return () => {
          for (let i = 0; i < BATCH; i++) heap.push(heap.pop() ?? 0, keys[i] ?? 0);
        };
      },
    });
    const change = await measureCurve(bench, {
      structure: 'heap',
      op: 'changePriority',
      batch: BATCH,
      shape: { expected: 'O(log n)', limit: 3 },
      setup: (n) => {
        const { heap, handles, keys } = fixture(n);
        return () => {
          for (let i = 0; i < BATCH; i++) heap.changePriority(handles[i] ?? 0, keys[i] ?? 0);
        };
      },
    });
    const remove = await measureCurve(bench, {
      structure: 'heap',
      op: 'remove+push',
      batch: BATCH,
      shape: { expected: 'O(log n)', limit: 3 },
      setup: (n) => {
        const { heap, handles, keys } = fixture(n);
        return () => {
          for (let i = 0; i < BATCH; i++) {
            const h = handles[i] ?? 0;
            if (heap.remove(h)) heap.push(h, keys[i] ?? 0);
          }
        };
      },
    });
    expect(popPush.ratio).toBeLessThanOrEqual(3);
    expect(change.ratio).toBeLessThanOrEqual(3);
    expect(remove.ratio).toBeLessThanOrEqual(3);
  });

  it('PROC-02 pop+push at the scheduler size n = 256 is recorded', async ({ bench }) => {
    await measureCurve(bench, {
      structure: 'heap',
      op: 'pop+push',
      variant: 'scheduler',
      sizes: [256],
      batch: BATCH,
      setup: (n) => {
        const { heap, keys } = fixture(n);
        return () => {
          for (let i = 0; i < BATCH; i++) heap.push(heap.pop() ?? 0, keys[i] ?? 0);
        };
      },
    });
  });

  it('DSA-HEAP-01 a sorted-array queue baseline grows linearly', async ({ bench, expect }) => {
    const heapCurve = await measureCurve(bench, {
      structure: 'heap',
      op: 'push+pop',
      batch: 100,
      setup: (n) => {
        const { heap, keys } = fixture(n);
        return () => {
          for (let i = 0; i < 100; i++) heap.push(heap.pop() ?? 0, keys[i] ?? 0);
        };
      },
    });
    const baseline = await measureCurve(bench, {
      structure: 'heap',
      op: 'push+pop',
      variant: 'baseline:sorted-array',
      batch: 100,
      setup: (n) => {
        const rand = mulberry32(SEED);
        const q = new SortedArrayQueue();
        for (let i = 0; i < n; i++) q.push(rand());
        return () => {
          for (let i = 0; i < 100; i++) {
            q.pop();
            q.push(rand());
          }
        };
      },
    });
    if (SIZES.length > 1) expect(baseline.ratio).toBeGreaterThan(heapCurve.ratio);
  });

  it('DSA-GEN-09 heap bytes per entry at 10^3, 10^4 and 10^5 are recorded', ({ expect }) => {
    for (const n of SIZES) {
      const { value: heap, bytesPerEntryMeasured } = measureBytesPerEntry(n, () =>
        buildHeap(n, mulberry32(SEED)),
      );
      const rec = recordMemory('heap', n, bytesPerEntryMeasured, heap.stats());
      expect(rec.bytesPerEntryUsed).toBeGreaterThan(0);
    }
  });
});
