/**
 * S5: LRU list (hash map + doubly linked list over slot arrays) (specs/08-dsa/data-structures.md
 * §3.5 S5, §4.5, §5 S5).
 *
 * Owner: R1 Kernel · non-owner reviewer: R5 · must be IMPLEMENTED by v0.3.0 (P3, target W10).
 * Mandatory location (Spec §10.1 LRU row): the LRU pager (§9.2, MEM-02). Also the VFS inode cache
 * and the server's bound on rate-limit keys (bounded mode).
 *
 * Layout: `index: Map<K, number>` (key → slot; Map is the allowed hashing primitive, §10.2); slot
 * arrays `keys: K[]`, `vals: V[]`, `prev`/`next: Int32Array`, `pins: Uint16Array`,
 * `flags: Uint8Array` (bit 0 = speculative); `head` (MRU) and `tail` (LRU); a free-slot stack
 * threaded through `next`. Pinned entries are UNLINKED from the recency list while pinned, so the
 * tail is always the least recently used unpinned entry and `evict` is O(1) worst case.
 *
 * Semantics fixed here so the tests are exact:
 * - `get` and `touch` of an unpinned entry move it to the MRU end; both clear the speculative
 *   flag (a hit promotes a pre-fetched entry). A pinned entry keeps its (unlinked) place.
 * - `put` of an existing key updates the value, moves it to the MRU end unless pinned and clears
 *   the speculative flag; it never evicts. `put` of a new key in bounded mode at capacity first
 *   evicts the LRU unpinned entry and returns it; FULL if every entry is pinned (nothing changes).
 * - `putAtLru` is `put` that links at the LRU end and sets the speculative flag (new or existing).
 * - `moveToLru` of an unpinned entry moves it to the LRU end; of a pinned entry it changes nothing
 *   (it is not in the list). Both return true when the key is present.
 * - `unpin` to count 0 relinks the entry at the MRU end (it was just in use).
 *
 * | Operation                                                         | Complexity |
 * |-------------------------------------------------------------------|------------|
 * | get, peek, has, put, putAtLru, touch, moveToLru, evict, peekLru   | O(1)       |
 * | delete, pin, unpin, isPinned, isSpeculative                        | O(1)       |
 * | keysMruToLru                                                      | O(n)       |
 *
 * O(1) means: at most one `Map` operation (amortised O(1)) plus a constant number of typed-array
 * reads and writes. Inserting a new key may grow the slot arrays by doubling, which is O(n) once
 * and amortised O(1) per insertion (each doubling pays for the n/2 insertions before it).
 *
 * Invariants checked by `checkInvariants()` (§5 S5), each failure message names its id:
 * L1 walking `next` from head reaches tail over exactly `evictableSize` slots with prev/next
 * consistent; L2 every indexed slot is linked (pins = 0) or unlinked (pins > 0), never both;
 * L3 index.size === size and keys[index.get(k)] === k; L4 free and used slots are disjoint;
 * L5 size ≤ capacity in bounded mode.
 *
 * C16: written by Claude Code under the team's disclosed 2026-09-25 decision (AI_USAGE.md §5,
 * log row 8), without any package or pilot code, from the algorithms of §5 S5. The R1 owner
 * reviews it and must be able to explain it; see README.md.
 */
import { DsaError } from '../_shared/errors.ts';
import type { DsaStats } from '../_shared/errors.ts';

export const IMPLEMENTED = true;

