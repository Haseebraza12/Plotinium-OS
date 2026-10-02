/**
 * S9 z-order list benchmarks (specs/08-dsa/data-structures.md §7, §8.10). Gated on IMPLEMENTED.
 * Window-sized structure: n = 10, 10^2, 10^3 (§7.1). Raise plus renumber is linear in n by
 * specification (WM-02 renumbers 1..n), so the curve is recorded, not shape-asserted. Target
 * (recorded): ≤ 2 µs per raise at n = 64.
 *
 * Added by the implementation: the O(1) parts (insertTop plus remove of the top, zOf, and a raise
 * that renumbers only the two top windows) are shape-asserted flat (≤ 3×) from n = 10 to 1,000,
 * and bytes per window are recorded (DSA-GEN-09).
 */
import { describe, it } from 'vitest';

import { measureBytesPerEntry } from '../src/_shared/mem.ts';
import { mulberry32 } from '../src/_shared/prng.ts';
import { IMPLEMENTED, LinkedZOrder } from '../src/zorder/index.ts';
import { BATCH, measureCurve, record, recordMemory, SEED, WINDOW_SIZES } from './harness.ts';

/** A list of windows 1..n, inserted bottom to top (pre-sized to n unless `initialCapacity` is given). */
function build(n: number, initialCapacity = n): LinkedZOrder {
  const list = new LinkedZOrder(initialCapacity);
  for (let wid = 1; wid <= n; wid++) list.insertTop(wid);
  return list;
}

function fixture(n: number): { list: LinkedZOrder; wids: Int32Array } {
  const list = build(n);
  const rand = mulberry32(SEED);
  return { list, wids: Int32Array.from({ length: BATCH }, () => 1 + Math.floor(rand() * n)) };
}

describe.runIf(IMPLEMENTED)('dsa/zorder benchmarks (S9)', () => {
  it('DSA-ZORD-01 raise plus renumber cost at n = 10, 100 and 1,000 is reported (linear by specification)', async ({
    bench,
  }) => {
    const raise = await measureCurve(bench, {
      structure: 'zorder',
      op: 'raise+renumber (random window)',
      sizes: WINDOW_SIZES,
      batch: BATCH,
      setup: (n) => {
        const { list, wids } = fixture(n);
        return () => {
          for (let i = 0; i < BATCH; i++) list.raise(wids[i] ?? 1);
        };
      },
    });
    record({
      structure: 'zorder',
      op: 'raise+renumber shape',
      timing: raise.timings[raise.timings.length - 1] ?? {
        n: 0,
        samples: 0,
        batch: 0,
        meanNs: 0,
        p50Ns: 0,
        p95Ns: 0,
        p99Ns: 0,
      },
      shape: { expected: 'O(n)', ratio: raise.ratio, limit: Number.POSITIVE_INFINITY, pass: true },
    });
    const at64 = await measureCurve(bench, {
      structure: 'zorder',
      op: 'raise+renumber',
      variant: 'budget n=64',
      sizes: [64],
      batch: BATCH,
      setup: (n) => {
        const { list, wids } = fixture(n);
        return () => {
          for (let i = 0; i < BATCH; i++) list.raise(wids[i] ?? 1);
        };
      },
    });
    const t = at64.timings[0];
    if (t !== undefined) {
      record({
        structure: 'zorder',
        op: 'raise budget',
        timing: t,
        budget: {
          metric: 'mean ns per raise at n = 64',
          limit: 2_000,
          value: t.meanNs,
          pass: t.meanNs <= 2_000,
          hard: false,
        },
      });
    }
  });

  it('DSA-ZORD-01 insertTop plus remove of the top, zOf and a raise just below the top stay flat from n = 10 to 1,000 (O(1) relink)', async ({
    bench,
    expect,
  }) => {
    // insertTop, then remove of that new top: link and unlink at the tail, no window renumbered.
    const insertRemove = await measureCurve(bench, {
      structure: 'zorder',
      op: 'insertTop+remove (top)',
      sizes: WINDOW_SIZES,
      batch: BATCH,
      shape: { expected: 'O(1)', limit: 3 },
      setup: (n) => {
        const list = build(n);
        const extra = n + 1;
        return () => {
          for (let i = 0; i < BATCH; i++) {
            list.insertTop(extra);
            list.remove(extra);
          }
        };
      },
    });
    // zOf of a random window: one S6 lookup and one array read.
    let sink = 0;
    const zOf = await measureCurve(bench, {
      structure: 'zorder',
      op: 'zOf (random window)',
      sizes: WINDOW_SIZES,
      batch: BATCH,
      shape: { expected: 'O(1)', limit: 3 },
      setup: (n) => {
        const { list, wids } = fixture(n);
        return () => {
          for (let i = 0; i < BATCH; i++) sink += list.zOf(wids[i] ?? 1) ?? 0;
        };
      },
    });
    // Alternately raise windows n − 1 and n: each raise relinks one slot and renumbers exactly the
    // two top windows, so the cost depends on n − p (here 1), not on n.
    const nearTop = await measureCurve(bench, {
      structure: 'zorder',
      op: 'raise (second from top)',
      sizes: WINDOW_SIZES,
      batch: BATCH,
      shape: { expected: 'O(1)', limit: 3 },
      setup: (n) => {
        const list = build(n);
        return () => {
          for (let i = 0; i < BATCH; i++) list.raise(i % 2 === 0 ? n - 1 : n);
        };
      },
    });
    expect(sink).toBeGreaterThan(0);
    expect(insertRemove.ratio).toBeLessThanOrEqual(3);
    expect(zOf.ratio).toBeLessThanOrEqual(3);
    expect(nearTop.ratio).toBeLessThanOrEqual(3);
  });

  it('DSA-GEN-09 zorder bytes per window at n = 10, 100 and 1,000 (and 10^4, 10^5 to show the flat curve) are recorded', ({
    expect,
  }) => {
    // Built from the default capacity (16), as the compositor does, so the slot arrays and the S6
    // table grow by doubling. 10^4 and 10^5 windows are not a realistic desktop (§7.1); they only
    // show that the bytes per window stay flat as n grows.
    for (const n of [...WINDOW_SIZES, 10_000, 100_000]) {
      const { value: list, bytesPerEntryMeasured } = measureBytesPerEntry(n, () => build(n, 16));
      const rec = recordMemory('zorder', n, bytesPerEntryMeasured, list.stats());
      expect(list.size).toBe(n);
      expect(rec.bytesPerEntryUsed).toBeGreaterThan(0);
    }
  });
});
