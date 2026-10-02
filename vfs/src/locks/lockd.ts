/**
 * `lockd`: the lease client of the kernel worker (offline-and-sync.md §3.14; virtual-file-system.md
 * §3.16; Spec: MUST, §9.3, VFS-09; C6, SYN-09). Its frames travel on the control lane of syncd's
 * socket (`ControlChannel`); syncd feeds it `hello.ok`, `hb.ack` and every `lock.*` frame.
 *
 * Two layers (VFS §3.16.1):
 * - Local, always: `LocalLockTable` arbitrates between the processes of this kernel.
 * - Server, when syncd is LIVE: one lease per inode per OS session, shared by its local holders. The
 *   first holder sends `lock.acquire`, an S → X upgrade sends an X acquire, the last release sends
 *   `lock.release`. Every grant carries a fence; a process holding X writes under it
 *   (`fenceFor`). A lease lost while hidden keeps its old fence, so the next save takes the
 *   stale-fence path (conflict EBUSY, bytes kept as a conflicted copy).
 * - Degraded (not LIVE): local advisory locks through `navigator.locks` (`scope: 'local'`); on
 *   reconnect every local lock still held is acquired on the server with `wait: false`, and a denial
 *   is reported as `lock.lost`.
 *
 * Heartbeats: syncd sends `hb` every `hbMs` (TTL/3, advertised in `hello.ok.timers`) from the
 * kernel worker with `heartbeatLeases()`; `onVisible` asks for an immediate one (§3.14.7). Pongs
 * never renew a lease (INV-S8). Requests for one inode are served in FIFO order.
 */
import { LEASE_TTL_MS } from '@plotinium/protocol';
import type { Errno, LeaseRef } from '@plotinium/protocol';

import type { Clock, ControlChannel, LockSyncClient } from '../sync/ports.ts';
import { systemClock } from '../sync/ports.ts';
import type { HbAckBody, HelloOkBody, LockFrame } from '../sync/types.ts';
import { requestAdvisory } from './advisory.ts';
import type { AdvisoryHandle } from './advisory.ts';
import { LocalLockTable } from './table.ts';
import type { Holder } from './table.ts';
import type {
  AcquireRequest,
  ForeignLease,
  Grant,
  LeaseMode,
  LockEvent,
  LockManagerLike,
  LockResult,
  LsofLease,
} from './types.ts';

interface ServerLease {
  readonly leaseId: string;
  readonly ino: string;
  readonly fence: number;
  readonly mode: LeaseMode;
  /** Server-clock epoch ms. */
  expiresAt: number;
}

type Reply =
  | { readonly kind: 'granted'; readonly lease: ServerLease }
  | {
      readonly kind: 'denied';
      readonly errno: Errno;
      readonly reason?: string;
      readonly holder?: string;
    }
  | { readonly kind: 'fallback' };

interface Pending {
  readonly reqId: string;
  readonly ino: string;
  readonly mode: LeaseMode;
  readonly pid: number;
  readonly resolve: (r: Reply) => void;
}

interface LocalWaiter {
  readonly pid: number;
  readonly check: () => boolean;
  readonly done: (outcome: 'ok' | 'timeout' | 'cancel') => void;
}

export interface LockdOptions {
  readonly channel: ControlChannel;
  readonly clock?: Clock;
  /** UUIDv7 generator (request ids, local lease ids). */
  readonly newId: () => string;
  /** `navigator.locks` of the kernel worker; absent: the local table alone arbitrates. */
  readonly locks?: LockManagerLike;
  /** Kernel events `lock.granted`, `lock.queued`, `lock.lost`, `lock.released`. */
  readonly emit?: (ev: LockEvent) => void;
}

const covers = (held: LeaseMode, wanted: LeaseMode): boolean => held === 'X' || wanted === 'S';
const fail = (errno: Errno, reason?: string, holder?: string): LockResult<never> => ({
  ok: false,
  errno,
  ...(reason === undefined ? {} : { reason }),
  ...(holder === undefined ? {} : { holder }),
});

export class Lockd implements LockSyncClient {
  private readonly channel: ControlChannel;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly locks: LockManagerLike | undefined;
  private readonly emitFn: (ev: LockEvent) => void;

  private readonly table = new LocalLockTable();
  private readonly server = new Map<string, ServerLease>();
  private readonly advisory = new Map<string, AdvisoryHandle>();
  private readonly pending = new Map<string, Pending>();
  private readonly cancelled = new Set<string>();
  private readonly foreign = new Map<string, ForeignLease>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly localWaiters = new Map<string, LocalWaiter[]>();
  private available = false;
  private offsetMs = 0;
  private ttlMs = LEASE_TTL_MS;

