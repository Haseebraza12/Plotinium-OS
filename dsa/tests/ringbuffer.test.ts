/**
 * S7 ring buffers: edge cases (specs/08-dsa/data-structures.md §8.8). Gated on IMPLEMENTED (C16).
 */
import { describe, expect, it } from 'vitest';

import { ByteRingBuffer, Float64Ring, IMPLEMENTED, RingBuffer } from '../src/ringbuffer/index.ts';
import type { RingMode } from '../src/ringbuffer/index.ts';
import { expectDsaError } from './helpers.ts';

const bytes = (...xs: number[]): Uint8Array => Uint8Array.from(xs);

describe.runIf(IMPLEMENTED)('dsa/ringbuffer (S7)', () => {
  it('DSA-RING-01 shift and peek on an empty ring return undefined', () => {
    const ring = new RingBuffer<string>(4);
    expect(ring.shift()).toBeUndefined();
    expect(ring.peekOldest()).toBeUndefined();
    expect(ring.peekNewest()).toBeUndefined();
    expect(ring.at(0)).toBeUndefined();
    expect(ring.size).toBe(0);
    expect(ring.capacity).toBe(4);
    expect(ring.mode).toBe('overwrite');
    expect(ring.toArray()).toEqual([]);
    expect([...ring]).toEqual([]);
    ring.checkInvariants();
  });

  it('DSA-RING-01 a capacity-1 ring holds exactly the newest element in overwrite mode', () => {
    const ring = new RingBuffer<number>(1);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    expect(ring.size).toBe(1);
    expect(ring.toArray()).toEqual([3]);
    expect(ring.peekOldest()).toBe(3);
    expect(ring.peekNewest()).toBe(3);
    expect(ring.dropped).toBe(2);
    expect(ring.head).toBe(0);
    ring.checkInvariants();
  });

  it('DSA-RING-01 filling exactly to capacity keeps every element and dropped is 0', () => {
    const ring = new RingBuffer<number>(8);
    for (let i = 0; i < 8; i++) ring.push(i);
    expect(ring.size).toBe(8);
    expect(ring.dropped).toBe(0);
    expect(ring.toArray()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(ring.peekOldest()).toBe(0);
    expect(ring.peekNewest()).toBe(7);
    ring.checkInvariants();
  });

  it('DSA-RING-01 overwrite mode replaces the oldest and counts dropped', () => {
    const ring = new RingBuffer<number>(4);
    for (let i = 0; i < 6; i++) ring.push(i);
    expect(ring.toArray()).toEqual([2, 3, 4, 5]);
    expect(ring.dropped).toBe(2);
    expect(ring.tryPush(6)).toBe(true);
    expect(ring.toArray()).toEqual([3, 4, 5, 6]);
    expect(ring.dropped).toBe(3);
    expect(ring.shift()).toBe(3);
    expect(ring.size).toBe(3);
    ring.checkInvariants();
  });

  it('DSA-RING-01 reject mode throws FULL on push and tryPush returns false', () => {
    const ring = new RingBuffer<number>(2, 'reject');
    expect(ring.mode).toBe('reject');
    ring.push(1);
    expect(ring.tryPush(2)).toBe(true);
    expectDsaError(() => ring.push(3), 'FULL');
    expect(ring.tryPush(3)).toBe(false);
    expect(ring.toArray()).toEqual([1, 2]);
    expect(ring.dropped).toBe(0);
    expect(ring.shift()).toBe(1);
    ring.push(3);
    expect(ring.toArray()).toEqual([2, 3]);
    ring.checkInvariants();
  });

  it('DSA-RING-01 wrapping around 10^6 times keeps head within range', () => {
    const ring = new RingBuffer<number>(8);
    for (let i = 0; i < 8_000_000; i++) ring.push(i);
    expect(ring.dropped).toBe(8_000_000 - 8);
    expect(ring.head).toBeGreaterThanOrEqual(0);
    expect(ring.head).toBeLessThan(8);
    expect(ring.toArray()).toEqual([
      7_999_992, 7_999_993, 7_999_994, 7_999_995, 7_999_996, 7_999_997, 7_999_998, 7_999_999,
    ]);
    for (let i = 0; i < 1_000_000; i++) {
      ring.shift();
      ring.push(i);
    }
    expect(ring.head).toBeLessThan(8);
    ring.checkInvariants();
  });

  it('DSA-RING-01 at() outside the range returns undefined', () => {
    const ring = new RingBuffer<string>(4);
    ring.push('a');
    ring.push('b');
    expect(ring.at(0)).toBe('a');
    expect(ring.at(1)).toBe('b');
    for (const i of [-1, 2, 3, 4, 1.5, Number.NaN]) expect(ring.at(i)).toBeUndefined();
  });

  it('DSA-RING-01 a capacity that is not a power of two throws RANGE', () => {
    for (const capacity of [0, 3, 6, 1000, -4, 2.5]) {
      expectDsaError(() => new RingBuffer<number>(capacity), 'RANGE');
      expectDsaError(() => new Float64Ring(capacity), 'RANGE');
      expectDsaError(() => new ByteRingBuffer(capacity), 'RANGE');
    }
    expect(new RingBuffer<number>(1024).capacity).toBe(1024);
  });

  it('DSA-RING-01 ByteRing partial write when nearly full, short read into a small buffer, zero-length read and write, and split copies across the wrap', () => {
    const pipe = new ByteRingBuffer(8);
    expect(pipe.capacity).toBe(8);
    expect(pipe.read(new Uint8Array(4))).toBe(0); // empty
    expect(pipe.write(new Uint8Array(0))).toBe(0);
    expect(pipe.write(bytes(1, 2, 3, 4, 5, 6))).toBe(6);
    expect(pipe.available).toBe(6);
    expect(pipe.free).toBe(2);

    const four = new Uint8Array(4);
    expect(pipe.read(four)).toBe(4);
    expect([...four]).toEqual([1, 2, 3, 4]);

    // 7 offered, 6 accepted; the write wraps: slots 6 and 7, then 0 to 3.
    expect(pipe.write(bytes(7, 8, 9, 10, 11, 12, 13))).toBe(6);
    expect(pipe.available).toBe(8);
    expect(pipe.free).toBe(0);
    expect(pipe.write(bytes(99))).toBe(0);
    expect(pipe.read(new Uint8Array(0))).toBe(0);

    const three = new Uint8Array(3);
    expect(pipe.read(three)).toBe(3);
    expect([...three]).toEqual([5, 6, 7]);
    const big = new Uint8Array(16);
    expect(pipe.read(big)).toBe(5); // the read wraps too
    expect([...big.subarray(0, 5)]).toEqual([8, 9, 10, 11, 12]);
    expect(pipe.available).toBe(0);
    expect(pipe.free).toBe(8);
    pipe.checkInvariants();
  });

  it('DSA-RING-01 slotOf maps logical indices to physical slots for the telemetry mirror', () => {
    const ring = new RingBuffer<string>(4);
    for (const x of ['a', 'b', 'c', 'd', 'e', 'f']) ring.push(x);
    expect(ring.head).toBe(2);
    expect([0, 1, 2, 3].map((i) => ring.slotOf(i))).toEqual([2, 3, 0, 1]);
    expect(ring.at(2)).toBe('e');
    expectDsaError(() => ring.slotOf(4), 'RANGE');
    expectDsaError(() => ring.slotOf(-1), 'RANGE');
  });

  it('DSA-RING-01 Float64Ring keeps the newest frame durations and reports nearest-rank percentiles', () => {
    const meter = new Float64Ring(4);
    expect(meter.percentile(0.95)).toBeUndefined();
    for (const ms of [16, 17, 33, 16, 18]) meter.push(ms);
    expect(meter.toArray()).toEqual([17, 33, 16, 18]);
    expect(meter.dropped).toBe(1);
    expect(meter.percentile(0.5)).toBe(17);
    expect(meter.percentile(0.95)).toBe(33);
    expect(meter.percentile(1)).toBe(33);
    expect(meter.toArray()).toEqual([17, 33, 16, 18]); // percentile does not reorder the ring
    expectDsaError(() => meter.percentile(0), 'RANGE');
    expectDsaError(() => meter.percentile(1.5), 'RANGE');
    meter.checkInvariants();
  });

  it('DSA-RING-01 clear empties the ring and keeps it usable', () => {
    const ring = new RingBuffer<number>(4);
    for (let i = 0; i < 6; i++) ring.push(i);
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.toArray()).toEqual([]);
    ring.push(9);
    expect(ring.toArray()).toEqual([9]);
    expect(ring.stats().size).toBe(1);
    ring.checkInvariants();
  });

  // Added with the implementation: the frame meter's Float64Ring had only one test, and these cover
  // its whole Ring API, iteration after a wrap, exact stats() and an unknown mode.
  it('DSA-RING-01 Float64Ring supports the whole Ring API in reject mode, iteration follows toArray after a wrap, and stats() is exact', () => {
    const meter = new Float64Ring(4, 'reject');
    expect(meter.mode).toBe('reject');
    expect(meter.shift()).toBeUndefined();
    expect([meter.peekOldest(), meter.peekNewest(), meter.at(0)]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    for (const ms of [16.5, 17.25, 33, -0]) meter.push(ms);
    expectDsaError(() => meter.push(1), 'FULL');
    expect(meter.tryPush(1)).toBe(false);
    expect([meter.peekOldest(), meter.peekNewest(), meter.at(1), meter.at(4)]).toEqual([
      16.5,
      -0,
      17.25,
      undefined,
    ]);
    expect(meter.shift()).toBe(16.5);
    expect(meter.tryPush(18)).toBe(true); // wraps into slot 0
    expect(meter.slotOf(3)).toBe(0);
    expect([...meter]).toEqual(meter.toArray());
    expect(meter.toArray()).toEqual([17.25, 33, -0, 18]);
    expect(meter.dropped).toBe(0);
    expect(meter.stats()).toEqual({ size: 4, capacity: 4, bytesAllocated: 32, bytesUsed: 32 });
    meter.checkInvariants();
    meter.clear();
    expect([meter.size, meter.toArray(), meter.percentile(0.5)]).toEqual([0, [], undefined]);
    meter.checkInvariants();

    const ring = new RingBuffer<string>(4);
    for (const x of ['a', 'b', 'c', 'd', 'e']) ring.push(x);
    expect([...ring]).toEqual(['b', 'c', 'd', 'e']);
    expect(ring.stats()).toEqual({ size: 4, capacity: 4, bytesAllocated: 32, bytesUsed: 32 });

    const pipe = new ByteRingBuffer(8);
    pipe.write(bytes(1, 2, 3));
    expect(pipe.stats()).toEqual({ size: 3, capacity: 8, bytesAllocated: 8, bytesUsed: 3 });

    expectDsaError(() => new RingBuffer<number>(4, 'drop' as RingMode), 'INVALID');
    expectDsaError(() => new Float64Ring(4, 'drop' as RingMode), 'INVALID');
  });

  it('DSA-RING-01 Float64Ring nearest-rank percentile is exact where q·n rounds past an integer (0.3 · 10 = 3.0000000000000004)', () => {
    // For the values 1..n, the nearest-rank percentile at q = k/n is exactly k. A plain
    // Math.ceil(q · n) gets this wrong whenever the product rounds up (for example k = 3, n = 10).
    for (let n = 1; n <= 64; n *= 2) {
      for (const size of [n, Math.max(1, n - 3)]) {
        const meter = new Float64Ring(n);
        for (let v = size; v >= 1; v--) meter.push(v); // pushed in descending order, so the sort matters
        for (let k = 1; k <= size; k++) expect(meter.percentile(k / size)).toBe(k);
      }
    }
    const ten = new Float64Ring(16);
    for (let v = 1; v <= 10; v++) ten.push(v);
    expect([0.1, 0.3, 0.7, 0.95, 1].map((q) => ten.percentile(q))).toEqual([1, 3, 7, 10, 10]);
    expectDsaError(() => ten.percentile(Number.NaN), 'RANGE');
    expectDsaError(() => ten.percentile(-0.5), 'RANGE');
  });
});
