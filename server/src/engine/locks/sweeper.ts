/**
 * The lease sweeper (offline-and-sync.md §3.14.5 "Expiry", §5.6; database.md §3.17; VFS-09).
 *
 *   onGrant(l):   index.upsert(l.leaseId, l.expiresAt); rearm()
 *   onRenew(l):   index.upsert(l.leaseId, newExpiresAt); rearm()      (changePriority, O(log n))
 *   onRelease(l): index.remove(l.leaseId); rearm()
 *   rearm():      ONE timer at the earliest deadline (never a polling tick)
 *   sweep():      due = popDue(now + slack)
 *                 expired = DELETE ... WHERE lease_id = ANY(due) AND lease_expires_at <= clock_timestamp()
 *                 due leases the database did not expire were renewed meanwhile: push their real
 *                 deadline back; expired ones go to onExpired (lock.expired, lock.released, grants)
 *
 * The database clock decides (§3.14.2). When the process clock runs slightly ahead of it, a due
 * lease is re-read with an unchanged deadline; it is pushed back to at least now + skewRetryMs so
 * the timer can never spin. Guarantee: a lease ends at most TTL + 0.5 s after its last renewal
 * (timer lateness plus one DELETE), and `acquire` also deletes expired rows itself.
 */
import type { Clock, Timer } from '../sync/clock.ts';
import type { ExpiryIndex } from './expiry-index.ts';
import type { LeaseRow, LockStore } from './types.ts';

export interface SweeperOptions {
  readonly store: LockStore;
  readonly clock: Clock;
  readonly index: ExpiryIndex;
  /** Receives the rows the database expired (after the DELETE committed). */
  readonly onExpired: (rows: readonly LeaseRow[]) => Promise<void> | void;
  readonly onError?: (err: unknown) => void;
  /** Leases due within this many ms are swept together (spec: 50 ms). */
  readonly slackMs?: number;
  /** Minimum push-back of a due lease the database did not expire (clock skew guard). */
  readonly skewRetryMs?: number;
  /** Retry delay after a failed sweep (the database was unreachable). */
  readonly errorRetryMs?: number;
}

export class Sweeper {
  readonly #o: Required<Omit<SweeperOptions, 'onError'>> & Pick<SweeperOptions, 'onError'>;
  #timer: Timer | undefined;
  #timerAt: number | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #stopped = false;

  constructor(options: SweeperOptions) {
    this.#o = { slackMs: 50, skewRetryMs: 50, errorRetryMs: 1_000, ...options };
  }

  /** A granted or renewed lease. */
  track(lease: LeaseRow): void {
    this.#o.index.upsert(lease.leaseId, lease.expiresAt);
    this.#rearm();
  }

  /** A released or expired lease. */
  untrack(leaseId: string): void {
    if (this.#o.index.remove(leaseId)) this.#rearm();
  }

  /** Rebuilds the index from the `locks` table (server start). */
  rebuild(rows: readonly LeaseRow[]): void {
    this.#o.index.clear();
    for (const r of rows) this.#o.index.upsert(r.leaseId, r.expiresAt);
    this.#rearm();
  }

  /** The deadline the single timer is armed for (tests and metrics). */
  get armedAt(): number | undefined {
    return this.#timerAt;
  }

  /** Runs one sweep now (the timer calls this). Concurrent calls coalesce into one extra run. */
  sweep(): Promise<void> {
    if (this.#running !== undefined) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#loop().finally(() => {
      this.#running = undefined;
      this.#rearm();
    });
    return this.#running;
  }

  stop(): void {
    this.#stopped = true;
    this.#timer?.cancel();
    this.#timer = undefined;
    this.#timerAt = undefined;
  }

  async #loop(): Promise<void> {
    do {
      this.#again = false;
      await this.#once();
    } while (this.#again && !this.#stopped);
  }

  async #once(): Promise<void> {
    const { index, store, clock } = this.#o;
    const now = clock.now();
    const due = index.popDue(now + this.#o.slackMs);
    if (due.length === 0) return;
    const ids = due.map((d) => d.id);
    let expired: readonly LeaseRow[];
    try {
      expired = await store.expire(ids);
    } catch (err) {
      this.#retryLater(ids);
      this.#o.onError?.(err);
      return;
    }
    const gone = new Set(expired.map((r) => r.leaseId));
    const survivors = ids.filter((id) => !gone.has(id));
    if (survivors.length > 0) {
      // Renewed after we indexed its old deadline (or the process clock is ahead of the DB).
      // A survivor that has no row any more was released meanwhile and is simply dropped.
      try {
        const floor = clock.now() + this.#o.skewRetryMs;
        for (const row of await store.get(survivors)) {
          if (!index.has(row.leaseId)) index.upsert(row.leaseId, Math.max(row.expiresAt, floor));
        }
      } catch (err) {
        this.#retryLater(survivors);
        this.#o.onError?.(err);
      }
    }
    if (expired.length > 0) await this.#o.onExpired(expired);
  }

  #retryLater(leaseIds: readonly string[]): void {
    const retryAt = this.#o.clock.now() + this.#o.errorRetryMs;
    for (const id of leaseIds) if (!this.#o.index.has(id)) this.#o.index.upsert(id, retryAt);
  }

  #rearm(): void {
    if (this.#stopped || this.#running !== undefined) return;
    const deadline = this.#o.index.peekDeadline();
    if (deadline === this.#timerAt && this.#timer !== undefined) return;
    this.#timer?.cancel();
    this.#timer = undefined;
    this.#timerAt = undefined;
    if (deadline === undefined) return;
    this.#timerAt = deadline;
    this.#timer = this.#o.clock.setTimer(deadline - this.#o.clock.now(), () => {
      this.#timer = undefined;
      this.#timerAt = undefined;
      void this.sweep();
    });
  }
}
