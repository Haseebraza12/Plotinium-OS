/**
 * S7: ring buffers (specs/08-dsa/data-structures.md §3.5 S7, §4.7, §5 S7). Extra credit when
 * justified (Spec §10.1 note, DSA-RING-01).
 *
 * Owner: R5 QA/DevOps · non-owner reviewer: R1 · must be IMPLEMENTED by v0.2.0 (P2, target W5).
 * Users: klog (8,192 entries, overwrite), the ai.predictor telemetry ring (4,096, overwrite,
 * mirrored slot by slot into IndexedDB with `slotOf`), the frame meter (Float64Ring of 1,024
 * durations) and pipes (ByteRing of 64 KiB, reject mode: a full pipe blocks the writer).
 *
 * Layout: capacity is a power of two; `buf` is `T[]`, `Float64Array` or `Uint8Array`; `head` is the
 * physical slot of the oldest element (kept masked, so it never overflows); `count`; `dropped`
 * counts overwrites. Physical slot of logical index i = (head + i) & mask. `shift` clears the slot
 * it reads so the garbage collector can reclaim it.
 *
 * | Operation                                          | Complexity |
 * |----------------------------------------------------|------------|
 * | push, tryPush, shift, peekOldest, peekNewest, at   | O(1)       |
 * | slotOf                                             | O(1)       |
 * | toArray, iteration                                 | O(n)       |
 * | ByteRing write / read                              | O(bytes), at most two copies |
 * | Float64Ring percentile                             | O(n log n) (sorts a copy)    |
 *
 * Invariants checked by `checkInvariants()` (§5 S7), each failure message names its id:
 * RB1 0 ≤ count ≤ capacity; RB2 0 ≤ head < capacity; RB3 logical i ↦ physical (head + i) & mask
 * is a bijection onto the occupied slots; RB4 (ByteRing) available + free === capacity.
 *
 * C16: written from first principles for the owner (no package, no pilot code); see AI_USAGE.md
 * and dsa/src/ringbuffer/README.md for the proofs and the benchmark.
 *
 * Why `& mask` works. For a power of two c = 2^k, `mask = c − 1` has exactly the low k bits set, so
 * for any x ≥ 0, `x & mask` keeps the low k bits of x, which is x mod c. Because head < c and every
 * logical index i < c, `head + i < 2c ≤ 2^31`, so the 32-bit `&` never sees a value it would wrap.
 * This is why the capacity must be a power of two, and why it is capped at 2^30.
 */
import { DsaError } from '../_shared/errors.ts';
import type { DsaStats } from '../_shared/errors.ts';

export const IMPLEMENTED = true;

/** overwrite: a full ring drops its oldest element; reject: a full ring refuses the new one. */
export type RingMode = 'overwrite' | 'reject';

export interface Ring<T> {
  /** O(1); overwrite mode drops the oldest (dropped++); reject mode throws FULL. */
  push(x: T): void;
  /** O(1); false only in reject mode when full. */
  tryPush(x: T): boolean;
  /** O(1); removes and returns the oldest. */
  shift(): T | undefined;
  peekOldest(): T | undefined;
  peekNewest(): T | undefined;
  /** O(1); 0 = oldest; undefined outside 0..size−1. */
  at(i: number): T | undefined;
  /** Physical slot of logical index i, for the persisted telemetry mirror; RANGE outside 0..size−1. */
  slotOf(i: number): number;
  readonly size: number;
  readonly capacity: number;
  /** Elements overwritten since construction (not reset by clear). */
  readonly dropped: number;
  /** Physical slot of the oldest element. */
  readonly head: number;
  readonly mode: RingMode;
  /** Empties the ring. */
  clear(): void;
  /** O(n), oldest → newest. */
  toArray(): T[];
  [Symbol.iterator](): Iterator<T>;
  stats(): DsaStats;
  checkInvariants(): void;
}

/**
 * Largest accepted capacity, 2^30. It keeps `head + i` below 2^31 (see the header), and a `T[]` of
 * 2^30 slots is already 8 GiB, far beyond any real ring (the largest user is klog at 8,192).
 */
const MAX_CAPACITY = 2 ** 30;

/**
 * Bytes per slot of a `T[]` ring: one tagged pointer in V8 on 64-bit Node, which does not enable
 * pointer compression. The element objects belong to the caller and are not counted.
 */
const POINTER_BYTES = 8;

