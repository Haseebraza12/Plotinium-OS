/**
 * S6: open-addressing hash table for integer keys (specs/08-dsa/data-structures.md §3.5 S6, §4.6,
 * §5 S6). The distinction-credit hash table (§10.2, DSA-HASH-01).
 *
 * Owner: R1 Kernel · non-owner reviewer: R3 · must be IMPLEMENTED by v0.2.0 (P2, target W6).
 * Mandatory location (Spec §10.1 hash-maps row): the process table pid → PCB (PROC-01) and the
 * window registry wid → WinRec (WM-01). One generic IntHashTable<V> backs both.
 *
 * Collision strategy (declared, §10.2): open addressing with LINEAR PROBING; load factor kept
 * ≤ 0.5 (grow by doubling before an insert would exceed it); BACKWARD-SHIFT deletion, so there are
 * no tombstones; shrink to half when a delete leaves size < cap/8 and cap > 8 (hysteresis).
 * Hash: Fibonacci hashing h(k) = Math.imul(k, 0x9E3779B1) >>> (32 − log2(cap)), cap a power of
 * two ≥ 8 so the shift stays ≤ 29 (Knuth, TAOCP vol. 3 §6.4).
 *
 * Layout: `keys: Int32Array(cap)` (−1 = EMPTY), `vals: (V | undefined)[]`, `size`, `cap`, `mask`,
 * `shift`: 24–48 bytes per entry at load 0.25–0.5, excluding the value objects.
 *
 * | Operation            | Complexity                          |
 * |----------------------|-------------------------------------|
 * | get, has             | O(1) expected (α ≤ 0.5)             |
 * | set                  | O(1) amortised expected             |
 * | delete               | O(1) expected (backward shift)      |
 * | forEach, keys, clear | O(capacity), slot order             |
 *
 * `probeStats()`: the probe length of a key is the number of slots a successful lookup examines,
 * ((slot − home) & mask) + 1; maxProbe is the maximum and meanProbe the mean over keys (both 0
 * when empty); loadFactor = size / capacity.
 *
 * Invariants checked by `checkInvariants()` (§5 S6), each failure message names its id:
 * HT1 every slot on the cyclic run from h(k) to the slot of k is occupied (reachability);
 * HT2 keys are unique; HT3 size equals the number of occupied slots and size ≤ cap/2;
 * HT4 cap is a power of two ≥ 8 with shift = 32 − log2(cap); HT5 vals[j] === undefined iff
 * keys[j] === −1.
 *
 * Implementation notes (R1, first principles; no package and no pilot code, §3.1, §10.2):
 *
 * - Why one EMPTY sentinel is enough. Keys are 0..2^31−1, so −1 can never be a real key and fits
 *   in an Int32Array. Because deletion shifts entries back instead of leaving tombstones, a slot is
 *   only ever EMPTY or OCCUPIED, and a probe may stop at the first EMPTY slot (HT1).
 * - Why every probe loop terminates. HT3 keeps size ≤ cap/2, so at least half of the slots are
 *   EMPTY and a linear probe from any slot reaches one within cap steps.
 * - Iteration is fail-fast. A backward shift can move a not-yet-visited entry into a slot the
 *   cursor has already passed, and a resize rebuilds the arrays, so forEach and keys() cannot
 *   visit every key exactly once if the table changes shape under them. Inserting or deleting a key
 *   (or clear) while an iteration is running therefore makes the iteration throw INVALID; replacing
 *   the value of an existing key is allowed. Collect the keys first to delete while walking.
 */
import { DsaError } from '../_shared/errors.ts';
import type { DsaStats } from '../_shared/errors.ts';

export const IMPLEMENTED = true;

/** Keys are integers 0..2^31−1; any other key throws RANGE. Values may not be undefined. */
export interface IntHashTable<V> {
  /** O(1) expected. */
  get(key: number): V | undefined;
  /** O(1) amortised expected; grows before the load would exceed 0.5. */
  set(key: number, value: V): void;
  /** O(1) expected; backward shift; may shrink (hysteresis). */
  delete(key: number): boolean;
  has(key: number): boolean;
  readonly size: number;
  /** Slots (a power of two ≥ 8). */
  readonly capacity: number;
  /** O(capacity), slot order. */
  forEach(cb: (value: V, key: number) => void): void;
  /** O(capacity), slot order. */
  keys(): IterableIterator<number>;
  clear(): void;
  probeStats(): ProbeStats;
  stats(): DsaStats;
  checkInvariants(): void;
}

