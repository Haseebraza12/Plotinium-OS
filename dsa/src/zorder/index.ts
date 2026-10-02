/**
 * S9: z-order list, renumbered 1..n (specs/08-dsa/data-structures.md §3.5 S9, §4.9, §5 S9).
 *
 * Owner: R3 Shell/WM · non-owner reviewer: R5 · must be IMPLEMENTED by v0.2.0 (P2, target W5).
 * Mandatory location: the compositor's stacking order (Spec §9.4, WM-02: "Focusing a window raises
 * it. Z-indices are renumbered 1…n after each change, so they never grow without limit").
 *
 * Design: a doubly linked list of window ids from bottom to top over slot arrays (`prev`, `next`,
 * `z: Int32Array`), plus an S6 IntHashTable from wid to slot (the only structure it may import).
 * `raise` relinks in O(1), then renumbers only the windows between the old position and the top
 * and returns those changes, so the compositor writes `style.zIndex` only for them (CSS
 * `z-index = windowLayerBase + z`).
 *
 * Contract: wids are integers 0..2^31−1 (RANGE otherwise). Every mutator returns the windows whose
 * z changed with their new z, listed bottom to top; the removed window of `remove` is not listed.
 * An operation on a missing wid returns [] and changes nothing; inserting a present wid throws
 * DUPLICATE.
 *
 * | Operation            | Complexity                        |
 * |----------------------|-----------------------------------|
 * | insertTop, zOf       | O(1)                              |
 * | top, bottom          | O(1)                              |
 * | raise, lower, remove | O(1) relink + O(n − p) renumber   |
 * | topWhere, bottomToTop| O(n)                              |
 *
 * (`lower` renumbers the p windows at and below the old position instead, so it is O(p); every
 * mutator is O(1) relink plus at most n renumbered windows. insertTop and the S6 lookups are
 * O(1) amortised expected: the slot arrays and the table grow by doubling.)
 *
 * Invariants checked by `checkInvariants()` (§5 S9), each failure message names its id:
 * Z1 the z numbers are exactly {1..n}, strictly increasing from bottom to top; Z2 list membership
 * equals hash-table membership; Z3 prev/next are mutually consistent.
 *
 * ── Memory layout (struct of arrays, §3.4 "Integer handles on hot paths") ──────────────────────
 *
 * A window lives in a SLOT s, a small integer index shared by four parallel Int32Arrays:
 *
 *   widAt[s]  the window id held by the slot
 *   prev[s]   the slot directly BELOW s (NIL = −1 when s is the bottom)
 *   next[s]   the slot directly ABOVE s (NIL when s is the top); for a free slot, the next free slot
 *   z[s]      the position of s counted from the bottom, 1..n (0 marks a free slot)
 *
 * `head` is the bottom slot and `tail` the top slot (both NIL when empty). Slots freed by `remove`
 * are pushed on a free chain threaded through `next`, so a slot is reused before the arrays grow.
 * `index` (S6 OpenAddressingTable) maps wid → slot, which is what makes every lookup by wid O(1).
 *
 *   bottom                                              top
 *   head ─► [s2 | wid 20 | z 1] ⇄ [s0 | wid 30 | z 2] ⇄ [s1 | wid 10 | z 3] ◄─ tail
 *
 * Per window: 16 bytes of slot arrays (4 × Int32) plus the S6 entry (≈ 24–48 bytes at load
 * 0.25–0.5); the arrays and the table double when full and never shrink.
 */
import { DsaError } from '../_shared/errors.ts';
import type { DsaStats } from '../_shared/errors.ts';
import { OpenAddressingTable } from '../hashtable/index.ts';
import type { IntHashTable } from '../hashtable/index.ts';

export const IMPLEMENTED = true;

export type ZChange = { wid: number; z: number };

export interface ZOrderList {
  /** O(1); the new window gets z = n; DUPLICATE if present. */
  insertTop(wid: number): ZChange[];
  /** O(1) unlink + renumber the windows above it (each z − 1). */
  remove(wid: number): ZChange[];
  /** O(1) relink + renumber from the old position up; [] if already the top. */
  raise(wid: number): ZChange[];
  /** To the bottom: the window gets z = 1 and those below it move up; [] if already the bottom. */
  lower(wid: number): ZChange[];
  /** O(1). */
  zOf(wid: number): number | undefined;
  top(): number | undefined;
  bottom(): number | undefined;
  /** O(n) from the top (focus fallback). */
  topWhere(pred: (wid: number) => boolean): number | undefined;
  /** O(n). */
  bottomToTop(): number[];
  readonly size: number;
  checkInvariants(): void;
}

