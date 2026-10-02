/**
 * S6 hash table benchmarks (specs/08-dsa/data-structures.md §7, §8.7). Gated on IMPLEMENTED.
 * Workload: 50% get / 25% set / 25% delete over sequential (PID-like) and random keys. Shape
 * (§7.2): flat (≤ 2×) from 10^3 to 10^5; reported next to the built-in Map. Absolute targets
 * (recorded, not asserted): mean ≤ 0.3 µs and not slower than Map by more than 1.5×.
 */
import { describe, it } from 'vitest';

import { measureBytesPerEntry } from '../src/_shared/mem.ts';
import { mulberry32 } from '../src/_shared/prng.ts';
import { IMPLEMENTED, OpenAddressingTable } from '../src/hashtable/index.ts';
import { BATCH, measureCurve, record, recordMemory, SEED, SIZES } from './harness.ts';

type KeyPattern = 'sequential' | 'random';

/**
 * A pool of 2n keys (sequential 1..2n or random), the first n resident, and a BATCH-long mixed
 * workload over the pool: sets and deletes balance, so the size stays near n while sampling.
 */
function workload(
  n: number,
  pattern: KeyPattern,
): { resident: Int32Array; ops: Uint8Array; keys: Int32Array } {
  const rand = mulberry32(SEED);
  const pool = Int32Array.from({ length: 2 * n }, (_, i) =>
    pattern === 'sequential' ? i + 1 : Math.floor(rand() * 2 ** 31),
  );
  const ops = Uint8Array.from({ length: BATCH }, () => {
    const r = rand();
    return r < 0.5 ? 0 : r < 0.75 ? 1 : 2;
  });
  const keys = Int32Array.from({ length: BATCH }, () => pool[Math.floor(rand() * 2 * n)] ?? 0);
  return { resident: pool.subarray(0, n), ops, keys };
}

interface MapLike {
  get(key: number): unknown;
  set(key: number, value: number): unknown;
  delete(key: number): boolean;
}

/** The timed mixed loop, shared by the table and the Map baseline. */
function mixed(target: MapLike, ops: Uint8Array, keys: Int32Array): () => void {
  return () => {
    for (let i = 0; i < BATCH; i++) {
      const k = keys[i] ?? 0;
      const op = ops[i];
      if (op === 0) target.get(k);
      else if (op === 1) target.set(k, i);
      else target.delete(k);
    }
  };
}

describe.runIf(IMPLEMENTED)('dsa/hashtable benchmarks (S6)', () => {
  it('PROC-01 mixed get/set/delete is flat from 10^3 to 10^5 for sequential and random keys and is reported next to Map', async ({
    bench,
    expect,
  }) => {
    for (const pattern of ['sequential', 'random'] as const) {
      const table = await measureCurve(bench, {
        structure: 'hashtable',
        op: 'mixed get/set/delete',
        variant: pattern,
        batch: BATCH,
        shape: { expected: 'O(1)', limit: 2 },
        setup: (n) => {
          const { resident, ops, keys } = workload(n, pattern);
          const t = new OpenAddressingTable<number>(2 * n);
          for (const k of resident) t.set(k, k);
          return mixed(t, ops, keys);
        },
      });
      const map = await measureCurve(bench, {
        structure: 'hashtable',
        op: 'mixed get/set/delete',
        variant: `baseline:Map ${pattern}`,
        batch: BATCH,
        setup: (n) => {
          const { resident, ops, keys } = workload(n, pattern);
          const m = new Map<number, number>();
          for (const k of resident) m.set(k, k);
          return mixed(m, ops, keys);
        },
      });
      table.timings.forEach((t, i) => {
        const vsMap = t.meanNs / (map.timings[i]?.meanNs ?? Number.NaN);
        record({
          structure: 'hashtable',
          variant: pattern,
          op: 'mixed vs Map',
          timing: t,
          budget: {
            metric: 'mean ratio to Map',
            limit: 1.5,
            value: vsMap,
            pass: vsMap <= 1.5,
            hard: false,
          },
        });
      });
      expect(table.ratio).toBeLessThanOrEqual(2);
    }
  });

  it('DSA-GEN-09 hash table bytes per entry at 10^3, 10^4 and 10^5 are recorded', ({ expect }) => {
    for (const n of SIZES) {
      const { value: table, bytesPerEntryMeasured } = measureBytesPerEntry(n, () => {
        const t = new OpenAddressingTable<number>();
        for (let k = 1; k <= n; k++) t.set(k, k);
        return t;
      });
      const rec = recordMemory('hashtable', n, bytesPerEntryMeasured, table.stats());
      // ≤ 48 B/entry excluding the values (§7.2).
      expect(rec.bytesPerEntryAllocated).toBeLessThanOrEqual(48);
    }
  });
});