export interface ProbeStats {
  maxProbe: number;
  meanProbe: number;
  loadFactor: number;
}

/**
 * Deliberate corruptions for the checkInvariants tests only (never called by product code):
 * - 'probe-hole': empty the slot just before the first entry (in slot order) that is not in its
 *   home slot (keys[i] := −1, vals[i] := undefined, size − 1) WITHOUT a backward shift, so that
 *   entry is cut off from its home (breaks HT1 only); needs at least one displaced entry.
 */
export type HashCorruption = 'probe-hole';

/** Marks a free slot in `keys`. Never a valid key, since keys are 0..2^31−1. */
const EMPTY = -1;

/** Smallest capacity: keeps shift = 32 − log2(cap) ≤ 29, well below 32 (see fibHash). */
const MIN_CAPACITY = 8;

/**
 * Largest capacity (2^30 slots, so 2^29 entries). Far beyond what the kernel needs (PID_MAX is
 * 32,767); it only guards the constructor against absurd or infinite requests.
 */
const MAX_CAPACITY = 2 ** 30;

/** 2,654,435,761 ≈ 2^32/φ (golden ratio), odd, so k ↦ k·A mod 2^32 is a bijection. */
const FIB_MULTIPLIER = 0x9e3779b1;

/**
 * Bytes per slot for stats(): 4 B for the Int32Array key plus 8 B for the value reference (one
 * tagged pointer per JS array element on 64-bit V8 without pointer compression, Node's default).
 * At load 0.25–0.5 this is 48–24 bytes per entry, the §3.5 S6 estimate.
 */
const BYTES_PER_SLOT = 4 + 8;

/**
 * Fibonacci (multiplicative) hash: the top log2(cap) bits of the 32-bit product k·A.
 *
 * Math.imul gives the low 32 bits of the product as a signed int32; `>>> shift` reinterprets it as
 * unsigned and keeps the top (32 − shift) = log2(cap) bits, a slot in 0..cap−1. The top bits mix
 * every bit of k, so consecutive pids land far apart instead of in one run. JavaScript takes shift
 * counts mod 32, so a shift of 32 (cap = 1) would be a no-op: MIN_CAPACITY = 8 keeps shift ≤ 29.
 */
function fibHash(key: number, shift: number): number {
  return Math.imul(key, FIB_MULTIPLIER) >>> shift;
}

/** Throws RANGE unless key is an integer in 0..2^31−1 (also rejects NaN, fractions and ±∞). */
function checkKey(key: number): void {
  // `key | 0` truncates to int32, so equality holds only for integers in −2^31..2^31−1.
  if ((key | 0) !== key || key < 0) {
    throw new DsaError(
      'RANGE',
      `dsa/hashtable: key must be an integer in 0..2^31−1, got ${String(key)}`,
    );
  }
}

/** log2 of a power of two. */
function log2(powerOfTwo: number): number {
  return 31 - Math.clz32(powerOfTwo);
}

/**
 * An array of exactly `cap` undefined slots. `new Array(cap)` sizes the backing store once;
 * growing it with push() would over-allocate by up to 1.5× and break the 12 B/slot budget.
 */
function emptyValues<V>(cap: number): (V | undefined)[] {
  return new Array<V | undefined>(cap).fill(undefined);
}

function modifiedDuringIteration(): DsaError {
  return new DsaError(
    'INVALID',
    'dsa/hashtable: a key was inserted or deleted during forEach/keys()',
  );
}

