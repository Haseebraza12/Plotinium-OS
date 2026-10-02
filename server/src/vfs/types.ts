/**
 * Server-side VFS transaction types.
 *
 * Spec: specs/09-database/database.md §4.7 (normative sketch), §3.8 (lock order L0-L4, lockPlan),
 * §3.9 (vfsTxn), §3.14 (fault harness). Primary owner R2, secondary reviewer R5.
 */
import { ErrnoError, type Errno } from '../errno.ts';

export type Uid = number;
/** UUIDv7, canonical lowercase text (C5). */
export type Ino = string;

export interface Principal {
  /** Effective uid (su-aware), derived by the server from the session, never from the client. */
  readonly uid: Uid;
  /** Login uid. */
  readonly realUid: Uid;
  /** Primary gid + user_groups. */
  readonly gids: readonly number[];
}

export type VfsCall =
  | 'mkdir'
  | 'create'
  | 'symlink'
  | 'link'
  | 'write'
  | 'truncate'
  | 'unlink'
  | 'rename'
  | 'copy'
  | 'chmod'
  | 'chown'
  | 'utimes'
  | 'batch'
  | 'audit.append'
  | 'session.layout';

/** An armed fault for this op (only under FAULT_INJECTION=1, database.md §3.14). */
export interface ArmedFault {
  /** plotinium.fault_after: the first `after` node ops succeed, node op after+1 raises P0001. */
  readonly after: number;
  readonly on: 'inodes' | 'dentries';
  /** AGT-09 debug delay between plan steps, at most 30 000 ms. */
  readonly delayMs?: number;
}

export interface OpContext {
  /** Client UUIDv7 idempotency key (C6). */
  readonly opId: string;
  readonly principal: Principal;
  readonly osSessionId: string;
  readonly cseq: number;
  readonly lamport: number;
  readonly call: VfsCall;
  /** Already validated by Valibot (protocol/). */
  readonly args: unknown;
  readonly base?: { readonly kind: 'versions' | 'digest'; readonly value: unknown };
  /** Clamped by the server. */
  readonly clientTs?: string;
  /** Aborted by proc.signal for the op's process (AGT-09). */
  readonly signal: AbortSignal;
  readonly fault?: ArmedFault;
}

/** Output of lockPlan(): the L1-L4 sets (database.md §3.8). */
export interface LockPlan {
  /** L1, the actor and every affected owner. vfsTxn sorts and de-duplicates. */
  readonly owners: readonly Uid[];
  /** L2: a directory changes parent. */
  readonly renameLock: boolean;
  /** L3: parents whose entries change + directories of walked subtrees. */
  readonly dirs: readonly Ino[];
  /** L4: content-write target; every non-directory of a modified subtree. */
  readonly files: readonly Ino[];
  /** Re-collected under the locks (plan, lock, re-plan). */
  readonly subtreeRoots: readonly { readonly parent: Ino; readonly name: string }[];
  /** Checked after locking (§3.12). */
  readonly expect?: { readonly kind: 'base' | 'fingerprint'; readonly digest: string };
}

/** The subset of an inode row that the lock statements return (L3/L4). */
export interface InodeRow {
  readonly ino: Ino;
  readonly type: 'f' | 'd' | 'l';
  readonly mode: number;
  readonly uid: Uid;
  readonly gid: number;
  readonly version: number;
  readonly lock_fence: number;
}

export interface Locked {
  readonly plan: LockPlan;
  readonly rows: ReadonlyMap<Ino, InodeRow>;
}

export interface BodyResult<R> {
  readonly status: 'applied' | 'conflict';
  /** Only for a stale-fence conflict. */
  readonly errno?: 'EBUSY';
  /** Small reply body, stored in op_log.result. */
  readonly result: R;
  /** vfs.changed payload (offline-and-sync.md). */
  readonly effects: unknown;
  /** Feed recipients: owners of every written row and of every directory whose entries changed. */
  readonly owners: readonly Uid[];
}

/** A committed op_log row read back for a duplicate or a racing rejection. */
export interface StoredOp {
  readonly uid: Uid;
  readonly status: 'applied' | 'conflict' | 'rejected';
  readonly errno: Errno | null;
  readonly result: unknown;
}

export type TxOutcome<R> =
  | ({ readonly kind: 'applied' | 'conflict' } & BodyResult<R>)
  | {
      readonly kind: 'duplicate';
      readonly status: StoredOp['status'];
      readonly errno: Errno | null;
      readonly result: unknown;
    };

/** An errno raised by VFS logic or mapped from a SQLSTATE (database.md §4.7, §4.9). */
export class VfsError extends ErrnoError {
  constructor(errno: Errno, detail: Record<string, unknown> = {}, message?: string) {
    super(errno, detail, message);
    this.name = 'VfsError';
  }
}

/** The re-plan found an affected owner outside the L1 set: restart with the union (§3.8). */
export class LockSetChanged extends Error {
  readonly owners: readonly Uid[];
  constructor(owners: readonly Uid[]) {
    super('lockset');
    this.name = 'LockSetChanged';
    this.owners = owners;
  }
}
