/**
 * TEST-ONLY protocol-level fake of the `/ws` server (offline-and-sync.md §3.6–§3.14), enough to
 * drive syncd and lockd end to end in Node:
 * - an op lane with an `op_log` keyed by opId: stored outcomes are returned with `duplicate: true`,
 *   `retry` is never persisted and answers the rest of the lane with `predecessor-retry`;
 * - fault injection: dropped replies, duplicated replies, a socket cut between COMMIT and the reply;
 * - per-owner feeds streamed on `hello`/`resume`, then `resume.done`; `snapshot.required` owners;
 * - a lease manager: S/X compatibility, fences from a monotonic counter, TTL renewed only by `hb`
 *   (and applied ops), a sweeper, `lock.expired` / `lock.released` pushes, clean `bye` releases.
 * It uses the test's virtual clock for every server time.
 */
import type { C2SFrame, C2SType, OpSubmit, S2CFrame, S2CType } from '@plotinium/protocol';

import type { SocketFactory, SocketHandlers, SocketLike } from '../../ports.ts';
import type { OpResultBody, SnapshotPage, VfsChangedBody } from '../../types.ts';
import type { FakeClock } from './clock.ts';
import { tid } from './device.ts';

export type Decision =
  | {
      readonly status: 'applied';
      readonly versions?: OpResultBody['versions'];
      readonly ownerSeqs?: OpResultBody['ownerSeqs'];
      readonly quota?: OpResultBody['quota'];
    }
  | {
      readonly status: 'conflict';
      readonly keptAs: NonNullable<OpResultBody['keptAs']>;
      readonly errno?: OpResultBody['errno'];
      readonly reason?: string;
      readonly versions?: OpResultBody['versions'];
      readonly ownerSeqs?: OpResultBody['ownerSeqs'];
    }
  | {
      readonly status: 'rejected';
      readonly errno: NonNullable<OpResultBody['errno']>;
      readonly reason?: string;
      readonly keptAs?: OpResultBody['keptAs'];
      readonly ownerSeqs?: OpResultBody['ownerSeqs'];
    }
  | {
      readonly status: 'retry';
      readonly errno: NonNullable<OpResultBody['errno']>;
      readonly reason?: string;
      readonly retryAfterMs: number;
    };

export interface Faults {
  /** The reply to this attempt is lost (the outcome is committed). */
  dropReply?: (opId: string, attempt: number) => boolean;
  /** The reply is delivered twice (a duplicated frame). */
  duplicateReply?: (opId: string, attempt: number) => boolean;
  /** The socket dies between COMMIT and the reply (the server killed after COMMIT). */
  closeAfterCommit?: (opId: string, attempt: number) => boolean;
}

interface Lease {
  readonly leaseId: string;
  readonly ino: string;
  mode: 'S' | 'X';
  fence: number;
  readonly session: string;
  readonly username: string;
  expiresAt: number;
  conn: Conn | null;
}

interface WaitReq {
  readonly conn: Conn;
  readonly body: C2SFrame<'lock.acquire'>['body'];
  readonly deadline: number | null;
}

export class Conn {
  readonly server: FakeServer;
  readonly handlers: SocketHandlers;
  readonly socket: SocketLike;
  closed = false;
  opened = false;
  session: string | null = null;
  private outId = 0;

  constructor(server: FakeServer, handlers: SocketHandlers) {
    this.server = server;
    this.handlers = handlers;
    this.socket = {
      send: (data) => {
        if (!this.closed) server.receive(this, data);
      },
      close: (code) => {
        if (this.closed) return;
        this.closed = true;
        server.clientClosed(this, code ?? 1000);
      },
    };
  }

  push<T extends S2CType>(t: T, body: S2CFrame<T>['body']): void {
    if (this.closed) return;
    const text = JSON.stringify({ v: 1, t, id: ++this.outId, body });
    this.server.sent.push({ t, body });
    // Frames pushed before a kill are delivered: they left before the socket died.
    setTimeout(() => this.handlers.onMessage(text), 0);
  }

  /** The server closes (or the network cuts) the socket with `code`. */
  kill(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.server.serverClosed(this, code);
    setTimeout(() => this.handlers.onClose(code, ''), 0);
  }
}

