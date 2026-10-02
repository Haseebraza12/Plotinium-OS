/**
 * The in-process registry of `/ws` connections (C9: one process, so broadcasts and revocations
 * run in memory after COMMIT; offline-and-sync.md §3.8.1, §3.14.5, §3.17; backend-api.md §3.7,
 * §3.8.4, §3.17; INV-SRV-7).
 *
 *   by auth session  revocation closes every socket of the session with `bye revoked` / 4401 and
 *                    releases the leases of its OS sessions (no foreign-key cascade, C7)
 *   by device        supersession: a hello with a newer kernelEpoch closes the older connections of
 *                    the device with `bye superseded` / 4409; a hello with an OLDER epoch than an
 *                    open connection's is refused the same way (the stale kernel must stop)
 *   by OS session    lock.expired to the holder, and "is another connection of this OS session
 *                    still open?" before a clean close releases leases
 */
import type { BuildIdentity, Hello, OpResult, OpSubmit } from '@plotinium/protocol';
import type { Cred } from '@plotinium/vfs/perm';

import { uuidv7 } from '../../util/uuidv7.ts';
import type { LockManager } from '../locks/manager.ts';
import type { LockFrame, LockNotifier } from '../locks/types.ts';
import { systemClock, type Clock } from './clock.ts';
import {
  CONNECTION_DEFAULTS,
  SyncConnection,
  type ConnAuth,
  type HelloInfo,
  type Transport,
} from './connection.ts';
import type { CommittedOp, OpOrigin, OsSessionCheck } from './engine.ts';
import type { Broadcaster, FeedReader } from './feed.ts';
import type { OsSessionStore } from './feed-reader.ts';
import { ownsOrClaims } from './feed-reader.ts';
import type { LamportClock } from './outcome.ts';
import type { InvalidOp } from './router.ts';
import type { DirContextSource } from './visibility.ts';

/** The engine surface the connections use (SyncEngine implements it for any Tx). */
export interface EngineApi {
  readonly lamport: LamportClock;
  applyOp(origin: OpOrigin, submit: OpSubmit, signal?: AbortSignal): Promise<OpResult>;
  rejectKilled(origin: OpOrigin, submit: OpSubmit): Promise<OpResult>;
  rejectInvalid(origin: OpOrigin, op: InvalidOp): Promise<OpResult>;
}

export interface HubConfig {
  /** The server's build identity (hello.ok.server, /api/readyz). */
  readonly build: BuildIdentity;
  readonly leaseTtlMs: number;
  readonly creditWindow: number;
  readonly feedWindow: number;
  readonly maxWatches: number;
}

export type HelloBody = Hello;

/** What a connection needs from the hub. */
export interface HubContext {
  readonly clock: Clock;
  readonly config: HubConfig;
  readonly engine: EngineApi;
  readonly locks: LockManager;
  readonly broadcaster: Broadcaster;
  readonly reader: FeedReader;
  readonly dirs: DirContextSource;
  register(
    conn: SyncConnection,
    r: { hello: HelloBody; info: HelloInfo },
  ): Promise<'ok' | 'forbidden' | 'stale'>;
  unregister(conn: SyncConnection): void;
  hasOtherConnection(osSessionId: string, conn: SyncConnection): boolean;
  validateAuth(authSessionId: string): Promise<boolean>;
  revoke(authSessionIds: readonly string[]): Promise<void>;
  canWatch(cred: Cred, dirIno: string): Promise<boolean>;
  cancelBackend(opId: string): void;
  onError(err: unknown, context: string): void;
}

export interface SyncHubOptions {
  readonly engine: EngineApi;
  readonly locks: LockManager;
  readonly broadcaster: Broadcaster;
  readonly reader: FeedReader;
  readonly dirs: DirContextSource;
  readonly sessions: OsSessionStore;
  readonly config: Pick<HubConfig, 'build' | 'leaseTtlMs'> & Partial<HubConfig>;
  readonly clock?: Clock;
  /** hb re-validation of the cookie session (one primary-key lookup). */
  readonly validateAuth: (authSessionId: string) => Promise<boolean>;
  /** watch: the login uid needs r and x on the directory. */
  readonly canWatch: (cred: Cred, dirIno: string) => Promise<boolean>;
  /** proc.signal for a running op: mark it in the cancel registry, then pg_cancel_backend. */
  readonly cancelBackend: (opId: string) => void;
  readonly newId?: () => string;
  readonly onError?: (err: unknown, context: string) => void;
}

