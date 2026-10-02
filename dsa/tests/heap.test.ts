/**
 * S3 binary heap: edge cases (specs/08-dsa/data-structures.md §8.4). Gated on IMPLEMENTED (C16).
 */
import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../src/_shared/prng.ts';
import { BinaryHeap, BoundedTopKHeap, HeapPriorityQueue, IMPLEMENTED } from '../src/heap/index.ts';
import { expectDsaError } from './helpers.ts';

/** Pop everything, returning the handles in pop order. */
function drain(heap: BinaryHeap): number[] {
  const out: number[] = [];
  for (let h = heap.pop(); h !== undefined; h = heap.pop()) out.push(h);
  return out;
}

/** Pop everything, returning the keys in pop order. */
function drainKeys(heap: BinaryHeap): number[] {
  const out: number[] = [];
  for (let k = heap.peekKey(); k !== undefined; k = heap.peekKey()) {
    out.push(k);
    heap.pop();
  }
  return out;
}

const ascending = (a: number, b: number): number => a - b;

describe.runIf(IMPLEMENTED)('dsa/heap (S3)', () => {
  it('DSA-HEAP-01 pop, peek and peekKey on an empty heap return undefined', () => {
    const heap = new BinaryHeap();
    expect(heap.pop()).toBeUndefined();
    expect(heap.peek()).toBeUndefined();
    expect(heap.peekKey()).toBeUndefined();
    expect(heap.size).toBe(0);
    expect(heap.has(0)).toBe(false);
    expect(heap.keyOf(0)).toBeUndefined();
    expect(heap.remove(0)).toBe(false);
    heap.checkInvariants();
  });

  it('DSA-HEAP-01 push then pop of one handle returns it and leaves the heap empty', () => {
    const heap = new BinaryHeap();
    heap.push(7, 3.5);
    expect(heap.size).toBe(1);
    expect(heap.peek()).toBe(7);
    expect(heap.peekKey()).toBe(3.5);
    expect(heap.has(7)).toBe(true);
    expect(heap.keyOf(7)).toBe(3.5);
    expect(heap.pop()).toBe(7);
    expect(heap.size).toBe(0);
    expect(heap.has(7)).toBe(false);
    expect(heap.pop()).toBeUndefined();
    heap.checkInvariants();
  });

  it('DSA-HEAP-01 100 equal keys are all popped exactly once', () => {
    const heap = new BinaryHeap();
    for (let h = 0; h < 100; h++) heap.push(h, 5);
    const popped = drain(heap);
    expect(popped).toHaveLength(100);
    expect([...popped].sort(ascending)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('DSA-HEAP-01 pushing a handle already present throws DUPLICATE', () => {
    const heap = new BinaryHeap();
    heap.push(3, 1);
    expectDsaError(() => heap.push(3, 2), 'DUPLICATE');
    expect(heap.size).toBe(1);
    expect(heap.keyOf(3)).toBe(1);
    heap.checkInvariants();
  });

  it('DSA-HEAP-01 NaN or infinite keys and negative handles throw RANGE', () => {
    const heap = new BinaryHeap();
    for (const key of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expectDsaError(() => heap.push(1, key), 'RANGE');
    }
    expectDsaError(() => heap.push(-1, 0), 'RANGE');
    expectDsaError(() => heap.push(1.5, 0), 'RANGE');
    expect(heap.size).toBe(0);
    heap.push(1, 0);
    expectDsaError(() => heap.changePriority(1, Number.NaN), 'RANGE');
    expect(heap.keyOf(1)).toBe(0);
    heap.checkInvariants();
  });

  it('PROC-02 changePriority on an absent handle returns false', () => {
    const heap = new BinaryHeap();
    expect(heap.changePriority(4, 1)).toBe(false);
    heap.push(1, 1);
    expect(heap.changePriority(4, 1)).toBe(false);
    expect(heap.size).toBe(1);
  });

  it('PROC-02 changePriority to the same key leaves the order unchanged', () => {
    const heap = new BinaryHeap();
    for (let h = 0; h < 10; h++) heap.push(h, h * 10);
    expect(heap.changePriority(5, 50)).toBe(true);
    heap.checkInvariants();
    expect(drain(heap)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("PROC-02 decreasing a leaf's key to the minimum makes it the next pop", () => {
    const heap = new BinaryHeap();
    // Ascending pushes never sift, so handle 15 sits at the last position: a leaf.
    for (let h = 0; h < 16; h++) heap.push(h, 100 + h);
    expect(heap.changePriority(15, 0)).toBe(true);
    heap.checkInvariants();
    expect(heap.peek()).toBe(15);
    expect(heap.pop()).toBe(15);
    expect(heap.pop()).toBe(0);
  });

  it("PROC-02 increasing the root's key moves it below its children", () => {
    const heap = new BinaryHeap();
    for (let h = 0; h < 7; h++) heap.push(h, h + 1);
    expect(heap.peek()).toBe(0);
    expect(heap.changePriority(0, 100)).toBe(true);
    heap.checkInvariants();
    expect(heap.peek()).toBe(1);
    expect(drain(heap)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it('DSA-HEAP-02 remove of the root, the last element, a middle element and the only element keep the heap valid', () => {
    const heap = new BinaryHeap();
    // Ascending keys: the heap array is exactly the push order, so positions are known.
    for (let h = 0; h < 10; h++) heap.push(h, h);
    expect(heap.remove(9)).toBe(true); // last position
    heap.checkInvariants();
    expect(heap.remove(4)).toBe(true); // middle
    heap.checkInvariants();
    expect(heap.remove(0)).toBe(true); // root
    heap.checkInvariants();
    expect(heap.remove(0)).toBe(false);
    expect(drain(heap)).toEqual([1, 2, 3, 5, 6, 7, 8]);

    heap.push(42, 1);
    expect(heap.remove(42)).toBe(true); // only element
    expect(heap.size).toBe(0);
    expect(heap.pop()).toBeUndefined();
    heap.checkInvariants();

    // Heap array [0, 10, 1, 11, 12, 2, 3] (handle = key): removing 11 moves 3 under 10, which
    // needs a sift UP, not down.
    for (const k of [0, 10, 1, 11, 12, 2, 3]) heap.push(k, k);
    expect(heap.remove(11)).toBe(true);
    heap.checkInvariants();
    expect(drain(heap)).toEqual([0, 1, 2, 3, 10, 12]);
  });

  it('DSA-HEAP-02 replaceTop on an empty heap behaves as push', () => {
    const heap = new BinaryHeap();
    expect(heap.replaceTop(7, 3)).toBeUndefined();
    expect(heap.size).toBe(1);
    expect(heap.peek()).toBe(7);
    expect(heap.peekKey()).toBe(3);

    heap.push(8, 5);
    expect(heap.replaceTop(9, 10)).toBe(7);
    expect(heap.has(7)).toBe(false);
    heap.checkInvariants();
    expect(heap.replaceTop(8, 20)).toBe(8); // the popped minimum may be pushed back at once
    expect(heap.keyOf(8)).toBe(20);
    heap.checkInvariants();
    expect(drain(heap)).toEqual([9, 8]);
  });

  it('DSA-HEAP-01 handles beyond the index-map capacity grow the map', () => {
    const heap = new BinaryHeap(4);
    heap.push(3, 3);
    heap.push(1_000, 1);
    heap.push(100_000, 2);
    expect(heap.has(100_000)).toBe(true);
    expect(heap.has(99_999)).toBe(false);
    heap.checkInvariants();
    expect(drain(heap)).toEqual([1_000, 100_000, 3]);
  });

  it('DSA-HEAP-01 growth from capacity 1 to 2^17 keeps every entry', () => {
    const n = 2 ** 17;
    const heap = new BinaryHeap(1);
    const rand = mulberry32(42);
    const keys = Array.from({ length: n }, () => Math.floor(rand() * 1e9));
    keys.forEach((k, h) => heap.push(h, k));
    expect(heap.size).toBe(n);
    heap.checkInvariants();
    const seen = new Uint8Array(n);
    let previous = Number.NEGATIVE_INFINITY;
    for (let h = heap.pop(); h !== undefined; h = heap.pop()) {
      const key = keys[h] ?? Number.NaN;
      expect(key).toBeGreaterThanOrEqual(previous);
      previous = key;
      seen[h] = (seen[h] ?? 0) + 1;
    }
    expect(seen.every((count) => count === 1)).toBe(true);
  });

  it('DSA-HEAP-01 clear empties the heap and handles can be reused', () => {
    const heap = new BinaryHeap();
    for (let h = 0; h < 20; h++) heap.push(h, 20 - h);
    heap.clear();
    expect(heap.size).toBe(0);
    expect(heap.pop()).toBeUndefined();
    for (let h = 0; h < 20; h++) expect(heap.has(h)).toBe(false);
    heap.checkInvariants();
    heap.push(5, 1);
    heap.push(6, 0);
    expect(drain(heap)).toEqual([6, 5]);
  });

  it('DSA-HEAP-01 ascending, descending and random inputs pop in ascending key order', () => {
    const rand = mulberry32(42);
    const inputs = [
      Array.from({ length: 500 }, (_, i) => i),
      Array.from({ length: 500 }, (_, i) => 500 - i),
      Array.from({ length: 500 }, () => rand() * 1000 - 500),
    ];
    for (const keys of inputs) {
      const heap = new BinaryHeap();
      keys.forEach((k, h) => heap.push(h, k));
      expect(drainKeys(heap)).toEqual([...keys].sort(ascending));
    }
  });

  it('PROC-02 scheduler keys effPrio·2^32 + seq stay exact and ordered at effPrio 39 and seq 2^32 − 1', () => {
    const key = (effPrio: number, seq: number): number => effPrio * 2 ** 32 + seq;
    const heap = new BinaryHeap();
    heap.push(1, key(39, 2 ** 32 - 1));
    heap.push(2, key(39, 2 ** 32 - 2));
    heap.push(3, key(38, 2 ** 32 - 1));
    heap.push(4, key(0, 0));
    heap.push(5, key(39, 0));
    expect(heap.keyOf(1)).toBe(40 * 2 ** 32 - 1);
    expect(Number.isSafeInteger(heap.keyOf(1))).toBe(true);
    expect(drain(heap)).toEqual([4, 3, 5, 2, 1]);
  });

  it('DSA-HEAP-02 BoundedTopK with k = 0 keeps nothing, with fewer than k offers keeps all, and drains in descending order', () => {
    const none = new BoundedTopKHeap(0);
    expect(none.offer(1, 100)).toBe(false);
    expect(none.size).toBe(0);
    expect(none.minScore()).toBeUndefined();
    expect(none.drainDescending()).toEqual([]);

    const top = new BoundedTopKHeap(5);
    expect(top.k).toBe(5);
    expect(top.minScore()).toBeUndefined();
    expect(top.offer(1, 0.3)).toBe(true);
    expect(top.offer(2, 0.9)).toBe(true);
    expect(top.offer(3, 0.1)).toBe(true);
    expect(top.size).toBe(3);
    expect(top.minScore()).toBe(0.1);
    expect(top.drainDescending()).toEqual([
      { handle: 2, score: 0.9 },
      { handle: 1, score: 0.3 },
      { handle: 3, score: 0.1 },
    ]);
    expect(top.size).toBe(0);

    const full = new BoundedTopKHeap(2);
    full.offer(1, 5);
    full.offer(2, 7);
    expect(full.offer(3, 5)).toBe(false); // not strictly greater than the minimum
    expect(full.offer(4, 6)).toBe(true);
    expect(full.minScore()).toBe(6);
    expect(full.drainDescending()).toEqual([
      { handle: 2, score: 7 },
      { handle: 4, score: 6 },
    ]);
    expectDsaError(() => new BoundedTopKHeap(-1), 'RANGE');
  });

  it('DSA-HEAP-01 checkInvariants detects a broken index map', () => {
    const heap = new BinaryHeap();
    heap.push(1, 1);
    heap.push(2, 2);
    heap.checkInvariants();
    heap.debugCorrupt('index-map');
    expect(() => heap.checkInvariants()).toThrow(/H2/);
  });

  it('DSA-HEAP-01 the PriorityQueue facade pops the most urgent item first and changePriority reorders items', () => {
    const q = new HeapPriorityQueue<{ name: string }>();
    const a = { name: 'a' };
    const b = { name: 'b' };
    const c = { name: 'c' };
    expect(q.pop()).toBeUndefined();
    expect(q.peek()).toBeUndefined();
    q.push(a, 3);
    q.push(b, 1);
    q.push(c, 2);
    expectDsaError(() => q.push(a, 0), 'DUPLICATE');
    expect(q.size).toBe(3);
    expect(q.peek()).toBe(b);
    q.changePriority(a, 0);
    expectDsaError(() => q.changePriority({ name: 'a' }, 1), 'NOT_FOUND');
    expect(q.pop()).toBe(a);
    expect(q.pop()).toBe(b);
    // Handles are recycled: an item popped earlier can be queued again.
    q.push(a, 5);
    expect(q.pop()).toBe(c);
    expect(q.pop()).toBe(a);
    expect(q.size).toBe(0);
  });

  it('DSA-GEN-09 stats report the size and allocated bytes of at least 16 per entry', () => {
    const heap = new BinaryHeap(1024);
    for (let h = 0; h < 1024; h++) heap.push(h, h);
    const stats = heap.stats();
    expect(stats.size).toBe(1024);
    expect(stats.capacity).toBeGreaterThanOrEqual(1024);
    expect(stats.bytesUsed).toBeGreaterThanOrEqual(16 * 1024);
    expect(stats.bytesAllocated).toBeGreaterThanOrEqual(stats.bytesUsed);
  });
});
