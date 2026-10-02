/**
 * The kernel timer heap (specs/03-kernel/processes-and-scheduling.md §3.8 `timers`, KPS-13).
 *
 * All kernel timing goes through here: sleep wake-ups, the aging tick, the watchdog tick,
 * CLOSE_GRACE_MS SIGKILL follow-ups, service start timeouts, lease heartbeats, `wait` and B-call
 * timeouts. It is a second `dsa/heap` instance keyed by the deadline (ms, float); heap handles are
 * timer slots taken from a free list. The host arms ONE platform timer for the earliest deadline
 * and re-arms it whenever the minimum changes (`onEarliestChange`).
 *
 * `dsa/heap` does not break ties (data-structures.md §3.5 S3), so `runDue` pops every due entry
 * and runs them in (deadline, priority, arm order) order.
 *
 * | Operation            | Complexity |
 * |----------------------|------------|
 * | arm, cancel, reschedule | O(log T) |
 * | nextDeadline         | O(1)       |
 * | runDue (d due)       | O(d log T + d log d) |
 */
import type { IndexedMinHeap } from '@plotinium/dsa/heap';

import type { HeapFactory } from './types.ts';

/** Opaque timer id: slot + generation, so a stale id never cancels a reused slot. */
export type TimerId = number;

/** 2^21 slots: far more than the kernel ever holds (PROC_MAX 4,096 plus services). */
const SLOT_SPACE = 2_097_152;

export type TimerCallback = (now: number, id: TimerId) => void;

export interface ArmOptions {
  /** Short label for klog and tests, for example `aging`, `watchdog`, `sleep:412`. */
  readonly label?: string;
  /** Tie-break among timers due at the same deadline: smaller runs first (default 0). */
  readonly priority?: number;
  /** Re-arm every `periodMs` after firing (must be > 0). */
  readonly periodMs?: number;
  /** Owning pid, so the kill path can cancel every timer of a process (§3.16 step 2). */
  readonly pid?: number;
}

interface Slot {
  gen: number;
  live: boolean;
  deadline: number;
  priority: number;
  armSeq: number;
  periodMs: number;
  label: string;
  pid: number;
  fn: TimerCallback | null;
}

export interface TimerInfo {
  readonly id: TimerId;
  readonly deadline: number;
  readonly label: string;
  readonly pid: number;
  readonly periodMs: number;
}

export class TimerHeap {
  private readonly heap: IndexedMinHeap;
  private readonly slots: Slot[] = [];
  private readonly free: number[] = [];
  private armCounter = 0;
  private lastEarliest: number | null = null;
  private running = false;
  /** Called with the new earliest deadline (or null) whenever it changes. */
  onEarliestChange: ((deadline: number | null) => void) | null = null;

  constructor(createHeap: HeapFactory, initialCapacity = 64) {
    this.heap = createHeap(initialCapacity);
  }

  get size(): number {
    return this.heap.size;
  }

  /** Arm a timer for absolute `deadline` (ms on the kernel clock). */
  arm(deadline: number, fn: TimerCallback, opts: ArmOptions = {}): TimerId {
    if (!Number.isFinite(deadline)) throw new RangeError('timer deadline must be finite');
    const periodMs = opts.periodMs ?? 0;
    if (opts.periodMs !== undefined && !(periodMs > 0))
      throw new RangeError('timer period must be > 0');
    const slotIndex = this.free.pop() ?? this.slots.length;
    if (slotIndex >= SLOT_SPACE) throw new RangeError('timer slots exhausted');
    let slot = this.slots[slotIndex];
    if (slot === undefined) {
      slot = {
        gen: 0,
        live: false,
        deadline: 0,
        priority: 0,
        armSeq: 0,
        periodMs: 0,
        label: '',
        pid: 0,
        fn: null,
      };
      this.slots[slotIndex] = slot;
    }
    slot.gen += 1;
    slot.live = true;
    slot.deadline = deadline;
    slot.priority = opts.priority ?? 0;
    slot.armSeq = ++this.armCounter;
    slot.periodMs = periodMs;
    slot.label = opts.label ?? '';
    slot.pid = opts.pid ?? 0;
    slot.fn = fn;
    this.heap.push(slotIndex, deadline);
    this.notify();
    return slot.gen * SLOT_SPACE + slotIndex;
  }

  /** Cancel; false if the id is stale (already fired, cancelled or reused). O(log T). */
  cancel(id: TimerId): boolean {
    const slotIndex = this.resolve(id);
    if (slotIndex < 0) return false;
    this.heap.remove(slotIndex);
    this.release(slotIndex);
    this.notify();
    return true;
  }