  constructor(opts: LockdOptions) {
    this.channel = opts.channel;
    this.clock = opts.clock ?? systemClock;
    this.newId = opts.newId;
    this.locks = opts.locks;
    this.emitFn = opts.emit ?? (() => undefined);
  }

  // -- syscalls -----------------------------------------------------------------------------------

  /** `lock.acquire` (syscall-abi.md §4.4.7): EBUSY `lease` with a holder, ETIMEDOUT, ECANCELED. */
  acquire(req: AcquireRequest): Promise<LockResult<Grant>> {
    if (req.timeoutMs !== undefined && (!req.wait || req.timeoutMs < 1 || req.timeoutMs > 600_000))
      return Promise.resolve(fail('EINVAL'));
    return this.chain(req.ino, () => this.acquireNow(req));
  }

  /** `lock.release {leaseId}`: EINVAL `unknown-lease` for a lease the process does not hold. */
  release(pid: number, leaseId: string): LockResult<Record<string, never>> {
    const h = this.table.remove(pid, leaseId);
    if (h === null) return fail('EINVAL', 'unknown-lease');
    this.afterHolderGone(h.ino);
    return { ok: true, value: {} };
  }

  /** Kill path (PROC-07): drop every lease and wait of `pid`; server leases go with the last holder. */
  releaseAll(pid: number): void {
    const inos = new Set<string>();
    for (const h of this.table.byPid(pid)) {
      this.table.remove(pid, h.id);
      inos.add(h.ino);
    }
    for (const ino of inos) this.afterHolderGone(ino);
    for (const list of this.localWaiters.values())
      for (const w of list.filter((x) => x.pid === pid)) w.done('cancel');
    for (const p of [...this.pending.values()]) {
      if (p.pid !== pid) continue;
      this.pending.delete(p.reqId);
      this.cancelled.add(p.reqId);
      this.channel.sendControl('lock.release', { reqId: p.reqId });
      p.resolve({ kind: 'denied', errno: 'ECANCELED', reason: 'signal' });
    }
  }

  /** The fence `pid` writes `ino` under (X holders only; kept after a loss, §3.14.7). */
  fenceFor(pid: number, ino: string): number | undefined {
    const h = this.table
      .holders(ino)
      .find((x) => x.pid === pid && x.mode === 'X' && x.fence !== null);
    return h?.fence ?? undefined;
  }

  /**
   * `open` for writing (VFS §3.16.3): EBUSY when another local process holds the file, or a
   * foreign lease is known and still live (the second writer gets EBUSY synchronously, VFS-09).
   */
  checkWritable(ino: string, pid: number): LockResult<null> {
    const other = this.table.otherHolder(ino, pid);
    if (other !== undefined) return fail('EBUSY', 'lease', `pid ${other.pid}`);
    const own = this.table.holders(ino).some((h) => h.pid === pid && h.mode === 'X' && !h.lost);
    const f = this.foreign.get(ino);
    if (!own && f !== undefined && f.expiresAt > this.serverNow())
      return fail('EBUSY', 'lease', f.username);
    return { ok: true, value: null };
  }

  /** The foreign holder of `ino`, for the Editor's "Locked by alice — read-only" banner. */
  foreignHolder(ino: string): ForeignLease | undefined {
    const f = this.foreign.get(ino);
    return f !== undefined && f.expiresAt > this.serverNow() ? f : undefined;
  }

  /** `visibilitychange` to visible or `resume` (§3.14.7): an immediate heartbeat re-verifies leases. */
  onVisible(): void {
    if (this.server.size > 0) this.channel.heartbeatNow();
  }

  /** `lsof` lease rows with the countdown (§3.14.2, §3.14.7). */
  lsof(): LsofLease[] {
    const out: LsofLease[] = [];
    const now = this.serverNow();
    for (const ino of this.table.inos()) {
      const sl = this.server.get(ino);
      for (const h of this.table.holders(ino)) {
        const serverScope = h.scope === 'server' && sl !== undefined && !h.lost;
        out.push({
          ino,
          mode: h.mode,
          scope: h.scope,
          holder: `pid ${h.pid}`,
          pids: [h.pid],
          leaseId: serverScope ? sl.leaseId : h.id,
          fence: h.fence,
          expiresAt: serverScope ? sl.expiresAt - this.offsetMs : null,
          remainingMs: serverScope ? Math.max(0, sl.expiresAt - now) : null,
          foreign: false,
          lost: h.lost,
        });
      }
    }
    for (const f of this.foreign.values()) {
      if (f.expiresAt <= now) continue;
      out.push({
        ino: f.ino,
        mode: f.mode,
        scope: 'server',
        holder: f.username,
        pids: [],
        leaseId: null,
        fence: null,
        expiresAt: f.expiresAt - this.offsetMs,
        remainingMs: f.expiresAt - now,
        foreign: true,
        lost: false,
      });
    }
    return out;
  }