export class FakeServer {
  readonly clock: FakeClock;
  readonly ttlMs: number;
  readonly opLog = new Map<string, OpResultBody>();
  /** Times each op's effect was committed (must never exceed 1). */
  readonly effects = new Map<string, number>();
  readonly attempts = new Map<string, number>();
  readonly received: { t: string; body: unknown }[] = [];
  readonly sent: { t: string; body: unknown }[] = [];
  readonly conns: Conn[] = [];
  readonly feeds = new Map<number, VfsChangedBody[]>();
  readonly snapshotOwners = new Set<number>();
  readonly snapshots = new Map<string, SnapshotPage[]>();
  readonly posted: string[] = [];
  readonly leases: Lease[] = [];
  readonly waiters: WaitReq[] = [];
  decide: (op: OpSubmit, attempt: number) => Decision = () => ({ status: 'applied' });
  faults: Faults = {};
  auth = { uid: 1000, username: 'alice' };
  suGrants: { uid: number; expiresAt: string }[] = [];
  creditWindow = 16;
  autoOpen = true;
  /** Close code for upgrades refused before `open` (null: accept). */
  refuseUpgrade: number | null = null;
  authStatus = 200;
  healthy = true;
  /** A silent server: frames are received and never answered (hello timeout, dead-man). */
  mute = false;
  build = 'abc1234';
  lamport = 100;
  nextFence = 41;
  private leaseSeq = 0;

