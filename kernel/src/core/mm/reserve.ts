/**
 * Reservation-based admission (specs/03-kernel/memory-and-paging.md §3.7, MEM-06, KMM-06).
 *
 * INV-M1: committed = Σ accounted + Σ reserved ≤ budget at every moment, except the recorded
 * state-growth excursion of §3.2.2. Memory is granted BEFORE it is used; a request that does not
 * fit waits (the caller is BLOCKED `waitingOn = 'mem'`) while reclaim frees space.
 *
 * Normative pseudocode (§3.7.3), implemented here:
 *
 *   reserve(p, bytes): bytes > budget → EINVAL exceeds-budget (ENOMEM only requested);
 *     no waiters and committed + bytes ≤ budget → reserved += bytes (O(1));
 *     else push on memWait keyed (effPrio, arrival), block, direct reclaim of the deficit, and a
 *     MEM_WAIT_MAX_MS timer → EAGAIN mem-pressure.
 *   onFree(): grant waiters in key order while the head fits (no overtaking, so a large request
 *     is never starved by small ones).
 *   commit(ticket, actual): reserved -= ticket; accounted += actual.   cancel: reserved -= ticket.
 *
 * The wait queue is dsa/heap (S3, an indexed binary min-heap over dense handles; C16: its owner
 * implements it). Handles are recycled, so the handle space stays as small as the queue.
 */
import { BinaryHeap } from '@plotinium/dsa';
import type { IndexedMinHeap } from '@plotinium/dsa';

import { MmError } from './errors.ts';

/** Monotonic clock and one-shot timers, injected by the host (kernel worker or Node loopback). */
export interface MmClock {
  now(): number;
  /** Run `fn` after `ms`; returns a function that cancels it. */
  schedule(ms: number, fn: () => void): () => void;
}

export interface Ticket {
  readonly id: number;
  readonly pid: number;
  readonly bytes: number;
  readonly why: string;
  /** False once committed or cancelled. */
  open: boolean;
}

export interface ReserveOptions {
  /** The requester's effective priority 0 (highest) … 39; the focused process is boosted. */
  prio?: number;
  /** For klog and `free -v`: 'alloc', 'declare', 'spawn', 'page-in', 'fault', 'state-growth' … */
  why?: string;
}

export interface ReservationHooks {
  /** A reservation of `pid` could not be granted at once (its caller is now BLOCKED on `mem`). */
  onBlock?(pid: number, bytes: number, why: string): void;
  /** A blocked reservation was granted (or failed): the caller may run again. */
  onWake?(pid: number, granted: boolean): void;
  /** Direct reclaim must free at least `deficit` bytes. */
  onDeficit?(deficit: number): void;
  /** committed crossed the budget upwards (the state-growth excursion) or back down. */
  onOverBudget?(over: boolean, ms: number): void;
  /** A timeout fired: klog `reserve-timeout`. */
  onTimeout?(pid: number, bytes: number, why: string, waitedMs: number): void;
}

export type HeapFactory = () => IndexedMinHeap;

interface Waiter {
  readonly handle: number;
  readonly pid: number;
  readonly bytes: number;
  readonly why: string;
  readonly since: number;
  readonly resolve: (t: Ticket) => void;
  readonly reject: (e: MmError) => void;
  cancelTimer: () => void;
}

/** Priority key: effPrio first, then arrival (FIFO within a priority). */
const PRIO_SPAN = 2 ** 40;

export class Reservations {
  private budgetBytes: number;
  private accountedBytes = 0;
  private reservedBytes = 0;
  private readonly heap: IndexedMinHeap;
  private readonly waiters = new Map<number, Waiter>();
  private readonly freeHandles: number[] = [];
  private nextHandle = 0;
  private seq = 0;
  private nextTicket = 1;
  private overSince: number | null = null;
  private maxOverMs = 0;
  private overEpisodes = 0;

  private readonly clock: MmClock;
  private readonly waitMaxMs: number;
  private readonly hooks: ReservationHooks;

  constructor(
    budget: number,
    clock: MmClock,
    waitMaxMs: number,
    hooks: ReservationHooks = {},
    heapFactory: HeapFactory = () => new BinaryHeap(),
  ) {
    this.budgetBytes = budget;
    this.clock = clock;
    this.waitMaxMs = waitMaxMs;
    this.hooks = hooks;
    this.heap = heapFactory();
  }