  /** `lock.status {path}` for a resolved inode. */
  status(ino: string): { holders: LsofLease[]; queued: number } {
    return { holders: this.lsof().filter((l) => l.ino === ino), queued: this.table.waiters(ino) };
  }

  /** Whether the server layer is in use (syncd LIVE); false = `lockd: local locks only`. */
  get serverLayer(): boolean {
    return this.available;
  }

  // -- LockSyncClient (fed by syncd) -----------------------------------------------------------------

  heldLeases(): LeaseRef[] {
    return [...this.server.values()].map((l) => ({
      leaseId: l.leaseId,
      ino: l.ino,
      fence: l.fence,
    }));
  }

  heartbeatLeases(): LeaseRef[] {
    return this.heldLeases();
  }

  onHelloOk(ok: HelloOkBody, clientNow: number): void {
    this.ttlMs = ok.timers.leaseTtlMs;
    const serverTime = Date.parse(ok.serverTime);
    if (Number.isFinite(serverTime)) this.offsetMs = serverTime - clientNow;
    for (const k of ok.keptLeases) {
      const cur = this.server.get(k.ino);
      if (cur?.leaseId !== k.leaseId) continue;
      const expiresAt = Date.parse(k.expiresAt);
      this.server.set(k.ino, {
        leaseId: k.leaseId,
        ino: k.ino,
        fence: k.fence,
        mode: k.mode,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : cur.expiresAt,
      });
    }
    for (const l of ok.lostLeases) {
      if (this.server.get(l.ino)?.leaseId === l.leaseId) this.lose(l.ino, 'expired');
    }
  }

  onServerAvailable(available: boolean): void {
    this.available = available;
    if (!available) {
      // Requests in flight fall back to local advisory locks (a late grant expires at the TTL).
      for (const p of [...this.pending.values()]) {
        this.pending.delete(p.reqId);
        this.cancelled.add(p.reqId);
        p.resolve({ kind: 'fallback' });
      }
      return;
    }
    // Reconnect after degraded mode (VFS §3.16.2): acquire every local lock on the server.
    for (const ino of this.table.inos()) {
      const live = this.table.holders(ino).filter((h) => !h.lost && h.scope === 'local');
      if (live.length === 0 || this.server.has(ino)) continue;
      void this.chain(ino, () => this.upgradeLocal(ino));
    }
  }

  onLockFrame(frame: LockFrame): void {
    switch (frame.t) {
      case 'lock.granted': {
        const b = frame.body;
        const expiresAt = Date.parse(b.expiresAt);
        const lease: ServerLease = {
          leaseId: b.leaseId,
          ino: b.ino,
          fence: b.fence,
          mode: b.mode,
          expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.serverNow() + b.ttlMs,
        };
        const p = this.pending.get(b.reqId);
        if (p === undefined) {
          // A grant for a cancelled or abandoned request: give it back at once.
          this.cancelled.delete(b.reqId);
          this.channel.sendControl('lock.release', { leaseId: b.leaseId });
          return;
        }
        this.pending.delete(b.reqId);
        p.resolve({ kind: 'granted', lease });
        return;
      }
      case 'lock.queued': {
        const p = this.pending.get(frame.body.reqId);
        if (p !== undefined)
          this.emit({
            topic: 'lock.queued',
            ino: p.ino,
            mode: p.mode,
            pids: [p.pid],
            reason: `position ${frame.body.position}`,
          });
        return;
      }
      case 'lock.denied': {
        const b = frame.body;
        const p = this.pending.get(b.reqId);
        this.cancelled.delete(b.reqId);
        if (p === undefined) return;
        this.pending.delete(b.reqId);
        if (b.holder !== undefined) {
          const exp = Date.parse(b.holder.expiresAt);
          this.foreign.set(p.ino, {
            ino: p.ino,
            username: b.holder.username,
            mode: b.holder.mode,
            expiresAt: Number.isFinite(exp) ? exp : this.serverNow() + this.ttlMs,
          });
        }
        p.resolve({
          kind: 'denied',
          errno: b.errno,
          ...(b.reason === undefined ? {} : { reason: b.reason }),
          ...(b.holder === undefined ? {} : { holder: b.holder.username }),
        });
        return;
      }
      case 'lock.released':
      case 'lock.expired': {
        const b = frame.body;
        const ours = this.server.get(b.ino);
        if (ours?.leaseId === b.leaseId) {
          this.lose(b.ino, b.reason);
          return;
        }
        const f = this.foreign.get(b.ino);
        this.foreign.delete(b.ino);
        // "Available — open for writing" (§3.14.7).
        this.emit({
          topic: 'lock.released',
          ino: b.ino,
          mode: f?.mode ?? 'X',
          pids: [],
          reason: b.reason,
        });
        return;
      }
    }
  }