export class OpenAddressingTable<V> implements IntHashTable<V> {
  /** keys[j] is the key in slot j, or EMPTY. */
  #keys: Int32Array;
  /** vals[j] is the value of keys[j]; undefined exactly when keys[j] is EMPTY (HT5). */
  #vals: (V | undefined)[];
  /** Number of occupied slots. */
  #size = 0;
  /** Number of slots: a power of two ≥ 8 (HT4). */
  #cap: number;
  /** cap − 1: `(i + 1) & mask` is the next slot with wrap-around from cap − 1 to 0. */
  #mask: number;
  /** 32 − log2(cap), the right shift of fibHash. */
  #shift: number;
  /** Bumped on every insert, delete and clear, so an iteration can detect them (fail-fast). */
  #modCount = 0;

  /** `initialCapacity` is rounded up to a power of two ≥ 8 (default 8). */
  constructor(initialCapacity = MIN_CAPACITY) {
    if (!(initialCapacity <= MAX_CAPACITY)) {
      throw new DsaError(
        'RANGE',
        `dsa/hashtable: initialCapacity must be at most 2^30, got ${String(initialCapacity)}`,
      );
    }
    let cap = MIN_CAPACITY;
    while (cap < initialCapacity) cap *= 2;
    this.#cap = cap;
    this.#mask = cap - 1;
    this.#shift = 32 - log2(cap);
    this.#keys = new Int32Array(cap).fill(EMPTY);
    this.#vals = emptyValues<V>(cap);
  }

  get size(): number {
    return this.#size;
  }

  get capacity(): number {
    return this.#cap;
  }

  /** O(1) expected: ≈ 1.5 probes on a hit and ≈ 2.5 on a miss at α ≤ ½. */
  get(key: number): V | undefined {
    checkKey(key);
    const slot = this.#find(key);
    return slot === EMPTY ? undefined : this.#vals[slot];
  }

  has(key: number): boolean {
    checkKey(key);
    return this.#find(key) !== EMPTY;
  }

  /** O(1) amortised expected. Replaces the value of an existing key; otherwise inserts. */
  set(key: number, value: V): void {
    checkKey(key);
    if (value === undefined) {
      // HT5 uses undefined to mean "no entry", so it cannot also be a stored value.
      throw new DsaError('INVALID', 'dsa/hashtable: values may not be undefined');
    }
    const keys = this.#keys;
    const mask = this.#mask;
    // Probe the cluster that starts at the home slot: stop at the key (update) or at EMPTY (insert).
    let i = fibHash(key, this.#shift);
    for (;;) {
      const k = keys[i];
      if (k === key) {
        this.#vals[i] = value; // same key: replace the value, size and layout unchanged
        return;
      }
      if (k === EMPTY) break;
      i = (i + 1) & mask;
    }
    // A new key. Grow BEFORE the insert would push the load above ½ (HT3); growing rehashes
    // every key, so the free slot found above is stale and is searched again in the new arrays.
    if (this.#size + 1 > this.#cap >>> 1) {
      this.#resize(this.#cap * 2);
      i = this.#freeSlotFor(key);
    }
    this.#keys[i] = key;
    this.#vals[i] = value;
    this.#size++;
    this.#modCount++;
  }

  /**
   * O(1) expected. Backward-shift deletion (Knuth, TAOCP vol. 3 §6.4, Algorithm R): after emptying
   * slot i, walk the rest of the cluster and move back every entry whose probe path runs through
   * i, so no entry is ever cut off from its home slot (HT1) and no tombstone is needed.
   */
  delete(key: number): boolean {
    checkKey(key);
    let i = this.#find(key);
    if (i === EMPTY) return false;
    const keys = this.#keys;
    const vals = this.#vals;
    const mask = this.#mask;
    const shift = this.#shift;
    keys[i] = EMPTY;
    vals[i] = undefined;
    this.#size--;
    this.#modCount++;

    // i is the hole. Scan j = i+1, i+2, … to the end of the cluster (the first EMPTY slot).
    let j = i;
    for (;;) {
      j = (j + 1) & mask;
      const k = keys[j];
      if (k === undefined || k === EMPTY) break;
      const home = fibHash(k, shift);
      // Distances measured forwards around the ring (so wrap-around from cap−1 to 0 just works):
      //   (j − home) & mask = how far k sits from its home,
      //   (j − i) & mask    = how far k sits from the hole.
      // If the hole is no farther than home, the hole lies on k's path [home, j): lookups for k
      // would now stop at the hole, so k moves into it and its old slot becomes the new hole.
      // Otherwise k's home lies after the hole, its path does not cross the hole, and k stays.
      if (((j - home) & mask) >= ((j - i) & mask)) {
        keys[i] = k;
        vals[i] = vals[j];
        keys[j] = EMPTY;
        vals[j] = undefined;
        i = j;
      }
    }

    // Hysteresis: grow above ½, shrink below ⅛. After either resize the load is about ¼, so
    // Θ(cap) operations must pass before the next resize and the O(cap) rebuild amortises to O(1).
    if (this.#size < this.#cap >>> 3 && this.#cap > MIN_CAPACITY) this.#resize(this.#cap >>> 1);
    return true;
  }

  /** O(capacity), slot order 0..cap−1. Throws INVALID if a key is inserted or deleted meanwhile. */
  forEach(cb: (value: V, key: number) => void): void {
    const keys = this.#keys;
    const vals = this.#vals;
    const expected = this.#modCount;
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j];
      if (k === undefined || k === EMPTY) continue;
      cb(vals[j] as V, k); // HT5: an occupied slot always has a defined value
      if (this.#modCount !== expected) throw modifiedDuringIteration();
    }
  }

  /** O(capacity), slot order 0..cap−1 (the same order as forEach). Fail-fast like forEach. */
  *keys(): IterableIterator<number> {
    const keys = this.#keys;
    const expected = this.#modCount;
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j];
      if (k === undefined || k === EMPTY) continue;
      yield k;
      if (this.#modCount !== expected) throw modifiedDuringIteration();
    }
  }

