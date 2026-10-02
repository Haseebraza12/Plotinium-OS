/**
 * The lease manager: S/X leases with a TTL and fencing tokens (Spec: MUST, §9.3, VFS-09;
 * offline-and-sync.md §3.14; database.md §3.17; PROC-07, BOOT-12).
 *
 * Every mutation of a lease is one short transaction in `LockStore`; this class keeps the memory
 * that the table cannot: FIFO waiter queues per inode (fairness: a new request queues behind any
 * earlier waiter, so writers are not starved), the connections interested in an inode (a denied
 * or queued requester is told when the inode frees up: "read-only" becomes "Available"), a mirror
 * of the live rows (lease counts per OS session, holder info) and the expiry index + sweeper.
 *
 * Lease endings and who hears about them (LockEnded.reason):
 *   explicit lock.release      -> lock.released 'released' to waiters/interested, nothing to the sender
 *   TTL (sweeper or acquire)   -> lock.expired 'expired' to the holder's session, lock.released to others
 *   auth session revoked       -> lock.expired 'revoked' to the holder's session, lock.released to others
 *   clean close / bye          -> lock.released 'session-closed' to others (leases released at once)
 *   dead predecessor (hello)   -> lock.released 'session-closed' to others
 *   abnormal close             -> nothing: the lease stays until its TTL (a quick reconnect keeps it)
 * After every ending, the inode's waiters are granted in FIFO order (`pump`).
 */
import {
  LEASE_TTL_MAX_MS,
  LEASE_TTL_MIN_MS,
  LEASE_TTL_MS,
  MAX_LEASES,
  type C2SFrame,
  type HelloOk,
  type LeaseRef,
} from '@plotinium/protocol';

import { systemClock, type Clock, type Timer } from '../sync/clock.ts';
import { ExpiryIndex, type HeapFactory } from './expiry-index.ts';
import { Sweeper } from './sweeper.ts';
import type {
  AcquireOutcome,
  LeaseMode,
  LeaseRow,
  LockConnRef,
  LockDeniedBody,
  LockEndReason,
  LockFrame,
  LockNotifier,
  LockStore,
} from './types.ts';

export type LockAcquireBody = C2SFrame<'lock.acquire'>['body'];
export type LeaseInfo = HelloOk['keptLeases'][number];

export interface LockManagerOptions {
  readonly store: LockStore;
  readonly notifier: LockNotifier;
  readonly clock?: Clock;
  /** LEASE_TTL_MS: 30 s by default, 15 s in the demo profile; range 15..120 s (§3.14.2). */
  readonly ttlMs?: number;
  /** MAX_LEASES per OS session (the 257th → EAGAIN lease-limit). */
  readonly maxLeases?: number;
  readonly createHeap?: HeapFactory;
  readonly onError?: (err: unknown, context: string) => void;
}