/** Bytes per slot of a Float64Ring (one IEEE-754 double). */
const FLOAT64_BYTES = 8;

/** Throws RANGE unless `capacity` is a power of two in 1..2^30. */
function validateCapacity(capacity: number, what: string): void {
  // `c & (c − 1)` clears the lowest set bit of c, so it is 0 exactly when c has a single set bit,
  // that is, when c is a power of two. Number.isInteger first, because `&` truncates 2.5 to 2.
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > MAX_CAPACITY ||
    (capacity & (capacity - 1)) !== 0
  ) {
    throw new DsaError(
      'RANGE',
      `${what}: capacity must be a power of two in 1..2^30, got ${String(capacity)}`,
    );
  }
}

/** The error `checkInvariants()` throws; the message starts with the invariant id (RB1..RB4). */
function violated(id: 'RB1' | 'RB2' | 'RB3' | 'RB4', detail: string): DsaError {
  return new DsaError('INVALID', `${id} violated: ${detail}`);
}

/**
 * The index arithmetic shared by RingBuffer and Float64Ring. It owns `head`, `count`, `dropped` and
 * the mode, and hands out physical slots; the subclasses own the storage and do the actual reads
 * and writes. So `push` is "ask for a slot, then store into it", and there is no virtual call on
 * the hot path.
 *
 * State (the only state; everything else is derived):
 *   head    physical slot of the oldest element, always in 0..capacity−1 (RB2)
 *   count   number of live elements, always in 0..capacity (RB1)
 *   dropped overwrites since construction (monotone; clear does not reset it)
 * Live elements occupy physical slots (head + 0) & mask, (head + 1) & mask, …, (head + count − 1)
 * & mask, oldest first (RB3). Every other slot is free.
 */
abstract class RingIndex {
  readonly #capacity: number;
  /** capacity − 1: `x & mask` === `x mod capacity` for x ≥ 0 (see the file header). */
  readonly #mask: number;
  readonly #overwrite: boolean;
  #head = 0;
  #count = 0;
  #dropped = 0;

  protected constructor(capacity: number, mode: RingMode, what: string) {
    validateCapacity(capacity, what);
    if (mode !== 'overwrite' && mode !== 'reject') {
      throw new DsaError(
        'INVALID',
        `${what}: mode must be 'overwrite' or 'reject', got ${String(mode)}`,
      );
    }
    this.#capacity = capacity;
    this.#mask = capacity - 1;
    this.#overwrite = mode === 'overwrite';
  }

