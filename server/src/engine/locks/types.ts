/**
 * Types of the lease manager (VFS-09; offline-and-sync.md §3.14; database.md §3.17, §4.11.16).
 *
 * The `locks` table is the authority: `EXCLUDE USING gist (ino WITH =, mode WITH <>)` keeps S and
 * X apart and the partial `UNIQUE (ino) WHERE mode = 'X'` keeps a single writer (INV-S6). The
 * manager's memory (waiter queues, the expiry index, a mirror of the live rows) is an index over
 * that table and is rebuilt from it at start (C9: leases survive a deploy).
 */
import type { S2CFrame } from '@plotinium/protocol';

export type LeaseMode = 'S' | 'X';

/** One row of `locks`, with the deadline in epoch milliseconds of the database clock. */
export interface LeaseRow {
  readonly leaseId: string;
  readonly ino: string;
  readonly osSessionId: string;
  readonly holderUid: number;
  readonly mode: LeaseMode;
  /** Fencing token from lock_fence_seq: strictly increasing, never reused (INV-S7). */
  readonly fence: number;
  /** lease_expires_at. */
  readonly expiresAt: number;
}

/** Who holds a busy inode, as `lock.denied.holder` reports it (§3.14.3 step 5). */
export interface HolderInfo {
  readonly username: string;
  readonly mode: LeaseMode;
  readonly expiresAt: number;
}

export interface AcquireRequest {
  readonly ino: string;
  readonly osSessionId: string;
  /**
   * The authorised principal (the login uid or a live `su` grant, checked by the manager). The
   * store derives its groups from `users` and `user_groups` itself, inside the transaction.
   */
  readonly holderUid: number;
  readonly mode: LeaseMode;
  readonly ttlMs: number;
}

/**
 * Outcome of the one short acquire transaction (§3.14.3). `expired` lists rows of this inode the
 * transaction deleted because their lease had already ended (step 2): the manager notifies them.
 */
export type AcquireOutcome =
  | {
      readonly kind: 'granted';
      readonly lease: LeaseRow;
      /** The caller's previous lease on this inode (renewed or upgraded in place: a new grant). */
      readonly replaced: LeaseRow | null;
      readonly expired: readonly LeaseRow[];
    }
  | {
      readonly kind: 'busy';
      readonly holder: HolderInfo | null;
      readonly expired: readonly LeaseRow[];
    }
  | {
      readonly kind: 'denied';
      readonly errno: 'ENOENT' | 'EISDIR' | 'EACCES';
      readonly expired: readonly LeaseRow[];
    };

/**
 * The persistence queries of the lease protocol (database.md §4.11.16). The Kysely implementation
 * is store.ts; tests use an in-memory double that enforces the same EXCLUDE semantics.
 */
export interface LockStore {
  /** §3.14.3: inode FOR UPDATE, delete expired rows, type and permission check, insert or upgrade. */
  acquire(req: AcquireRequest): Promise<AcquireOutcome>;
  /** Explicit release of one lease of this OS session; null when there is no such row. */
  release(leaseId: string, osSessionId: string): Promise<LeaseRow | null>;
  /** Every lease of these OS sessions (clean close, dead predecessors). */
  releaseSessions(osSessionIds: readonly string[]): Promise<readonly LeaseRow[]>;
  /** Every lease of every OS session opened by these auth sessions (revocation, §3.14.5). */
  releaseAuthSessions(authSessionIds: readonly string[]): Promise<readonly LeaseRow[]>;
  /**
   * Leases of the OTHER OS sessions of the same device and uid whose kernel epoch is older than
   * `kernelEpoch` (§3.8.1: that kernel can no longer run).
   */
  releaseDevicePredecessors(q: {
    readonly deviceId: string;
    readonly uid: number;
    readonly osSessionId: string;
    readonly kernelEpoch: number;
  }): Promise<readonly LeaseRow[]>;
  /**
   * Heartbeat renewal: `lease_expires_at = clock_timestamp() + ttl` for the listed (or 'all')
   * leases of the session that are still live. Returns the renewed rows (INV-S8).
   */
  renew(
    osSessionId: string,
    leaseIds: readonly string[] | 'all',
    ttlMs: number,
  ): Promise<readonly LeaseRow[]>;
  /**
   * §3.14.6: the rows among `refs` that still exist for this session with the same ino and fence
   * and have not expired, renewed by the same statement.
   */
  verifyHeld(
    osSessionId: string,
    refs: readonly { readonly leaseId: string; readonly ino: string; readonly fence: number }[],
    ttlMs: number,
  ): Promise<readonly LeaseRow[]>;
  /** Sweeper: DELETE ... WHERE lease_id = ANY($1) AND lease_expires_at <= clock_timestamp() RETURNING. */
  expire(leaseIds: readonly string[]): Promise<readonly LeaseRow[]>;
  /** Current rows of these leases (a due lease that was renewed meanwhile). */
  get(leaseIds: readonly string[]): Promise<readonly LeaseRow[]>;
  /** Every row, to rebuild the expiry index at start. */
  loadAll(): Promise<readonly LeaseRow[]>;
  /** The username of a holder, for `lock.denied.holder`. */
  usernameOf(uid: number): Promise<string | null>;
}

type Body<
  T extends 'lock.granted' | 'lock.queued' | 'lock.denied' | 'lock.released' | 'lock.expired',
> = S2CFrame<T>['body'];
export type LockGrantedBody = Body<'lock.granted'>;
export type LockQueuedBody = Body<'lock.queued'>;
export type LockDeniedBody = Body<'lock.denied'>;
export type LockEndedBody = Body<'lock.released'>;
export type LockEndReason = LockEndedBody['reason'];

/** A frame the lock manager wants delivered. The sync hub owns the sockets. */
export type LockFrame =
  | { readonly t: 'lock.granted'; readonly body: LockGrantedBody }
  | { readonly t: 'lock.queued'; readonly body: LockQueuedBody }
  | { readonly t: 'lock.denied'; readonly body: LockDeniedBody }
  | { readonly t: 'lock.released'; readonly body: LockEndedBody }
  | { readonly t: 'lock.expired'; readonly body: LockEndedBody };

/** Delivery of lock frames (implemented by the sync hub over the connection registry). */
export interface LockNotifier {
  /** To one connection (replies, and pushes to waiters and interested connections). */
  toConn(connId: string, frame: LockFrame): void;
  /** To every connection of an OS session (lock.expired to the holder). */
  toSession(osSessionId: string, frame: LockFrame): void;
  /**
   * Connections that watch the inode's directory (optional; §4.4 "a lease on a watched ... inode
   * ended"). Connections that asked for the inode are tracked by the manager itself.
   */
  watchersOf?(ino: string): Iterable<string>;
}

/** The requesting connection, as the sync hub knows it after the handshake. */
export interface LockConnRef {
  readonly connId: string;
  readonly osSessionId: string;
  /** Login uid from the cookie session (never from a frame). */
  readonly uid: number;
  /** True when `principal` is the login uid or holds a live `su` grant on this auth session (§3.8.6). */
  mayActAs(principal: number): boolean;
}