interface Waiter {
  readonly reqId: string;
  readonly conn: LockConnRef;
  readonly mode: LeaseMode;
  readonly holderUid: number;
  timer: Timer | undefined;
  cancelled: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export class LockManager {
  readonly ttlMs: number;
  readonly maxLeases: number;
  readonly #store: LockStore;
  readonly #notify: LockNotifier;
  readonly #clock: Clock;
  readonly #sweeper: Sweeper;
  readonly #onError: (err: unknown, context: string) => void;

  /** Mirror of the live rows: leaseId -> row, and indexes by OS session and by inode. */
  readonly #leases = new Map<string, LeaseRow>();
  readonly #bySession = new Map<string, Set<string>>();
  readonly #byIno = new Map<string, Set<string>>();
  /** FIFO waiters per inode. */
  readonly #waiters = new Map<string, Waiter[]>();
  /** Connections that were denied (EBUSY) or queued for an inode: they hear lock.released. */
  readonly #interest = new Map<string, Set<string>>();
  readonly #pumping = new Map<string, Promise<void>>();
  readonly #pumpAgain = new Set<string>();

  constructor(options: LockManagerOptions) {
    const ttl = options.ttlMs ?? LEASE_TTL_MS;
    if (!Number.isInteger(ttl) || ttl < LEASE_TTL_MIN_MS || ttl > LEASE_TTL_MAX_MS) {
      throw new RangeError(
        `LEASE_TTL_MS must be ${LEASE_TTL_MIN_MS}..${LEASE_TTL_MAX_MS}, got ${ttl}`,
      );
    }
    this.ttlMs = ttl;
    this.maxLeases = options.maxLeases ?? MAX_LEASES;
    this.#store = options.store;
    this.#notify = options.notifier;
    this.#clock = options.clock ?? systemClock;
    this.#onError = options.onError ?? (() => undefined);
    this.#sweeper = new Sweeper({
      store: this.#store,
      clock: this.#clock,
      index: new ExpiryIndex(options.createHeap),
      onExpired: (rows) => this.#ended(rows, 'expired', { notifyHolder: true }),
      onError: (err) => this.#onError(err, 'sweep'),
    });
  }

  /** HB_MS = TTL / 3, advertised in hello.ok.timers. */
  get hbMs(): number {
    return Math.floor(this.ttlMs / 3);
  }

  /** Rebuilds the mirror and the expiry index from the `locks` table (server start, C9). */
  async start(): Promise<void> {
    const rows = await this.#store.loadAll();
    this.#leases.clear();
    this.#bySession.clear();
    this.#byIno.clear();
    for (const r of rows) this.#mirror(r);
    this.#sweeper.rebuild(rows);
  }

  /** Stops the sweeper and every waiter timer (graceful shutdown; leases stay in the table). */
  stop(): void {
    this.#sweeper.stop();
    for (const queue of this.#waiters.values()) for (const w of queue) w.timer?.cancel();
  }

  /** Runs the sweeper now (tests, and a probe after a long event-loop stall). */
  sweepNow(): Promise<void> {
    return this.#sweeper.sweep();
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  leasesOf(osSessionId: string): LeaseRow[] {
    return [...(this.#bySession.get(osSessionId) ?? [])].flatMap((id) => {
      const row = this.#leases.get(id);
      return row === undefined ? [] : [row];
    });
  }

  holdersOf(ino: string): LeaseRow[] {
    return [...(this.#byIno.get(ino) ?? [])].flatMap((id) => {
      const row = this.#leases.get(id);
      return row === undefined ? [] : [row];
    });
  }

  waitingOn(ino: string): number {
    return this.#waiters.get(ino)?.length ?? 0;
  }

  // -------------------------------------------------------------------------------------------
  // lock.acquire (§3.14.3)
  // -------------------------------------------------------------------------------------------

  async acquire(conn: LockConnRef, body: LockAcquireBody): Promise<void> {
    const deny = (errno: LockDeniedBody['errno'], reason?: string): void =>
      this.#send(conn.connId, {
        t: 'lock.denied',
        body: { reqId: body.reqId, errno, ...(reason === undefined ? {} : { reason }) },
      });

    if (!conn.mayActAs(body.principal)) {
      deny('EACCES', 'principal');
      return;
    }
    if (this.#queued(conn.connId, body.reqId) !== undefined) {
      deny('EAGAIN', 'duplicate-request');
      return;
    }
    const holdsIno = this.leasesOf(conn.osSessionId).some((l) => l.ino === body.ino);
    if (!holdsIno && (this.#bySession.get(conn.osSessionId)?.size ?? 0) >= this.maxLeases) {
      deny('EAGAIN', 'lease-limit');
      return;
    }

    const waiter: Waiter = {
      reqId: body.reqId,
      conn,
      mode: body.mode,
      holderUid: body.principal,
      timer: undefined,
      cancelled: false,
    };
    const queue = this.#waiters.get(body.ino);
    if (queue !== undefined && queue.length > 0) {
      // Fairness (§3.14.1): an earlier waiter exists, so this request may not overtake it.
      if (body.wait) this.#enqueue(body.ino, waiter, body.timeoutMs);
      else await this.#denyBusy(conn.connId, body.reqId, body.ino);
      return;
    }

    let out: AcquireOutcome;
    try {
      out = await this.#store.acquire({
        ino: body.ino,
        osSessionId: conn.osSessionId,
        holderUid: body.principal,
        mode: body.mode,
        ttlMs: this.ttlMs,
      });
    } catch (err) {
      this.#onError(err, 'acquire');
      deny('EAGAIN');
      return;
    }
    await this.#afterExpiredRows(out.expired);
    switch (out.kind) {
      case 'granted':
        this.#granted(waiter, out.lease, out.replaced, body.ino);
        return;
      case 'busy':
        if (body.wait) {
          this.#enqueue(body.ino, waiter, body.timeoutMs);
          // The holder may have gone while we were in the transaction: try the queue once more.
          void this.#pump(body.ino);
        } else {
          this.#addInterest(body.ino, conn.connId);
          this.#send(conn.connId, {
            t: 'lock.denied',
            body: {
              reqId: body.reqId,
              errno: 'EBUSY',
              reason: 'lease',
              ...(out.holder === null
                ? {}
                : {
                    holder: {
                      username: out.holder.username,
                      mode: out.holder.mode,
                      expiresAt: iso(out.holder.expiresAt),
                    },
                  }),
            },
          });
        }
        return;
      case 'denied':
        deny(out.errno);
        return;
    }
  }

  /** lock.release {reqId}: cancels a queued request (the requester gets lock.denied ECANCELED). */
  cancelRequest(conn: LockConnRef, reqId: string): boolean {
    const found = this.#queued(conn.connId, reqId);
    if (found === undefined) return false;
    this.#dropWaiter(found.ino, found.waiter);
    this.#send(conn.connId, { t: 'lock.denied', body: { reqId, errno: 'ECANCELED' } });
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Release, renewal, verification
  // -------------------------------------------------------------------------------------------

  /** lock.release {leaseId} (also the PROC-07 kill path). False when the session holds no such lease. */
  async releaseLease(conn: LockConnRef, leaseId: string): Promise<boolean> {
    const row = await this.#store.release(leaseId, conn.osSessionId);
    if (row === null) {
      this.#forget(leaseId); // an expired lease the sweeper has not reported yet
      return false;
    }
    await this.#ended([row], 'released', { notifyHolder: false, exceptConn: conn.connId });
    return true;
  }

  /**
   * hb {leases}: renews the listed leases that are still live (the heartbeat IS the renewal; pongs
   * never renew, INV-S8). Returns hb.ack's `renewed` and `lost`.
   */
  async heartbeat(
    osSessionId: string,
    leases: readonly LeaseRef[],
  ): Promise<{ renewed: string[]; lost: LeaseRef[] }> {
    if (leases.length === 0) return { renewed: [], lost: [] };
    const rows = await this.#store.renew(
      osSessionId,
      leases.map((l) => l.leaseId),
      this.ttlMs,
    );
    const renewed = new Set<string>();
    for (const r of rows) {
      renewed.add(r.leaseId);
      this.#track(r);
    }
    return {
      renewed: [...renewed],
      lost: leases.filter((l) => !renewed.has(l.leaseId)),
    };
  }

  /** Any applied op of an OS session renews all its leases (critic fix, §3.14.2). */
  async renewSession(osSessionId: string): Promise<void> {
    if ((this.#bySession.get(osSessionId)?.size ?? 0) === 0) return;
    for (const r of await this.#store.renew(osSessionId, 'all', this.ttlMs)) this.#track(r);
  }

  /** hello.heldLeases (§3.14.6): kept leases are renewed and returned; the rest are lost. */
  async verifyHeld(
    osSessionId: string,
    refs: readonly LeaseRef[],
  ): Promise<{ kept: LeaseInfo[]; lost: LeaseRef[] }> {
    if (refs.length === 0) return { kept: [], lost: [] };
    const rows = await this.#store.verifyHeld(osSessionId, refs, this.ttlMs);
    const kept = new Map<string, LeaseRow>();
    for (const r of rows) {
      kept.set(r.leaseId, r);
      this.#track(r);
    }
    return {
      kept: [...kept.values()].map((r) => ({
        leaseId: r.leaseId,
        ino: r.ino,
        fence: r.fence,
        mode: r.mode,
        expiresAt: iso(r.expiresAt),
      })),
      lost: refs.filter((ref) => !kept.has(ref.leaseId)),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Connection and session lifecycle
  // -------------------------------------------------------------------------------------------

  /**
   * A connection closed. Its waiters and interests are dropped. `releaseLeases` is the close
   * policy's decision: true for `bye` or a clean client close (1000, 1001) when no other
   * connection of the OS session is open; false for an abnormal close (leases wait for the TTL).
   */
  async connectionClosed(
    conn: { connId: string; osSessionId: string | null },
    releaseLeases: boolean,
  ): Promise<void> {
    for (const [ino, queue] of [...this.#waiters]) {
      const mine = queue.filter((w) => w.conn.connId === conn.connId);
      for (const w of mine) this.#dropWaiter(ino, w);
    }
    for (const [ino, set] of this.#interest) {
      set.delete(conn.connId);
      if (set.size === 0) this.#interest.delete(ino);
    }
    if (!releaseLeases || conn.osSessionId === null) return;
    const rows = await this.#store.releaseSessions([conn.osSessionId]);
    await this.#ended(rows, 'session-closed', { notifyHolder: false });
  }

  /** Revocation of auth sessions (logout, password change, admin, expiry): §3.14.5, INV-SRV-7. */
  async releaseAuthSessions(authSessionIds: readonly string[]): Promise<readonly LeaseRow[]> {
    if (authSessionIds.length === 0) return [];
    const rows = await this.#store.releaseAuthSessions(authSessionIds);
    await this.#ended(rows, 'revoked', { notifyHolder: true });
    return rows;
  }

  /** hello from a newer kernel epoch: the older OS sessions of that device and uid are dead (§3.8.1). */
  async releaseDevicePredecessors(q: {
    readonly deviceId: string;
    readonly uid: number;
    readonly osSessionId: string;
    readonly kernelEpoch: number;
  }): Promise<readonly LeaseRow[]> {
    const rows = await this.#store.releaseDevicePredecessors(q);
    await this.#ended(rows, 'session-closed', { notifyHolder: false });
    return rows;
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  #send(connId: string, frame: LockFrame): void {
    this.#notify.toConn(connId, frame);
  }

  #queued(connId: string, reqId: string): { ino: string; waiter: Waiter } | undefined {
    for (const [ino, queue] of this.#waiters) {
      const waiter = queue.find((w) => w.reqId === reqId && w.conn.connId === connId);
      if (waiter !== undefined) return { ino, waiter };
    }
    return undefined;
  }

  #enqueue(ino: string, waiter: Waiter, timeoutMs: number | undefined): void {
    let queue = this.#waiters.get(ino);
    if (queue === undefined) {
      queue = [];
      this.#waiters.set(ino, queue);
    }
    queue.push(waiter);
    this.#addInterest(ino, waiter.conn.connId);
    if (timeoutMs !== undefined) {
      waiter.timer = this.#clock.setTimer(timeoutMs, () => {
        if (waiter.cancelled) return;
        this.#dropWaiter(ino, waiter);
        this.#send(waiter.conn.connId, {
          t: 'lock.denied',
          body: { reqId: waiter.reqId, errno: 'ETIMEDOUT' },
        });
      });
    }
    this.#send(waiter.conn.connId, {
      t: 'lock.queued',
      body: { reqId: waiter.reqId, position: queue.length },
    });
  }

  #dropWaiter(ino: string, waiter: Waiter): void {
    waiter.cancelled = true;
    waiter.timer?.cancel();
    const queue = this.#waiters.get(ino);
    if (queue === undefined) return;
    const i = queue.indexOf(waiter);
    if (i < 0) return;
    queue.splice(i, 1);
    if (queue.length === 0) this.#waiters.delete(ino);
    // The removed head may have blocked compatible requests behind it (an X ahead of S waiters).
    else if (i === 0) void this.#pump(ino);
  }

  async #denyBusy(connId: string, reqId: string, ino: string): Promise<void> {
    this.#addInterest(ino, connId);
    const holder = this.holdersOf(ino).sort((a, b) => b.expiresAt - a.expiresAt)[0];
    let username: string | null = null;
    if (holder !== undefined) {
      try {
        username = await this.#store.usernameOf(holder.holderUid);
      } catch (err) {
        this.#onError(err, 'holder');
      }
    }
    this.#send(connId, {
      t: 'lock.denied',
      body: {
        reqId,
        errno: 'EBUSY',
        reason: 'lease',
        ...(holder === undefined || username === null
          ? {}
          : { holder: { username, mode: holder.mode, expiresAt: iso(holder.expiresAt) } }),
      },
    });
  }

  #granted(waiter: Waiter, lease: LeaseRow, replaced: LeaseRow | null, ino: string): void {
    if (replaced !== null && replaced.leaseId !== lease.leaseId) this.#forget(replaced.leaseId);
    this.#track(lease);
    this.#removeInterest(ino, waiter.conn.connId);
    this.#send(waiter.conn.connId, {
      t: 'lock.granted',
      body: {
        reqId: waiter.reqId,
        leaseId: lease.leaseId,
        ino: lease.ino,
        mode: lease.mode,
        fence: lease.fence,
        expiresAt: iso(lease.expiresAt),
        ttlMs: this.ttlMs,
      },
    });
  }

  #addInterest(ino: string, connId: string): void {
    let set = this.#interest.get(ino);
    if (set === undefined) {
      set = new Set();
      this.#interest.set(ino, set);
    }
    set.add(connId);
  }

  #removeInterest(ino: string, connId: string): void {
    const set = this.#interest.get(ino);
    if (set === undefined) return;
    set.delete(connId);
    if (set.size === 0) this.#interest.delete(ino);
  }

  #mirror(row: LeaseRow): void {
    this.#leases.set(row.leaseId, row);
    let s = this.#bySession.get(row.osSessionId);
    if (s === undefined) {
      s = new Set();
      this.#bySession.set(row.osSessionId, s);
    }
    s.add(row.leaseId);
    let i = this.#byIno.get(row.ino);
    if (i === undefined) {
      i = new Set();
      this.#byIno.set(row.ino, i);
    }
    i.add(row.leaseId);
  }

  #track(row: LeaseRow): void {
    this.#mirror(row);
    this.#sweeper.track(row);
  }

  #forget(leaseId: string): void {
    const row = this.#leases.get(leaseId);
    this.#sweeper.untrack(leaseId);
    if (row === undefined) return;
    this.#leases.delete(leaseId);
    const s = this.#bySession.get(row.osSessionId);
    s?.delete(leaseId);
    if (s?.size === 0) this.#bySession.delete(row.osSessionId);
    const i = this.#byIno.get(row.ino);
    i?.delete(leaseId);
    if (i?.size === 0) this.#byIno.delete(row.ino);
  }

  /** Rows an acquire transaction found expired and deleted (§3.14.3 step 2). */
  async #afterExpiredRows(rows: readonly LeaseRow[]): Promise<void> {
    if (rows.length > 0) await this.#ended(rows, 'expired', { notifyHolder: true, pump: false });
  }

  /** Forgets ended leases, notifies holders and interested connections, grants waiters. */
  async #ended(
    rows: readonly LeaseRow[],
    reason: LockEndReason,
    opts: { notifyHolder: boolean; exceptConn?: string; pump?: boolean },
  ): Promise<void> {
    const inos = new Set<string>();
    for (const row of rows) {
      this.#forget(row.leaseId);
      inos.add(row.ino);
      const body = { ino: row.ino, leaseId: row.leaseId, reason };
      if (opts.notifyHolder) this.#notify.toSession(row.osSessionId, { t: 'lock.expired', body });
      const targets = new Set<string>(this.#interest.get(row.ino) ?? []);
      for (const w of this.#waiters.get(row.ino) ?? []) targets.add(w.conn.connId);
      for (const c of this.#notify.watchersOf?.(row.ino) ?? []) targets.add(c);
      if (opts.exceptConn !== undefined) targets.delete(opts.exceptConn);
      for (const c of targets) this.#send(c, { t: 'lock.released', body });
    }
    if (opts.pump === false) return;
    await Promise.all([...inos].map((ino) => this.#pump(ino)));
  }

  /** Grants the inode's waiters in FIFO order until the head is still incompatible. */
  #pump(ino: string): Promise<void> {
    const running = this.#pumping.get(ino);
    if (running !== undefined) {
      this.#pumpAgain.add(ino);
      return running;
    }
    const p = (async () => {
      do {
        this.#pumpAgain.delete(ino);
        await this.#pumpOnce(ino);
      } while (this.#pumpAgain.has(ino));
    })()
      .catch((err: unknown) => this.#onError(err, 'pump'))
      .finally(() => this.#pumping.delete(ino));
    this.#pumping.set(ino, p);
    return p;
  }

  async #pumpOnce(ino: string): Promise<void> {
    for (;;) {
      const head = this.#waiters.get(ino)?.[0];
      if (head === undefined) return;
      const out = await this.#store.acquire({
        ino,
        osSessionId: head.conn.osSessionId,
        holderUid: head.holderUid,
        mode: head.mode,
        ttlMs: this.ttlMs,
      });
      await this.#afterExpiredRows(out.expired);
      if (out.kind === 'busy') return;
      if (head.cancelled) {
        // Cancelled (lock.release reqId, timeout or close) while the transaction ran.
        if (out.kind === 'granted')
          await this.#store.release(out.lease.leaseId, out.lease.osSessionId);
        continue;
      }
      this.#dropWaiter(ino, head);
      if (out.kind === 'granted') this.#granted(head, out.lease, out.replaced, ino);
      else
        this.#send(head.conn.connId, {
          t: 'lock.denied',
          body: { reqId: head.reqId, errno: out.errno },
        });
    }
  }
}