function addTo<K, V>(m: Map<K, Set<V>>, k: K, v: V): void {
  let s = m.get(k);
  if (s === undefined) {
    s = new Set();
    m.set(k, s);
  }
  s.add(v);
}

function removeFrom<K, V>(m: Map<K, Set<V>>, k: K, v: V): void {
  const s = m.get(k);
  if (s === undefined) return;
  s.delete(v);
  if (s.size === 0) m.delete(k);
}

export class SyncHub implements HubContext, OsSessionCheck {
  readonly clock: Clock;
  readonly config: HubConfig;
  readonly engine: EngineApi;
  readonly locks: LockManager;
  readonly broadcaster: Broadcaster;
  readonly reader: FeedReader;
  readonly dirs: DirContextSource;
  readonly #o: SyncHubOptions;
  readonly #conns = new Map<string, SyncConnection>();
  readonly #byAuth = new Map<string, Set<SyncConnection>>();
  readonly #byDevice = new Map<string, Set<SyncConnection>>();
  readonly #byOsSession = new Map<string, Set<SyncConnection>>();
  /** `${osSessionId}|${uid}` -> deviceId, for the op pipeline's step 1 without a round trip. */
  readonly #known = new Map<string, string>();
  #draining = false;

  constructor(options: SyncHubOptions) {
    this.#o = options;
    this.clock = options.clock ?? systemClock;
    this.engine = options.engine;
    this.locks = options.locks;
    this.broadcaster = options.broadcaster;
    this.reader = options.reader;
    this.dirs = options.dirs;
    this.config = {
      creditWindow: CONNECTION_DEFAULTS.creditWindow,
      feedWindow: CONNECTION_DEFAULTS.feedWindow,
      maxWatches: CONNECTION_DEFAULTS.maxWatches,
      ...options.config,
    };
  }

  get size(): number {
    return this.#conns.size;
  }

  get draining(): boolean {
    return this.#draining;
  }

