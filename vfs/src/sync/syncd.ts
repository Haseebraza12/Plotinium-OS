/**
 * `syncd`: the WebSocket protocol v1 client of the kernel worker (offline-and-sync.md §3.2–§3.15;
 * C2, C6; OFF-02, OFF-04, VFS-10, SYN-02..SYN-12). One socket per kernel; `lockd`'s frames ride its
 * control lane.
 *
 * - Connection: the state machine of §3.7 (`machine.ts`) with full-jitter back-off, the 5 s hello
 *   timeout, the 25 s dead-man timer, the offline probe and the per-close-code reactions of §4.5.
 * - Handshake: `hello` carries the per-owner resume cursors, the held leases and the Lamport counter;
 *   `hello.ok` gives auth, limits and timers (§3.8.4).
 * - Replay: the outbox in commit order, packed into `op.submit` / `op.batch` frames (≤ 32 ops) under
 *   the advertised credit window (16), blobs first, ops over 60 KB through `POST /api/ops/{opId}` at
 *   the head of an empty window; `attempts` is persisted before a frame leaves (§3.9, §5.2).
 * - Results: one IndexedDB transaction per final result (`results.ts`), `retry` resends after
 *   `max(retryAfterMs, fullJitter(attempts))`; the server's `op_log` deduplicates by `opId`.
 * - Feed: per-owner cursors with a reorder buffer, a gap timer and batched acks (`feed.ts`); remote
 *   apply (`remote.ts`); `snapshot.required` pages then `resume`.
 * - Status: `net.state` and the taskbar label on every change (OFF-04).
 *
 * All protocol state lives here in the kernel worker; the main thread only forwards `online`,
 * `offline`, `visibilitychange` and `resume` (SYN-15, INV-S10).
 */
import {
  CLOSE_CODES,
  CREDIT_WINDOW,
  DEAD_MAN_MS,
  HELLO_TIMEOUT_MS,
  MAX_PAYLOAD,
  PROBE_MS,
  PROTO,
  S2C_TYPES,
  SYNC_WAIT_MS,
  hbMs as hbOf,
  LEASE_TTL_MS,
} from '@plotinium/protocol';
import type {
  BuildIdentity,
  C2SFrame,
  C2SType,
  Change,
  FeedCursor,
  NetStatus,
  S2CFrame,
} from '@plotinium/protocol';

import type { OutboxRec } from '../store/records.ts';
import { fullJitter, nextDelayMs } from './backoff.ts';
import type { Rng } from './backoff.ts';
import { FeedTracker } from './feed.ts';
import { Lamport } from './lamport.ts';
import { isConnected, isSyncing, transition } from './machine.ts';
import type { SyncEvent } from './machine.ts';
import { OutboxQueue, toSubmit } from './outbox.ts';
import { HttpUnavailable, systemClock } from './ports.ts';
import type {
  Clock,
  ControlChannel,
  FrameDecoder,
  LockSyncClient,
  SocketFactory,
  SocketLike,
  SyncEffect,
  SyncHost,
  SyncHttp,
  Timer,
} from './ports.ts';
import { closureOf } from './results.ts';
import type { ClosureMember, TxContext } from './results.ts';
import { rowToChange } from './remote.ts';
import { planSend } from './sender.ts';
import type { BlobReadiness } from './sender.ts';
import { netStatusOf, sameStatus, statusLabel } from './status.ts';
import type { StatusInput } from './status.ts';
import type { RemoteEffect, ResultEffect, ResultRequest, SyncStorage } from './storage.ts';
import type {
  HelloOkBody,
  SyncKeptAs,
  OpResultBody,
  QueueEntry,
  SnapshotPage,
  SyncNotice,
  SyncState,
  VfsChangedBody,
  WaitOutcome,
} from './types.ts';

/** The OS session this kernel instance syncs (offline-and-sync.md §3.8.1). */
export interface SyncSession {
  readonly osSessionId: string;
  readonly deviceId: string;
  /** Fencing epoch from `meta` (C2). */
  readonly kernelEpoch: number;
  /** The login uid of the session (also mirrored, with root). */
  readonly loginUid: number;
  readonly build: BuildIdentity;
  /** `wss://<origin>/ws` (same origin, cookie-authenticated). */
  readonly url: string;
}

export interface SyncdOptions {
  readonly session: SyncSession;
  readonly storage: SyncStorage;
  readonly socket: SocketFactory;
  readonly http: SyncHttp;
  readonly clock?: Clock;
  readonly random?: Rng;
  readonly host?: Partial<SyncHost>;
  /** Frame decoder; the kernel binds the Valibot `S2CFrame` schema (TODO(protocol) below). */
  readonly decode?: FrameDecoder;
  /** OS time zone for local conflicted-copy dates. */
  readonly timeZone?: string;
  /** `navigator.onLine` at start. */
  readonly online?: boolean;
  /** Most deferred remote changes kept in memory before falling back to a directory re-fetch. */
  readonly deferredMax?: number;
}

type ByeReason = S2CFrame<'bye'>['body']['reason'];
type UpBye = C2SFrame<'bye'>['body']['reason'];

const S2C = new Set<string>(S2C_TYPES);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Structural decoder: `{v: 1, t, id, body}` with a known `t` and an object body.
 * TODO(protocol): replace with `v.safeParse(S2CFrame, …)` through a protocol-exported parser
 * (vfs cannot import valibot); the kernel injects that decoder through `SyncdOptions.decode`.
 */
export function decodeFrame(raw: string): S2CFrame | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(v) ||
    v.v !== 1 ||
    typeof v.t !== 'string' ||
    !S2C.has(v.t) ||
    typeof v.id !== 'number' ||
    !isRecord(v.body)
  )
    return null;
  return v as unknown as S2CFrame;
}

interface Waiter {
  readonly resolve: (o: WaitOutcome) => void;
  readonly timer: Timer;
}

interface ServerTimers {
  hbMs: number;
  deadManMs: number;
  leaseTtlMs: number;
}

/** The Lamport value to merge, or none. */
const lamportOf = (n: number | undefined): number | null => (n === undefined || n <= 0 ? null : n);

export class Syncd implements ControlChannel {
  private readonly session: SyncSession;
  private readonly storage: SyncStorage;
  private readonly socketFactory: SocketFactory;
  private readonly http: SyncHttp;
  private readonly clock: Clock;
  private readonly rnd: Rng;
  private readonly host: Partial<SyncHost>;
  private readonly decode: FrameDecoder;
  private readonly timeZone: string;
  private readonly deferredMax: number;