/** "No slot": below the bottom, above the top, an empty list's head/tail, the end of the free chain. */
const NIL = -1;
/** Largest window id: wids are non-negative int32 handles (§3.4), so they fit `widAt`. */
const MAX_WID = 0x7fff_ffff;
/** Four Int32Array entries per slot: widAt, prev, next, z. */
const SLOT_BYTES = 4 * Int32Array.BYTES_PER_ELEMENT;
/** S6 holds at most 2^30 slots and is sized at twice the capacity, so 2^29 windows at most. */
const MAX_INITIAL_CAPACITY = 2 ** 29;

type ZInvariant = 'Z1' | 'Z2' | 'Z3';

/** Throw the checkInvariants() failure for invariant `id`; the message names the id. */
function violated(id: ZInvariant, detail: string): never {
  throw new Error(`dsa/zorder ${id} violated: ${detail}`);
}

/** RANGE unless `wid` is an integer in 0..2^31−1 (the contract's wid domain). */
function assertWid(wid: number, op: string): void {
  if (!Number.isInteger(wid) || wid < 0 || wid > MAX_WID) {
    throw new DsaError(
      'RANGE',
      `dsa/zorder ${op}: wid must be an integer in 0..2^31-1, got ${String(wid)}`,
    );
  }
}

/** A copy of `a` with room for `capacity` entries (typed-array doubling, §3.4). */
function grown(a: Int32Array, capacity: number): Int32Array {
  const b = new Int32Array(capacity);
  b.set(a);
  return b;
}

export class LinkedZOrder implements ZOrderList {
  // Slot arrays (see the layout note above). Indexing a typed array yields `number | undefined`
  // under noUncheckedIndexedAccess; every index used below is a live slot (< used), so the `!`
  // assertions only restate what Z3 guarantees.
  private widAt: Int32Array;
  private prev: Int32Array;
  private next: Int32Array;
  private z: Int32Array;
  /** Bottom slot, or NIL when empty. */
  private head = NIL;
  /** Top slot, or NIL when empty. */
  private tail = NIL;
  /** First slot of the free chain (linked through `next`), or NIL. */
  private freeHead = NIL;
  /** Slots 0..used−1 have been handed out at least once; the rest are fresh. */
  private used = 0;
  /** n, the number of windows in the list. */
  private count = 0;
  /** S6: wid → slot. Z2 says its keys are exactly the wids in the list. */
  private readonly index: IntHashTable<number>;

