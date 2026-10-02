/**
 * S8 Bloom filter: edge cases (specs/08-dsa/data-structures.md §8.9). Gated on IMPLEMENTED (C16).
 */
import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../src/_shared/prng.ts';
import { DoubleHashBloom, IMPLEMENTED } from '../src/bloom/index.ts';
import { expectDsaError } from './helpers.ts';

/** A 32-byte pseudo-random "SHA-256" from a seed. */
function hash(seed: number): Uint8Array {
  const rand = mulberry32(seed);
  return Uint8Array.from({ length: 32 }, () => Math.floor(rand() * 256));
}

describe.runIf(IMPLEMENTED)('dsa/bloom (S8)', () => {
  it('DSA-BLOOM-01 an empty filter reports every hash absent', () => {
    const bloom = new DoubleHashBloom({ nDesign: 1_000 });
    for (let s = 0; s < 1_000; s++) expect(bloom.mayContain(hash(s))).toBe(false);
    expect(bloom.count).toBe(0);
    expect(bloom.bitCount()).toBe(0);
    expect(bloom.expectedFpr()).toBe(0);
    bloom.checkInvariants();
  });

  it('DSA-BLOOM-01 one added hash is reported present', () => {
    const bloom = new DoubleHashBloom({ nDesign: 1_000 });
    const h = hash(1);
    bloom.add(h);
    expect(bloom.mayContain(h)).toBe(true);
    expect(bloom.count).toBe(1);
    expect(bloom.bitCount()).toBeGreaterThanOrEqual(1);
    expect(bloom.bitCount()).toBeLessThanOrEqual(7);
    // Only the first 8 bytes are used: a hash that differs after byte 8 collides by design.
    const tail = Uint8Array.from(h);
    tail[31] = (tail[31] ?? 0) ^ 0xff;
    expect(bloom.mayContain(tail)).toBe(true);
  });

  it('DSA-BLOOM-01 adding the same hash twice leaves the bits unchanged', () => {
    const bloom = new DoubleHashBloom({ nDesign: 1_000 });
    const h = hash(2);
    bloom.add(h);
    const bits = bloom.bitCount();
    bloom.add(h);
    expect(bloom.bitCount()).toBe(bits);
    expect(bloom.count).toBe(2); // count is adds, an upper bound on members
    bloom.checkInvariants();
  });

  it('DSA-BLOOM-01 a hash shorter than 8 bytes and nDesign below 1 throw RANGE', () => {
    const bloom = new DoubleHashBloom({ nDesign: 100 });
    expectDsaError(() => bloom.add(new Uint8Array(7)), 'RANGE');
    expectDsaError(() => bloom.mayContain(new Uint8Array(0)), 'RANGE');
    bloom.add(new Uint8Array(8)); // exactly 8 is enough
    for (const n of [0, -1, 1.5, Number.NaN]) {
      expectDsaError(() => new DoubleHashBloom({ nDesign: n }), 'RANGE');
      expectDsaError(() => bloom.rebuild(n), 'RANGE');
    }
  });

  it('DSA-BLOOM-01 rebuild clears every bit and resizes to 10 bits per key rounded to 32', () => {
    const bloom = new DoubleHashBloom({ nDesign: 100 });
    expect(bloom.nDesign).toBe(100);
    expect(bloom.k).toBe(7);
    expect(bloom.mBits).toBe(1_024); // 1,000 rounded up to a multiple of 32
    for (let s = 0; s < 50; s++) bloom.add(hash(s));
    bloom.rebuild(1_000);
    expect(bloom.nDesign).toBe(1_000);
    expect(bloom.mBits).toBe(10_016);
    expect(bloom.count).toBe(0);
    expect(bloom.bitCount()).toBe(0);
    expect(bloom.mayContain(hash(0))).toBe(false);
    expect(new DoubleHashBloom({ nDesign: 16_384 }).mBits).toBe(163_840);
    expect(new DoubleHashBloom({ nDesign: 1 }).mBits).toBe(32);
    const stats = bloom.stats();
    expect(stats.bytesAllocated).toBe(10_016 / 8);
    bloom.checkInvariants();
  });

  it('DSA-BLOOM-01 h2 is forced odd', () => {
    // Bytes 4..8 are zero, so h2 = 0 before `| 1`. With h2 forced to 1 the seven positions are
    // h1, h1+1, …, h1+6 (mod m): seven distinct bits. Without it all seven would coincide.
    const bloom = new DoubleHashBloom({ nDesign: 100 });
    const h = Uint8Array.from([0x2a, 0x01, 0x00, 0x00, 0, 0, 0, 0]);
    bloom.add(h);
    expect(bloom.bitCount()).toBe(7);
    // An even, non-zero h2 is made odd as well: bytes 4..8 = 2 and 3 give the same positions.
    const even = new DoubleHashBloom({ nDesign: 100 });
    even.add(Uint8Array.from([0x2a, 0x01, 0x00, 0x00, 2, 0, 0, 0]));
    const odd = new DoubleHashBloom({ nDesign: 100 });
    odd.add(Uint8Array.from([0x2a, 0x01, 0x00, 0x00, 3, 0, 0, 0]));
    expect(even.mayContain(Uint8Array.from([0x2a, 0x01, 0x00, 0x00, 3, 0, 0, 0]))).toBe(true);
    expect(odd.mayContain(Uint8Array.from([0x2a, 0x01, 0x00, 0x00, 2, 0, 0, 0]))).toBe(true);
  });

  it('DSA-BLOOM-01 expectedFpr follows (1 − e^(−k·count/m))^k', () => {
    const bloom = new DoubleHashBloom({ nDesign: 16_384 });
    for (let s = 0; s < 16_384; s++) bloom.add(hash(s));
    const expected = (1 - Math.exp((-7 * 16_384) / 163_840)) ** 7;
    expect(bloom.expectedFpr()).toBeCloseTo(expected, 10);
    expect(bloom.expectedFpr()).toBeCloseTo(0.0082, 3);
  });
});
