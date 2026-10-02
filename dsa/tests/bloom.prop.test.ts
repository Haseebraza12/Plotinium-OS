/**
 * S8 Bloom filter: property tests (specs/08-dsa/data-structures.md §8.9). Gated on IMPLEMENTED.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../src/_shared/prng.ts';
import { DoubleHashBloom, IMPLEMENTED } from '../src/bloom/index.ts';
import { PROP } from './helpers.ts';

/** A stream of 32-byte pseudo-random hashes (SHA-256 output is uniform). */
function hashes(seed: number, count: number): Uint8Array[] {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, () =>
    Uint8Array.from({ length: 32 }, () => Math.floor(rand() * 256)),
  );
}

describe.runIf(IMPLEMENTED)('dsa/bloom properties (S8)', () => {
  it('DSA-BLOOM-01 no false negatives for random hash sets', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ size: 'max', minLength: 8, maxLength: 32 }), {
          size: 'max',
          maxLength: 300,
        }),
        fc.integer({ min: 1, max: 500 }),
        (members, nDesign) => {
          const bloom = new DoubleHashBloom({ nDesign });
          let bits = 0;
          let decreased = false;
          for (const h of members) {
            bloom.add(h);
            const now = bloom.bitCount();
            decreased ||= now < bits; // BF2
            bits = now;
          }
          expect(decreased).toBe(false);
          expect(members.filter((h) => !bloom.mayContain(h))).toEqual([]); // BF1
          expect(bloom.count).toBe(members.length);
          bloom.checkInvariants();
        },
      ),
      PROP,
    );
  });

  it('DSA-BLOOM-01 empirical false-positive rate over 10^5 non-members at n_design is between 0.4% and 1.3%', () => {
    const nDesign = 16_384;
    const bloom = new DoubleHashBloom({ nDesign });
    for (const h of hashes(1, nDesign)) bloom.add(h);
    const trials = Number(process.env['PLT_BLOOM_TRIALS'] ?? 100_000); // nightly: 10^6, 0.6–1.05%
    const rand = mulberry32(2);
    const probe = new Uint8Array(32);
    let falsePositives = 0;
    for (let t = 0; t < trials; t++) {
      for (let i = 0; i < 32; i++) probe[i] = Math.floor(rand() * 256);
      if (bloom.mayContain(probe)) falsePositives++;
    }
    const rate = falsePositives / trials;
    const [low, high] = trials >= 1_000_000 ? [0.006, 0.0105] : [0.004, 0.013];
    expect(rate).toBeGreaterThanOrEqual(low);
    expect(rate).toBeLessThanOrEqual(high);
  });
});