  constructor(initialCapacity = 16) {
    if (
      !Number.isInteger(initialCapacity) ||
      initialCapacity < 0 ||
      initialCapacity > MAX_INITIAL_CAPACITY
    ) {
      throw new DsaError(
        'RANGE',
        `dsa/zorder: initialCapacity must be an integer in 0..2^29, got ${String(initialCapacity)}`,
      );
    }
    const capacity = Math.max(1, initialCapacity);
    this.widAt = new Int32Array(capacity);
    this.prev = new Int32Array(capacity);
    this.next = new Int32Array(capacity);
    this.z = new Int32Array(capacity);
    // S6 grows before its load exceeds 0.5, so 2 × capacity slots hold `capacity` windows
    // without a rehash.
    this.index = new OpenAddressingTable<number>(2 * capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Slots the arrays can hold before they double. */
  get capacity(): number {
    return this.z.length;
  }

  // ── Mutators ─────────────────────────────────────────────────────────────────────────────────

  insertTop(wid: number): ZChange[] {
    assertWid(wid, 'insertTop');
    if (this.index.has(wid)) {
      throw new DsaError(
        'DUPLICATE',
        `dsa/zorder insertTop: window ${wid} is already in the z-order`,
      );
    }
    const slot = this.allocSlot();
    this.widAt[slot] = wid;
    this.linkTop(slot);
    this.count += 1;
    // Z1: the windows below keep 1..n−1, so the new top is exactly n and nothing else changes.
    this.z[slot] = this.count;
    this.index.set(wid, slot);
    return [{ wid, z: this.count }];
  }

  remove(wid: number): ZChange[] {
    const slot = this.slotOf(wid, 'remove');
    if (slot === NIL) return [];
    const p = this.z[slot]!;
    const above = this.next[slot]!;
    this.unlink(slot);
    this.freeSlot(slot);
    this.index.delete(wid);
    this.count -= 1;
    // Windows p+1..n each move down by one: the old successor now sits at position p. Windows
    // below p are untouched. When the top was removed, `above` is NIL and nothing changes.
    return this.renumber(above, p, this.count);
  }

  raise(wid: number): ZChange[] {
    const slot = this.slotOf(wid, 'raise');
    if (slot === NIL || slot === this.tail) return [];
    const p = this.z[slot]!;
    // Not NIL: the slot is not the top, so some window is above it.
    const above = this.next[slot]!;
    this.unlink(slot); // O(1)
    this.linkTop(slot); // O(1)
    // The windows that were at p+1..n now sit at p..n−1 and the raised window at n. The walk from
    // `above` passes exactly those n − p windows and ends at the raised one (the new tail), so the
    // changes are listed bottom to top and nobody below p is visited.
    return this.renumber(above, p, this.count);
  }

  lower(wid: number): ZChange[] {
    const slot = this.slotOf(wid, 'lower');
    if (slot === NIL || slot === this.head) return [];
    const p = this.z[slot]!;
    this.unlink(slot); // O(1)
    this.linkBottom(slot); // O(1)
    // The lowered window becomes 1 and the p − 1 windows that were below it move up to 2..p.
    // Windows above p keep their numbers, so the walk stops after p slots.
    return this.renumber(slot, 1, p);
  }

  // ── Queries ──────────────────────────────────────────────────────────────────────────────────

  zOf(wid: number): number | undefined {
    const slot = this.slotOf(wid, 'zOf');
    return slot === NIL ? undefined : this.z[slot];
  }

  top(): number | undefined {
    return this.tail === NIL ? undefined : this.widAt[this.tail];
  }

  bottom(): number | undefined {
    return this.head === NIL ? undefined : this.widAt[this.head];
  }

  /** The topmost window satisfying `pred`, walking down from the top. `pred` must not mutate the list. */
  topWhere(pred: (wid: number) => boolean): number | undefined {
    for (let s = this.tail; s !== NIL; s = this.prev[s]!) {
      const wid = this.widAt[s]!;
      if (pred(wid)) return wid;
    }
    return undefined;
  }

  bottomToTop(): number[] {
    const out: number[] = [];
    for (let s = this.head; s !== NIL; s = this.next[s]!) out.push(this.widAt[s]!);
    return out;
  }

  /** Memory accounting (§3.4): the slot arrays plus the S6 table. */
  stats(): DsaStats {
    const table = this.index.stats();
    return {
      size: this.count,
      capacity: this.capacity,
      bytesAllocated: this.capacity * SLOT_BYTES + table.bytesAllocated,
      bytesUsed: this.count * SLOT_BYTES + table.bytesUsed,
    };
  }

  /**
   * O(n + free slots). One walk from the bottom checks Z3 (each prev points at the slot the walk
   * came from, the walk ends at the tail after exactly n slots), Z1 (the k-th slot has z = k, so
   * the numbers are exactly 1..n and strictly increasing) and Z2 (the table maps each listed wid
   * to its own slot, and holds exactly n keys). A second walk checks that the free chain and the
   * list together account for every slot handed out (part of Z3: `next` also links free slots).
   */
  checkInvariants(): void {
    const n = this.count;
    if ((this.head === NIL) !== (n === 0) || (this.tail === NIL) !== (n === 0)) {
      violated('Z3', `head ${this.head} and tail ${this.tail} disagree with size ${n}`);
    }
    let below = NIL;
    let k = 0;
    for (let s = this.head; s !== NIL; s = this.next[s] ?? NIL) {
      if (s < 0 || s >= this.used)
        violated('Z3', `link to slot ${s} outside the ${this.used} slots in use`);
      k += 1;
      if (k > n)
        violated(
          'Z3',
          `the walk from the bottom passes more than size = ${n} slots (a cycle or a stale link)`,
        );
      if (this.prev[s] !== below)
        violated('Z3', `prev[${s}] = ${this.prev[s]} but the slot below it is ${below}`);
      const wid = this.widAt[s] ?? NIL;
      if (this.z[s] !== k)
        violated('Z1', `window ${wid} at position ${k} from the bottom has z = ${this.z[s]}`);
      const mapped = wid < 0 ? undefined : this.index.get(wid);
      if (mapped !== s)
        violated(
          'Z2',
          `window ${wid} is listed at slot ${s} but the table maps it to ${String(mapped)}`,
        );
      below = s;
    }
    if (k !== n) violated('Z1', `the list holds ${k} windows but size = ${n}`);
    if (below !== this.tail)
      violated(
        'Z3',
        `the walk from the bottom ends at slot ${below}, not at the tail ${this.tail}`,
      );
    if (this.index.size !== n)
      violated('Z2', `the table holds ${this.index.size} wids but the list holds ${n}`);
    let free = 0;
    for (let s = this.freeHead; s !== NIL; s = this.next[s] ?? NIL) {
      free += 1;
      if (free > this.used - n)
        violated('Z3', `the free chain is longer than the ${this.used - n} slots outside the list`);
      if (this.z[s] !== 0) violated('Z3', `free slot ${s} still has z = ${this.z[s]}`);
    }
    if (free + n !== this.used)
      violated('Z3', `${n} listed + ${free} free slots, but ${this.used} slots in use`);
  }

  // ── Slot and link primitives, each O(1) ─────────────────────────────────────────────────────

  /** The slot of `wid`, or NIL when the window is not in the list (after the RANGE check). */
  private slotOf(wid: number, op: string): number {
    assertWid(wid, op);
    return this.index.get(wid) ?? NIL;
  }

  /**
   * Walk up from slot `start`, giving the slots the numbers first, first+1, …, last, and report
   * each one as a change (bottom to top). O(last − first + 1). Callers pass a range that ends at
   * or below the top, so the walk never runs off the list.
   */
  private renumber(start: number, first: number, last: number): ZChange[] {
    // Local aliases keep the three arrays in registers for the O(n) loop, the only one on a hot path.
    const { z, widAt, next } = this;
    const changes: ZChange[] = [];
    let s = start;
    for (let zNew = first; zNew <= last && s !== NIL; zNew++) {
      z[s] = zNew;
      changes.push({ wid: widAt[s]!, z: zNew });
      s = next[s]!;
    }
    return changes;
  }

  /** Take a slot from the free chain, or the next fresh slot (doubling the arrays when full). */
  private allocSlot(): number {
    if (this.freeHead !== NIL) {
      const slot = this.freeHead;
      this.freeHead = this.next[slot]!;
      return slot;
    }
    if (this.used === this.capacity) this.grow();
    const slot = this.used;
    this.used += 1;
    return slot;
  }

  /** Push an unlinked slot on the free chain; z = 0 marks it free (checked by Z3). */
  private freeSlot(slot: number): void {
    this.z[slot] = 0;
    this.prev[slot] = NIL;
    this.widAt[slot] = NIL;
    this.next[slot] = this.freeHead;
    this.freeHead = slot;
  }

  /** Double every slot array: O(capacity), so amortised O(1) per insertTop. */
  private grow(): void {
    const capacity = this.capacity * 2;
    this.widAt = grown(this.widAt, capacity);
    this.prev = grown(this.prev, capacity);
    this.next = grown(this.next, capacity);
    this.z = grown(this.z, capacity);
  }

  /** Link a detached slot above the current top. */
  private linkTop(slot: number): void {
    this.prev[slot] = this.tail;
    this.next[slot] = NIL;
    if (this.tail === NIL) this.head = slot;
    else this.next[this.tail] = slot;
    this.tail = slot;
  }

  /** Link a detached slot below the current bottom. */
  private linkBottom(slot: number): void {
    this.next[slot] = this.head;
    this.prev[slot] = NIL;
    if (this.head === NIL) this.tail = slot;
    else this.prev[this.head] = slot;
    this.head = slot;
  }

  /** Detach a live slot, joining its neighbours (or moving head/tail when it was an end). */
  private unlink(slot: number): void {
    const below = this.prev[slot]!;
    const above = this.next[slot]!;
    if (below === NIL) this.head = above;
    else this.next[below] = above;
    if (above === NIL) this.tail = below;
    else this.prev[above] = below;
  }
}
