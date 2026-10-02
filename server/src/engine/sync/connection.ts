/**
 * One `/ws` connection after the upgrade (offline-and-sync.md §3.6-§3.9, §3.14, §4; backend-api.md
 * §3.7). It executes the pure router's actions against the engine, the op lane, the lock manager
 * and the per-owner streams, and owns this socket's timers, throttle and backpressure.
 *
 * Lanes (SYN-02): op frames go to this connection's OpLane and are answered one at a time; every
 * other frame is handled as it arrives and never waits behind an op, so a lock grant or an `hb`
 * stays fast while a 1,000-node rm -r runs on the same socket.
 */
import {
  DEAD_MAN_MS,
  hbMs as hbFor,
  MAX_WATCHES,
  CREDIT_WINDOW,
  FEED_WINDOW,
  type BuildIdentity,
  type HelloOk,
  type OpResult,
  type OpSubmit,
} from '@plotinium/protocol';
import type { Cred } from '@plotinium/vfs/perm';

import type { LockConnRef, LockFrame } from '../locks/types.ts';
import {
  backpressure,
  leaseActionOnClose,
  type SendClass,
  type ServerByeReason,
} from './close-policy.ts';
import { ProtocolViolation, type OpOrigin } from './engine.ts';
import type { FeedEntry, FeedSubscriber } from './feed.ts';
import { OpLane } from './lane.ts';
import { retry } from './outcome.ts';
import {
  resumeMode,
  snapshotUrl,
  OwnerStream,
  type SendResult,
  type SnapshotReason,
  type StreamSink,
} from './resume.ts';
import {
  bye,
  initialRouterState,
  laneOf,
  noteProtocolError,
  routeFrame,
  type Outbound,
  type RouterAction,
  type RouterState,
} from './router.ts';
import { FrameThrottle } from './throttle.ts';
import { filterChanges } from './visibility.ts';
import { ConnectionWatchdog } from './watchdog.ts';
import type { HelloBody, HubContext } from './hub.ts';

/** The socket as the connection needs it (a thin adapter over `ws`). */
export interface Transport {
  send(text: string): void;
  close(code: number, reason?: string): void;
  /** Destroys the socket without a close frame (missed pong). */
  terminate(): void;
  ping(): void;
  readonly bufferedAmount: number;
  /** Stops reading the socket for `ms` (throttle); optional. */
  pauseReading?(ms: number): void;
}

/** The cookie session the upgrade was authenticated with (never a frame's claim). */
export interface ConnAuth {
  readonly authSessionId: string;
  readonly uid: number;
  readonly username: string;
  readonly kind: HelloOk['auth']['kind'];
  /** Primary gid first, then supplementary groups. */
  readonly gids: readonly number[];
  /** Live `su` grants of the auth session, read when needed (they expire). */
  suGrants(): readonly { readonly uid: number; readonly expiresAt: Date }[];
  /** Groups of a granted principal (su target); defaults to [uid]. */
  gidsOf?(uid: number): readonly number[];
}

export interface HelloInfo {
  readonly osSessionId: string;
  readonly deviceId: string;
  readonly kernelEpoch: number;
  readonly proto: number;
}

const MAX_CHANGES = 200;
const MAX_REFETCH_DIRS = 64;

export class SyncConnection implements FeedSubscriber {
  readonly connId: string;
  readonly auth: ConnAuth;
  readonly #t: Transport;
  readonly #hub: HubContext;
  readonly #watchdog: ConnectionWatchdog;
  readonly #throttle: FrameThrottle;
  readonly #streams = new Map<number, OwnerStream>();
  readonly #watches = new Set<string>();
  #router: RouterState = initialRouterState;
  #outId = 0;
  #lane: OpLane | null = null;
  #hello: HelloInfo | null = null;
  #helloDone: Promise<void> = Promise.resolve();
  #byeReceived = false;
  #serverClosing = false;
  #closed = false;
  #unsubscribe: (() => void) | null = null;

