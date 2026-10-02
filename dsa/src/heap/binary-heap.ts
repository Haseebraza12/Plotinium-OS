/**
 * S3 BinaryHeap: an indexed binary min-heap of dense integer handles
 * (specs/08-dsa/data-structures.md §3.5 S3, §4.3, §5 S3).
 *
 * The tree is stored implicitly in three parallel typed arrays (struct of arrays, §3.4):
 *
 *   keys: Float64Array   keys[i]  = key of the entry at heap position i      (heap order)
 *   hnd:  Int32Array     hnd[i]   = handle of the entry at heap position i
 *   pos:  Int32Array     pos[h]   = heap position of handle h, or −1 when h is absent
 *
 * Position i has its parent at (i − 1) >> 1 and its children at 2i + 1 and 2i + 2, so the first
 * `size` positions always form a complete binary tree of height ⌊log₂ n⌋. `keys` and `hnd` are
 * sized to the number of entries; `pos` is sized to the handle space (largest handle + 1). Both
 * grow by doubling (amortised O(1) per push) and never shrink. For dense handles that is
 * 8 + 4 + 4 = 16 bytes per entry.
 *
 * Every sift uses a HOLE (§5 S3): the moving entry is held in locals, parents (sift up) or the
 * smaller child (sift down) are shifted into the hole one level at a time, and the moving entry
 * is written once where the hole stops. Each level costs one key write, one handle write and one
 * pos write, half the writes of swap-based sifting.
 *
 * Invariants (checkInvariants):
 *   H1 keys[(i − 1) >> 1] ≤ keys[i] for 0 < i < size       (heap order)
 *   H2 pos[hnd[i]] === i for 0 ≤ i < size                  (the index map points back)
 *   H3 pos[h] === −1 for every handle h not in the heap    (no stale index entries)
 *   H4 every key is finite                                 (no NaN: comparisons stay total)
 */
import { DsaError } from '../_shared/errors.ts';
import type { DsaStats } from '../_shared/errors.ts';
import type { HeapCorruption, IndexedMinHeap } from './index.ts';

/** Handles are stored in an Int32Array, so the largest representable handle is 2^31 − 1. */
const MAX_HANDLE = 0x7fff_ffff;

/** Bytes per live entry: 8 (key) + 4 (handle) + 4 (its pos slot). */
const BYTES_PER_ENTRY = 16;

/** Contract check for push and replaceTop (§6.0: RANGE). */
function checkHandle(handle: number): void {
  if (!Number.isInteger(handle) || handle < 0 || handle > MAX_HANDLE) {
    throw new DsaError('RANGE', `heap: handle must be an integer in [0, 2^31 − 1], got ${handle}`);
  }
}

/** Contract check for every key (§6.0: RANGE). NaN would make every comparison false (H4). */
function checkKey(key: number): void {
  if (!Number.isFinite(key)) {
    throw new DsaError('RANGE', `heap: key must be a finite number, got ${key}`);
  }
}

export class BinaryHeap implements IndexedMinHeap {
  // Note on `!` below: noUncheckedIndexedAccess types every typed-array read as
  // `number | undefined`. Inside the heap every index read is < size ≤ capacity (or < pos.length
  // after ensureHandle), so the read is always defined and the assertion costs nothing at runtime.
  private keys: Float64Array;
  private hnd: Int32Array;
  private pos: Int32Array;
  private n = 0;

  /**
   * `initialCapacity` sizes both the heap arrays and the handle space; both grow by doubling.
   * RANGE unless it is an integer ≥ 0 (0 is allowed and allocates one slot).
   */
  constructor(initialCapacity = 16) {
    if (!Number.isInteger(initialCapacity) || initialCapacity < 0) {
      throw new DsaError('RANGE', `heap: capacity must be an integer ≥ 0, got ${initialCapacity}`);
    }
    const cap = Math.max(1, initialCapacity);
    this.keys = new Float64Array(cap);
    this.hnd = new Int32Array(cap);
    this.pos = new Int32Array(cap).fill(-1); // H3: no handle is present yet
  }

  get size(): number {
    return this.n;
  }

  /** O(log n) worst case, amortised O(1) extra for growth. */
  push(handle: number, key: number): void {
    checkHandle(handle);
    checkKey(key);
    if (this.positionOf(handle) !== -1) {
      throw new DsaError('DUPLICATE', `heap: handle ${handle} is already in the heap`);
    }
    this.ensureHandle(handle);
    if (this.n === this.keys.length) this.growHeap();
    // The new entry starts in a hole at the first free leaf and moves up.
    const i = this.n++;
    this.siftUp(i, handle, key);
  }