  /** After a successful upgrade: registers the connection and arms its hello timer. */
  accept(transport: Transport, auth: ConnAuth): SyncConnection {
    const conn = new SyncConnection((this.#o.newId ?? uuidv7)(), transport, auth, this);
    this.#conns.set(conn.connId, conn);
    addTo(this.#byAuth, auth.authSessionId, conn);
    conn.start();
    return conn;
  }

  /** Open sockets of an auth session (the upgrade allows at most 4 per auth session). */
  socketsOf(authSessionId: string): number {
    return this.#byAuth.get(authSessionId)?.size ?? 0;
  }

  connection(connId: string): SyncConnection | undefined {
    return this.#conns.get(connId);
  }

  // -------------------------------------------------------------------------------------------
  // HubContext
  // -------------------------------------------------------------------------------------------

  async register(
    conn: SyncConnection,
    r: { hello: HelloBody; info: HelloInfo },
  ): Promise<'ok' | 'forbidden' | 'stale'> {
    const { info } = r;
    const ok = await this.#o.sessions.register({
      osSessionId: info.osSessionId,
      ownerUid: conn.auth.uid,
      authSessionId: conn.auth.authSessionId,
      deviceId: info.deviceId,
      kernelEpoch: info.kernelEpoch,
    });
    if (!ok) return 'forbidden';
    const peers = [...(this.#byDevice.get(info.deviceId) ?? [])].filter(
      (c) => c !== conn && c.hello !== null && !c.closed,
    );
    if (peers.some((c) => (c.hello?.kernelEpoch ?? 0) > info.kernelEpoch)) return 'stale';
    for (const c of peers)
      if ((c.hello?.kernelEpoch ?? 0) < info.kernelEpoch) c.closeWith('superseded');
    addTo(this.#byDevice, info.deviceId, conn);
    addTo(this.#byOsSession, info.osSessionId, conn);
    this.#known.set(`${info.osSessionId}|${conn.auth.uid}`, info.deviceId);
    return 'ok';
  }

  unregister(conn: SyncConnection): void {
    this.#conns.delete(conn.connId);
    removeFrom(this.#byAuth, conn.auth.authSessionId, conn);
    const h = conn.hello;
    if (h !== null) {
      removeFrom(this.#byDevice, h.deviceId, conn);
      removeFrom(this.#byOsSession, h.osSessionId, conn);
    }
  }

  hasOtherConnection(osSessionId: string, conn: SyncConnection): boolean {
    return [...(this.#byOsSession.get(osSessionId) ?? [])].some((c) => c !== conn && !c.closed);
  }

  validateAuth(authSessionId: string): Promise<boolean> {
    return this.#o.validateAuth(authSessionId);
  }

  /**
   * An auth session ended (logout, password change, admin, expiry): every socket of it gets
   * `bye revoked` and 4401 at once, and the lock manager releases the leases of its OS sessions.
   * Hook it to SessionService.onRevoke.
   */
  async revoke(authSessionIds: readonly string[]): Promise<void> {
    for (const id of authSessionIds) {
      for (const c of [...(this.#byAuth.get(id) ?? [])]) c.closeWith('revoked');
    }
    await this.locks.releaseAuthSessions(authSessionIds);
  }

  canWatch(cred: Cred, dirIno: string): Promise<boolean> {
    return this.#o.canWatch(cred, dirIno);
  }

  cancelBackend(opId: string): void {
    this.#o.cancelBackend(opId);
  }

  onError(err: unknown, context: string): void {
    this.#o.onError?.(err, context);
  }

  // -------------------------------------------------------------------------------------------
  // Engine and lock-manager hooks
  // -------------------------------------------------------------------------------------------

  /** Step 1 of the op pipeline: the op's OS session belongs to the uid (and device). */
  async ownsOsSession(osSessionId: string, uid: number, deviceId: string | null): Promise<boolean> {
    const known = this.#known.get(`${osSessionId}|${uid}`);
    if (known !== undefined && (deviceId === null || known === deviceId)) return true;
    const owned = await ownsOrClaims(this.#o.sessions, osSessionId, uid, deviceId);
    if (owned && deviceId !== null) this.#known.set(`${osSessionId}|${uid}`, deviceId);
    return owned;
  }

  /**
   * `POST /api/ops/{opId}` (ops over 60 KB): joins the op lane of the op's OS session when that
   * session has a live socket of the same uid, otherwise runs directly. Resolves with the op.result
   * body for the HTTP response (status 200 for every outcome); rejects with ProtocolViolation when
   * the OS session is not the caller's (the route answers 403 EACCES).
   */
  submitOp(origin: Omit<OpOrigin, 'connId' | 'deviceId'>, submit: OpSubmit): Promise<OpResult> {
    const live = [...(this.#byOsSession.get(submit.osSessionId) ?? [])].find(
      (c) => c.auth.uid === origin.uid && !c.closed && c.hello !== null,
    );
    if (live !== undefined) return live.submitHttp(submit);
    return this.engine.applyOp({ ...origin, connId: null, deviceId: null }, submit);
  }

  /** After COMMIT: fan out through the broadcaster and renew the OS session's leases. */
  committed(c: CommittedOp): void {
    this.broadcaster.committed(c).catch((err: unknown) => this.onError(err, 'broadcast'));
    this.locks
      .renewSession(c.osSessionId)
      .catch((err: unknown) => this.onError(err, 'renew-session'));
  }

  /** Delivery of lock frames to connections (the LockManager's notifier). */
  readonly lockNotifier: LockNotifier = {
    toConn: (connId: string, frame: LockFrame) => {
      this.#conns.get(connId)?.sendLock(frame);
    },
    toSession: (osSessionId: string, frame: LockFrame) => {
      for (const c of this.#byOsSession.get(osSessionId) ?? []) c.sendLock(frame);
    },
  };

  /** A su grant ended (expiry, exit, revocation): SIGHUP to the elevated processes (§3.17). */
  suEnded(authSessionId: string, uid: number, reason: 'su-expired' | 'su-revoked'): void {
    for (const c of this.#byAuth.get(authSessionId) ?? []) c.sendSuEnded(uid, reason);
  }

  /**
   * Graceful shutdown (backend-api.md §3.17): each connection lets its running op finish for up
   * to graceMs, then gets `bye restart` / 1012. Leases are NOT released (they stay in the table
   * and clients that reconnect within the TTL keep them).
   */
  async shutdown(graceMs: number): Promise<void> {
    this.#draining = true;
    await Promise.all([...this.#conns.values()].map((c) => c.drainAndClose(graceMs)));
    this.broadcaster.stop();
    this.locks.stop();
  }
}