  onHbAck(ack: HbAckBody, clientNow: number, rttMs: number): void {
    const serverTime = Date.parse(ack.serverTime);
    if (Number.isFinite(serverTime)) {
      this.offsetMs = serverTime - (clientNow - rttMs / 2);
      const renewed = new Set(ack.renewed);
      for (const l of this.server.values())
        if (renewed.has(l.leaseId)) l.expiresAt = serverTime + this.ttlMs;
    }
    for (const l of ack.lost) {
      if (this.server.get(l.ino)?.leaseId === l.leaseId) this.lose(l.ino, 'expired');
    }
  }

  // -- internals ----------------------------------------------------------------------------------

  private serverNow(): number {
    return this.clock.now() + this.offsetMs;
  }

  private emit(ev: LockEvent): void {
    this.emitFn(ev);
  }

  /** Serve requests for one inode in arrival order. */
  private chain<T>(ino: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(ino) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(ino, tail);
    void tail.then(() => {
      if (this.chains.get(ino) === tail) this.chains.delete(ino);
    });
    return run;
  }

  private async acquireNow(req: AcquireRequest): Promise<LockResult<Grant>> {
    if (!this.table.compatible(req.ino, req.pid, req.mode)) {
      if (!req.wait)
        return fail('EBUSY', 'lease', `pid ${this.table.otherHolder(req.ino, req.pid)?.pid ?? 0}`);
      const outcome = await this.waitLocal(req);
      if (outcome === 'timeout') return fail('ETIMEDOUT');
      if (outcome === 'cancel') return fail('ECANCELED', 'signal');
    }
    if (this.available) {
      const sl = this.server.get(req.ino);
      if (sl !== undefined && covers(sl.mode, req.mode))
        return { ok: true, value: this.grant(req, 'server', sl) };
      const reply = await this.askServer(
        req.ino,
        req.mode,
        req.wait,
        req.principal,
        req.pid,
        req.timeoutMs,
      );
      if (reply.kind === 'granted') {
        this.attach(reply.lease);
        return { ok: true, value: this.grant(req, 'server', reply.lease) };
      }
      if (reply.kind === 'denied')
        return fail(
          reply.errno,
          reply.reason ?? (reply.errno === 'EBUSY' ? 'lease' : undefined),
          reply.holder,
        );
    }
    return this.acquireLocal(req);
  }

  /** Degraded mode: the local table plus an advisory `navigator.locks` lock. */
  private async acquireLocal(req: AcquireRequest): Promise<LockResult<Grant>> {
    if (this.locks !== undefined) {
      const cur = this.advisory.get(req.ino);
      if (cur === undefined || (req.mode === 'X' && cur.mode === 'S')) {
        cur?.release();
        this.advisory.delete(req.ino);
        const h = await requestAdvisory(
          this.locks,
          req.ino,
          req.mode === 'X' || cur?.mode === 'X' ? 'X' : 'S',
          false,
        );
        if (h === null) return fail('EBUSY', 'lease', 'another tab');
        this.advisory.set(req.ino, h);
      }
    }
    return { ok: true, value: this.grant(req, 'local', null) };
  }

  private grant(req: AcquireRequest, scope: 'server' | 'local', lease: ServerLease | null): Grant {
    const id = lease?.leaseId ?? this.newId();
    const h: Holder = {
      id,
      pid: req.pid,
      ino: req.ino,
      principal: req.principal,
      mode: req.mode,
      scope,
      fence: lease?.fence ?? null,
      lost: false,
    };
    this.table.add(h);
    this.foreign.delete(req.ino);
    const expiresAt = lease === null ? null : lease.expiresAt - this.offsetMs;
    this.emit({
      topic: 'lock.granted',
      ino: req.ino,
      mode: req.mode,
      pids: [req.pid],
      ...(lease === null ? {} : { fence: lease.fence }),
      ...(expiresAt === null ? {} : { expiresAt }),
    });
    return { leaseId: id, fence: h.fence, expiresAt, scope };
  }