/** §10.3 LRU<K, V>: get, put, evict, pin, unpin (plus the pager's speculative primitives). */
export interface LRU<K, V> {
  /** O(1); moves to MRU (not if pinned); promotes a speculative entry. */
  get(key: K): V | undefined;
  /** O(1); no recency change. */
  peek(key: K): V | undefined;
  has(key: K): boolean;
  /** O(1); insert or update at MRU; bounded: returns the evicted entry; FULL if all are pinned. */
  put(key: K, value: V): [K, V] | undefined;
  /** O(1); speculative insertion at the LRU end. */
  putAtLru(key: K, value: V): [K, V] | undefined;
  /** O(1); false if absent. */
  touch(key: K): boolean;
  /** O(1); demotion; false if absent. */
  moveToLru(key: K): boolean;
  /** O(1); the least recently used unpinned entry, removed. */
  evict(): [K, V] | undefined;
  /** O(1). */
  peekLru(): K | undefined;
  /** O(1); also removes pinned entries. */
  delete(key: K): boolean;
  /** O(1); counted; NOT_FOUND if absent. */
  pin(key: K): void;
  /** O(1); NOT_FOUND if absent, INVALID if not pinned; relinks at MRU at count 0. */
  unpin(key: K): void;
  isPinned(key: K): boolean;
  isSpeculative(key: K): boolean;
  /** All entries, pinned included. */
  readonly size: number;
  /** Unpinned entries (the recency list). */
  readonly evictableSize: number;
  /** undefined in unbounded mode. */
  readonly capacity: number | undefined;
  /** O(n); evictable entries only, MRU first. */
  keysMruToLru(): IterableIterator<K>;
  stats(): DsaStats;
  checkInvariants(): void;
}

export interface LruOptions {
  /** Bounded mode: an integer ≥ 1 (RANGE otherwise). Omitted: unbounded (the pager). */
  capacity?: number;
  /** Initial slot-array length; the arrays grow by doubling. */
  initialSlots?: number;
}

/**
 * Deliberate corruptions for the checkInvariants tests only (never called by product code):
 * - 'pinned-linked': set the pin count of the MRU head entry to 1 without unlinking it (breaks
 *   L2); needs at least one evictable entry.
 */
export type LruCorruption = 'pinned-linked';

/** The null slot index: "no neighbour" in prev/next, an empty list in head/tail, an empty free stack. */
const NIL = -1;
/** Bit 0 of `flags`: inserted by putAtLru (a pre-fetched page) and not hit since. */
const SPECULATIVE = 1;
/** `pins` is a Uint16Array: pinning past this count throws RANGE instead of wrapping to 0 (L2). */
const MAX_PINS = 0xffff;
/** Slot indices live in Int32Arrays; stopping at 2^30 keeps `2 * slots` inside int32 range. */
const MAX_SLOTS = 2 ** 30;
/** Slot-array length when `initialSlots` is omitted (clamped to `capacity` in bounded mode). */
const DEFAULT_SLOTS = 16;
/**
 * Bytes per slot counted by stats(): prev + next (Int32, 4 + 4), pins (Uint16, 2), flags (Uint8, 1)
 * and one 8-byte element each in the `keys` and `vals` arrays (Node's V8 has no pointer
 * compression). The Map and the key/value objects themselves are not counted; the benchmark's
 * measured bytes/entry includes them (§7.2: "reported (Map-dominated)").
 */
const BYTES_PER_SLOT =
  2 * Int32Array.BYTES_PER_ELEMENT +
  Uint16Array.BYTES_PER_ELEMENT +
  Uint8Array.BYTES_PER_ELEMENT +
  2 * 8;

/** Map's key equality (SameValueZero): like ===, except that NaN equals NaN. */
function sameValueZero(a: unknown, b: unknown): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/**
 * Every entry lives in one "slot" s, a position in parallel arrays (struct of arrays):
 * keys[s], vals[s], prev[s], next[s], pins[s], flags[s]. A slot is in exactly one of three states:
 *
 *   linked    holds an entry, pins[s] = 0, and sits on the recency list (head = MRU … tail = LRU)
 *   pinned    holds an entry, pins[s] > 0, and is NOT on the list (prev[s] = next[s] = NIL)
 *   free      holds nothing and sits on the free stack, whose links reuse next[s]
 *
 * Note on `!`: with noUncheckedIndexedAccess a typed-array read is typed `number | undefined`.
 * Every index used below is a slot taken from `index`, `head`, `tail`, `free` or a neighbour link,
 * and invariants L1–L4 keep those inside [0, slots), so the reads are asserted with `!`.
 */