  private st: SyncState = 'IDLE';
  private online: boolean;
  private readonly queue = new OutboxQueue();
  private readonly feed: FeedTracker;
  private readonly lamport = new Lamport();
  private locks: LockSyncClient | null = null;

  // Connection
  private socket: SocketLike | null = null;
  private gen = 0;
  private opened = false;
  private outId = 0;
  private auth: HelloOkBody['auth'] | null = null;
  private creditWindow = CREDIT_WINDOW;
  private timers: ServerTimers = {
    hbMs: hbOf(LEASE_TTL_MS),
    deadManMs: DEAD_MAN_MS,
    leaseTtlMs: LEASE_TTL_MS,
  };
  private serverBuild: string | null = null;
  private readonly awaiting = new Set<number>();
  private readonly inflight = new Set<string>();
  private httpInflight: string | null = null;
  private lastFrameAt = 0;
  private lastAckAt: number | null = null;

  // Back-off and close handling
  private failures = 0;
  private closeCode: number | null = null;
  private retryAfterMs = 0;
  private bye: ByeReason | null = null;
  private upgradeRequired = false;
  private backoffAt: number | null = null;

  // Timers
  private backoffTimer: Timer | null = null;
  private helloTimer: Timer | null = null;
  private deadMan: Timer | null = null;
  private hbTimer: Timer | null = null;
  private probeTimer: Timer | null = null;
  private pauseTimer: Timer | null = null;
  private pausedUntil = 0;

  // Blobs
  private readonly blobState = new Map<string, 'ready' | 'uploading'>();
  private readonly uploadQueue: string[] = [];
  private activeUploads = 0;
  private uploadFailures = 0;

  // Work
  private serial: Promise<void> = Promise.resolve();
  private pumping = false;
  private pumpAgain = false;
  private kickQueued = false;
  private readonly waiters = new Map<string, Waiter[]>();
  private deferred: Change[] = [];
  private readonly refetchInos = new Set<string>();
  private lastStatus: NetStatus | null = null;
  private lastLabel = '';
  private closingDone: (() => void) | null = null;

  constructor(opts: SyncdOptions) {
    this.session = opts.session;
    this.storage = opts.storage;
    this.socketFactory = opts.socket;
    this.http = opts.http;
    this.clock = opts.clock ?? systemClock;
    this.rnd = opts.random ?? Math.random;
    this.host = opts.host ?? {};
    this.decode = opts.decode ?? decodeFrame;
    this.timeZone = opts.timeZone ?? 'UTC';
    this.online = opts.online ?? true;
    this.deferredMax = opts.deferredMax ?? 10_000;
    this.feed = new FeedTracker(this.clock, {
      onGap: (ownerUid, fromSeq) =>
        this.sendControl('resume', { cursors: [{ ownerUid, fromSeq }] }),
      onAck: (cursors) => this.sendControl('ack', { cursors }),
    });
  }

  // -- public API --------------------------------------------------------------------------------

  get state(): SyncState {
    return this.st;
  }

  /** Service start (boot stage, non-critical, C17): loads local state; no network I/O. */
  async start(): Promise<void> {
    const [recs, cursors, lamport] = await Promise.all([
      this.storage.loadOutbox(),
      this.storage.loadCursors(),
      this.storage.loadLamport(),
    ]);
    this.queue.load(recs);
    this.lamport.observe(lamport);
    for (const [owner, seq] of cursors) this.feed.mirror(owner, seq);
    for (const owner of [this.session.loginUid, 0])
      if (!this.feed.isMirrored(owner)) this.feed.mirror(owner, 0);
    this.publish();
  }

  /** First CONNECTING, after desktop-interactive (§3.7 rule 9). */
  connect(): void {
    this.go({ type: 'connect', online: this.online });
  }

  attachLocks(client: LockSyncClient): void {
    this.locks = client;
  }

  /** New local commits exist (the VFS calls this after `oncomplete`); also ends reservations. */
  kick(): void {
    if (this.kickQueued) return;
    this.kickQueued = true;
    void this.enqueue(async () => {
      this.kickQueued = false;
      const recs = await this.storage.loadOutbox();
      this.queue.load(recs);
      for (const e of this.queue.all()) e.reserved = false;
      this.publish();
      this.pump();
      this.checkLive();
    });
  }

  /**
   * The VFS wants to coalesce a new write into this still-unsent record (VFS §3.14.2). True when
   * the record is not in flight; it then stays unsent until the next `kick()`.
   */
  reserve(opId: string): boolean {
    const e = this.queue.get(opId);
    if (e === undefined || e.sent || e.locked) return false;
    e.reserved = true;
    return true;
  }

  /** Platform events forwarded by the router (SYN-15). */
  setOnline(online: boolean): void {
    this.online = online;
    this.go({ type: online ? 'online' : 'offline' });
  }

  /** `visibilitychange` to visible, or Page Lifecycle `resume` (§3.14.7). */
  onVisible(): void {
    if (this.st === 'BACKOFF' || this.st === 'OFFLINE') {
      if (!this.upgradeRequired) this.go({ type: 'visible' });
      return;
    }
    if (isSyncing(this.st) && this.clock.mono() - this.lastFrameAt > 2 * this.timers.hbMs) {
      // Nothing arrived for more than 2 × HB_MS: reconnect at once.
      this.closeCode = null;
      this.go({ type: 'timeout' });
      this.backoffTimer?.cancel();
      this.go({ type: 'timer' });
    }
  }

  /** The user signed in again after AUTH_REQUIRED (§3.7 rule 6). */
  signedIn(): void {
    this.go({ type: 'signed-in' });
  }

  /** A new or ended `su` grant (§3.8.6): held ops of that principal become sendable again. */
  setSuGrants(grants: readonly { uid: number; expiresAt: string }[]): void {
    if (this.auth === null) return;
    this.auth = {
      ...this.auth,
      suGrants: grants.slice(0, 4).map((g) => ({ uid: g.uid, expiresAt: g.expiresAt })),
    };
    this.queue.clearHolds('principal-auth');
    this.publish();
    this.pump();
  }

  /** Start mirroring an owner whose directory was just loaded from a snapshot at `headSeq`. */
  mirrorOwner(ownerUid: number, headSeq: number): void {
    if (this.feed.isMirrored(ownerUid)) return;
    this.feed.mirror(ownerUid, headSeq);
    void this.enqueue(() => this.storage.writeMeta(this.tx([{ ownerUid, seq: headSeq }])));
    if (isSyncing(this.st))
      this.sendControl('resume', { cursors: [{ ownerUid, fromSeq: headSeq }] });
  }

