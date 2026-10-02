/**
 * S3: binary min-heap with an index map (specs/08-dsa/data-structures.md §3.5 S3, §4.3, §5 S3).
 *
 * Owner: R1 Kernel · non-owner reviewer: R3 · must be IMPLEMENTED by v0.2.0 (P2, target W3).
 * Mandatory location (Spec §10.1 heap row): the scheduler ready queue (§9.1, PROC-02). Also the
 * kernel timer heap, the ai.search bounded top-k, the ai.indexer work queue and the server's
 * lease-expiry heap.
 *
 * Layout (struct of arrays, §3.4): `keys: Float64Array` in heap order, `hnd: Int32Array` (handle at
 * each heap position) and `pos: Int32Array` (handle → position, −1 when absent) sized to the handle
 * space and grown by doubling: 16 bytes per entry for dense handles. Sifts move a hole instead of
 * swapping (§5 S3). The heap orders by key only; callers encode tie-breaks into the key.
 *
 * | Operation                                       | Complexity |
 * |-------------------------------------------------|------------|
 * | push, pop, changePriority, remove, replaceTop   | O(log n)   |
 * | peek, peekKey, has, keyOf                       | O(1)       |
 * | BoundedTopK.offer                               | O(log k)   |
 * | BoundedTopK.drainDescending                     | O(k log k) |
 *
 * Invariants checked by `checkInvariants()` (§5 S3), each failure message names its id:
 * H1 keys[(i−1) >> 1] ≤ keys[i]; H2 pos[hnd[i]] === i; H3 pos[h] === −1 for absent handles;
 * H4 every key is finite.
 *
 * Files: this file holds the public contract (interfaces and IMPLEMENTED); the implementations
 * live in binary-heap.ts (BinaryHeap), priority-queue.ts (HeapPriorityQueue) and bounded-top-k.ts
 * (BoundedTopKHeap). Written from first principles: no package and no pilot code (§3.1, §10.2).
 */
import type { DsaStats } from '../_shared/errors.ts';

export const IMPLEMENTED = true;

export { BinaryHeap } from './binary-heap.ts';
export { BoundedTopKHeap } from './bounded-top-k.ts';
export { HeapPriorityQueue } from './priority-queue.ts';

/**
 * Min-heap of dense integer handles (pid, timer id, lock slot) ordered by a numeric key.
 * Contract violations throw DsaError: DUPLICATE for a handle already present; RANGE for a key
 * that is not finite or a handle that is not an integer ≥ 0.
 */
export interface IndexedMinHeap {
  /** O(log n); DUPLICATE if present; RANGE if the key is not finite or the handle < 0. */
  push(handle: number, key: number): void;
  /** O(log n); the handle with the minimum key, undefined when empty. */
  pop(): number | undefined;
  /** O(1). */
  peek(): number | undefined;
  /** O(1). */
  peekKey(): number | undefined;
  /** O(log n); false if absent; RANGE if the key is not finite. */
  changePriority(handle: number, key: number): boolean;
  /** O(log n); false if absent. */
  remove(handle: number): boolean;
  /**
   * Pop the minimum and push `(handle, key)` in one sift-down; returns the popped handle. On an
   * empty heap it behaves as `push` and returns undefined. DUPLICATE if `handle` is present and is
   * not the popped minimum.
   */
  replaceTop(handle: number, key: number): number | undefined;
  /** O(1). */
  has(handle: number): boolean;
  /** O(1). */
  keyOf(handle: number): number | undefined;
  readonly size: number;
  /** Empties the heap; every handle can be pushed again. */
  clear(): void;
  stats(): DsaStats;
  checkInvariants(): void;
}

/**
 * Deliberate corruptions for the checkInvariants tests only (never called by product code):
 * - 'index-map': write a wrong position into pos[] for the handle at the root (breaks H2); needs
 *   at least two entries.
 */
export type HeapCorruption = 'index-map';

/**
 * §10.3 PriorityQueue<T>: generic items mapped to heap handles with a Map and a free-handle stack.
 * Smaller priority = more urgent.
 */
export interface PriorityQueue<T> {
  /** O(log n); DUPLICATE if the item is already queued; RANGE if the priority is not finite. */
  push(item: T, priority: number): void;
  /** O(log n); the most urgent item. */
  pop(): T | undefined;
  /** O(1). */
  peek(): T | undefined;
  /** O(log n) through item → handle → heap position; NOT_FOUND if the item is not queued. */
  changePriority(item: T, priority: number): void;
}

/**
 * Keeps the k largest scores with a min-heap of at most k entries (RAG top-K′,
 * rag-semantic-search.md). `offer` pushes while fewer than k are kept, otherwise replaces the
 * minimum only when `score` is strictly greater. Handles are the caller's distinct candidate ids.
 */
export interface BoundedTopK {
  readonly k: number;
  readonly size: number;
  /** O(log k); true if the candidate is kept. RANGE if the score is not finite. */
  offer(handle: number, score: number): boolean;
  /** O(1): the smallest kept score (the admission threshold once full); undefined when empty. */
  minScore(): number | undefined;
  /** O(k log k); kept entries by score, largest first; empties the structure. */
  drainDescending(): Array<{ handle: number; score: number }>;
}
