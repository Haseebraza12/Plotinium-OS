/**
 * Minimal local copies of the team-written dsa/ interfaces that ai/ uses (spec §10.2, C16).
 *
 * The shapes follow specs/08-dsa/data-structures.md §4.3 (S3 heap: `BoundedTopK`,
 * `IndexedMinHeap`), §4.7 (S7 `Ring`) and §4.8 (S8 `BloomFilter`), reduced to the members ai/
 * calls. ai/ never implements these structures: callers inject a factory, and the tests use small
 * doubles from ai/tests/doubles.ts.
 *
 * TODO(dsa): replace each interface with `import type { … } from '@plotinium/dsa/<name>'` once the
 * module exports it; dsa/src only holds READMEs today.
 */

/** S3 `BoundedTopK`: keeps the k largest scores with a min-heap of size k (RAG top-K'). */
export interface BoundedTopK {
  readonly k: number;
  readonly size: number;
  /** O(log k); true if kept. Admission once full is strict: `score > minScore()`. */
  offer(handle: number, score: number): boolean;
  /** O(1): the admission threshold once full. */
  minScore(): number | undefined;
  /** O(k log k); empties the structure. */
  drainDescending(): Array<{ handle: number; score: number }>;
}

export type TopKFactory = (k: number) => BoundedTopK;

/** S3 `IndexedMinHeap`: dense integer handles with numeric keys (indexer work queue). */
export interface IndexedMinHeap {
  push(handle: number, key: number): void;
  pop(): number | undefined;
  peek(): number | undefined;
  changePriority(handle: number, key: number): boolean;
  remove(handle: number): boolean;
  has(handle: number): boolean;
  keyOf(handle: number): number | undefined;
  readonly size: number;
}

export type MinHeapFactory = () => IndexedMinHeap;

/** S7 `Ring`: fixed capacity; `push` overwrites the oldest entry when full. */
export interface Ring<T> {
  push(x: T): void;
  at(i: number): T | undefined;
  readonly size: number;
  readonly capacity: number;
  clear(): void;
  /** Oldest first. */
  toArray(): T[];
}

export type RingFactory = <T>(capacity: number) => Ring<T>;

/** S8 `BloomFilter` over SHA-256 bytes (rag-semantic-search.md §3.9). */
export interface BloomFilter {
  add(hashBytes: Uint8Array): void;
  mayContain(hashBytes: Uint8Array): boolean;
}