  /** O(log n): removes and returns the handle with the minimum key. */
  pop(): number | undefined {
    if (this.n === 0) return undefined;
    const top = this.hnd[0]!;
    this.pos[top] = -1; // H3 for the handle leaving the heap
    const last = --this.n;
    // The last leaf fills the hole left at the root and sifts down. When the heap had one entry
    // (last === 0) there is nothing left to place.
    if (last > 0) this.siftDown(0, this.hnd[last]!, this.keys[last]!);
    return top;
  }

  /** O(1). */
  peek(): number | undefined {
    return this.n === 0 ? undefined : this.hnd[0];
  }

  /** O(1). */
  peekKey(): number | undefined {
    return this.n === 0 ? undefined : this.keys[0];
  }

  /**
   * O(log n). pos[] finds the entry in O(1); then only one direction can be violated: a smaller key
   * can only break H1 with the parent (sift up), a larger key only with the children (sift down).
   */
  changePriority(handle: number, key: number): boolean {
    checkKey(key);
    const i = this.positionOf(handle);
    if (i === -1) return false;
    const old = this.keys[i]!;
    if (key < old) this.siftUp(i, handle, key);
    else if (key > old) this.siftDown(i, handle, key);
    else this.keys[i] = key; // equal (0 and −0 included): order unchanged, store the exact key
    return true;
  }

  /**
   * O(log n). The last leaf moves into the removed entry's position. That leaf came from another
   * subtree, so its key may be smaller than the new parent (sift up) or larger than the new
   * children (sift down), never both, because the parent is ≤ the old children (H1).
   */
  remove(handle: number): boolean {
    const i = this.positionOf(handle);
    if (i === -1) return false;
    this.pos[handle] = -1;
    const last = --this.n;
    if (i !== last) {
      const movedHandle = this.hnd[last]!;
      const movedKey = this.keys[last]!;
      if (i > 0 && movedKey < this.keys[(i - 1) >> 1]!) this.siftUp(i, movedHandle, movedKey);
      else this.siftDown(i, movedHandle, movedKey);
    }
    return true;
  }

  /**
   * Pop the minimum and push `(handle, key)` with a single sift-down from the root: O(log n), about
   * half the work of pop() followed by push(). On an empty heap it is push() and returns undefined.
   * The popped minimum itself may be pushed back (its position is exactly the root being
   * replaced); any other handle already in the heap is DUPLICATE.
   */
  replaceTop(handle: number, key: number): number | undefined {
    checkHandle(handle);
    checkKey(key);
    if (this.n === 0) {
      this.push(handle, key);
      return undefined;
    }
    const at = this.positionOf(handle);
    if (at > 0) throw new DsaError('DUPLICATE', `heap: handle ${handle} is already in the heap`);
    this.ensureHandle(handle);
    const top = this.hnd[0]!;
    this.pos[top] = -1; // cleared first: if handle === top, siftDown writes its new position
    this.siftDown(0, handle, key);
    return top;
  }

  /** O(1). */
  has(handle: number): boolean {
    return this.positionOf(handle) !== -1;
  }

  /** O(1). */
  keyOf(handle: number): number | undefined {
    const i = this.positionOf(handle);
    return i === -1 ? undefined : this.keys[i];
  }

  /** O(n): resets only the pos[] slots of present handles, so a large handle space stays cheap. */
  clear(): void {
    for (let i = 0; i < this.n; i++) this.pos[this.hnd[i]!] = -1;
    this.n = 0;
  }

  stats(): DsaStats {
    return {
      size: this.n,
      capacity: this.keys.length,
      bytesAllocated: this.keys.byteLength + this.hnd.byteLength + this.pos.byteLength,
      bytesUsed: this.n * BYTES_PER_ENTRY,
    };
  }