  /** O(capacity). Empties every slot and keeps the current capacity (no reallocation). */
  clear(): void {
    this.#keys.fill(EMPTY);
    this.#vals.fill(undefined);
    this.#size = 0;
    this.#modCount++;
  }

  /** O(capacity). Probe length of the key in slot j is ((j − home) & mask) + 1. */
  probeStats(): ProbeStats {
    if (this.#size === 0) return { maxProbe: 0, meanProbe: 0, loadFactor: 0 };
    const keys = this.#keys;
    let max = 0;
    let total = 0;
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j];
      if (k === undefined || k === EMPTY) continue;
      const probe = ((j - fibHash(k, this.#shift)) & this.#mask) + 1;
      if (probe > max) max = probe;
      total += probe;
    }
    return { maxProbe: max, meanProbe: total / this.#size, loadFactor: this.#size / this.#cap };
  }

  /**
   * DsaStats (§3.4): `capacity` here is the number of ENTRIES the allocation holds without
   * growing (cap/2, because the load stays ≤ ½), unlike the `capacity` getter, which counts slots.
   */
  stats(): DsaStats {
    return {
      size: this.#size,
      capacity: this.#cap >>> 1,
      bytesAllocated: this.#cap * BYTES_PER_SLOT,
      bytesUsed: this.#size * BYTES_PER_SLOT,
    };
  }

  /**
   * Throws an Error naming the first broken invariant (HT1–HT5). O(capacity + Σ probe lengths),
   * which is O(capacity) expected; for tests and __DEV__ sampling only, never on hot paths.
   */
  checkInvariants(): void {
    const keys = this.#keys;
    const vals = this.#vals;
    const cap = this.#cap;

    // HT4: capacity shape, and the arrays and derived fields agree with it.
    if (!(Number.isInteger(cap) && cap >= MIN_CAPACITY && (cap & (cap - 1)) === 0)) {
      throw new Error(`HT4 capacity ${cap} is not a power of two ≥ ${MIN_CAPACITY}`);
    }
    if (this.#shift !== 32 - log2(cap) || this.#mask !== cap - 1) {
      throw new Error(`HT4 shift ${this.#shift} / mask ${this.#mask} do not match capacity ${cap}`);
    }
    if (keys.length !== cap || vals.length !== cap) {
      throw new Error(
        `HT4 arrays have ${keys.length} keys and ${vals.length} values for capacity ${cap}`,
      );
    }

    // HT5 (pairing of keys and values) and HT3 (size and load), in one slot scan.
    let occupied = 0;
    for (let j = 0; j < cap; j++) {
      const k = keys[j] ?? EMPTY;
      if ((vals[j] === undefined) !== (k === EMPTY)) {
        throw new Error(
          `HT5 slot ${j}: key ${k} with value ${vals[j] === undefined ? 'undefined' : 'defined'}`,
        );
      }
      if (k !== EMPTY) occupied++;
    }
    if (occupied !== this.#size)
      throw new Error(`HT3 size is ${this.#size} but ${occupied} slots are occupied`);
    if (this.#size > cap >>> 1)
      throw new Error(`HT3 size ${this.#size} exceeds capacity/2 = ${cap >>> 1}`);

    // HT1 and HT2: walk each key's probe path from its home to its slot. Every slot on the way must
    // be occupied (HT1), and none may already hold the same key (HT2). Two copies of a key share a
    // home, so the walk to the later copy always passes the earlier one: no auxiliary set is needed.
    for (let j = 0; j < cap; j++) {
      const k = keys[j] ?? EMPTY;
      if (k === EMPTY) continue;
      if (k < 0) throw new Error(`HT2 slot ${j} holds ${k}, which is not a key in 0..2^31−1`);
      for (let p = fibHash(k, this.#shift); p !== j; p = (p + 1) & this.#mask) {
        const q = keys[p] ?? EMPTY;
        if (q === EMPTY)
          throw new Error(
            `HT1 key ${k} in slot ${j} is unreachable: slot ${p} on its probe path is EMPTY`,
          );
        if (q === k) throw new Error(`HT2 key ${k} is stored twice, in slots ${p} and ${j}`);
      }
    }
  }

  /** Test-only: see HashCorruption. */
  debugCorrupt(kind: HashCorruption): void {
    switch (kind) {
      case 'probe-hole': {
        for (let j = 0; j < this.#cap; j++) {
          const k = this.#keys[j] ?? EMPTY;
          if (k === EMPTY || fibHash(k, this.#shift) === j) continue;
          // k is displaced, so by HT1 the slot before it is occupied: empty it with no shift.
          const i = (j - 1) & this.#mask;
          this.#keys[i] = EMPTY;
          this.#vals[i] = undefined;
          this.#size--;
          this.#modCount++;
          return;
        }
        throw new DsaError(
          'INVALID',
          'dsa/hashtable: probe-hole needs at least one displaced entry',
        );
      }
    }
  }

  /** Slot of `key`, or EMPTY (−1) if absent. Stops at the first EMPTY slot, which HT1 makes sound. */
  #find(key: number): number {
    const keys = this.#keys;
    const mask = this.#mask;
    let i = fibHash(key, this.#shift);
    for (;;) {
      const k = keys[i];
      if (k === key) return i;
      if (k === EMPTY) return EMPTY;
      i = (i + 1) & mask;
    }
  }

  /** First EMPTY slot on the probe path of a key known to be absent. */
  #freeSlotFor(key: number): number {
    const keys = this.#keys;
    const mask = this.#mask;
    let i = fibHash(key, this.#shift);
    while (keys[i] !== EMPTY) i = (i + 1) & mask;
    return i;
  }

  /**
   * O(cap). Rebuild into `newCap` slots: every key gets a new home (the shift changes), so each is
   * re-inserted by linear probing into fresh arrays. Keys are unique, so no equality checks.
   */
  #resize(newCap: number): void {
    const oldKeys = this.#keys;
    const oldVals = this.#vals;
    this.#cap = newCap;
    this.#mask = newCap - 1;
    this.#shift = 32 - log2(newCap);
    this.#keys = new Int32Array(newCap).fill(EMPTY);
    this.#vals = emptyValues<V>(newCap);
    for (let j = 0; j < oldKeys.length; j++) {
      const k = oldKeys[j];
      if (k === undefined || k === EMPTY) continue;
      const i = this.#freeSlotFor(k);
      this.#keys[i] = k;
      this.#vals[i] = oldVals[j];
    }
  }
}

/** pid → PCB (PROC-01). */
export type PidTable<P> = IntHashTable<P>;
/** wid → WinRec (WM-01). */
export type WindowRegistry<W> = IntHashTable<W>;
