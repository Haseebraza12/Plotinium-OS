/**
 * S3 HeapPriorityQueue<T>: the §10.3 generic PriorityQueue<T> facade over BinaryHeap
 * (specs/08-dsa/data-structures.md §4.3).
 *
 * Items are mapped to dense integer handles so the heap keeps its typed-array layout:
 *
 *   handleOf: Map<T, number>   item → handle (the "index map" at the item level)
 *   items:    (T | undefined)[] handle → item (undefined when the handle is free)
 *   free:     number[]         stack of released handles, reused before new ones
 *
 * Reusing released handles keeps them dense: the largest handle ever issued is below the largest
 * number of items queued at once, so the heap's pos[] array stays proportional to the queue.
 * changePriority is O(log n): Map lookup O(1) expected, then BinaryHeap.changePriority.
 */
import { DsaError } from '../_shared/errors.ts';
import { BinaryHeap } from './binary-heap.ts';
import type { PriorityQueue } from './index.ts';

export class HeapPriorityQueue<T> implements PriorityQueue<T> {
  private readonly heap: BinaryHeap;
  private readonly handleOf = new Map<T, number>();
  private readonly items: Array<T | undefined> = [];
  private readonly free: number[] = [];

  constructor(initialCapacity = 16) {
    this.heap = new BinaryHeap(initialCapacity);
  }

  /** Items queued. */
  get size(): number {
    return this.heap.size;
  }

  /** O(log n); DUPLICATE if the item is already queued; RANGE if the priority is not finite. */
  push(item: T, priority: number): void {
    if (this.handleOf.has(item)) {
      throw new DsaError('DUPLICATE', 'priority queue: the item is already queued');
    }
    if (!Number.isFinite(priority)) {
      throw new DsaError('RANGE', `priority queue: priority must be finite, got ${priority}`);
    }
    // Checked before a handle is taken, so a rejected push leaves no trace.
    const handle = this.free.pop() ?? this.items.length;
    this.items[handle] = item;
    this.handleOf.set(item, handle);
    this.heap.push(handle, priority);
  }

  /** O(log n); the most urgent (smallest priority) item, undefined when empty. */
  pop(): T | undefined {
    const handle = this.heap.pop();
    if (handle === undefined) return undefined;
    const item = this.items[handle] as T;
    this.items[handle] = undefined; // drop the reference so the item can be collected
    this.handleOf.delete(item);
    this.free.push(handle);
    return item;
  }

  /** O(1). */
  peek(): T | undefined {
    const handle = this.heap.peek();
    return handle === undefined ? undefined : this.items[handle];
  }

  /** O(log n) through item → handle → heap position; NOT_FOUND if the item is not queued. */
  changePriority(item: T, priority: number): void {
    const handle = this.handleOf.get(item);
    if (handle === undefined) {
      throw new DsaError('NOT_FOUND', 'priority queue: the item is not queued');
    }
    this.heap.changePriority(handle, priority); // RANGE if the priority is not finite
  }
}