  /**
   * Wait for the server's result of `opId` (§3.13): only while RESUMING or LIVE, at most
   * `timeoutMs`; `retry` keeps waiting; leaving RESUMING/LIVE answers `pending`.
   */
  async waitFor(opId: string, timeoutMs: number = SYNC_WAIT_MS): Promise<WaitOutcome> {
    // The kernel calls kick() right after the commit: let that load land first. The op cannot have
    // been sent (so no result can be queued) before it is loaded.
    await this.serial;
    if (!isSyncing(this.st) || this.queue.get(opId) === undefined) return { sync: 'pending' };
    return new Promise((resolve) => {
      const w: Waiter = {
        resolve,
        timer: this.clock.after(timeoutMs, () => {
          this.dropWaiter(opId, w);
          resolve({ sync: 'pending' });
        }),
      };
      const list = this.waiters.get(opId) ?? [];
      list.push(w);
      this.waiters.set(opId, list);
    });
  }

  /**
   * The process waiting on `opId` was killed (§3.13.3, AGT-09). A record that may have reached the
   * server gets `proc.signal` (now, or right after its next send); one that never left is reverted
   * locally with its dependants and nothing reaches the server.
   */
  cancelOp(opId: string, sig: 'SIGINT' | 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    const e = this.queue.get(opId);
    if (e === undefined) return Promise.resolve();
    if (e.sent || e.everSent) {
      e.cancel = true;
      if (e.sent) this.sendControl('proc.signal', { target: { kind: 'op', opId }, sig });
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      const cur = this.queue.get(opId);
      if (cur === undefined || cur.sent || cur.everSent) return;
      const members = this.closureMembers(cur.rec);
      this.lockEntries([cur, ...members.map((m) => this.queue.get(m.rec.opId))]);
      try {
        const eff = await this.storage.applyResult({
          kind: 'cancel',
          rec: cur.rec,
          members,
          ctx: this.tx(),
        });
        this.afterResult('revert', opId, eff);
        this.resolveWaiters(opId, { sync: 'rejected', errno: 'ECANCELED', reason: 'killed' });
      } finally {
        this.unlockAll();
      }
    });
  }

  /** Settings → Storage "Discard" of a parked op (audited by the caller, VFS §3.14.4). */
  discardParked(opId: string): Promise<void> {
    return this.enqueue(async () => {
      const e = this.queue.get(opId);
      if (e?.rec.state !== 'parked') return;
      await this.storage.discardParked(e.rec, this.clock.now());
      this.queue.remove(opId);
      this.publish();
    });
  }

  /** Graceful stop (§3.7 rule 8; BOOT-12): wait ≤ 2 s for in-flight results, `bye`, close 1000. */
  async shutdown(reason: UpBye = 'shutdown'): Promise<void> {
    if (!isConnected(this.st)) {
      this.go({ type: 'shutdown' });
      return;
    }
    const socket = this.socket;
    this.go({ type: 'shutdown' });
    if (this.inflight.size > 0 || this.httpInflight !== null) {
      await new Promise<void>((resolve) => {
        const t = this.clock.after(2_000, () => {
          this.closingDone = null;
          resolve();
        });
        this.closingDone = () => {
          t.cancel();
          this.closingDone = null;
          resolve();
        };
      });
    }
    if (socket !== null) {
      this.sendFrame(socket, 'bye', { reason });
      socket.close(CLOSE_CODES.NORMAL.code, reason);
    }
    this.go({ type: 'closed' });
  }

  /** The current `NetStatus` (the `net.status` syscall) and its label. */
  status(): { status: NetStatus | null; label: string } {
    const input = this.statusInput();
    return { status: netStatusOf(input), label: statusLabel(input) };
  }

  /** Counts for `sync status` and Settings → Storage. */
  outbox(): ReturnType<OutboxQueue['summary']> {
    return this.queue.summary();
  }

  /** Records in commit order (read-only view for `sync status`). */
  records(): readonly OutboxRec[] {
    return this.queue.all().map((e) => e.rec);
  }

  /** Resolves when every queued storage task has run (tests and shutdown). */
  idle(): Promise<void> {
    return this.serial;
  }

  // -- ControlChannel (lockd) ---------------------------------------------------------------------

  sendControl<T extends Exclude<C2SType, 'op.submit' | 'op.batch'>>(
    t: T,
    body: C2SFrame<T>['body'],
  ): boolean {
    if (this.socket === null || !isSyncing(this.st)) return false;
    return this.sendFrame(this.socket, t, body);
  }

  heartbeatNow(): void {
    if (this.socket !== null && isSyncing(this.st)) this.sendHb();
  }

  /** Whether the server layer of lockd is usable (syncd LIVE, §3.14.7). */
  get serverAvailable(): boolean {
    return this.st === 'LIVE';
  }

  // -- state machine -------------------------------------------------------------------------------

  private go(e: SyncEvent): void {
    const prev = this.st;
    const next = transition(prev, e);
    if (next === prev) return;
    this.exit(prev, next);
    this.st = next;
    this.enter(next);
    this.publish();
  }

  private exit(prev: SyncState, next: SyncState): void {
    if (prev === 'LIVE') this.locks?.onServerAvailable(false);
    if (prev === 'BACKOFF') {
      this.backoffTimer?.cancel();
      this.backoffTimer = null;
      this.backoffAt = null;
    }
    if (prev === 'OFFLINE') {
      this.probeTimer?.cancel();
      this.probeTimer = null;
    }
    const wasOpen = prev === 'CONNECTING' || isConnected(prev);
    const staysOpen = next === 'HANDSHAKING' || isConnected(next) || next === 'CLOSING';
    if (wasOpen && !staysOpen) this.dropConnection();
    if (isSyncing(prev) && !isSyncing(next)) {
      // §3.13.2: leaving RESUMING/LIVE answers every waiting caller with `pending`.
      for (const opId of [...this.waiters.keys()]) this.resolveWaiters(opId, { sync: 'pending' });
    }
  }

  private enter(s: SyncState): void {
    switch (s) {
      case 'CONNECTING':
        this.openSocket();
        break;
      case 'HANDSHAKING':
        this.helloTimer = this.clock.after(HELLO_TIMEOUT_MS, () => this.onTimeout());
        void this.sendHello(this.gen);
        break;
      case 'LIVE':
        this.locks?.onServerAvailable(true);
        this.runRefetch();
        break;
      case 'BACKOFF':
        this.scheduleBackoff();
        break;
      case 'OFFLINE':
        this.scheduleProbe();
        break;
      case 'SUPERSEDED':
        // A newer kernel epoch of this device took over (§3.7 rule 7): never reconnect.
        this.stopAll();
        this.host.notice?.({ type: 'superseded' });
        break;
      case 'CLOSED':
        this.stopAll();
        break;
      case 'IDLE':
      case 'RESUMING':
      case 'AUTH_REQUIRED':
      case 'CLOSING':
        break;
    }
  }

  private openSocket(): void {
    const gen = ++this.gen;
    this.opened = false;
    this.outId = 0;
    this.bye = null;
    this.socket = this.socketFactory(this.session.url, {
      onOpen: () => {
        if (gen !== this.gen) return;
        this.opened = true;
        this.lastFrameAt = this.clock.mono();
        this.go({ type: 'open' });
      },
      onMessage: (data) => {
        if (gen === this.gen) this.onMessage(data);
      },
      onClose: (code) => {
        if (gen === this.gen) this.onClose(code);
      },
    });
  }

  /** Forget the socket of this generation (its late events are ignored). */
  private dropConnection(): void {
    const s = this.socket;
    this.socket = null;
    this.gen++;
    for (const t of [this.helloTimer, this.deadMan, this.hbTimer]) t?.cancel();
    this.helloTimer = null;
    this.deadMan = null;
    this.hbTimer = null;
    this.queue.resetSent();
    this.inflight.clear();
    this.feed.pause();
    this.awaiting.clear();
    try {
      s?.close(4000, 'client-reset');
    } catch {
      // already closing
    }
  }

  private stopAll(): void {
    this.socket = null;
    for (const t of [
      this.backoffTimer,
      this.probeTimer,
      this.pauseTimer,
      this.helloTimer,
      this.deadMan,
      this.hbTimer,
    ])
      t?.cancel();
    this.backoffTimer = null;
    this.probeTimer = null;
    this.pauseTimer = null;
    this.feed.pause();
    for (const opId of [...this.waiters.keys()]) this.resolveWaiters(opId, { sync: 'pending' });
  }

  private onClose(code: number): void {
    const opened = this.opened;
    this.socket = null;
    if (this.st === 'CLOSING') {
      this.go({ type: 'close', code, beforeOpen: false });
      return;
    }
    this.closeCode = code;
    if (this.bye === 'upgrade-required') {
      // §3.16.3 rule 4: stay offline-capable, ask for a restart; no reconnect loop.
      this.upgradeRequired = true;
      this.go({ type: 'offline' });
      return;
    }
    if (!opened && this.st === 'CONNECTING') {
      // §3.7 rule 5: a failed upgrade reports 1006 only; ask /api/auth/me once.
      const gen = this.gen;
      void this.http.authMe().then(
        (status) => {
          if (gen === this.gen && this.st === 'CONNECTING')
            this.go({ type: 'close', code, beforeOpen: true, unauthorised: status === 401 });
        },
        () => {
          if (gen === this.gen && this.st === 'CONNECTING')
            this.go({ type: 'close', code, beforeOpen: true });
        },
      );
      return;
    }
    this.go({ type: 'close', code, beforeOpen: !opened });
  }

  private onTimeout(): void {
    this.closeCode = null;
    this.go({ type: 'timeout' });
  }

  private scheduleBackoff(): void {
    const code = this.closeCode;
    if (code === CLOSE_CODES.SERVICE_RESTART.code) this.failures = 0;
    const delay = nextDelayMs(
      this.failures,
      code,
      code === CLOSE_CODES.RATE_LIMITED.code || this.retryAfterMs > 0 ? this.retryAfterMs : 0,
      this.rnd,
    );
    this.failures++;
    this.retryAfterMs = 0;
    this.closeCode = null;
    this.backoffAt = this.clock.now() + delay;
    this.backoffTimer = this.clock.after(delay, () => {
      this.backoffTimer = null;
      this.go({ type: 'timer' });
    });
  }

  private scheduleProbe(): void {
    if (this.upgradeRequired) return;
    this.probeTimer = this.clock.after(PROBE_MS, () => {
      this.probeTimer = null;
      void this.http.healthz().then(
        (ok) => {
          if (this.st !== 'OFFLINE') return;
          if (ok) this.go({ type: 'probe-ok' });
          else this.scheduleProbe();
        },
        () => {
          if (this.st === 'OFFLINE') this.scheduleProbe();
        },
      );
    });
  }

  // -- frames out ---------------------------------------------------------------------------------

  private sendFrame<T extends C2SType>(
    socket: SocketLike,
    t: T,
    body: C2SFrame<T>['body'],
  ): boolean {
    const frame = { v: 1, t, id: ++this.outId, body };
    const text = JSON.stringify(frame);
    if (new TextEncoder().encode(text).length > MAX_PAYLOAD) {
      this.host.notice?.({
        type: 'protocol-error',
        code: 'limit',
        msg: `refused to send an oversized ${t} frame`,
      });
      return false;
    }
    try {
      socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  private async sendHello(gen: number): Promise<void> {
    let lamport = this.lamport.value;
    try {
      lamport = this.lamport.observe(await this.storage.loadLamport());
    } catch {
      // keep the in-memory value
    }
    const socket = this.socket;
    if (gen !== this.gen || this.st !== 'HANDSHAKING' || socket === null) return;
    const sum = this.queue.summary();
    this.sendFrame(socket, 'hello', {
      proto: PROTO,
      build: this.session.build,
      osSessionId: this.session.osSessionId,
      deviceId: this.session.deviceId,
      kernelEpoch: this.session.kernelEpoch,
      lamport,
      outbox: { pending: sum.pending + sum.inflight, held: sum.held + sum.parked },
      heldLeases: (this.locks?.heldLeases() ?? []).slice(0, 256),
      resume: this.feed.resumeCursors(),
    });
  }

  private sendHb(): void {
    const socket = this.socket;
    if (socket === null) return;
    this.sendFrame(socket, 'hb', {
      t: Math.max(0, Math.floor(this.clock.mono())),
      leases: (this.locks?.heartbeatLeases() ?? []).slice(0, 256),
      lamport: this.lamport.value,
    });
  }

  private armHeartbeat(): void {
    this.hbTimer?.cancel();
    this.hbTimer = this.clock.after(this.timers.hbMs, () => {
      this.hbTimer = null;
      if (!isSyncing(this.st)) return;
      this.sendHb();
      this.armHeartbeat();
    });
  }

  private armDeadMan(): void {
    this.deadMan?.cancel();
    this.deadMan = this.clock.after(this.timers.deadManMs, () => {
      this.deadMan = null;
      if (isConnected(this.st)) this.onTimeout();
    });
  }

  // -- frames in ----------------------------------------------------------------------------------

  private onMessage(raw: string): void {
    this.lastFrameAt = this.clock.mono();
    if (isConnected(this.st) && this.st !== 'HANDSHAKING') this.armDeadMan();
    const frame = this.decode(raw);
    if (frame === null) {
      this.host.notice?.({
        type: 'protocol-error',
        code: 'bad-frame',
        msg: 'undecodable server frame',
      });
      return;
    }
    switch (frame.t) {
      case 'hello.ok':
        if (this.st === 'HANDSHAKING') this.onHelloOk(frame.body);
        return;
      case 'op.result':
        this.returnCredit(frame.body.opId);
        void this.enqueue(() => this.onResult(frame.body));
        return;
      case 'vfs.changed':
        void this.enqueue(() => this.onChanged(frame.body));
        return;
      case 'resume.done': {
        const { ownerUid } = frame.body;
        void this.enqueue(() => {
          this.awaiting.delete(ownerUid);
          this.checkLive();
          return Promise.resolve();
        });
        return;
      }
      case 'snapshot.required':
        void this.enqueue(() => this.onSnapshotRequired(frame.body));
        return;
      case 'lock.granted':
      case 'lock.queued':
      case 'lock.denied':
      case 'lock.released':
      case 'lock.expired':
        this.locks?.onLockFrame(frame);
        return;
      case 'hb.ack': {
        const now = this.clock.mono();
        this.locks?.onHbAck(frame.body, this.clock.now(), Math.max(0, now - frame.body.t));
        return;
      }
      case 'proc.signal': {
        const { uid } = frame.body.target;
        if (this.auth !== null)
          this.auth = { ...this.auth, suGrants: this.auth.suGrants.filter((g) => g.uid !== uid) };
        this.host.notice?.({ type: 'su-ended', uid, reason: frame.body.reason });
        this.publish();
        return;
      }
      case 'throttle':
        this.retryAfterMs = frame.body.retryAfterMs;
        if (frame.body.scope !== 'locks') this.pauseFor(frame.body.retryAfterMs);
        return;
      case 'error':
        this.host.notice?.({
          type: 'protocol-error',
          code: frame.body.code,
          msg: frame.body.msg,
          ...(frame.body.refId === undefined ? {} : { refId: frame.body.refId }),
        });
        return;
      case 'bye':
        this.bye = frame.body.reason;
        if (frame.body.retryAfterMs !== undefined) this.retryAfterMs = frame.body.retryAfterMs;
        return;
    }
  }

  private onHelloOk(ok: HelloOkBody): void {
    this.helloTimer?.cancel();
    this.helloTimer = null;
    this.failures = 0;
    this.auth = ok.auth;
    this.creditWindow = ok.limits.creditWindow;
    this.timers = {
      hbMs: ok.timers.hbMs,
      deadManMs: ok.timers.deadManMs,
      leaseTtlMs: ok.timers.leaseTtlMs,
    };
    this.lamport.observe(ok.lamport);
    const build = ok.server.build;
    if (build !== this.serverBuild) {
      this.host.notice?.({
        type: 'server-build',
        build,
        differs: build !== this.session.build.build,
      });
      this.serverBuild = build;
    }
    this.awaiting.clear();
    for (const o of ok.owners) if (this.feed.isMirrored(o.ownerUid)) this.awaiting.add(o.ownerUid);
    this.queue.clearHolds('principal-auth');
    this.go({ type: 'hello.ok' });
    this.locks?.onHelloOk(ok, this.clock.now());
    this.armDeadMan();
    this.armHeartbeat();
    void this.enqueue(() => this.storage.writeMeta(this.tx([], ok.lamport)));
    this.pump();
    this.checkLive();
  }

  private returnCredit(opId: string): void {
    this.inflight.delete(opId);
    if (this.st === 'CLOSING' && this.inflight.size === 0 && this.httpInflight === null)
      this.closingDone?.();
  }

  // -- results ------------------------------------------------------------------------------------

  private tx(cursors: readonly FeedCursor[] = [], lamport: number | null = null): TxContext {
    return { now: this.clock.now(), timeZone: this.timeZone, cursors, lamport };
  }

  private closureMembers(k: OutboxRec): ClosureMember[] {
    const later = closureOf(
      k,
      this.queue.all().map((e) => e.rec),
    );
    return later.map((rec) => {
      const e = this.queue.get(rec.opId);
      return { rec, everSent: e === undefined ? rec.attempts > 0 : e.sent || e.everSent };
    });
  }

  private lockEntries(entries: readonly (QueueEntry | undefined)[]): void {
    for (const e of entries) if (e !== undefined) e.locked = true;
  }

  private unlockAll(): void {
    for (const e of this.queue.all()) e.locked = false;
  }

  private async onResult(r: OpResultBody): Promise<void> {
    this.lamport.observe(r.lamport);
    const e = this.queue.get(r.opId);
    if (e === undefined) return; // already processed (§6: ignored)
    if (r.status === 'retry') {
      this.onRetry(e, r);
      return;
    }
    // Final result: the record must not be sent again while its transaction runs.
    e.locked = true;
    const rec = e.rec;
    const ownerSeqs = r.ownerSeqs ?? [];
    const planned = this.feed.planOwn(ownerSeqs);
    const ctx = this.tx(planned, lamportOf(r.lamport));
    let req: ResultRequest;
    let kind: SyncEffect['kind'];
    if (rec.state === 'reverted') {
      req = { kind: 'reverted', rec, result: r, ctx };
      kind = r.status === 'rejected' ? 'revert' : 'ack';
    } else if (r.status === 'applied' || (r.status === 'conflict' && r.keptAs === undefined)) {
      req = { kind: 'ack', rec, result: r, ctx };
      kind = 'ack';
    } else if (r.status === 'conflict' && r.keptAs !== undefined) {
      req = { kind: 'conflict', rec, result: r, keptAs: r.keptAs, ctx };
      kind = 'conflict';
    } else {
      const members = this.closureMembers(rec);
      this.lockEntries(members.map((m) => this.queue.get(m.rec.opId)));
      req = { kind: 'reject', rec, result: r, members, ctx };
      kind = 'revert';
    }
    let eff: ResultEffect;
    try {
      eff = await this.storage.applyResult(req);
    } catch (err) {
      // The transaction failed (nothing changed): resend later; the server answers from op_log.
      e.sent = false;
      this.pauseFor(fullJitter(1, this.rnd));
      throw err;
    } finally {
      this.unlockAll();
    }
    this.feed.commitOwn(ownerSeqs, planned);
    this.lastAckAt = this.clock.now();
    this.afterResult(eff.parked ? 'park' : kind, r.opId, eff);
    this.notifyResult(req, r, eff);
    await this.drainFeed();
    await this.reapplyDeferred();
    this.pump();
    this.checkLive();
  }

  private afterResult(kind: SyncEffect['kind'], opId: string, eff: ResultEffect): void {
    for (const id of eff.deleted) this.queue.remove(id);
    for (const rec of eff.rewritten) this.queue.update(rec);
    if (eff.writes.length > 0) this.host.applied?.({ kind, opId, writes: eff.writes });
    if (eff.refetch.length > 0) this.scheduleRefetch(eff.refetch, kind);
    this.publish();
  }

  private notifyResult(req: ResultRequest, r: OpResultBody, eff: ResultEffect): void {
    const keptAs: SyncKeptAs | undefined = r.keptAs;
    if (req.kind === 'conflict' && keptAs !== undefined) {
      const ino = req.rec.op.kind === 'write' ? req.rec.op.ino : keptAs.ino;
      this.host.notice?.({
        type: 'conflict',
        opId: r.opId,
        ino,
        keptAs,
        ...(r.errno === undefined ? {} : { errno: r.errno }),
        ...(r.reason === undefined ? {} : { reason: r.reason }),
      });
      this.resolveWaiters(r.opId, { sync: 'applied', conflict: { keptAs } });
      return;
    }
    if (req.kind === 'reject' || (req.kind === 'reverted' && r.status === 'rejected')) {
      const errno = r.errno ?? 'EIO';
      const cascade = req.kind === 'reject' ? req.members.map((m) => m.rec.opId) : [];
      const notice: SyncNotice = {
        type: 'rejected',
        opId: r.opId,
        errno,
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        ...(keptAs === undefined ? {} : { keptAs }),
        parked: eff.parked,
        cascade,
      };
      this.host.notice?.(notice);
      this.resolveWaiters(r.opId, {
        sync: 'rejected',
        errno,
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        ...(keptAs === undefined ? {} : { keptAs }),
      });
      for (const id of cascade) {
        if (eff.deleted.includes(id))
          this.resolveWaiters(id, { sync: 'rejected', errno, reason: 'cascade' });
      }
      return;
    }
    this.resolveWaiters(r.opId, { sync: 'applied' });
  }

  /** `retry` (§3.9 step 6, §3.10): back to pending, resend after max(retryAfterMs, fullJitter). */
  private onRetry(e: QueueEntry, r: OpResultBody): void {
    e.sent = false;
    if (r.errno === 'EACCES' && r.reason === 'principal') {
      e.held = 'principal-auth';
      if (this.auth !== null)
        this.auth = {
          ...this.auth,
          suGrants: this.auth.suGrants.filter((g) => g.uid !== e.rec.principal),
        };
    } else if (r.errno === 'EAGAIN' && r.reason === 'blob-missing') {
      for (const sha of e.rec.blobs) {
        this.blobState.delete(sha);
        void this.storage.setUploaded(sha, false).catch(() => undefined);
      }
    }
    const delay = Math.max(r.retryAfterMs ?? 0, fullJitter(e.rec.attempts, this.rnd));
    this.pauseFor(delay);
    this.publish();
  }

  private pauseFor(ms: number): void {
    const until = this.clock.mono() + ms;
    if (until <= this.pausedUntil) return;
    this.pausedUntil = until;
    this.pauseTimer?.cancel();
    this.pauseTimer = this.clock.after(ms, () => {
      this.pauseTimer = null;
      this.pump();
    });
  }

  private resolveWaiters(opId: string, outcome: WaitOutcome): void {
    const list = this.waiters.get(opId);
    if (list === undefined) return;
    this.waiters.delete(opId);
    for (const w of list) {
      w.timer.cancel();
      w.resolve(outcome);
    }
  }

  private dropWaiter(opId: string, w: Waiter): void {
    const list = this.waiters.get(opId);
    if (list === undefined) return;
    const rest = list.filter((x) => x !== w);
    if (rest.length === 0) this.waiters.delete(opId);
    else this.waiters.set(opId, rest);
  }

  // -- sending ------------------------------------------------------------------------------------

  private allowed(principal: number): boolean {
    const a = this.auth;
    if (a === null) return false;
    if (principal === a.uid) return true;
    const now = this.clock.now();
    return a.suGrants.some((g) => g.uid === principal && Date.parse(g.expiresAt) > now);
  }

  private blobReadiness(sha: string): BlobReadiness {
    const s = this.blobState.get(sha);
    return s === 'ready' ? 'ready' : s === 'uploading' ? 'uploading' : 'unknown';
  }

  /** Run the send loop (non-reentrant). */
  private pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    void (async () => {
      try {
        do {
          this.pumpAgain = false;
          await this.pumpOnce();
        } while (this.pumpAgain);
      } finally {
        this.pumping = false;
      }
    })();
  }

  private async pumpOnce(): Promise<void> {
    const socket = this.socket;
    if (socket === null || !isSyncing(this.st)) return;
    if (this.clock.mono() < this.pausedUntil) return;
    const gen = this.gen;
    const plan = planSend(this.queue, {
      credit: this.creditWindow - this.inflight.size,
      inflight: this.inflight.size + (this.httpInflight === null ? 0 : 1),
      httpBusy: this.httpInflight !== null,
      allowed: (p) => this.allowed(p),
      blob: (sha) => this.blobReadiness(sha),
    });
    for (const h of plan.holds) h.entry.held = h.reason;
    for (const sha of plan.upload) this.startUpload(sha);
    if (plan.holds.length > 0) this.publish();
    if (plan.http !== null) {
      await this.sendHttp(plan.http);
      return;
    }
    if (plan.frame.length === 0) {
      this.checkLive();
      return;
    }
    for (const e of plan.frame) {
      e.sent = true;
      e.held = null;
      this.inflight.add(e.rec.opId);
    }
    let updated: OutboxRec[];
    try {
      updated = await this.storage.noteSent(plan.frame.map((e) => e.rec));
    } catch {
      for (const e of plan.frame) {
        e.sent = false;
        this.inflight.delete(e.rec.opId);
      }
      this.pauseFor(fullJitter(1, this.rnd));
      return;
    }
    if (gen !== this.gen || this.socket !== socket || !isSyncing(this.st)) {
      for (const e of plan.frame) e.sent = false;
      return;
    }
    plan.frame.forEach((e, i) => {
      const u = updated[i];
      if (u !== undefined) e.rec = u;
      e.everSent = true;
    });
    const ops = plan.frame.map((e) => toSubmit(e.rec));
    const [first] = ops;
    const sent =
      ops.length === 1 && first !== undefined
        ? this.sendFrame(socket, 'op.submit', first)
        : this.sendFrame(socket, 'op.batch', { ops });
    if (!sent) {
      for (const e of plan.frame) {
        e.sent = false;
        this.inflight.delete(e.rec.opId);
      }
      return;
    }
    for (const e of plan.frame) {
      if (e.cancel)
        this.sendFrame(socket, 'proc.signal', {
          target: { kind: 'op', opId: e.rec.opId },
          sig: 'SIGTERM',
        });
    }
    this.publish();
    this.pumpAgain = true;
  }

  /** An op over OP_ENVELOPE_MAX: `POST /api/ops/{opId}` at the head of an empty window (§3.4). */
  private async sendHttp(e: QueueEntry): Promise<void> {
    const opId = e.rec.opId;
    this.httpInflight = opId;
    e.sent = true;
    e.held = null;
    try {
      const [u] = await this.storage.noteSent([e.rec]);
      if (u !== undefined) e.rec = u;
      e.everSent = true;
      const result = await this.http.postOp(opId, JSON.stringify(toSubmit(e.rec)));
      this.httpInflight = null;
      void this.enqueue(() => this.onResult(result));
    } catch (err) {
      this.httpInflight = null;
      e.sent = false;
      // §6: a POST that fails in transit keeps the record at the head; resend later (dedup by opId).
      this.pauseFor(fullJitter(Math.max(1, e.rec.attempts), this.rnd));
      if (!(err instanceof HttpUnavailable))
        this.host.notice?.({
          type: 'protocol-error',
          code: 'limit',
          msg: `POST /api/ops failed for ${opId}`,
        });
    } finally {
      if (this.st === 'CLOSING' && this.inflight.size === 0) this.closingDone?.();
      this.pump();
    }
  }

  // -- blobs --------------------------------------------------------------------------------------

  private startUpload(sha: string): void {
    if (this.blobState.has(sha)) return;
    this.blobState.set(sha, 'uploading');
    this.uploadQueue.push(sha);
    this.drainUploads();
  }

  /** At most 2 uploads at a time (§3.9 step 1). */
  private drainUploads(): void {
    while (this.activeUploads < 2 && this.uploadQueue.length > 0) {
      const sha = this.uploadQueue.shift();
      if (sha === undefined) break;
      this.activeUploads++;
      void (async () => {
        try {
          if (!(await this.storage.blobUploaded(sha))) {
            await this.http.putBlob(sha);
            await this.storage.setUploaded(sha, true);
          }
          this.blobState.set(sha, 'ready');
          this.uploadFailures = 0;
        } catch {
          this.blobState.delete(sha);
          this.uploadFailures++;
          this.pauseFor(fullJitter(this.uploadFailures, this.rnd));
        } finally {
          this.activeUploads--;
          this.drainUploads();
          this.pump();
        }
      })();
    }
  }

  // -- feed ---------------------------------------------------------------------------------------

  /** Inodes and directories local ops still own (remote apply skips them, VFS §3.17.1). */
  private touched(): Set<string> {
    const out = new Set<string>();
    for (const e of this.queue.all()) for (const x of e.rec.touches) out.add(x);
    return out;
  }

  private mirroredOwners(): Set<number> {
    return new Set(this.feed.owners());
  }

  private async onChanged(entry: VfsChangedBody): Promise<void> {
    this.lamport.observe(entry.lamport);
    const offer = this.feed.offer(entry);
    if (offer === 'stale' || offer === 'buffered') return;
    if (offer === 'unmirrored') {
      // §6: applied if the inodes are local, otherwise ignored; no cursor.
      if (!entry.redacted && entry.changes.length > 0)
        await this.applyChanges(
          entry.changes,
          this.tx([], lamportOf(entry.lamport)),
          'remote',
          entry.opId,
        );
      return;
    }
    await this.drainFeed();
  }

  /** Apply every entry that is next in line, one transaction each (INV-S5). */
  private async drainFeed(): Promise<void> {
    for (;;) {
      let progressed = false;
      for (const owner of this.feed.ready()) {
        const next = this.feed.nextEntry(owner);
        if (next === null) continue;
        const { entry, cursorAfter } = next;
        const changes = entry.redacted ? [] : entry.changes;
        await this.applyChanges(
          changes,
          this.tx([{ ownerUid: owner, seq: cursorAfter }], lamportOf(entry.lamport)),
          'remote',
          entry.opId,
        );
        this.feed.advance(owner, cursorAfter);
        if (entry.refetch !== undefined) this.scheduleRefetch(entry.refetch.dirs, 'remote');
        progressed = true;
      }
      if (!progressed) return;
    }
  }

  private async applyChanges(
    changes: readonly Change[],
    ctx: TxContext,
    kind: SyncEffect['kind'],
    opId?: string,
    completeDir?: (row: { ino: string; uid: number; type: string }) => boolean,
  ): Promise<RemoteEffect> {
    const eff = await this.storage.applyChanges(
      changes,
      {
        touched: this.touched(),
        mirroredOwners: this.mirroredOwners(),
        ...(completeDir === undefined ? {} : { completeDir }),
      },
      ctx,
    );
    if (eff.writes.length > 0)
      this.host.applied?.({ kind, ...(opId === undefined ? {} : { opId }), writes: eff.writes });
    this.defer(eff.deferred);
    if (eff.refetch.length > 0) this.scheduleRefetch(eff.refetch, 'remote');
    return eff;
  }

  private defer(changes: readonly Change[]): void {
    if (changes.length === 0) return;
    this.deferred.push(...changes);
    if (this.deferred.length > this.deferredMax) {
      const dropped = this.deferred.splice(0, this.deferred.length - this.deferredMax);
      const dirs = new Set<string>();
      for (const c of dropped) {
        if (c.parentIno !== undefined) dirs.add(c.parentIno);
        if (c.fromParentIno !== undefined) dirs.add(c.fromParentIno);
      }
      this.scheduleRefetch([...dirs], 'remote');
    }
  }

  /** Changes skipped for a local op are applied once no local op touches them any more. */
  private async reapplyDeferred(): Promise<void> {
    if (this.deferred.length === 0) return;
    const touched = this.touched();
    const ready: Change[] = [];
    const keep: Change[] = [];
    for (const c of this.deferred) {
      const busy =
        touched.has(c.ino) ||
        (c.parentIno !== undefined && touched.has(c.parentIno)) ||
        (c.fromParentIno !== undefined && touched.has(c.fromParentIno));
      (busy ? keep : ready).push(c);
    }
    this.deferred = keep;
    if (ready.length > 0) await this.applyChanges(ready, this.tx(), 'remote');
  }

  // -- snapshots and re-fetch ---------------------------------------------------------------------

  private async fetchPages(
    url: string,
    each: (page: SnapshotPage, first: boolean) => Promise<void>,
  ): Promise<boolean> {
    let after: string | undefined;
    let first = true;
    for (;;) {
      let page: SnapshotPage;
      try {
        page = await this.http.snapshot(url, after);
      } catch {
        return false;
      }
      await each(page, first);
      first = false;
      if (page.complete || page.next === undefined) return true;
      after = page.next;
    }
  }

  /** `snapshot.required` (§3.8.5): page through the snapshot, apply, then resume from its head. */
  private async onSnapshotRequired(body: S2CFrame<'snapshot.required'>['body']): Promise<void> {
    const owner = body.ownerUid;
    if (body.reason === 'reset') {
      // TODO(R5): §6 "reset" copies local rows newer than the restored server into
      // ~/lost+found/restore-<date>/ first (open question §9.1 #6); the version guard keeps them.
      this.host.notice?.({ type: 'snapshot-reset', ownerUid: owner });
    }
    let headSeq = body.headSeq;
    const gen = this.gen;
    const ok = await this.fetchPages(body.url, async (page, first) => {
      if (first) headSeq = page.owners?.find((o) => o.ownerUid === owner)?.headSeq ?? headSeq;
      await this.applyChanges(
        page.rows.map(rowToChange),
        this.tx(),
        'snapshot',
        undefined,
        (row) => row.type === 'd' && row.uid === owner,
      );
    });
    if (!ok) {
      // Retry while the connection lives; a reconnect starts over from hello.
      if (gen === this.gen && isSyncing(this.st))
        this.clock.after(
          fullJitter(2, this.rnd),
          () => void this.enqueue(() => this.onSnapshotRequired(body)),
        );
      return;
    }
    await this.storage.writeMeta(this.tx([{ ownerUid: owner, seq: headSeq }]));
    this.feed.reset(owner, headSeq);
    if (gen === this.gen)
      this.sendControl('resume', { cursors: [{ ownerUid: owner, fromSeq: headSeq }] });
    await this.drainFeed();
  }

  private scheduleRefetch(inos: readonly string[], reason: string): void {
    if (inos.length === 0) return;
    for (const i of inos) this.refetchInos.add(i);
    this.host.notice?.({ type: 'refetch', dirs: [...inos], reason });
    if (this.st === 'LIVE') this.runRefetch();
  }

  /** Re-read the authoritative state of directories (`GET /api/sync/snapshot?scope=dir`). */
  private runRefetch(): void {
    if (this.refetchInos.size === 0) return;
    const inos = [...this.refetchInos];
    this.refetchInos.clear();
    void this.enqueue(async () => {
      const dirs = await this.storage.dirsOf(inos);
      for (const dir of dirs) {
        const ok = await this.fetchPages(
          `/api/sync/snapshot?scope=dir&ino=${dir}`,
          async (page) => {
            await this.applyChanges(
              page.rows.map(rowToChange),
              this.tx(),
              'snapshot',
              undefined,
              (row) => row.ino === dir,
            );
          },
        );
        if (!ok) this.refetchInos.add(dir);
      }
    });
  }

  // -- liveness and status ------------------------------------------------------------------------

  /** RESUMING → LIVE: every owner resumed and no sendable op left (held ops do not block, §3.9 step 7). */
  private checkLive(): void {
    if (
      this.st !== 'RESUMING' ||
      this.awaiting.size > 0 ||
      this.inflight.size > 0 ||
      this.httpInflight !== null
    )
      return;
    for (const e of this.queue.all()) {
      if (e.sent) return;
      if (e.rec.state === 'parked' || e.held !== null) continue;
      if (this.allowed(e.rec.principal)) return;
    }
    this.go({ type: 'resumed' });
  }

  private statusInput(): StatusInput {
    const sum = this.queue.summary();
    return {
      state: this.st,
      queued: sum.pending + sum.inflight,
      waitingForSignIn: sum.held,
      parked: sum.parked,
      failures: this.failures,
      retryInMs:
        this.st === 'BACKOFF' && this.backoffAt !== null
          ? Math.max(0, this.backoffAt - this.clock.now())
          : null,
      upgradeRequired: this.upgradeRequired,
      lastAckAt: this.lastAckAt,
      leaseTtlMs: this.timers.leaseTtlMs,
      serverBuild: this.serverBuild,
      extraDegraded: this.st === 'LIVE' ? [] : ['lockd'],
    };
  }

  /** Publish `net.state` and the label when either changed (OFF-04). */
  private publish(): void {
    if (this.st === 'IDLE') return; // the taskbar exists from desktop-interactive (§3.7 rule 9)
    const input = this.statusInput();
    const status = netStatusOf(input);
    const label = statusLabel(input);
    if (status === null) return;
    if (sameStatus(status, this.lastStatus) && label === this.lastLabel) return;
    this.lastStatus = status;
    this.lastLabel = label;
    this.host.status?.(status, label);
  }

  /** Serialise every storage-touching task (results, feed, loads) in arrival order. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.serial.then(task).catch((err: unknown) => {
      this.host.notice?.({
        type: 'protocol-error',
        code: 'bad-frame',
        msg: err instanceof Error ? err.message.slice(0, 200) : 'sync task failed',
      });
    });
    this.serial = run;
    return run;
  }
}
