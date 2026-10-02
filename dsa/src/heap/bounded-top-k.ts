/**
 * S3 BoundedTopKHeap: keeps the k largest scores seen so far (RAG top-K′,
 * rag-semantic-search.md; specs/08-dsa/data-structures.md §4.3, §5 S3 "BoundedTopK").
 *
 * Idea: a MIN-heap of at most k entries. Its root is the smallest score kept, which is exactly the
 * admission threshold once the heap is full: a new candidate belongs in the top k only if it beats
 * that score, and then it replaces the root with one sift-down (replaceTop).
 *
 *   offer: size < k → push; score > root → replaceTop; otherwise reject.   O(log k)
 *   N candidates → O(N log k) time and O(k) memory, instead of sorting all N (O(N log N)).
 *
 * The heap's handles are SLOTS 0..k−1, not the caller's ids, so memory stays O(k) however large
 * the caller's candidate ids are. `ids[slot]` maps a slot back to the caller's handle. When the
 * root is replaced, the new candidate takes over the root's slot, which replaceTop allows because
 * that slot is the popped minimum.
 */
import { DsaError } from '../_shared/errors.ts';
import { BinaryHeap } from './binary-heap.ts';
import type { BoundedTopK } from './index.ts';

export class BoundedTopKHeap implements BoundedTopK {
  private readonly capacity: number;
  private readonly heap: BinaryHeap;
  /** Caller handle stored in each slot; Float64 so any safe-integer candidate id is exact. */
  private readonly ids: Float64Array;

  /** RANGE unless `k` is an integer ≥ 0. */
  constructor(k: number) {
    if (!Number.isInteger(k) || k < 0) {
      throw new DsaError('RANGE', `top-k: k must be an integer ≥ 0, got ${k}`);
    }
    this.capacity = k;
    this.heap = new BinaryHeap(k);
    this.ids = new Float64Array(k);
  }

  get k(): number {
    return this.capacity;
  }

  get size(): number {
    return this.heap.size;
  }

  /**
   * O(log k); true if the candidate is kept. A score equal to the current minimum is rejected
   * (strictly greater replaces). RANGE if the score is not finite or the handle is not a safe
   * integer ≥ 0. Handles are the caller's distinct candidate ids; distinctness is not checked,
   * because that would need memory proportional to every id ever offered.
   */
  offer(handle: number, score: number): boolean {
    if (!Number.isSafeInteger(handle) || handle < 0) {
      throw new DsaError('RANGE', `top-k: handle must be a safe integer ≥ 0, got ${handle}`);
    }
    if (!Number.isFinite(score)) {
      throw new DsaError('RANGE', `top-k: score must be finite, got ${score}`);
    }
    const size = this.heap.size;
    if (size < this.capacity) {
      // Not full yet: slots 0..size−1 are taken, so `size` is the next free slot.
      this.ids[size] = handle;
      this.heap.push(size, score);
      return true;
    }
    const threshold = this.heap.peekKey();
    if (threshold === undefined || score <= threshold) return false; // k = 0, or not good enough
    const slot = this.heap.peek()!; // defined: the heap is full and k > 0
    this.ids[slot] = handle;
    this.heap.replaceTop(slot, score); // evicts the old minimum, reuses its slot
    return true;
  }

  /** O(1): the smallest kept score (the admission threshold once full); undefined when empty. */
  minScore(): number | undefined {
    return this.heap.peekKey();
  }

  /**
   * O(k log k): pops the min-heap (ascending scores) and fills the result from the back, so it
   * comes out largest first. Empties the structure; slots are reused by later offers.
   */
  drainDescending(): Array<{ handle: number; score: number }> {
    const out = new Array<{ handle: number; score: number }>(this.heap.size);
    for (let i = out.length - 1; i >= 0; i--) {
      const score = this.heap.peekKey()!;
      const slot = this.heap.pop()!;
      out[i] = { handle: this.ids[slot]!, score };
    }
    return out;
  }
}