  /** Move a live timer to a new deadline (changeKey); false if the id is stale. O(log T). */
  reschedule(id: TimerId, deadline: number): boolean {
    if (!Number.isFinite(deadline)) throw new RangeError('timer deadline must be finite');
    const slotIndex = this.resolve(id);
    if (slotIndex < 0) return false;
    const slot = this.slots[slotIndex];
    /* v8 ignore next -- resolve() guarantees the slot exists */
    if (slot === undefined) return false;
    slot.deadline = deadline;
    slot.armSeq = ++this.armCounter;
    this.heap.changePriority(slotIndex, deadline);
    this.notify();
    return true;
  }

  has(id: TimerId): boolean {
    return this.resolve(id) >= 0;
  }

  /** Earliest deadline, or null when no timer is armed. O(1). */
  nextDeadline(): number | null {
    return this.heap.peekKey() ?? null;
  }

  info(id: TimerId): TimerInfo | undefined {
    const slotIndex = this.resolve(id);
    const slot = slotIndex >= 0 ? this.slots[slotIndex] : undefined;
    if (slot === undefined) return undefined;
    return {
      id,
      deadline: slot.deadline,
      label: slot.label,
      pid: slot.pid,
      periodMs: slot.periodMs,
    };
  }

  /** Every live timer owned by `pid` (the kill path cancels them, §3.16 step 2). */
  timersOf(pid: number): TimerId[] {
    const out: TimerId[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s?.live === true && s.pid === pid) out.push(s.gen * SLOT_SPACE + i);
    }
    return out;
  }

  /** Cancel every timer of `pid`; returns how many were cancelled. */
  cancelAllOf(pid: number): number {
    let n = 0;
    for (const id of this.timersOf(pid)) if (this.cancel(id)) n++;
    return n;
  }

  /**
   * Fire every timer with deadline ≤ now, in (deadline, priority, arm order). Entries are taken
   * one deadline at a time, so a timer armed by a callback with an earlier deadline than the
   * remaining due ones still fires first. Periodic timers re-arm at `deadline + k·period`,
   * skipping missed periods (the aging rule recomputes from the wait, so a skipped tick loses
   * nothing). Returns the number of callbacks run.
   */
  runDue(now: number): number {
    if (this.running) return 0;
    this.running = true;
    let fired = 0;
    try {
      for (
        let due = this.heap.peekKey();
        due !== undefined && due <= now;
        due = this.heap.peekKey()
      ) {
        // Every entry of this deadline (dsa/heap does not break ties; we sort them below).
        const batch: TimerId[] = [];
        for (let k = this.heap.peekKey(); k === due; k = this.heap.peekKey()) {
          const slotIndex = this.heap.pop();
          /* v8 ignore next -- peekKey() was defined, so pop() returns a handle */
          if (slotIndex === undefined) break;
          batch.push((this.slots[slotIndex]?.gen ?? 0) * SLOT_SPACE + slotIndex);
        }
        batch.sort((a, b) => this.compareSlots(a % SLOT_SPACE, b % SLOT_SPACE));
        for (const id of batch) {
          // A timer cancelled (and possibly re-armed in its reused slot) by an earlier callback of
          // this batch has a different generation now: skip it.
          const slotIndex = this.resolve(id);
          const slot = slotIndex >= 0 ? this.slots[slotIndex] : undefined;
          if (slot?.fn == null) continue;
          const fn = slot.fn;
          if (slot.periodMs > 0) {
            const missed = Math.floor((now - slot.deadline) / slot.periodMs);
            slot.deadline += (missed + 1) * slot.periodMs;
            slot.armSeq = ++this.armCounter;
            this.heap.push(slotIndex, slot.deadline);
          } else {
            this.release(slotIndex);
          }
          fired++;
          fn(now, id);
        }
      }
    } finally {
      this.running = false;
      this.notify();
    }
    return fired;
  }

  /** Test and `sched` diagnostics: heap invariants of the underlying dsa/heap. */
  checkInvariants(): void {
    this.heap.checkInvariants();
  }

  private compareSlots(a: number, b: number): number {
    const sa = this.slots[a];
    const sb = this.slots[b];
    /* v8 ignore next -- both handles came from the heap */
    if (sa === undefined || sb === undefined) return a - b;
    return sa.deadline - sb.deadline || sa.priority - sb.priority || sa.armSeq - sb.armSeq;
  }

  private resolve(id: TimerId): number {
    if (!Number.isInteger(id) || id < 0) return -1;
    const slotIndex = id % SLOT_SPACE;
    const gen = Math.floor(id / SLOT_SPACE);
    const slot = this.slots[slotIndex];
    return slot?.live === true && slot.gen === gen ? slotIndex : -1;
  }

  private release(slotIndex: number): void {
    const slot = this.slots[slotIndex];
    /* v8 ignore next -- callers pass resolved slots */
    if (slot === undefined) return;
    slot.live = false;
    slot.fn = null;
    this.free.push(slotIndex);
  }

  private notify(): void {
    if (this.running) return;
    const earliest = this.nextDeadline();
    if (earliest === this.lastEarliest) return;
    this.lastEarliest = earliest;
    this.onEarliestChange?.(earliest);
  }
}