export class LruCache<K, V> implements LRU<K, V> {
  /** key → slot. The only hashing in the structure; the recency order lives in prev/next. */
  private readonly index = new Map<K, number>();
  /** Bounded mode: maximum size. undefined: unbounded (the pager evicts explicitly). */
  private readonly cap: number | undefined;

  // Slot arrays; all have the same length (the allocated slot count, stats().capacity).
  private keys: (K | undefined)[] = [];
  private vals: (V | undefined)[] = [];
  /** Linked: neighbour towards the MRU end (NIL at head). Pinned or free: NIL. */
  private prev = new Int32Array(0);
  /** Linked: neighbour towards the LRU end (NIL at tail). Free: next free slot. Pinned: NIL. */
  private next = new Int32Array(0);
  /** Pin count; > 0 means pinned, i.e. unlinked and never evicted. */
  private pins = new Uint16Array(0);
  /** Bit 0 = SPECULATIVE. */
  private flags = new Uint8Array(0);

  /** MRU end of the recency list, or NIL when no entry is evictable. */
  private head = NIL;
  /** LRU end: always the least recently used UNPINNED entry, because pinned entries are unlinked. */
  private tail = NIL;
  /** Top of the free-slot stack (threaded through `next`), or NIL. */
  private free = NIL;
  /** Slots on the recency list (= evictableSize). */
  private linked = 0;
  /** Slots holding an entry; L3 checks it against index.size, so a leaked slot is caught. */
  private used = 0;

  constructor(opts?: LruOptions) {
    const capacity = opts?.capacity;
    if (
      capacity !== undefined &&
      !(Number.isInteger(capacity) && capacity >= 1 && capacity <= MAX_SLOTS)
    ) {
      throw new DsaError(
        'RANGE',
        `dsa/lru: capacity must be an integer in [1, 2^30], got ${capacity}`,
      );
    }
    const initial = opts?.initialSlots ?? DEFAULT_SLOTS;
    if (!(Number.isInteger(initial) && initial >= 0 && initial <= MAX_SLOTS)) {
      throw new DsaError(
        'RANGE',
        `dsa/lru: initialSlots must be an integer in [0, 2^30], got ${initial}`,
      );
    }
    this.cap = capacity;
    // A bounded cache never holds more than `capacity` entries, so never allocate more slots.
    this.resize(capacity === undefined ? initial : Math.min(initial, capacity));
  }

  // ---------------------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------------------

  get(key: K): V | undefined {
    const s = this.index.get(key);
    if (s === undefined) return undefined;
    this.hit(s);
    return this.vals[s];
  }

  peek(key: K): V | undefined {
    const s = this.index.get(key);
    return s === undefined ? undefined : this.vals[s];
  }

  has(key: K): boolean {
    return this.index.has(key);
  }

  peekLru(): K | undefined {
    return this.tail === NIL ? undefined : this.keys[this.tail];
  }

  isPinned(key: K): boolean {
    const s = this.index.get(key);
    return s !== undefined && this.pins[s] !== 0;
  }

  isSpeculative(key: K): boolean {
    const s = this.index.get(key);
    return s !== undefined && (this.flags[s]! & SPECULATIVE) !== 0;
  }

  get size(): number {
    return this.index.size;
  }

  get evictableSize(): number {
    return this.linked;
  }

  get capacity(): number | undefined {
    return this.cap;
  }