  /**
   * O(size + handle space). Throws DsaError INVALID naming the first violated invariant. The heap
   * pass checks H4, H2 and H1 per position; the index-map pass then checks H3.
   */
  checkInvariants(): void {
    const { keys, hnd, pos, n } = this;
    const fail = (id: string, detail: string): never => {
      throw new DsaError('INVALID', `heap invariant ${id} violated: ${detail}`);
    };
    if (n < 0 || n > keys.length || keys.length !== hnd.length) {
      fail('H2', `size ${n} does not fit the heap arrays (capacity ${keys.length}/${hnd.length})`);
    }
    for (let i = 0; i < n; i++) {
      const key = keys[i]!;
      if (!Number.isFinite(key)) fail('H4', `key ${key} at position ${i} is not finite`);
      const h = hnd[i]!;
      if (h < 0 || h >= pos.length) {
        fail('H2', `handle ${h} at position ${i} is outside the index map`);
      }
      if (pos[h] !== i) fail('H2', `pos[${h}] = ${pos[h]} but handle ${h} sits at position ${i}`);
      if (i > 0) {
        const parent = (i - 1) >> 1;
        if (keys[parent]! > key) {
          fail('H1', `parent key ${keys[parent]} at ${parent} > child key ${key} at ${i}`);
        }
      }
    }
    // H2 made pos[hnd[i]] = i for every position, which also proves the n handles are distinct.
    // H3: every other slot of the index map must be −1, i.e. there are no stale positions.
    for (let h = 0; h < pos.length; h++) {
      const p = pos[h]!;
      if (p === -1) continue;
      if (p < 0 || p >= n || hnd[p] !== h) {
        fail('H3', `pos[${h}] = ${p} but handle ${h} is not in the heap at that position`);
      }
    }
  }

  /** Test-only: see HeapCorruption. */
  debugCorrupt(kind: HeapCorruption): void {
    switch (kind) {
      case 'index-map':
        if (this.n < 2) {
          throw new DsaError('INVALID', 'heap: index-map corruption needs two entries');
        }
        this.pos[this.hnd[0]!] = 1; // the root's handle now claims position 1: breaks H2
        return;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Internals

  /**
   * Heap position of `handle`, or −1 when absent. A typed array returns undefined for negative,
   * fractional or out-of-range indices, so invalid handles simply read as absent.
   */
  private positionOf(handle: number): number {
    return this.pos[handle] ?? -1;
  }

  /**
   * Hole-moving sift up. The hole starts at position `i`; `(handle, key)` is the entry to place.
   * While the parent's key is strictly greater, the parent moves down into the hole (and its pos
   * is updated), and the hole moves up one level. At most ⌊log₂ n⌋ iterations.
   * Strict `>` keeps equal keys where they are, so equal keys never move needlessly.
   */
  private siftUp(i: number, handle: number, key: number): void {
    const { keys, hnd, pos } = this;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const parentKey = keys[parent]!;
      if (parentKey <= key) break; // H1 holds between the parent and the entry: stop here
      const parentHandle = hnd[parent]!;
      keys[i] = parentKey;
      hnd[i] = parentHandle;
      pos[parentHandle] = i;
      i = parent;
    }
    keys[i] = key;
    hnd[i] = handle;
    pos[handle] = i;
  }

  /**
   * Hole-moving sift down over positions [0, n). The hole starts at position `i`. While the
   * smaller child's key is strictly smaller than `key`, that child moves up into the hole and the
   * hole moves down one level. Positions ≥ ⌊n / 2⌋ are leaves, so the loop stops there. At most
   * ⌊log₂ n⌋ iterations, two key comparisons each.
   */
  private siftDown(i: number, handle: number, key: number): void {
    const { keys, hnd, pos, n } = this;
    const firstLeaf = n >> 1;
    while (i < firstLeaf) {
      // Pick the smaller child; the right one exists only if it is inside the heap.
      let child = 2 * i + 1;
      let childKey = keys[child]!;
      const right = child + 1;
      if (right < n) {
        const rightKey = keys[right]!;
        if (rightKey < childKey) {
          child = right;
          childKey = rightKey;
        }
      }
      if (key <= childKey) break; // H1 holds between the entry and both children: stop here
      const childHandle = hnd[child]!;
      keys[i] = childKey;
      hnd[i] = childHandle;
      pos[childHandle] = i;
      i = child;
    }
    keys[i] = key;
    hnd[i] = handle;
    pos[handle] = i;
  }

  /** Double the heap arrays (keys, hnd): amortised O(1) per push. */
  private growHeap(): void {
    const cap = this.keys.length * 2;
    const keys = new Float64Array(cap);
    keys.set(this.keys);
    const hnd = new Int32Array(cap);
    hnd.set(this.hnd);
    this.keys = keys;
    this.hnd = hnd;
  }

  /** Grow the index map by doubling until `handle` fits; new slots are −1 (H3). */
  private ensureHandle(handle: number): void {
    const old = this.pos;
    if (handle < old.length) return;
    let cap = old.length * 2;
    while (cap <= handle) cap *= 2;
    const pos = new Int32Array(cap);
    pos.set(old);
    pos.fill(-1, old.length);
    this.pos = pos;
  }
}