  constructor(connId: string, transport: Transport, auth: ConnAuth, hub: HubContext) {
    this.connId = connId;
    this.auth = auth;
    this.#t = transport;
    this.#hub = hub;
    this.#watchdog = new ConnectionWatchdog({
      clock: hub.clock,
      idleTimeoutMs: hub.config.leaseTtlMs,
      onTimeout: () => this.closeWith('idle-timeout'),
      ping: () => this.#t.ping(),
      terminate: () => this.#t.terminate(),
    });
    this.#throttle = new FrameThrottle({ clock: hub.clock });
  }

  get hello(): HelloInfo | null {
    return this.#hello;
  }

  get osSessionId(): string | null {
    return this.#hello?.osSessionId ?? null;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Streams that are mirrored by this connection (tests and diagnostics). */
  streamOf(owner: number): OwnerStream | undefined {
    return this.#streams.get(owner);
  }

  /** Arms the hello timer and the ping cycle; subscribes to the broadcaster. */
  start(): void {
    this.#watchdog.start();
    this.#unsubscribe = this.#hub.broadcaster.subscribe(this);
  }

  // -------------------------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------------------------

  /** One inbound WebSocket message (text or binary). */
  onMessage(raw: string, isBinary = false): void {
    if (this.#closed || this.#serverClosing) return;
    this.#watchdog.appFrame();
    const now = this.#hub.clock.now();
    const routed = routeFrame(this.#router, raw, now, isBinary);
    this.#router = routed.state;
    const lane = routed.actions.some((a) => laneOf(a) === 'op') ? 'op' : 'control';
    const admit = this.#throttle.admit(lane);
    if (admit.kind === 'close') {
      this.closeWith('rate-limited', admit.retryAfterMs);
      return;
    }
    if (admit.kind === 'throttle') {
      if (admit.notify)
        this.#send({ t: 'throttle', body: { retryAfterMs: admit.retryAfterMs, scope: 'frames' } });
      this.#t.pauseReading?.(admit.retryAfterMs);
    }
    for (const action of routed.actions) this.#dispatch(action);
  }

  /** A `ws` pong: socket liveness only; it renews no lease and resets no idle timer (INV-S8). */
  onPong(): void {
    this.#watchdog.pong();
  }

  /**
   * The socket closed (any side). Leases: released at once after `bye` or a clean client close
   * (1000/1001) when no other connection of the OS session is open; kept until the TTL otherwise.
   */
  onClose(code: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#watchdog.stop();
    this.#unsubscribe?.();
    for (const s of this.#streams.values()) s.stop();
    this.#streams.clear();
    void this.#lane?.close();
    this.#hub.unregister(this);
    const os = this.osSessionId;
    const action = leaseActionOnClose({
      code,
      byeReceived: this.#byeReceived,
      serverInitiated: this.#serverClosing,
    });
    const release = action === 'release' && os !== null && !this.#hub.hasOtherConnection(os, this);
    this.#hub.locks
      .connectionClosed({ connId: this.connId, osSessionId: os }, release)
      .catch((err: unknown) => this.#hub.onError(err, 'close-release'));
  }

  /** Server-initiated close: `bye {reason}` then the reason's close code. */
  closeWith(reason: ServerByeReason, retryAfterMs?: number): void {
    if (this.#closed || this.#serverClosing) return;
    this.#serverClosing = true;
    for (const a of bye(reason, retryAfterMs)) {
      if (a.kind === 'send') this.#write(a.frame);
      else if (a.kind === 'close') this.#t.close(a.code, a.reason);
    }
  }

  /** Graceful shutdown (backend-api.md §3.17): finish the running op, then bye restart / 1012. */
  async drainAndClose(graceMs: number): Promise<void> {
    const lane = this.#lane;
    if (lane !== null) {
      await Promise.race([
        lane.drain(),
        new Promise<void>((resolve) => this.#hub.clock.setTimer(graceMs, resolve)),
      ]);
    }
    this.closeWith('restart', 0);
  }

  // -------------------------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------------------------

  /**
   * `POST /api/ops/{opId}` for this connection's OS session: the op joins this socket's op lane
   * (so HTTP and WebSocket ops of one session never run concurrently) and its result is returned
   * here, never sent on the socket (backend-api.md §3.6.2).
   */
  submitHttp(submit: OpSubmit): Promise<OpResult> {
    return new Promise<OpResult>((resolve) => {
      const lamport = this.#hub.engine.lamport.value;
      const r = this.#lane?.enqueue([submit], resolve) ?? 'closed';
      if (r === 'limit') resolve(retry(submit.opId, 'EAGAIN', 'rate', lamport, 1_000));
      else if (r === 'closed') resolve(retry(submit.opId, 'EIO', 'server', lamport, 1_000));
    });
  }

  /** A lock frame from the lock manager. */
  sendLock(frame: LockFrame): void {
    this.#send(frame);
  }

  /** proc.signal SIGHUP when a su grant ends (§3.17). */
  sendSuEnded(uid: number, reason: 'su-expired' | 'su-revoked'): void {
    this.#send({
      t: 'proc.signal',
      body: { target: { kind: 'principal', uid }, sig: 'SIGHUP', reason },
    });
  }

  sendResult(result: OpResult): void {
    this.#send({ t: 'op.result', body: result });
  }

  #write(frame: Outbound): void {
    this.#outId = this.#outId >= 0xffff_ffff ? 1 : this.#outId + 1;
    this.#t.send(JSON.stringify({ v: 1, t: frame.t, id: this.#outId, body: frame.body }));
  }

  /** Backpressure-aware send (§4.6.1). */
  #send(frame: Outbound, cls: SendClass = 'control'): SendResult {
    if (this.#closed || this.#serverClosing) return 'closed';
    const decision = backpressure(this.#t.bufferedAmount, cls);
    if (decision === 'close') {
      this.closeWith('slow-consumer');
      return 'closed';
    }
    if (decision === 'coalesce') return 'coalesced';
    this.#write(frame);
    return 'sent';
  }

  // -------------------------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------------------------

  #protocolError(frame: Outbound): void {
    const r = noteProtocolError(this.#router, this.#hub.clock.now(), { kind: 'send', frame });
    this.#router = r.state;
    for (const a of r.actions) this.#dispatch(a);
  }

  #dispatch(action: RouterAction): void {
    if (action.kind === 'send') {
      this.#send(action.frame);
    } else if (action.kind === 'close') {
      // The close that answers the client's own bye is not a server-initiated close (UI-166).
      if (action.afterBye !== true && (action.reason !== 'shutdown' || !this.#byeReceived))
        this.#serverClosing = true;
      this.#t.close(action.code, action.reason);
    } else if (action.kind === 'hello') {
      this.#helloDone = this.#onHello(action.proto, action.body).catch((err: unknown) => {
        this.#hub.onError(err, 'hello');
        this.closeWith('restart', 1_000);
      });
    } else if (action.kind === 'bye') {
      this.#byeReceived = true;
    } else {
      // Frames after hello wait until the handshake finished (the lane and streams exist).
      void this.#helloDone.then(() => this.#afterHello(action));
    }
  }

  #afterHello(action: RouterAction): void {
    if (this.#closed || this.#serverClosing || this.#hello === null) return;
    const hello = this.#hello;
    switch (action.kind) {
      case 'ops': {
        const r = this.#lane?.enqueue(action.ops);
        if (r === 'limit') {
          this.#protocolError({
            t: 'error',
            body: {
              code: 'limit',
              refId: action.frameId,
              msg: `more than ${this.#hub.config.creditWindow} ops in flight`,
            },
          });
        }
        return;
      }
      case 'invalid-ops':
        for (const op of action.ops) {
          this.#hub.engine.rejectInvalid(this.#origin(), op).then(
            (r) => this.sendResult(r),
            (err: unknown) => this.#fail(err),
          );
        }
        return;
      case 'ack':
        for (const c of action.cursors) this.#streams.get(c.ownerUid)?.ack(c.seq);
        return;
      case 'lock.acquire':
        this.#hub.locks
          .acquire(this.#lockRef(hello), action.body)
          .catch((err: unknown) => this.#hub.onError(err, 'lock.acquire'));
        return;
      case 'lock.release':
        void this.#release(hello, action.frameId, action.body);
        return;
      case 'hb':
        void this.#heartbeat(hello, action.body);
        return;
      case 'watch':
        void this.#watch(action.frameId, action.ino);
        return;
      case 'unwatch':
        this.#watches.delete(action.ino);
        return;
      case 'resume':
        void this.#resume(
          action.body.cursors.map((c) => ({ ownerUid: c.ownerUid, fromSeq: c.fromSeq })),
        );
        return;
      case 'proc.signal':
        this.#lane?.signal(action.body.target.opId);
        return;
      case 'send':
      case 'close':
      case 'hello':
      case 'bye':
        return;
    }
  }

  #fail(err: unknown): void {
    if (err instanceof ProtocolViolation) {
      this.closeWith(err.byeReason);
      return;
    }
    this.#hub.onError(err, 'op');
  }

  #mayActAs(principal: number): boolean {
    if (principal === this.auth.uid) return true;
    const now = this.#hub.clock.now();
    return this.auth.suGrants().some((g) => g.uid === principal && g.expiresAt.getTime() > now);
  }

  #origin(): OpOrigin {
    return {
      connId: this.connId,
      uid: this.auth.uid,
      deviceId: this.#hello?.deviceId ?? null,
      mayActAs: (p) => this.#mayActAs(p),
      gidsOf: (p) => (p === this.auth.uid ? this.auth.gids : (this.auth.gidsOf?.(p) ?? [p])),
    };
  }

  #lockRef(hello: HelloInfo): LockConnRef {
    return {
      connId: this.connId,
      osSessionId: hello.osSessionId,
      uid: this.auth.uid,
      mayActAs: (p) => this.#mayActAs(p),
    };
  }

  get #cred(): Cred {
    const gid = this.auth.gids[0] ?? this.auth.uid;
    return { uid: this.auth.uid, gid, groups: this.auth.gids.length > 0 ? this.auth.gids : [gid] };
  }

  async #onHello(proto: number, body: HelloBody): Promise<void> {
    const hub = this.#hub;
    this.#watchdog.helloReceived();
    const info: HelloInfo = {
      osSessionId: body.osSessionId,
      deviceId: body.deviceId,
      kernelEpoch: body.kernelEpoch,
      proto,
    };
    const registered = await hub.register(this, { hello: body, info });
    if (registered === 'forbidden') {
      this.closeWith('policy');
      return;
    }
    if (registered === 'stale') {
      this.closeWith('superseded');
      return;
    }
    this.#hello = info;
    hub.engine.lamport.observe(body.lamport);
    await hub.locks.releaseDevicePredecessors({
      deviceId: body.deviceId,
      uid: this.auth.uid,
      osSessionId: body.osSessionId,
      kernelEpoch: body.kernelEpoch,
    });
    const leases = await hub.locks.verifyHeld(body.osSessionId, body.heldLeases);
    const owners = body.resume.map((c) => c.ownerUid);
    const heads = await hub.reader.heads(owners);
    const now = hub.clock.now();
    const plans = body.resume.map((c) => {
      const head = heads.get(c.ownerUid) ?? { feedSeq: 0, purgedSeq: 0 };
      const known = heads.has(c.ownerUid);
      const decision = known
        ? resumeMode(c.fromSeq, head)
        : ({ mode: 'snapshot', reason: 'reset' } as const);
      return { cursor: c, head, decision };
    });
    this.#lane = new OpLane({
      creditWindow: hub.config.creditWindow,
      apply: (submit, signal) => hub.engine.applyOp(this.#origin(), submit, signal),
      rejectKilled: (submit) => hub.engine.rejectKilled(this.#origin(), submit),
      cancelRunning: (opId) => hub.cancelBackend(opId),
      reply: (r) => this.sendResult(r),
      fail: (err) => this.#fail(err),
      lamport: () => hub.engine.lamport.value,
    });
    const grants = this.auth
      .suGrants()
      .filter((g) => g.expiresAt.getTime() > now)
      .slice(0, 4);
    this.#send({
      t: 'hello.ok',
      body: {
        proto,
        osSessionId: body.osSessionId,
        server: hub.config.build,
        serverTime: new Date(now).toISOString(),
        lamport: hub.engine.lamport.value,
        auth: {
          uid: this.auth.uid,
          username: this.auth.username,
          gids: this.auth.gids.slice(0, 64),
          kind: this.auth.kind,
          suGrants: grants.map((g) => ({ uid: g.uid, expiresAt: g.expiresAt.toISOString() })),
        },
        limits: {
          maxPayload: 65_536,
          opEnvelopeMax: 61_440,
          maxBatch: 32,
          creditWindow: hub.config.creditWindow,
          feedWindow: hub.config.feedWindow,
          maxLeases: hub.locks.maxLeases,
          maxWatches: hub.config.maxWatches,
        },
        timers: {
          leaseTtlMs: hub.config.leaseTtlMs,
          hbMs: hbFor(hub.config.leaseTtlMs),
          deadManMs: DEAD_MAN_MS,
        },
        owners: plans.map((p) => ({
          ownerUid: p.cursor.ownerUid,
          fromSeq: p.cursor.fromSeq,
          headSeq: p.head.feedSeq,
          horizonSeq: p.head.purgedSeq + 1,
          mode: p.decision.mode,
        })),
        keptLeases: leases.kept,
        lostLeases: leases.lost,
      },
    });
    for (const p of plans)
      this.#startOwner(p.cursor.ownerUid, p.cursor.fromSeq, p.decision, p.head.feedSeq);
  }

  #startOwner(
    ownerUid: number,
    fromSeq: number,
    decision: ReturnType<typeof resumeMode>,
    headSeq: number,
  ): void {
    this.#streams.get(ownerUid)?.stop();
    this.#streams.delete(ownerUid);
    if (decision.mode === 'snapshot') {
      this.#snapshotRequired(ownerUid, decision.reason, headSeq);
      return;
    }
    const stream = new OwnerStream({
      ownerUid,
      fromSeq,
      connId: this.connId,
      reader: this.#hub.reader,
      dirs: this.#hub.dirs,
      sink: this.#sink,
      feedWindow: this.#hub.config.feedWindow,
      onError: (err) => this.#hub.onError(err, 'resume'),
    });
    this.#streams.set(ownerUid, stream);
    void stream.start();
  }

  #snapshotRequired(ownerUid: number, reason: SnapshotReason, headSeq: number): void {
    this.#send({
      t: 'snapshot.required',
      body: { ownerUid, reason, headSeq, url: snapshotUrl(ownerUid) },
    });
  }

  async #resume(cursors: readonly { ownerUid: number; fromSeq: number }[]): Promise<void> {
    try {
      const heads = await this.#hub.reader.heads(cursors.map((c) => c.ownerUid));
      for (const c of cursors) {
        const head = heads.get(c.ownerUid);
        const decision =
          head === undefined
            ? ({ mode: 'snapshot', reason: 'reset' } as const)
            : resumeMode(c.fromSeq, head);
        this.#startOwner(c.ownerUid, c.fromSeq, decision, head?.feedSeq ?? 0);
      }
    } catch (err) {
      this.#hub.onError(err, 'resume');
    }
  }

  async #heartbeat(
    hello: HelloInfo,
    body: { t: number; leases: { leaseId: string; ino: string; fence: number }[]; lamport: number },
  ): Promise<void> {
    try {
      // Every hb re-validates the auth session (one primary-key lookup, backend-api.md §3.8.3).
      if (!(await this.#hub.validateAuth(this.auth.authSessionId))) {
        await this.#hub.revoke([this.auth.authSessionId]);
        return;
      }
      this.#hub.engine.lamport.observe(body.lamport);
      const r = await this.#hub.locks.heartbeat(hello.osSessionId, body.leases);
      this.#send({
        t: 'hb.ack',
        body: {
          t: body.t,
          serverTime: new Date(this.#hub.clock.now()).toISOString(),
          renewed: r.renewed,
          lost: r.lost,
        },
      });
    } catch (err) {
      this.#hub.onError(err, 'hb');
    }
  }

  async #release(
    hello: HelloInfo,
    frameId: number,
    body: { leaseId?: string | undefined; reqId?: string | undefined },
  ): Promise<void> {
    try {
      const ref = this.#lockRef(hello);
      if (body.leaseId !== undefined) {
        if (!(await this.#hub.locks.releaseLease(ref, body.leaseId))) {
          this.#send({
            t: 'error',
            body: { code: 'forbidden', refId: frameId, errno: 'EINVAL', msg: 'unknown-lease' },
          });
        }
      } else if (body.reqId !== undefined) {
        this.#hub.locks.cancelRequest(ref, body.reqId);
      }
    } catch (err) {
      this.#hub.onError(err, 'lock.release');
    }
  }

  async #watch(frameId: number, ino: string): Promise<void> {
    if (this.#watches.has(ino)) return;
    if (this.#watches.size >= this.#hub.config.maxWatches) {
      this.#send({
        t: 'error',
        body: {
          code: 'limit',
          refId: frameId,
          msg: `at most ${this.#hub.config.maxWatches} watches`,
        },
      });
      return;
    }
    try {
      if (!(await this.#hub.canWatch(this.#cred, ino))) {
        this.#send({
          t: 'error',
          body: { code: 'forbidden', refId: frameId, errno: 'EACCES', msg: 'watch needs r and x' },
        });
        return;
      }
      this.#watches.add(ino);
    } catch (err) {
      this.#hub.onError(err, 'watch');
    }
  }

  // -------------------------------------------------------------------------------------------
  // Feed delivery
  // -------------------------------------------------------------------------------------------

  /** Broadcaster fan-out (strictly increasing seq per owner). */
  deliver(entry: FeedEntry): void {
    if (this.#closed || this.#hello === null) return;
    const stream = this.#streams.get(entry.ownerUid);
    if (stream !== undefined) {
      stream.live(entry);
      return;
    }
    if (entry.originConnId === this.connId) return;
    if (entry.dirs.some((d) => this.#watches.has(d))) this.#sendEntry(entry, 'live');
  }

  readonly #sink: StreamSink = {
    sendEntry: (entry, phase) => this.#sendEntry(entry, phase),
    sendResumeDone: (ownerUid, headSeq) => {
      this.#send({ t: 'resume.done', body: { ownerUid, headSeq } });
    },
    sendSnapshotRequired: (ownerUid, reason, headSeq) =>
      this.#snapshotRequired(ownerUid, reason, headSeq),
  };

  #sendEntry(entry: FeedEntry, phase: 'stream' | 'live'): SendResult {
    const f = filterChanges(this.#cred, entry.ownerUid, entry.changes, entry.context);
    const tooMany = f.changes.length > MAX_CHANGES;
    const dirs = entry.dirs.slice(0, MAX_REFETCH_DIRS);
    return this.#send(
      {
        t: 'vfs.changed',
        body: {
          ownerUid: entry.ownerUid,
          seq: entry.seq,
          opId: entry.opId,
          commitTime: entry.commitTime,
          lamport: entry.lamport,
          redacted: f.redacted,
          changes: tooMany ? [] : [...f.changes],
          ...(tooMany && dirs.length > 0 ? { refetch: { dirs } } : {}),
        },
      },
      phase === 'live' ? 'feed' : 'control',
    );
  }
}

/** Defaults of the advertised limits (hello.ok.limits). */
export const CONNECTION_DEFAULTS = {
  creditWindow: CREDIT_WINDOW,
  feedWindow: FEED_WINDOW,
  maxWatches: MAX_WATCHES,
} as const;

export type { BuildIdentity };