  constructor(clock: FakeClock, ttlMs = 15_000) {
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  /** The socket factory for one client. */
  factory(auth?: { uid: number; username: string }): SocketFactory {
    return (_url, handlers) => {
      const conn = new Conn(this, handlers);
      if (auth !== undefined) Object.assign(conn, { auth });
      this.conns.push(conn);
      if (this.refuseUpgrade !== null) {
        const code = this.refuseUpgrade;
        conn.closed = true;
        setTimeout(() => handlers.onClose(code, ''), 0);
      } else if (this.autoOpen) {
        setTimeout(() => {
          if (conn.closed) return;
          conn.opened = true;
          handlers.onOpen();
        }, 0);
      }
      return conn.socket;
    };
  }

  /** The last connection (open or not). */
  get last(): Conn {
    const c = this.conns[this.conns.length - 1];
    if (c === undefined) throw new Error('no connection');
    return c;
  }

  framesOf<T extends C2SType>(t: T): C2SFrame<T>['body'][] {
    return this.received.filter((f) => f.t === t).map((f) => f.body as C2SFrame<T>['body']);
  }

  sentOf<T extends S2CType>(t: T): S2CFrame<T>['body'][] {
    return this.sent.filter((f) => f.t === t).map((f) => f.body as S2CFrame<T>['body']);
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private authOf(conn: Conn): { uid: number; username: string } {
    return (conn as unknown as { auth?: { uid: number; username: string } }).auth ?? this.auth;
  }

  // -- frames ---------------------------------------------------------------------------------------

  receive(conn: Conn, data: string): void {
    const f = JSON.parse(data) as { t: C2SType; body: unknown };
    this.received.push({ t: f.t, body: f.body });
    if (this.mute) return;
    switch (f.t) {
      case 'hello':
        this.onHello(conn, f.body as C2SFrame<'hello'>['body']);
        return;
      case 'op.submit':
        this.lane(conn, [f.body as OpSubmit]);
        return;
      case 'op.batch':
        this.lane(conn, (f.body as C2SFrame<'op.batch'>['body']).ops);
        return;
      case 'hb':
        this.onHb(conn, f.body as C2SFrame<'hb'>['body']);
        return;
      case 'lock.acquire':
        this.onAcquire(conn, f.body as C2SFrame<'lock.acquire'>['body']);
        return;
      case 'lock.release':
        this.onRelease(conn, f.body as C2SFrame<'lock.release'>['body']);
        return;
      case 'resume':
        for (const c of (f.body as C2SFrame<'resume'>['body']).cursors)
          this.stream(conn, c.ownerUid, c.fromSeq);
        return;
      case 'bye':
        this.releaseSession(conn.session, 'session-closed');
        conn.kill(1000);
        return;
      case 'ack':
      case 'watch':
      case 'unwatch':
      case 'proc.signal':
        return;
    }
  }

  private onHello(conn: Conn, h: C2SFrame<'hello'>['body']): void {
    conn.session = h.osSessionId;
    this.sweep();
    const kept: S2CFrame<'hello.ok'>['body']['keptLeases'] = [];
    const lost: S2CFrame<'hello.ok'>['body']['lostLeases'] = [];
    for (const ref of h.heldLeases) {
      const l = this.leases.find(
        (x) => x.leaseId === ref.leaseId && x.session === h.osSessionId && x.fence === ref.fence,
      );
      if (l === undefined) lost.push(ref);
      else {
        l.expiresAt = this.clock.now() + this.ttlMs;
        l.conn = conn;
        kept.push({
          leaseId: l.leaseId,
          ino: l.ino,
          fence: l.fence,
          mode: l.mode,
          expiresAt: this.iso(l.expiresAt),
        });
      }
    }
    const a = this.authOf(conn);
    conn.push('hello.ok', {
      proto: 1,
      osSessionId: h.osSessionId,
      server: { name: 'Plotinium', version: '1.0.0', build: this.build, date: '2027-01-15' },
      serverTime: this.iso(this.clock.now()),
      lamport: this.lamport,
      auth: {
        uid: a.uid,
        username: a.username,
        gids: [100],
        kind: 'user',
        suGrants: this.suGrants,
      },
      limits: {
        maxPayload: 65_536,
        opEnvelopeMax: 61_440,
        maxBatch: 32,
        creditWindow: this.creditWindow,
        feedWindow: 256,
        maxLeases: 256,
        maxWatches: 256,
      },
      timers: { leaseTtlMs: this.ttlMs, hbMs: Math.floor(this.ttlMs / 3), deadManMs: 25_000 },
      owners: h.resume.map((r) => ({
        ownerUid: r.ownerUid,
        fromSeq: r.fromSeq,
        headSeq: this.head(r.ownerUid),
        horizonSeq: 1,
        mode: this.snapshotOwners.has(r.ownerUid) ? 'snapshot' : 'stream',
      })),
      keptLeases: kept,
      lostLeases: lost,
    });
    for (const r of h.resume) {
      if (this.snapshotOwners.has(r.ownerUid)) {
        conn.push('snapshot.required', {
          ownerUid: r.ownerUid,
          reason: 'horizon',
          headSeq: this.head(r.ownerUid),
          url: `/api/sync/snapshot?scope=owner&owner=${r.ownerUid}`,
        });
      } else this.stream(conn, r.ownerUid, r.fromSeq);
    }
  }

  head(owner: number): number {
    const f = this.feeds.get(owner) ?? [];
    return f.reduce((m, e) => Math.max(m, e.seq), 0);
  }

  stream(conn: Conn, owner: number, fromSeq: number): void {
    this.snapshotOwners.delete(owner);
    for (const e of this.feeds.get(owner) ?? []) if (e.seq > fromSeq) conn.push('vfs.changed', e);
    conn.push('resume.done', { ownerUid: owner, headSeq: this.head(owner) });
  }

  /** The op lane: one op at a time, in arrival order (§3.6, §5.3). */
  private lane(conn: Conn, ops: readonly OpSubmit[]): void {
    let retry: number | null = null;
    this.cut = false;
    for (const op of ops) {
      const attempt = (this.attempts.get(op.opId) ?? 0) + 1;
      this.attempts.set(op.opId, attempt);
      if (retry !== null) {
        this.reply(conn, op.opId, attempt, {
          opId: op.opId,
          status: 'retry',
          duplicate: false,
          errno: 'EAGAIN',
          reason: 'predecessor-retry',
          retryAfterMs: retry,
          lamport: this.lamport,
        });
        continue;
      }
      const stored = this.opLog.get(op.opId);
      if (stored !== undefined) {
        this.reply(conn, op.opId, attempt, { ...stored, duplicate: true });
        continue;
      }
      const d = this.decide(op, attempt);
      if (d.status === 'retry') {
        retry = d.retryAfterMs;
        this.reply(conn, op.opId, attempt, {
          opId: op.opId,
          status: 'retry',
          duplicate: false,
          errno: d.errno,
          ...(d.reason === undefined ? {} : { reason: d.reason }),
          retryAfterMs: d.retryAfterMs,
          lamport: this.lamport,
        });
        continue;
      }
      this.lamport = Math.max(this.lamport, op.lamport) + 1;
      const result: OpResultBody = {
        opId: op.opId,
        duplicate: false,
        lamport: this.lamport,
        commitTime: this.iso(this.clock.now()),
        ...d,
      };
      this.opLog.set(op.opId, result);
      if (d.status === 'applied' || d.status === 'conflict') {
        this.effects.set(op.opId, (this.effects.get(op.opId) ?? 0) + 1);
        // Any applied op of an OS session renews all its leases (§3.14.2).
        for (const l of this.leases)
          if (l.session === conn.session) l.expiresAt = this.clock.now() + this.ttlMs;
      }
      if (this.faults.closeAfterCommit?.(op.opId, attempt) === true) {
        conn.kill(1006);
        return;
      }
      this.reply(conn, op.opId, attempt, result);
    }
    // On TCP a reply is lost only with its connection: the socket dies after this lane step.
    if (this.cut) conn.kill(1006);
  }

  private cut = false;

  private reply(conn: Conn, opId: string, attempt: number, r: OpResultBody): void {
    if (this.faults.dropReply?.(opId, attempt) === true) {
      this.cut = true;
      return;
    }
    conn.push('op.result', r);
    if (this.faults.duplicateReply?.(opId, attempt) === true) conn.push('op.result', r);
  }

  /** `POST /api/ops/{opId}` (backend-api.md §3.6.2): the same pipeline, the result in the reply. */
  postOp(opId: string, body: string): OpResultBody {
    const op = JSON.parse(body) as OpSubmit;
    if (op.opId !== opId) throw new Error('409 EINVAL');
    this.posted.push(opId);
    const stored = this.opLog.get(opId);
    if (stored !== undefined) return { ...stored, duplicate: true };
    const d = this.decide(op, 1);
    if (d.status === 'retry')
      return {
        opId,
        status: 'retry',
        duplicate: false,
        errno: d.errno,
        retryAfterMs: d.retryAfterMs,
        lamport: this.lamport,
      };
    this.lamport += 1;
    const result: OpResultBody = { opId, duplicate: false, lamport: this.lamport, ...d };
    this.opLog.set(opId, result);
    if (d.status === 'applied' || d.status === 'conflict')
      this.effects.set(opId, (this.effects.get(opId) ?? 0) + 1);
    return result;
  }

  /** `GET /api/sync/snapshot` pages registered for `url`; `after` is the page index. */
  snapshotPage(url: string, after?: string): SnapshotPage {
    const pages = this.snapshots.get(url);
    if (pages === undefined) throw new Error(`404 ${url}`);
    const i = after === undefined ? 0 : Number(after);
    const page = pages[i];
    if (page === undefined) throw new Error('bad cursor');
    return i + 1 < pages.length
      ? { ...page, next: String(i + 1), complete: false }
      : { ...page, complete: true };
  }

  // -- leases ---------------------------------------------------------------------------------------

  private onHb(conn: Conn, hb: C2SFrame<'hb'>['body']): void {
    this.sweep();
    const renewed: string[] = [];
    const lost: typeof hb.leases = [];
    for (const ref of hb.leases) {
      const l = this.leases.find((x) => x.leaseId === ref.leaseId && x.session === conn.session);
      if (l === undefined) lost.push(ref);
      else {
        l.expiresAt = this.clock.now() + this.ttlMs;
        l.conn = conn;
        renewed.push(l.leaseId);
      }
    }
    conn.push('hb.ack', { t: hb.t, serverTime: this.iso(this.clock.now()), renewed, lost });
  }

  private compatible(session: string, ino: string, mode: 'S' | 'X'): Lease | null {
    const others = this.leases.filter((l) => l.ino === ino && l.session !== session);
    if (mode === 'X') return others[0] ?? null;
    return others.find((l) => l.mode === 'X') ?? null;
  }

  private grant(conn: Conn, body: C2SFrame<'lock.acquire'>['body']): void {
    const session = conn.session ?? 'none';
    const own = this.leases.findIndex((l) => l.ino === body.ino && l.session === session);
    if (own >= 0) this.leases.splice(own, 1); // one row per (ino, session): an upgrade replaces it
    const lease: Lease = {
      leaseId: tid(0x1ea5e0000 + ++this.leaseSeq),
      ino: body.ino,
      mode: body.mode,
      fence: this.nextFence++,
      session,
      username: this.authOf(conn).username,
      expiresAt: this.clock.now() + this.ttlMs,
      conn,
    };
    this.leases.push(lease);
    conn.push('lock.granted', {
      reqId: body.reqId,
      leaseId: lease.leaseId,
      ino: lease.ino,
      mode: lease.mode,
      fence: lease.fence,
      expiresAt: this.iso(lease.expiresAt),
      ttlMs: this.ttlMs,
    });
  }

  private onAcquire(conn: Conn, body: C2SFrame<'lock.acquire'>['body']): void {
    this.sweep();
    const blocker = this.compatible(conn.session ?? 'none', body.ino, body.mode);
    const queuedAhead = this.waiters.some((w) => w.body.ino === body.ino);
    if (blocker === null && !queuedAhead) {
      this.grant(conn, body);
      return;
    }
    if (body.wait) {
      this.waiters.push({
        conn,
        body,
        deadline: body.timeoutMs === undefined ? null : this.clock.now() + body.timeoutMs,
      });
      conn.push('lock.queued', {
        reqId: body.reqId,
        position: this.waiters.filter((w) => w.body.ino === body.ino).length,
      });
      return;
    }
    const holder = blocker ?? this.leases.find((l) => l.ino === body.ino);
    conn.push('lock.denied', {
      reqId: body.reqId,
      errno: 'EBUSY',
      reason: 'lease',
      ...(holder === undefined
        ? {}
        : {
            holder: {
              username: holder.username,
              mode: holder.mode,
              expiresAt: this.iso(holder.expiresAt),
            },
          }),
    });
  }

  private onRelease(conn: Conn, body: C2SFrame<'lock.release'>['body']): void {
    if (body.reqId !== undefined) {
      const i = this.waiters.findIndex((w) => w.body.reqId === body.reqId);
      if (i >= 0) {
        this.waiters.splice(i, 1);
        conn.push('lock.denied', { reqId: body.reqId, errno: 'ECANCELED' });
      }
      return;
    }
    const i = this.leases.findIndex(
      (l) => l.leaseId === body.leaseId && l.session === conn.session,
    );
    if (i < 0) return;
    const [l] = this.leases.splice(i, 1);
    if (l !== undefined) this.ended(l, 'released', false);
  }

  /** Notify watchers and waiters, then grant the next FIFO waiters. */
  private ended(
    l: Lease,
    reason: 'released' | 'expired' | 'session-closed',
    toHolder: boolean,
  ): void {
    if (toHolder && l.conn !== null && !l.conn.closed)
      l.conn.push('lock.expired', {
        ino: l.ino,
        leaseId: l.leaseId,
        reason: reason === 'released' ? 'expired' : reason,
      });
    for (const c of this.conns)
      if (!c.closed && c.session !== l.session)
        c.push('lock.released', { ino: l.ino, leaseId: l.leaseId, reason });
    for (const w of [...this.waiters]) {
      if (w.body.ino !== l.ino) continue;
      if (this.compatible(w.conn.session ?? 'none', w.body.ino, w.body.mode) !== null) break;
      this.waiters.splice(this.waiters.indexOf(w), 1);
      this.grant(w.conn, w.body);
    }
  }

  /** The expiry sweeper (§3.14.5): TTL passed without renewal. */
  sweep(): void {
    const now = this.clock.now();
    for (const l of [...this.leases]) {
      if (l.expiresAt > now) continue;
      this.leases.splice(this.leases.indexOf(l), 1);
      this.ended(l, 'expired', true);
    }
    for (const w of [...this.waiters]) {
      if (w.deadline === null || w.deadline > now) continue;
      this.waiters.splice(this.waiters.indexOf(w), 1);
      w.conn.push('lock.denied', { reqId: w.body.reqId, errno: 'ETIMEDOUT' });
    }
  }

  releaseSession(session: string | null, reason: 'session-closed'): void {
    for (const l of [...this.leases]) {
      if (l.session !== session) continue;
      this.leases.splice(this.leases.indexOf(l), 1);
      this.ended(l, reason, false);
    }
  }

  clientClosed(conn: Conn, code: number): void {
    // A clean close releases the session's leases at once; an abnormal one keeps them (§3.14.5).
    if (code === 1000 || code === 1001) this.releaseSession(conn.session, 'session-closed');
    for (const l of this.leases) if (l.conn === conn) l.conn = null;
  }

  serverClosed(conn: Conn, _code: number): void {
    for (const l of this.leases) if (l.conn === conn) l.conn = null;
  }
}
