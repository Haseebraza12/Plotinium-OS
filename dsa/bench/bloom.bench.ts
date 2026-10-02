/**
 * S8 Bloom filter benchmarks (specs/08-dsa/data-structures.md §7, §8.9). Gated on IMPLEMENTED.
 * Workload: random 32-byte hashes (seed 42), n = nDesign. Shape (§7.2): add and mayContain flat
 * (≤ 2×) from 10^3 to 10^5; memory 1.25 bytes per key at design load. Target (recorded): ≤ 200 ns.
 */
import { describe, it } from 'vitest';

import { mulberry32 } from '../src/_shared/prng.ts';
import { DoubleHashBloom, IMPLEMENTED } from '../src/bloom/index.ts';
import { BATCH, measureCurve, recordMemory, SEED, SIZES } from './harness.ts';

/** `count` random 32-byte hashes packed in one buffer, returned as views. */
function hashes(count: number, seed: number): Uint8Array[] {
  const rand = mulberry32(seed);
  const buf = Uint8Array.from({ length: count * 32 }, () => Math.floor(rand() * 256));
  return Array.from({ length: count }, (_, i) => buf.subarray(i * 32, i * 32 + 32));
}

function filled(n: number): DoubleHashBloom {
  const bloom = new DoubleHashBloom({ nDesign: n });
  for (const h of hashes(n, SEED)) bloom.add(h);
  return bloom;
}

describe.runIf(IMPLEMENTED)('dsa/bloom benchmarks (S8)', () => {
  it('DSA-BLOOM-01 add and mayContain are flat from 10^3 to 10^5 at 1.25 bytes per key', async ({
    bench,
    expect,
  }) => {
    const add = await measureCurve(bench, {
      structure: 'bloom',
      op: 'add',
      batch: BATCH,
      shape: { expected: 'O(1)', limit: 2 },
      setup: (n) => {
        const bloom = filled(n);
        const extra = hashes(BATCH, SEED + 1);
        return () => {
          for (let i = 0; i < BATCH; i++) bloom.add(extra[i] ?? new Uint8Array(32));
        };
      },
    });
    const query = await measureCurve(bench, {
      structure: 'bloom',
      op: 'mayContain (50% members)',
      batch: BATCH,
      shape: { expected: 'O(1)', limit: 2 },
      setup: (n) => {
        const bloom = filled(n);
        const members = hashes(Math.min(n, BATCH), SEED);
        const others = hashes(BATCH, SEED + 2);
        const probes = Array.from(
          { length: BATCH },
          (_, i) => (i % 2 === 0 ? members[i % members.length] : others[i]) ?? new Uint8Array(32),
        );
        return () => {
          for (let i = 0; i < BATCH; i++) bloom.mayContain(probes[i] ?? new Uint8Array(32));
        };
      },
    });
    expect(add.ratio).toBeLessThanOrEqual(2);
    expect(query.ratio).toBeLessThanOrEqual(2);
  });

  it('DSA-GEN-09 Bloom bytes per key at 10^3, 10^4 and 10^5 are recorded', ({ expect }) => {
    for (const n of SIZES) {
      const bloom = filled(n);
      const rec = recordMemory('bloom', n, null, bloom.stats());
      // m = 10 · n bits rounded up to 32: 1.25 bytes per key plus at most 4 bytes in total.
      expect(rec.bytesPerEntryAllocated).toBeLessThanOrEqual(1.25 + 4 / n);
    }
  });
});
