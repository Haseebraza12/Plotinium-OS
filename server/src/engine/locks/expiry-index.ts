/**
 * The in-memory lease-expiry index (offline-and-sync.md §3.14.5, §5.6; database.md §3.17). The
 * broadcaster reuses it as its per-owner hold list keyed by seq (§5.4: "held[owner] is a min-heap").
 *
 * A min-heap of lease deadlines over the team's `dsa/heap` IndexedMinHeap (S3, R1; C16): push on a
 * grant, `changePriority` on a renewal, `remove` on a release, all O(log n). The heap orders dense
 * integer handles, so this module maps each id to a handle and recycles freed handles (a free-list
 * stack keeps the handle space as small as the number of live entries).
 *
 * The heap is only an index: the sweeper still asks the database which leases really expired
 * (`DELETE ... WHERE lease_expires_at <= clock_timestamp()`), so a stale index entry can delay an
 * expiry by at most one re-read, never cause a wrong one.
 *
 * dsa/heap ships with IMPLEMENTED = false until R1 writes it (C16, spec §10.2). Exactly like the
 * kernel's host timers (kernel/src/host/timers.ts), while HEAP_IMPLEMENTED is false the index keeps
 * its entries in a built-in Map and finds the minimum by a linear scan: correct, O(n) per peek,
 * and NOT a heap (it does not stand in for S3). Tests pass a test-only heap double to exercise the
 * heap path. TODO(dsa/heap): delete the Map stand-in once HEAP_IMPLEMENTED is true.
 */
import { BinaryHeap, HEAP_IMPLEMENTED, type IndexedMinHeap } from '@plotinium/dsa';

export type HeapFactory = () => IndexedMinHeap;

/** The team's heap once it ships; null selects the Map stand-in. */
export const defaultHeapFactory: HeapFactory | null = HEAP_IMPLEMENTED
  ? () => new BinaryHeap()
  : null;

/** Which structure an index runs on (diagnostics: `/api/readyz` may report it). */
export const EXPIRY_INDEX_KIND = HEAP_IMPLEMENTED ? 'dsa/heap' : 'Map, dsa/heap pending';

export class ExpiryIndex {
  readonly #heap: IndexedMinHeap | null;
  readonly #handleOf = new Map<string, number>();
  readonly #idOf: (string | undefined)[] = [];
  readonly #free: number[] = [];
  /** The stand-in while dsa/heap is not implemented: id -> key. */
  readonly #scan = new Map<string, number>();

  constructor(createHeap: HeapFactory | null = defaultHeapFactory) {
    this.#heap = createHeap === null ? null : createHeap();
  }

  get kind(): 'heap' | 'scan' {
    return this.#heap === null ? 'scan' : 'heap';
  }

  get size(): number {
    return this.#heap === null ? this.#scan.size : this.#handleOf.size;
  }

  has(id: string): boolean {
    return this.#heap === null ? this.#scan.has(id) : this.#handleOf.has(id);
  }

  /** Adds the id or moves its key (a renewal). O(log n) on the heap. */
  upsert(id: string, deadline: number): void {
    const heap = this.#heap;
    if (heap === null) {
      this.#scan.set(id, deadline);
      return;
    }
    const handle = this.#handleOf.get(id);
    if (handle !== undefined) {
      heap.changePriority(handle, deadline);
      return;
    }
    const h = this.#free.pop() ?? this.#idOf.length;
    this.#handleOf.set(id, h);
    this.#idOf[h] = id;
    heap.push(h, deadline);
  }

  /** Forgets the id (released or expired). O(log n) on the heap; false when it was not indexed. */
  remove(id: string): boolean {
    const heap = this.#heap;
    if (heap === null) return this.#scan.delete(id);
    const handle = this.#handleOf.get(id);
    if (handle === undefined) return false;
    heap.remove(handle);
    this.#release(id, handle);
    return true;
  }

  /** The earliest key, or undefined when the index is empty. */
  peekDeadline(): number | undefined {
    if (this.#heap !== null) return this.#heap.peekKey();
    let min: number | undefined;
    for (const key of this.#scan.values()) if (min === undefined || key < min) min = key;
    return min;
  }

  /** Pops every id whose key (deadline) is <= `limit`, earliest first. O(m log n) on the heap. */
  popDue(limit: number): { id: string; deadline: number }[] {
    const heap = this.#heap;
    const due: { id: string; deadline: number }[] = [];
    if (heap === null) {
      for (const [id, deadline] of this.#scan) if (deadline <= limit) due.push({ id, deadline });
      for (const d of due) this.#scan.delete(d.id);
      return due.sort((a, b) => a.deadline - b.deadline);
    }
    for (;;) {
      const deadline = heap.peekKey();
      if (deadline === undefined || deadline > limit) return due;
      const handle = heap.pop();
      if (handle === undefined) return due;
      const id = this.#idOf[handle];
      if (id === undefined) continue; // unreachable while H2/H3 hold
      this.#release(id, handle);
      due.push({ id, deadline });
    }
  }

  clear(): void {
    this.#heap?.clear();
    this.#handleOf.clear();
    this.#idOf.length = 0;
    this.#free.length = 0;
    this.#scan.clear();
  }

  #release(id: string, handle: number): void {
    this.#handleOf.delete(id);
    this.#idOf[handle] = undefined;
    this.#free.push(handle);
  }
}