  /**
   * Reserves the slot for a new newest element and updates the index; the caller stores into it.
   * Returns −1 (and changes nothing) when the ring is full in reject mode. O(1).
   */
  protected claimSlot(): number {
    const count = this.#count;
    if (count < this.#capacity) {
      // Not full: the first free slot is just past the newest, logical index `count`.
      this.#count = count + 1;
      return (this.#head + count) & this.#mask;
    }
    if (!this.#overwrite) return -1;
    // Full, overwrite mode: logical index `count` = capacity maps to (head + capacity) & mask, which
    // is head itself. The new element reuses the oldest's slot, and the next-oldest (head + 1)
    // becomes the oldest. count stays at capacity; one element was lost, so dropped++.
    const slot = this.#head;
    this.#head = (slot + 1) & this.#mask;
    this.#dropped++;
    return slot;
  }

  /** Removes the oldest from the index and returns its slot (the caller reads and clears it); −1 when empty. O(1). */
  protected takeOldestSlot(): number {
    if (this.#count === 0) return -1;
    const slot = this.#head;
    // Masking on every advance keeps head in 0..capacity−1 forever (RB2), however many times the
    // ring wraps; it never grows towards 2^53 the way an unmasked counter would.
    this.#head = (slot + 1) & this.#mask;
    this.#count--;
    return slot;
  }

  /** Physical slot of logical index i (0 = oldest), or −1 when i is not an integer in 0..size−1. O(1). */
  protected slotAt(i: number): number {
    // `!(i >= 0 && i < count)` is also true for NaN, whose comparisons are all false.
    if (!(i >= 0 && i < this.#count) || !Number.isInteger(i)) return -1;
    return (this.#head + i) & this.#mask;
  }

  /** Forgets every element (the caller has already released its storage). dropped is kept. O(1). */
  protected resetIndex(): void {
    this.#head = 0;
    this.#count = 0;
  }

  /**
   * Checks RB1, RB2 and the index half of RB3, and returns the occupancy map: 1 for the image of
   * i ↦ (head + i) & mask over i in 0..count−1, 0 elsewhere. The subclass checks the storage half of
   * RB3 against it (a slot outside the live range must be free). O(capacity).
   */
  protected checkIndexInvariants(storageLength: number): Uint8Array {
    const capacity = this.#capacity;
    const mask = this.#mask;
    const head = this.#head;
    const count = this.#count;
    if (!Number.isInteger(count) || count < 0 || count > capacity) {
      throw violated('RB1', `count ${count} is outside 0..${capacity}`);
    }
    if (!Number.isInteger(head) || head < 0 || head >= capacity) {
      throw violated('RB2', `head ${head} is outside 0..${capacity - 1}`);
    }
    // `& mask` is reduction mod capacity only for a power of two with mask = capacity − 1.
    if ((capacity & mask) !== 0 || mask !== capacity - 1 || storageLength !== capacity) {
      throw violated(
        'RB3',
        `capacity ${capacity}, mask ${mask} and ${storageLength} storage slots do not form a power-of-two ring`,
      );
    }
    // Injective: no two logical indices share a slot. With `count` distinct images the map is a
    // bijection from 0..count−1 onto the marked slots.
    const occupied = new Uint8Array(capacity);
    for (let i = 0; i < count; i++) {
      const slot = (head + i) & mask;
      if (occupied[slot] === 1) {
        throw violated(
          'RB3',
          `logical index ${i} maps to slot ${slot}, which an earlier index uses`,
        );
      }
      occupied[slot] = 1;
    }
    return occupied;
  }

  /** Physical slot of logical index i, for the persisted telemetry mirror; RANGE outside 0..size−1. O(1). */
  slotOf(i: number): number {
    const slot = this.slotAt(i);
    if (slot < 0) {
      throw new DsaError('RANGE', `slotOf: index ${String(i)} is outside 0..${this.#count - 1}`);
    }
    return slot;
  }

  get size(): number {
    return this.#count;
  }
  get capacity(): number {
    return this.#capacity;
  }
  /** Elements overwritten since construction (not reset by clear). */
  get dropped(): number {
    return this.#dropped;
  }
  /** Physical slot of the oldest element (meaningless but still in range when the ring is empty). */
  get head(): number {
    return this.#head;
  }
  get mode(): RingMode {
    return this.#overwrite ? 'overwrite' : 'reject';
  }
}

function fullError(capacity: number): DsaError {
  return new DsaError('FULL', `ring is full (reject mode, capacity ${capacity})`);
}

/**
 * A ring of arbitrary values over a preallocated `T[]` (klog, telemetry). Free slots always hold
 * `undefined`, so a shifted or cleared element is not kept alive by the ring (checked by RB3).
 *
 * Iteration reads the live ring by logical index; pushing or shifting while iterating changes what
 * the iterator sees next. Take `toArray()` first when the loop body mutates the ring.
 */
export class RingBuffer<T> extends RingIndex implements Ring<T> {
  readonly #buf: (T | undefined)[];

  /** RANGE unless `capacity` is a power of two ≥ 1. */
  constructor(capacity: number, mode: RingMode = 'overwrite') {
    super(capacity, mode, 'RingBuffer');
    // Allocated once, never resized. In Node 24 `new Array(n).fill(undefined)` is a packed,
    // fast-elements array even at 2^20 slots.
    this.#buf = new Array<T | undefined>(capacity).fill(undefined);
  }

  push(x: T): void {
    const slot = this.claimSlot();
    if (slot < 0) throw fullError(this.capacity);
    this.#buf[slot] = x;
  }

  tryPush(x: T): boolean {
    const slot = this.claimSlot();
    if (slot < 0) return false;
    this.#buf[slot] = x;
    return true;
  }

  shift(): T | undefined {
    const slot = this.takeOldestSlot();
    if (slot < 0) return undefined;
    const x = this.#buf[slot];
    this.#buf[slot] = undefined; // release the reference so the GC can reclaim the element
    return x;
  }

  peekOldest(): T | undefined {
    return this.at(0);
  }

  peekNewest(): T | undefined {
    return this.at(this.size - 1);
  }

  at(i: number): T | undefined {
    const slot = this.slotAt(i);
    return slot < 0 ? undefined : this.#buf[slot];
  }

  /** O(n): releases only the n occupied slots; the free ones already hold undefined. */
  clear(): void {
    for (let i = this.size - 1; i >= 0; i--) this.#buf[this.slotAt(i)] = undefined;
    this.resetIndex();
  }

  toArray(): T[] {
    const n = this.size;
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(this.#buf[this.slotAt(i)] as T);
    return out;
  }

  *[Symbol.iterator](): Generator<T, void, undefined> {
    for (let i = 0; i < this.size; i++) yield this.#buf[this.slotAt(i)] as T;
  }

  /** Exact: one pointer per slot; the element objects are the caller's and are not counted. */
  stats(): DsaStats {
    return {
      size: this.size,
      capacity: this.capacity,
      bytesAllocated: this.capacity * POINTER_BYTES,
      bytesUsed: this.size * POINTER_BYTES,
    };
  }

  checkInvariants(): void {
    const occupied = this.checkIndexInvariants(this.#buf.length);
    // RB3, storage half: the slots outside the image of the live range are free (hold undefined),
    // so the image is exactly the set of occupied slots and nothing stale stays reachable.
    for (let slot = 0; slot < occupied.length; slot++) {
      if (occupied[slot] === 0 && this.#buf[slot] !== undefined) {
        throw violated(
          'RB3',
          `slot ${slot} is outside the live range but still holds a value (shift or clear did not release it)`,
        );
      }
    }
  }
}

/**
 * The Ring API over a Float64Array (frame meter), plus nearest-rank percentiles. Numbers are stored
 * unboxed, so pushing a frame duration allocates nothing. Freed slots are not zeroed: a stale double
 * holds no reference, and every read goes through the live range.
 */
export class Float64Ring extends RingIndex implements Ring<number> {
  readonly #buf: Float64Array;

  /** RANGE unless `capacity` is a power of two ≥ 1. */
  constructor(capacity: number, mode: RingMode = 'overwrite') {
    super(capacity, mode, 'Float64Ring');
    this.#buf = new Float64Array(capacity);
  }

  push(x: number): void {
    const slot = this.claimSlot();
    if (slot < 0) throw fullError(this.capacity);
    this.#buf[slot] = x;
  }

  tryPush(x: number): boolean {
    const slot = this.claimSlot();
    if (slot < 0) return false;
    this.#buf[slot] = x;
    return true;
  }

  shift(): number | undefined {
    const slot = this.takeOldestSlot();
    return slot < 0 ? undefined : this.#buf[slot];
  }

  peekOldest(): number | undefined {
    return this.at(0);
  }

  peekNewest(): number | undefined {
    return this.at(this.size - 1);
  }

  at(i: number): number | undefined {
    const slot = this.slotAt(i);
    return slot < 0 ? undefined : this.#buf[slot];
  }

  /** O(1): there are no references to release. */
  clear(): void {
    this.resetIndex();
  }

  toArray(): number[] {
    const n = this.size;
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.#buf[this.slotAt(i)] as number);
    return out;
  }

  *[Symbol.iterator](): Generator<number, void, undefined> {
    for (let i = 0; i < this.size; i++) yield this.#buf[this.slotAt(i)] as number;
  }

  /** Exact: 8 bytes per slot. */
  stats(): DsaStats {
    return {
      size: this.size,
      capacity: this.capacity,
      bytesAllocated: this.capacity * FLOAT64_BYTES,
      bytesUsed: this.size * FLOAT64_BYTES,
    };
  }

  checkInvariants(): void {
    this.checkIndexInvariants(this.#buf.length);
  }

  /**
   * Nearest-rank percentile of the held values, q in (0, 1]: for sorted x1 ≤ … ≤ xn, x⌈q·n⌉.
   * undefined when empty; RANGE for q outside (0, 1]. O(n log n): sorts a copy, never the ring.
   */
  percentile(q: number): number | undefined {
    if (!(q > 0 && q <= 1))
      throw new DsaError('RANGE', `percentile: q must be in (0, 1], got ${String(q)}`);
    const n = this.size;
    if (n === 0) return undefined;

    // Copy the live range in at most two segments (before and after the wrap), then sort the copy.
    const sorted = new Float64Array(n);
    const head = this.head;
    const first = Math.min(n, this.capacity - head);
    sorted.set(this.#buf.subarray(head, head + first), 0);
    if (first < n) sorted.set(this.#buf.subarray(0, n - first), first);
    sorted.sort(); // typed-array sort is numeric ascending (NaN last)

    // Nearest rank r = ⌈q·n⌉ is the smallest r with r/n ≥ q. q·n can round up past an integer
    // (0.7 · 10 = 7.000000000000001, so ⌈⌉ gives 8), so settle r against r/n ≥ q, which compares
    // like with like; a rounding error moves r by at most one, so each loop runs at most once.
    let rank = Math.ceil(q * n);
    while (rank > 1 && (rank - 1) / n >= q) rank--;
    while (rank < n && rank / n < q) rank++;
    return sorted[rank - 1];
  }
}

/** Pipes: a byte ring in reject mode. */
export interface ByteRing {
  /** Bytes accepted (partial when nearly full; 0 when full). */
  write(src: Uint8Array): number;
  /** Bytes delivered (≤ dst.length, ≤ available), oldest first. */
  read(dst: Uint8Array): number;
  readonly available: number;
  readonly free: number;
  readonly capacity: number;
}

/**
 * A byte ring for pipes (always reject mode: bytes are never overwritten; a full pipe accepts
 * fewer bytes and the kernel blocks the writer). `write` and `read` move whole runs with
 * `Uint8Array.set`: the run is split in at most two contiguous copies, before and after the
 * physical end of the buffer, so both are O(bytes) with no per-byte index arithmetic.
 */
export class ByteRingBuffer implements ByteRing {
  readonly #buf: Uint8Array;
  readonly #mask: number;
  /** Physical slot of the oldest unread byte (RB2). */
  #head = 0;
  /** Unread bytes, `available` (RB1). */
  #count = 0;

  /** RANGE unless `capacity` is a power of two ≥ 1. */
  constructor(capacity: number) {
    validateCapacity(capacity, 'ByteRingBuffer');
    this.#buf = new Uint8Array(capacity);
    this.#mask = capacity - 1;
  }

  write(src: Uint8Array): number {
    const capacity = this.#buf.length;
    const n = Math.min(src.length, capacity - this.#count); // partial write when nearly full
    if (n === 0) return 0;
    const tail = (this.#head + this.#count) & this.#mask; // first free slot
    const first = Math.min(n, capacity - tail); // bytes that fit before the physical end
    this.#buf.set(first === src.length ? src : src.subarray(0, first), tail);
    if (first < n) this.#buf.set(src.subarray(first, n), 0); // the rest wraps to slot 0
    this.#count += n;
    return n;
  }

  read(dst: Uint8Array): number {
    const n = Math.min(dst.length, this.#count);
    if (n === 0) return 0;
    const head = this.#head;
    const first = Math.min(n, this.#buf.length - head); // bytes before the physical end
    dst.set(this.#buf.subarray(head, head + first), 0);
    if (first < n) dst.set(this.#buf.subarray(0, n - first), first); // the rest from slot 0
    this.#count -= n;
    // A drained pipe restarts at slot 0, so the next write is one contiguous copy. Any head is
    // valid for an empty ring, so this changes no observable byte order.
    this.#head = this.#count === 0 ? 0 : (head + n) & this.#mask;
    return n;
  }

  get available(): number {
    return this.#count;
  }
  get free(): number {
    return this.#buf.length - this.#count;
  }
  get capacity(): number {
    return this.#buf.length;
  }

  /** Exact: one byte per slot. */
  stats(): DsaStats {
    return {
      size: this.#count,
      capacity: this.capacity,
      bytesAllocated: this.capacity,
      bytesUsed: this.#count,
    };
  }

  checkInvariants(): void {
    const capacity = this.#buf.length;
    if (!Number.isInteger(this.#count) || this.#count < 0 || this.#count > capacity) {
      throw violated('RB1', `available ${this.#count} is outside 0..${capacity}`);
    }
    if (!Number.isInteger(this.#head) || this.#head < 0 || this.#head >= capacity) {
      throw violated('RB2', `head ${this.#head} is outside 0..${capacity - 1}`);
    }
    // RB3 for bytes: the live run is (head + i) & mask for i < available, which is a bijection onto
    // its image exactly when capacity is a power of two and mask = capacity − 1.
    if ((capacity & this.#mask) !== 0 || this.#mask !== capacity - 1) {
      throw violated(
        'RB3',
        `capacity ${capacity} and mask ${this.#mask} do not form a power-of-two ring`,
      );
    }
    if (this.available + this.free !== capacity) {
      throw violated(
        'RB4',
        `available ${this.available} + free ${this.free} !== capacity ${capacity}`,
      );
    }
  }
}
