/**
 * Shared types of the `syncd` client (offline-and-sync.md §3.7–§3.13, §4.8).
 *
 * Wire shapes come from @plotinium/protocol (ws/frames.ts, ws/ops.ts). The HTTP snapshot shapes of
 * backend-api.md §4.2 are not exported by protocol yet, so they are declared here.
 */
import type { Errno, FeedCursor, LeaseRef, S2CFrame, S2CType } from '@plotinium/protocol';

import type { OutboxRec } from '../store/records.ts';

/** The connection state machine of §3.7 (HANDSHAKING is the "hello" state). */
export type SyncState =
  | 'IDLE'
  | 'OFFLINE'
  | 'CONNECTING'
  | 'HANDSHAKING'
  | 'RESUMING'
  | 'LIVE'
  | 'BACKOFF'
  | 'AUTH_REQUIRED'
  | 'SUPERSEDED'
  | 'CLOSING'
  | 'CLOSED';

export type S2CBody<T extends S2CType> = S2CFrame<T>['body'];
export type OpResultBody = S2CBody<'op.result'>;
export type HelloOkBody = S2CBody<'hello.ok'>;
export type VfsChangedBody = S2CBody<'vfs.changed'>;
export type HbAckBody = S2CBody<'hb.ack'>;
export type LockFrame = S2CFrame<
  'lock.granted' | 'lock.queued' | 'lock.denied' | 'lock.released' | 'lock.expired'
>;

/** A `keptAs` of an `op.result`: the conflicted or salvaged copy (§3.12). */
export interface SyncKeptAs {
  readonly ino: string;
  readonly parentIno: string;
  readonly name: string;
}

/**
 * TODO(protocol): backend-api.md §4.2 `SnapshotRow` / `SnapshotPage` (protocol/src/http/sync.ts)
 * are not exported yet; declared locally with the spec's shape.
 */
export interface SnapshotRow {
  readonly parentIno: string | null;
  readonly name: string | null;
  readonly ino: string;
  readonly type: 'f' | 'd' | 'l';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly nlink: number;
  readonly version: number;
  readonly blob?: string;
  readonly symlinkTarget?: string;
  readonly mtime: number;
  readonly ctime: number;
  readonly btime: number;
}

export interface SnapshotPage {
  readonly owners?: readonly { readonly ownerUid: number; readonly headSeq: number }[];
  readonly rows: readonly SnapshotRow[];
  readonly next?: string;
  readonly complete: boolean;
}

/** Why a record cannot be sent right now (§3.4). `parked` is persisted as the record state. */
export type HeldReason = 'principal-auth' | 'blob-upload' | 'parked';

/** What `syncd` reports for the Settings → Storage list and `sync status`. */
export interface OutboxSummary {
  readonly pending: number;
  readonly inflight: number;
  readonly held: number;
  readonly parked: number;
  readonly reverted: number;
}

/** The outcome a BLOCKED caller receives (§3.13.2). */
export type WaitOutcome =
  | { readonly sync: 'applied'; readonly conflict?: { readonly keptAs: SyncKeptAs } }
  | { readonly sync: 'pending' }
  | {
      readonly sync: 'rejected';
      readonly errno: Errno;
      readonly reason?: string;
      readonly keptAs?: SyncKeptAs;
    };

/** Notices for the kernel (notifications, TTY lines, SIGHUP, bootlog). */
export type SyncNotice =
  | {
      readonly type: 'rejected';
      readonly opId: string;
      readonly errno: Errno;
      readonly reason?: string;
      readonly keptAs?: SyncKeptAs;
      readonly parked: boolean;
      /** Other ops reverted with it (the cascade of §3.12.4). */
      readonly cascade: readonly string[];
    }
  | {
      readonly type: 'conflict';
      readonly opId: string;
      readonly ino: string;
      readonly keptAs: SyncKeptAs;
      readonly errno?: Errno;
      readonly reason?: string;
    }
  | { readonly type: 'refetch'; readonly dirs: readonly string[]; readonly reason: string }
  | {
      readonly type: 'su-ended';
      readonly uid: number;
      readonly reason: 'su-expired' | 'su-revoked';
    }
  | { readonly type: 'server-build'; readonly build: string; readonly differs: boolean }
  | {
      readonly type: 'protocol-error';
      readonly code: string;
      readonly msg: string;
      readonly refId?: number;
    }
  | { readonly type: 'snapshot-reset'; readonly ownerUid: number }
  /** A newer kernel of this device took over (close 4409): this kernel must stop. */
  | { readonly type: 'superseded' };

/** The cursor writes and Lamport merge that ride along a result or feed transaction (INV-S5). */
export interface MetaAdvance {
  readonly cursors: readonly FeedCursor[];
  readonly lamport: number;
}

/** The lease side of `hello` and `hb`, provided by lockd (§3.14.6). */
export interface HeldLeases {
  readonly held: readonly LeaseRef[];
}

/** The subset of an outbox record the sender needs, plus its in-memory state. */
export interface QueueEntry {
  rec: OutboxRec;
  /** In memory only (§3.4): sent on the current connection, no final result yet. */
  sent: boolean;
  /** Sent at least once in this boot, or `attempts > 0` on disk. */
  everSent: boolean;
  held: HeldReason | null;
  /** Reserved by the kernel for coalescing: not sendable until the next kick (§3.14.2). */
  reserved: boolean;
  /** Locked by syncd while a transaction may delete or rewrite it (a cascade, a local cancel). */
  locked: boolean;
  /** The process waiting on it was killed: `proc.signal` follows its next send (§3.13.3). */
  cancel: boolean;
  /** Cached serialised size of the `op.submit` body. */
  size: number;
}