  get budget(): number {
    return this.budgetBytes;
  }
  get accounted(): number {
    return this.accountedBytes;
  }
  get reserved(): number {
    return this.reservedBytes;
  }
  get committed(): number {
    return this.accountedBytes + this.reservedBytes;
  }
  get free(): number {
    return Math.max(0, this.budgetBytes - this.committed);
  }
  /** Number of blocked reservations. */
  get blocked(): number {
    return this.waiters.size;
  }
  /** Bytes of the blocked reservations (reservedWaiting in MemStat). */
  get waitingBytes(): number {
    let n = 0;
    for (const w of this.waiters.values()) n += w.bytes;
    return n;
  }
  /** Whether `pid` has a blocked reservation. O(w). */
  hasWaiter(pid: number): boolean {
    for (const w of this.waiters.values()) if (w.pid === pid) return true;
    return false;
  }
  /** Age of the oldest blocked reservation, 0 when none. */
  oldestBlockedMs(): number {
    let oldest = Number.POSITIVE_INFINITY;
    for (const w of this.waiters.values()) oldest = Math.min(oldest, w.since);
    return Number.isFinite(oldest) ? this.clock.now() - oldest : 0;
  }
  /** Bytes the head waiter still needs freed before it fits (0 when nothing waits or it fits). */
  headDeficit(): number {
    const h = this.heap.size > 0 ? this.heap.peek() : undefined;
    const w = h === undefined ? undefined : this.waiters.get(h);
    return w ? Math.max(0, this.committed + w.bytes - this.budgetBytes) : 0;
  }
  /** Longest continuous interval with committed > budget, including a current one (§3.7.3). */
  maxOverBudgetMs(): number {
    const cur = this.overSince === null ? 0 : this.clock.now() - this.overSince;
    return Math.max(this.maxOverMs, cur);
  }
  get overBudgetEpisodes(): number {
    return this.overEpisodes;
  }

  /** Settings → System → Memory: takes effect at once; never kills anything (§3.3). */
  setBudget(bytes: number): void {
    this.budgetBytes = bytes;
    this.noteChange();
    const deficit = this.committed - bytes;
    if (deficit > 0) this.hooks.onDeficit?.(deficit);
    this.onFree();
  }