  /** A server lease now covers `ino`: every live local holder writes under its fence. */
  private attach(lease: ServerLease): void {
    this.server.set(lease.ino, lease);
    this.foreign.delete(lease.ino);
    for (const h of this.table.holders(lease.ino)) {
      if (h.lost) continue;
      h.scope = 'server';
      h.fence = lease.fence;
    }
    const adv = this.advisory.get(lease.ino);
    adv?.release();
    this.advisory.delete(lease.ino);
  }

  private askServer(
    ino: string,
    mode: LeaseMode,
    wait: boolean,
    principal: number,
    pid: number,
    timeoutMs?: number,
  ): Promise<Reply> {
    const reqId = this.newId();
    return new Promise<Reply>((resolve) => {
      this.pending.set(reqId, { reqId, ino, mode, pid, resolve });
      const sent = this.channel.sendControl('lock.acquire', {
        reqId,
        ino,
        mode,
        wait,
        ...(wait && timeoutMs !== undefined ? { timeoutMs } : {}),
        principal,
      });
      if (!sent) {
        this.pending.delete(reqId);
        resolve({ kind: 'fallback' });
      }
    });
  }

  /** Reconnect: turn the local locks of `ino` into a server lease, or report them lost. */
  private async upgradeLocal(ino: string): Promise<void> {
    const live = this.table.holders(ino).filter((h) => !h.lost);
    const first = live.find((h) => h.mode === 'X') ?? live[0];
    if (first === undefined || this.server.has(ino) || !this.available) return;
    const mode = this.table.strongest(ino) ?? 'S';
    const reply = await this.askServer(ino, mode, false, first.principal, first.pid);
    if (reply.kind === 'granted') {
      this.attach(reply.lease);
      this.emit({
        topic: 'lock.granted',
        ino,
        mode,
        fence: reply.lease.fence,
        expiresAt: reply.lease.expiresAt - this.offsetMs,
        pids: live.map((h) => h.pid),
      });
      return;
    }
    if (reply.kind === 'denied') {
      for (const h of live) h.lost = true;
      this.advisory.get(ino)?.release();
      this.advisory.delete(ino);
      this.emit({
        topic: 'lock.lost',
        ino,
        mode,
        pids: live.map((h) => h.pid),
        reason: 'denied',
        ...(reply.holder === undefined ? {} : { holder: reply.holder }),
      });
    }
  }

  /** Our server lease on `ino` ended without a release (TTL, revocation): holders turn read-only. */
  private lose(ino: string, reason: string): void {
    const sl = this.server.get(ino);
    if (sl === undefined) return;
    this.server.delete(ino);
    const live = this.table.holders(ino).filter((h) => !h.lost);
    for (const h of live) h.lost = true; // the fence stays: a later write takes the stale-fence path
    this.emit({
      topic: 'lock.lost',
      ino,
      mode: sl.mode,
      fence: sl.fence,
      pids: live.map((h) => h.pid),
      reason,
    });
  }

  private afterHolderGone(ino: string): void {
    this.wakeLocal(ino);
    const live = this.table.holders(ino).filter((h) => !h.lost);
    if (live.length > 0) return;
    const sl = this.server.get(ino);
    if (sl !== undefined) {
      this.server.delete(ino);
      this.channel.sendControl('lock.release', { leaseId: sl.leaseId });
    }
    const adv = this.advisory.get(ino);
    adv?.release();
    this.advisory.delete(ino);
  }

  private waitLocal(req: AcquireRequest): Promise<'ok' | 'timeout' | 'cancel'> {
    return new Promise((resolve) => {
      this.table.addWaiter(req.ino, 1);
      let settled = false;
      const timer =
        req.timeoutMs === undefined ? null : this.clock.after(req.timeoutMs, () => done('timeout'));
      const w: LocalWaiter = {
        pid: req.pid,
        check: () => this.table.compatible(req.ino, req.pid, req.mode),
        done: (o) => done(o),
      };
      const done = (o: 'ok' | 'timeout' | 'cancel'): void => {
        if (settled) return;
        settled = true;
        timer?.cancel();
        this.table.addWaiter(req.ino, -1);
        const list = (this.localWaiters.get(req.ino) ?? []).filter((x) => x !== w);
        if (list.length === 0) this.localWaiters.delete(req.ino);
        else this.localWaiters.set(req.ino, list);
        resolve(o);
      };
      const list = this.localWaiters.get(req.ino) ?? [];
      list.push(w);
      this.localWaiters.set(req.ino, list);
    });
  }

  private wakeLocal(ino: string): void {
    const list = this.localWaiters.get(ino);
    const head = list?.[0];
    if (head?.check() === true) head.done('ok');
  }
}