  /**
   * Evictable keys, MRU first. The walk reads the successor before yielding, so the caller may
   * delete, evict or touch the key it was just given; any other change during iteration is unsafe.
   */
  *keysMruToLru(): IterableIterator<K> {
    let s = this.head;
    while (s !== NIL) {
      const after = this.next[s]!;
      yield this.keys[s] as K;
      s = after;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Updates
  // ---------------------------------------------------------------------------------------------

  put(key: K, value: V): [K, V] | undefined {
    const s = this.index.get(key);
    if (s === undefined) return this.insert(key, value, false);
    // Existing key: an update needs no room, so it never evicts (and never throws FULL).
    this.vals[s] = value;
    this.hit(s);
    return undefined;
  }

  putAtLru(key: K, value: V): [K, V] | undefined {
    const s = this.index.get(key);
    if (s === undefined) return this.insert(key, value, true);
    this.vals[s] = value;
    this.demote(s);
    this.flags[s] = this.flags[s]! | SPECULATIVE;
    return undefined;
  }

  touch(key: K): boolean {
    const s = this.index.get(key);
    if (s === undefined) return false;
    this.hit(s);
    return true;
  }

  moveToLru(key: K): boolean {
    const s = this.index.get(key);
    if (s === undefined) return false;
    this.demote(s);
    return true;
  }

  evict(): [K, V] | undefined {
    // O(1) worst case: pinned entries are not on the list, so the tail is always evictable and
    // no scan past pinned entries is ever needed (MEM-02: pinned pages are never evicted).
    const s = this.tail;
    if (s === NIL) return undefined;
    const entry: [K, V] = [this.keys[s] as K, this.vals[s] as V];
    this.unlink(s);
    this.release(s);
    return entry;
  }

  delete(key: K): boolean {
    const s = this.index.get(key);
    if (s === undefined) return false;
    if (this.pins[s] === 0) this.unlink(s); // a pinned slot is already off the list
    this.release(s);
    return true;
  }

  pin(key: K): void {
    const s = this.index.get(key);
    if (s === undefined) throw new DsaError('NOT_FOUND', 'dsa/lru: pin of an absent key');
    const count = this.pins[s]!;
    if (count === MAX_PINS)
      throw new DsaError('RANGE', `dsa/lru: pin count would exceed ${MAX_PINS}`);
    // 0 → 1: leave the recency list, so the tail (the eviction victim) can never be this entry.
    if (count === 0) this.unlink(s);
    this.pins[s] = count + 1;
  }

  unpin(key: K): void {
    const s = this.index.get(key);
    if (s === undefined) throw new DsaError('NOT_FOUND', 'dsa/lru: unpin of an absent key');
    const count = this.pins[s]!;
    if (count === 0) throw new DsaError('INVALID', 'dsa/lru: unpin of an entry that is not pinned');
    this.pins[s] = count - 1;
    // 1 → 0: rejoin the list at the MRU end, because a pinned entry was in use until now.
    if (count === 1) this.linkHead(s);
  }

  // ---------------------------------------------------------------------------------------------
  // Accounting and checking
  // ---------------------------------------------------------------------------------------------

  stats(): DsaStats {
    const slots = this.prev.length;
    return {
      size: this.index.size,
      capacity: slots,
      bytesAllocated: slots * BYTES_PER_SLOT,
      bytesUsed: this.used * BYTES_PER_SLOT,
    };
  }

  /**
   * Verifies L1–L5 in O(slots) with one scratch mark per slot; throws an Error whose message
   * starts with "dsa/lru invariant <id>". Called by the property test after every operation.
   */
  checkInvariants(): void {
    const { prev, next, pins, flags, keys, vals } = this;
    const slots = prev.length;
    const fail = (id: string, what: string): never => {
      throw new Error(`dsa/lru invariant ${id} violated: ${what}`);
    };
    const ON_LIST = 1;
    const INDEXED = 2;
    const FREE = 4;
    const mark = new Uint8Array(slots);

    // L1: head → … → tail via next, prev mirrors next, exactly `linked` slots, no cycle.
    if ((this.head === NIL) !== (this.tail === NIL))
      fail('L1', `head ${this.head} and tail ${this.tail} disagree on emptiness`);
    let count = 0;
    let last = NIL;
    for (let s = this.head; s !== NIL; s = next[s]!) {
      if (!(s >= 0 && s < slots)) fail('L1', `list slot ${s} is out of range [0, ${slots})`);
      if ((mark[s]! & ON_LIST) !== 0) fail('L1', `the list revisits slot ${s} (cycle)`);
      if (prev[s] !== last) fail('L1', `prev[${s}] is ${prev[s]}, expected ${last}`);
      mark[s] = mark[s]! | ON_LIST;
      count++;
      last = s;
    }
    if (last !== this.tail)
      fail('L1', `the walk from head ends at slot ${last}, but tail is ${this.tail}`);
    if (count !== this.linked)
      fail('L1', `the list has ${count} slots, but evictableSize is ${this.linked}`);

    // L3 (size) before the per-key pass: every used slot is indexed exactly once.
    if (this.index.size !== this.used)
      fail('L3', `index.size is ${this.index.size}, but ${this.used} slots are in use`);

    // L3 per key, and L2: an indexed slot is on the list if and only if it is unpinned.
    for (const [k, s] of this.index) {
      if (!(Number.isInteger(s) && s >= 0 && s < slots))
        fail('L3', `a key maps to slot ${s}, out of range [0, ${slots})`);
      if (!sameValueZero(keys[s], k))
        fail('L3', `keys[${s}] is not the key that indexes slot ${s}`);
      if ((mark[s]! & INDEXED) !== 0) fail('L3', `slot ${s} is indexed by two keys`);
      mark[s] = mark[s]! | INDEXED;
      const onList = (mark[s] & ON_LIST) !== 0;
      if (pins[s] === 0 && !onList) fail('L2', `slot ${s} is unpinned but not on the recency list`);
      if (pins[s] !== 0 && onList)
        fail('L2', `slot ${s} is pinned (count ${pins[s]}) but still on the recency list`);
    }
    for (let s = 0; s < slots; s++) {
      if ((mark[s]! & ON_LIST) !== 0 && (mark[s]! & INDEXED) === 0)
        fail('L2', `slot ${s} is on the list but holds no indexed entry`);
    }

    // L4: the free stack is acyclic, disjoint from used slots, and free + used covers every slot.
    if (
      next.length !== slots ||
      pins.length !== slots ||
      flags.length !== slots ||
      keys.length !== slots ||
      vals.length !== slots
    ) {
      fail('L4', 'the slot arrays have different lengths');
    }
    let freeCount = 0;
    for (let s = this.free; s !== NIL; s = next[s]!) {
      if (!(s >= 0 && s < slots)) fail('L4', `free slot ${s} is out of range [0, ${slots})`);
      if ((mark[s]! & FREE) !== 0) fail('L4', `the free stack revisits slot ${s} (cycle)`);
      if ((mark[s]! & (ON_LIST | INDEXED)) !== 0) fail('L4', `slot ${s} is both free and in use`);
      if (pins[s] !== 0 || flags[s] !== 0)
        fail('L4', `free slot ${s} has a stale pin count or flag`);
      mark[s] = mark[s]! | FREE;
      freeCount++;
    }
    if (freeCount + this.used !== slots)
      fail('L4', `${freeCount} free + ${this.used} used slots ≠ ${slots} slots (a slot leaked)`);

    // L5: a bounded cache never exceeds its capacity.
    if (this.cap !== undefined && this.index.size > this.cap)
      fail('L5', `size ${this.index.size} exceeds capacity ${this.cap}`);
  }

  /** Test-only: see LruCorruption. */
  debugCorrupt(kind: LruCorruption): void {
    switch (kind) {
      case 'pinned-linked':
        if (this.head === NIL)
          throw new Error("dsa/lru: 'pinned-linked' needs at least one evictable entry");
        this.pins[this.head] = 1; // pinned, yet still linked: breaks L2
        break;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Internals: the recency list, the free-slot stack and the slot arrays
  // ---------------------------------------------------------------------------------------------

  /** A use of slot s (get, touch, put of an existing key): MRU unless pinned; promotes it. */
  private hit(s: number): void {
    if (this.pins[s] === 0 && this.head !== s) {
      this.unlink(s);
      this.linkHead(s);
    }
    this.flags[s] = this.flags[s]! & ~SPECULATIVE;
  }

  /** Demotion (moveToLru, putAtLru of an existing key): LRU end unless pinned. */
  private demote(s: number): void {
    if (this.pins[s] === 0 && this.tail !== s) {
      this.unlink(s);
      this.linkTail(s);
    }
  }

  /** Insert a new key; in bounded mode at capacity, evict first (FULL, with no change, if nothing can go). */
  private insert(key: K, value: V, atLru: boolean): [K, V] | undefined {
    let evicted: [K, V] | undefined;
    if (this.cap !== undefined && this.index.size >= this.cap) {
      // An empty recency list at capacity means every entry is pinned: nothing may be evicted.
      if (this.tail === NIL)
        throw new DsaError('FULL', `dsa/lru: all ${this.cap} entries are pinned`);
      evicted = this.evict(); // frees a slot, which allocSlot reuses below
    }
    const s = this.allocSlot();
    this.keys[s] = key;
    this.vals[s] = value;
    this.flags[s] = atLru ? SPECULATIVE : 0;
    // pins[s] is already 0: resize() and release() leave every free slot with count 0 (L4).
    if (atLru) this.linkTail(s);
    else this.linkHead(s);
    this.index.set(key, s);
    return evicted;
  }

  /** Link slot s at the MRU end. */
  private linkHead(s: number): void {
    const old = this.head;
    this.prev[s] = NIL;
    this.next[s] = old;
    if (old === NIL)
      this.tail = s; // the list was empty: s is also the LRU end
    else this.prev[old] = s;
    this.head = s;
    this.linked++;
  }

  /** Link slot s at the LRU end (speculative insertion, demotion). */
  private linkTail(s: number): void {
    const old = this.tail;
    this.next[s] = NIL;
    this.prev[s] = old;
    if (old === NIL)
      this.head = s; // the list was empty: s is also the MRU end
    else this.next[old] = s;
    this.tail = s;
    this.linked++;
  }

  /** Remove slot s from the list by joining its neighbours; head/tail move if s was an end. */
  private unlink(s: number): void {
    const p = this.prev[s]!;
    const n = this.next[s]!;
    if (p === NIL) this.head = n;
    else this.next[p] = n;
    if (n === NIL) this.tail = p;
    else this.prev[n] = p;
    this.prev[s] = NIL;
    this.next[s] = NIL;
    this.linked--;
  }

  /** Pop a free slot, growing the arrays by doubling when the free stack is empty. */
  private allocSlot(): number {
    if (this.free === NIL) {
      const slots = this.prev.length;
      if (slots >= MAX_SLOTS) throw new DsaError('RANGE', `dsa/lru: more than 2^30 entries`);
      let to = Math.max(1, 2 * slots);
      if (this.cap !== undefined) to = Math.min(to, this.cap); // > slots, since used < cap here
      this.resize(to);
    }
    const s = this.free;
    this.free = this.next[s]!;
    this.next[s] = NIL;
    this.used++;
    return s;
  }

  /** Forget the entry in slot s (already unlinked) and push s on the free stack. */
  private release(s: number): void {
    this.index.delete(this.keys[s] as K);
    this.keys[s] = undefined; // drop the references so the key and value can be collected
    this.vals[s] = undefined;
    this.pins[s] = 0;
    this.flags[s] = 0;
    this.prev[s] = NIL;
    this.next[s] = this.free;
    this.free = s;
    this.used--;
  }

  /**
   * Grow every slot array to `to` slots, copying the old contents, and push the new slots on the
   * free stack lowest index on top (so slots are handed out in index order). O(to); called only
   * when the free stack is empty and `to` is about double the old length, so amortised O(1).
   */
  private resize(to: number): void {
    const from = this.prev.length;
    const prev = new Int32Array(to);
    prev.set(this.prev);
    prev.fill(NIL, from);
    const next = new Int32Array(to);
    next.set(this.next);
    const pins = new Uint16Array(to);
    pins.set(this.pins);
    const flags = new Uint8Array(to);
    flags.set(this.flags);
    this.prev = prev;
    this.next = next;
    this.pins = pins;
    this.flags = flags;
    for (let s = from; s < to; s++) {
      this.keys.push(undefined); // push keeps the arrays packed (no holes) for V8
      this.vals.push(undefined);
    }
    for (let s = to - 1; s >= from; s--) {
      next[s] = this.free;
      this.free = s;
    }
  }
}