  /**
   * Reserve `bytes` for `pid`. Resolves at once when it fits and nobody waits; otherwise the
   * caller blocks until reclaim frees space, or fails with EAGAIN `mem-pressure` after
   * MEM_WAIT_MAX_MS. A request larger than the budget can never fit: EINVAL `exceeds-budget`.
   */
  reserve(pid: number, bytes: number, opts: ReserveOptions = {}): Promise<Ticket> {
    const why = opts.why ?? 'alloc';
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return Promise.reject(new MmError('EINVAL', undefined, `bad reservation size ${bytes}`));
    }
    if (bytes > this.budgetBytes) {
      return Promise.reject(
        new MmError('EINVAL', 'exceeds-budget', `${bytes} bytes exceed the budget`),
      );
    }
    const now = this.tryReserve(pid, bytes, this.budgetBytes, why);
    if (now) return Promise.resolve(now);
    return new Promise<Ticket>((resolve, reject) => {
      const handle = this.freeHandles.pop() ?? this.nextHandle++;
      const prio = Math.min(39, Math.max(0, Math.trunc(opts.prio ?? 20)));
      const w: Waiter = {
        handle,
        pid,
        bytes,
        why,
        since: this.clock.now(),
        resolve,
        reject,
        cancelTimer: () => undefined,
      };
      this.waiters.set(handle, w);
      this.heap.push(handle, prio * PRIO_SPAN + this.seq++);
      w.cancelTimer = this.clock.schedule(this.waitMaxMs, () => this.timeout(handle));
      this.hooks.onBlock?.(pid, bytes, why);
      const deficit = this.committed + bytes - this.budgetBytes;
      this.hooks.onDeficit?.(Math.max(deficit, this.headDeficit()));
    });
  }

  /**
   * Non-blocking reservation: granted only if nobody waits (no overtaking) and
   * committed + bytes ≤ limit. `mem.prefetch` uses limit = LOW_WM · budget (§3.7.2).
   */
  tryReserve(
    pid: number,
    bytes: number,
    limit: number = this.budgetBytes,
    why = 'alloc',
  ): Ticket | null {
    if (this.waiters.size > 0 || this.committed + bytes > Math.min(limit, this.budgetBytes))
      return null;
    this.reservedBytes += bytes;
    return { id: this.nextTicket++, pid, bytes, why, open: true };
  }

  /** The allocation now exists: move the ticket's bytes from reserved to accounted. */
  commit(ticket: Ticket, actualBytes: number = ticket.bytes): void {
    if (!ticket.open) throw new MmError('EINVAL', undefined, 'ticket already used');
    if (actualBytes > ticket.bytes)
      throw new MmError('EINVAL', undefined, 'actual bytes exceed the reservation');
    ticket.open = false;
    this.reservedBytes -= ticket.bytes;
    this.accountedBytes += actualBytes;
    this.noteChange();
    if (actualBytes < ticket.bytes) this.onFree();
  }

  /** Give a reservation back unused. */
  cancel(ticket: Ticket): void {
    if (!ticket.open) return;
    ticket.open = false;
    this.reservedBytes -= ticket.bytes;
    this.noteChange();
    this.onFree();
  }

  /** Move part of an open ticket into accounted (state growth consuming its headroom). */
  consume(ticket: Ticket, bytes: number): Ticket {
    const take = Math.min(bytes, ticket.bytes);
    this.cancelSilently(ticket);
    this.reservedBytes += ticket.bytes - take;
    this.accountedBytes += take;
    this.noteChange();
    return {
      id: this.nextTicket++,
      pid: ticket.pid,
      bytes: ticket.bytes - take,
      why: ticket.why,
      open: true,
    };
  }

  /** Merge two open tickets of one process into one (reserved bytes unchanged). */
  merge(a: Ticket | null, b: Ticket): Ticket {
    if (a === null || !a.open) return b;
    a.open = false;
    b.open = false;
    return { id: this.nextTicket++, pid: b.pid, bytes: a.bytes + b.bytes, why: b.why, open: true };
  }

  private cancelSilently(ticket: Ticket): void {
    if (!ticket.open) return;
    ticket.open = false;
    this.reservedBytes -= ticket.bytes;
  }

  /**
   * Charge bytes that already exist without a reservation. Only the state-growth path of §3.2.2
   * does this; it is the one way committed can exceed the budget, and the excursion is recorded.
   */
  chargeUnreserved(bytes: number): void {
    this.accountedBytes += bytes;
    this.noteChange();
    const deficit = this.committed - this.budgetBytes;
    if (deficit > 0) this.hooks.onDeficit?.(deficit);
  }

  /** Remove a charge (drop, verified page-out, release, exit), then grant waiters. */
  uncharge(bytes: number): void {
    this.accountedBytes -= bytes;
    if (this.accountedBytes < 0) this.accountedBytes = 0;
    this.noteChange();
    this.onFree();
  }

  /** Grant blocked reservations in key order while the head fits (§3.7.3 onFree). */
  onFree(): void {
    while (this.heap.size > 0) {
      const h = this.heap.peek();
      const w = h === undefined ? undefined : this.waiters.get(h);
      if (h === undefined || w === undefined) break;
      if (this.committed + w.bytes > this.budgetBytes) break;
      this.heap.pop();
      this.release(w);
      this.reservedBytes += w.bytes;
      this.noteChange();
      this.hooks.onWake?.(w.pid, true);
      w.resolve({ id: this.nextTicket++, pid: w.pid, bytes: w.bytes, why: w.why, open: true });
    }
  }

  /** Fail every blocked reservation of `pid` (the process was killed): ECANCELED `killed`. */
  cancelWaiters(pid: number): number {
    let n = 0;
    for (const w of [...this.waiters.values()]) {
      if (w.pid !== pid) continue;
      this.heap.remove(w.handle);
      this.release(w);
      w.reject(new MmError('ECANCELED', 'killed'));
      n++;
    }
    if (n > 0) this.onFree();
    return n;
  }

  private timeout(handle: number): void {
    const w = this.waiters.get(handle);
    if (!w) return;
    this.heap.remove(handle);
    this.release(w);
    const waited = this.clock.now() - w.since;
    this.hooks.onTimeout?.(w.pid, w.bytes, w.why, waited);
    this.hooks.onWake?.(w.pid, false);
    w.reject(
      new MmError(
        'EAGAIN',
        'mem-pressure',
        `reservation of ${w.bytes} bytes blocked for ${waited} ms`,
      ),
    );
    // A removed head may unblock smaller requests behind it.
    this.onFree();
  }

  private release(w: Waiter): void {
    w.cancelTimer();
    this.waiters.delete(w.handle);
    this.freeHandles.push(w.handle);
  }

  private noteChange(): void {
    const now = this.clock.now();
    if (this.committed > this.budgetBytes) {
      if (this.overSince === null) {
        this.overSince = now;
        this.overEpisodes++;
        this.hooks.onOverBudget?.(true, 0);
      }
    } else if (this.overSince !== null) {
      const ms = now - this.overSince;
      this.maxOverMs = Math.max(this.maxOverMs, ms);
      this.overSince = null;
      this.hooks.onOverBudget?.(false, ms);
    }
  }
}
