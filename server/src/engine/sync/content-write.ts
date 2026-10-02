/**
 * The content-write op (`write`): version compare-and-swap, leases and fences, and the conflicted
 * copy (Spec: MUST, §9.3, VFS-06, VFS-09, VFS-10; offline-and-sync.md §3.12.2, §3.14.4, §3.5;
 * database.md §3.13, §4.11.15; SYN-08).
 *
 * Inside vfsTxn (L0 op_log, L1 users, L3 the parent directory, L4 the file):
 *   recheck  exists (ENOENT), regular file (EISDIR / EINVAL), w on the file and x on every
 *            ancestor (EACCES), then decide:
 *              a stale fence (below inodes.lock_fence, or its own lease gone) -> conflict EBUSY stale-fence
 *              a live lease of another OS session                         -> conflict EBUSY lease
 *              base version != current version                          -> conflict (no errno)
 *              otherwise                                                 -> apply
 *   body     apply: take the new blob (0 rows -> retry EAGAIN blob-missing), CAS the inode
 *            (version + 1), drop the old blob reference, quota delta to the owner (EDQUOT).
 *            conflict: the current file is left UNCHANGED (nothing is ever silently overwritten);
 *            the losing bytes become a NEW inode `deriveIno(opId, ino)` named
 *            `<stem> (conflict from <user>, <date>)<ext>` next to the original when the principal
 *            has w and x on the parent, otherwise in `~/lost+found` (created 0700 on demand); owned
 *            by the principal, mode of the original, charged to the principal's quota (EDQUOT
 *            rejects the whole op instead).
 *   `mtime` is clamped to commitTime + 60 s (§3.5); the conflicted copy's date is the commit date
 *   in PLOTINIUM_TZ.
 *
 * TODO(R2, §3.12.5): salvage of REJECTED content (EACCES, EPERM, parent ENOENT) into ~/lost+found in
 * the rejection transaction needs a hook in vfsTxn's recordRejection; until then the client parks
 * the bytes locally (§3.12.4 step 3), so nothing is lost.
 */
import { deriveIno, type Change, type OpSubmit } from '@plotinium/protocol';
import { may, W, X, type Cred, type PermSubject } from '@plotinium/vfs/perm';

import type { OpHandler } from '../../vfs/tx.ts';
import {
  VfsError,
  type BodyResult,
  type Ino,
  type InodeRow,
  type LockPlan,
  type Locked,
  type OpContext,
  type Uid,
} from '../../vfs/types.ts';
import { checkWriteLeases, type LeaseState } from '../locks/fencing.ts';
import { conflictName, isoDate } from './names.ts';
import type { StoredResult } from './outcome.ts';

/** Offline edits may not claim an mtime later than this after the commit (§3.5). */
export const MTIME_CLAMP_MS = 60_000;
/** A conflicted-copy name is tried with n = 1..9 (database.md §3.13 step 4). */
export const MAX_CONFLICT_NAMES = 9;
export const LOST_FOUND = 'lost+found';
export const LOST_FOUND_MODE = 0o700;

/** vfs.changed payload stored in op_log.effects (offline-and-sync.md §4.4). */
export interface Effects {
  readonly changes: readonly Change[];
  /** Directories whose entry set changed (watchers of these directories receive the entry). */
  readonly dirs: readonly Ino[];
}

export interface PermRow extends PermSubject {
  readonly ino: Ino;
}

/** Where a file is named: hard links have several names; the first dentry in key order is used. */
export interface Location {
  readonly owner: Uid;
  readonly parentIno: Ino;
  readonly name: string;
  readonly parentOwner: Uid;
}

export interface FileContent {
  readonly size: number;
  readonly blobId: number | null;
  readonly nlink: number;
}

export interface NewFile {
  readonly ino: Ino;
  readonly uid: Uid;
  readonly gid: number;
  readonly mode: number;
  readonly blobId: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface Stamp {
  readonly version: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface DirStamp extends Stamp {
  readonly nlink: number;
}

/** The SQL the handler needs (Kysely implementation: kysely-content.ts). */
export interface ContentSql<Tx> {
  /** Lock-free: the file's owner and ONE name (first dentry in key order) with its parent's owner. */
  locate(tx: Tx, ino: Ino): Promise<Location | null>;
  /** size, blob and nlink of the (already locked) file. */
  content(tx: Tx, ino: Ino): Promise<FileContent | null>;
  /** The directory itself and every ancestor up to '/' (x checks). */
  ancestors(tx: Tx, dirIno: Ino): Promise<readonly PermRow[]>;
  /** username, primary gid and supplementary groups of a uid. */
  credentials(
    tx: Tx,
    uid: Uid,
  ): Promise<{ username: string; primaryGid: number; groups: readonly number[] } | null>;
  /** `SELECT ino, os_session_id, mode, fence, lease_expires_at > clock_timestamp() ... FROM locks`. */
  leasesOn(tx: Tx, inos: readonly Ino[]): Promise<readonly LeaseState[]>;
  /** /home/<username> and its lost+found (null when missing), lock-free. */
  homeOf(tx: Tx, username: string): Promise<{ homeIno: Ino; lostFoundIno: Ino | null } | null>;
  /** The transaction timestamp now() in ms: the commit time clients see (§3.5). */
  txNow(tx: Tx): Promise<number>;
  /** `UPDATE blobs SET refcount = refcount + 1 ... RETURNING blob_id, size`; null = blob-missing. */
  takeBlob(tx: Tx, sha256: string): Promise<{ blobId: number; size: number } | null>;
  releaseBlob(tx: Tx, blobId: number): Promise<void>;
  /** The CAS: `... WHERE ino = $1 AND version = $expected`; null when the version moved. */
  casWrite(
    tx: Tx,
    a: { ino: Ino; blobId: number; size: number; mtimeMs: number; expectedVersion: number },
  ): Promise<Stamp | null>;
  /** used_bytes/used_inodes += delta (the users CHECK raises EDQUOT, root exempt). */
  addUsage(tx: Tx, uid: Uid, bytes: number, inodes: number): Promise<void>;
  /** A regular-file inode for a conflicted copy (no name yet). */
  insertFile(tx: Tx, f: NewFile): Promise<Stamp>;
  /** A dentry `ON CONFLICT ON CONSTRAINT dentries_pkey DO NOTHING`: false when the name is taken. */
  link(
    tx: Tx,
    d: { parentIno: Ino; name: string; ino: Ino; type: 'f' | 'd'; uid: Uid },
  ): Promise<boolean>;
  /** mkdir `lost+found` (0700, nlink 2) in the home directory; returns its stamp. */
  createDir(tx: Tx, d: { ino: Ino; uid: Uid; gid: number; mode: number }): Promise<DirStamp>;
  /** A directory whose entries changed: version + 1, mtime, nlink + delta. */
  touchDir(tx: Tx, dirIno: Ino, nlinkDelta: number): Promise<DirStamp>;
}

type Decision =
  | { readonly kind: 'apply'; readonly expected: number }
  | {
      readonly kind: 'conflict';
      readonly errno?: 'EBUSY';
      readonly reason?: 'lease' | 'stale-fence';
    };

type CopyDir =
  | { readonly kind: 'parent' }
  | { readonly kind: 'lost+found'; readonly homeIno: Ino; readonly lostFoundIno: Ino | null };

export interface ContentWriteOptions {
  /** PLOTINIUM_TZ for the conflicted-copy date. */
  readonly timeZone: string;
}

type WriteOp = Extract<OpSubmit['op'], { kind: 'write' }>;
export type WriteBody = BodyResult<StoredResult> & { readonly effects: Effects };

export class ContentWriteHandler<Tx> implements OpHandler<Tx, StoredResult> {
  readonly #sql: ContentSql<Tx>;
  readonly #submit: OpSubmit;
  readonly #op: WriteOp;
  readonly #opts: ContentWriteOptions;
  #where: Location | null = null;
  #decision: Decision | null = null;
  #cred: Cred | null = null;
  #username = '';
  #copyDir: CopyDir = { kind: 'parent' };

  constructor(sql: ContentSql<Tx>, submit: OpSubmit, opts: ContentWriteOptions) {
    if (submit.op.kind !== 'write')
      throw new TypeError('ContentWriteHandler handles write ops only');
    this.#sql = sql;
    this.#submit = submit;
    this.#op = submit.op;
    this.#opts = opts;
  }

  async plan(tx: Tx, extraOwners: readonly Uid[]): Promise<LockPlan> {
    this.#where = await this.#sql.locate(tx, this.#op.ino);
    if (this.#where === null) throw new VfsError('ENOENT', { ino: this.#op.ino });
    return {
      owners: [this.#where.owner, this.#where.parentOwner, ...extraOwners],
      renameLock: false,
      dirs: [this.#where.parentIno],
      files: [this.#op.ino],
      subtreeRoots: [],
    };
  }

  /**
   * After L3/L4: when the principal cannot write the parent, a conflicted copy would go to
   * ~/lost+found, whose directories must be locked too (in ino order within the statement; a rare
   * out-of-order wait resolves as 40P01 and a retry, database.md §3.8).
   */
  async replan(tx: Tx, locked: Locked): Promise<{ dirs: readonly Ino[]; owners: readonly Uid[] }> {
    const where = this.#located();
    const cred = await this.#credentials(tx);
    const parent = locked.rows.get(where.parentIno);
    const dirs: Ino[] = [where.parentIno];
    this.#copyDir = { kind: 'parent' };
    if (parent !== undefined && !may(cred, parent, W | X)) {
      const home = await this.#sql.homeOf(tx, this.#username);
      if (home !== null) {
        this.#copyDir = {
          kind: 'lost+found',
          homeIno: home.homeIno,
          lostFoundIno: home.lostFoundIno,
        };
        dirs.push(home.homeIno);
        if (home.lostFoundIno !== null) dirs.push(home.lostFoundIno);
      }
    }
    return { dirs, owners: locked.plan.owners };
  }

  async recheck(tx: Tx, op: OpContext, locked: Locked): Promise<void> {
    const where = this.#located();
    const file = locked.rows.get(this.#op.ino);
    if (file === undefined) throw new VfsError('ENOENT', { ino: this.#op.ino });
    if (file.type === 'd') throw new VfsError('EISDIR', { ino: file.ino });
    if (file.type !== 'f') throw new VfsError('EINVAL', { ino: file.ino });
    const cred = await this.#credentials(tx);
    if (!may(cred, file, W)) throw new VfsError('EACCES', { ino: file.ino });
    for (const a of await this.#sql.ancestors(tx, where.parentIno)) {
      if (!may(cred, a, X)) throw new VfsError('EACCES', { ino: a.ino });
    }

    const base = this.#submit.base;
    const expected =
      base.kind === 'versions' ? base.entries.find((e) => e.ino === file.ino)?.version : undefined;
    if (expected === undefined)
      throw new VfsError('EINVAL', { reason: 'base-missing', ino: file.ino });

    const verdict = checkWriteLeases({
      osSessionId: op.osSessionId,
      fences: this.#submit.fences ?? [],
      targets: [{ ino: file.ino, lockFence: file.lock_fence }],
      leases: await this.#sql.leasesOn(tx, [file.ino]),
      bulk: false,
    });
    if (!verdict.ok) {
      this.#decision = {
        kind: 'conflict',
        errno: 'EBUSY',
        reason: verdict.reason === 'stale-fence' ? 'stale-fence' : 'lease',
      };
    } else if (file.version !== expected) {
      this.#decision = { kind: 'conflict' };
    } else {
      this.#decision = { kind: 'apply', expected };
    }
  }

  async body(tx: Tx, locked: Locked): Promise<WriteBody> {
    const decision = this.#decision;
    const file = locked.rows.get(this.#op.ino);
    if (decision === null || file === undefined) throw new VfsError('EIO', { reason: 'server' });
    const blob = await this.#sql.takeBlob(tx, this.#op.blob);
    if (blob === null)
      throw new VfsError('EAGAIN', { reason: 'blob-missing', sha256: this.#op.blob });
    if (blob.size !== this.#op.size) throw new VfsError('EINVAL', { reason: 'size-mismatch' });
    const commitMs = await this.#sql.txNow(tx);
    const mtimeMs = Math.min(this.#op.mtime, commitMs + MTIME_CLAMP_MS);

    if (decision.kind === 'apply') {
      const before = await this.#sql.content(tx, file.ino);
      if (before === null) throw new VfsError('ENOENT', { ino: file.ino });
      const stamp = await this.#sql.casWrite(tx, {
        ino: file.ino,
        blobId: blob.blobId,
        size: this.#op.size,
        mtimeMs,
        expectedVersion: decision.expected,
      });
      // Under the L4 row lock the CAS cannot miss; if it ever did, it is a conflict, never an overwrite.
      if (stamp !== null) {
        if (before.blobId !== null) await this.#sql.releaseBlob(tx, before.blobId);
        await this.#sql.addUsage(tx, file.uid, this.#op.size - before.size, 0);
        return {
          status: 'applied',
          result: {
            versions: [
              { ino: file.ino, version: stamp.version, mtime: stamp.mtimeMs, ctime: stamp.ctimeMs },
            ],
          },
          effects: {
            changes: [
              {
                kind: 'upsert',
                ino: file.ino,
                version: stamp.version,
                type: 'f',
                mode: file.mode,
                uid: file.uid,
                gid: file.gid,
                size: this.#op.size,
                nlink: before.nlink,
                blob: this.#op.blob,
                mtime: stamp.mtimeMs,
                ctime: stamp.ctimeMs,
              },
            ],
            dirs: [],
          },
          owners: [file.uid],
        };
      }
    }
    return this.#conflict(
      tx,
      locked,
      file,
      blob.blobId,
      mtimeMs,
      commitMs,
      decision.kind === 'conflict' ? decision : { kind: 'conflict' },
    );
  }

  async #conflict(
    tx: Tx,
    locked: Locked,
    file: InodeRow,
    blobId: number,
    mtimeMs: number,
    commitMs: number,
    decision: Extract<Decision, { kind: 'conflict' }>,
  ): Promise<WriteBody> {
    const where = this.#located();
    const cred = await this.#credentials(tx);
    const changes: Change[] = [];
    const dirs: Ino[] = [];
    const owners = new Set<Uid>([cred.uid]);
    let parentIno = where.parentIno;
    let parentRow: PermSubject | undefined = locked.rows.get(where.parentIno);
    let createdDir: { homeIno: Ino } | null = null;

    if (this.#copyDir.kind === 'lost+found') {
      const target = this.#copyDir;
      if (target.lostFoundIno === null) {
        // ~/lost+found (0700) created on demand, with a derived id both sides can name.
        parentIno = deriveIno(this.#submit.opId, target.homeIno);
        await this.#sql.createDir(tx, {
          ino: parentIno,
          uid: cred.uid,
          gid: cred.gid,
          mode: LOST_FOUND_MODE,
        });
        if (
          !(await this.#sql.link(tx, {
            parentIno: target.homeIno,
            name: LOST_FOUND,
            ino: parentIno,
            type: 'd',
            uid: cred.uid,
          }))
        ) {
          throw new VfsError('EEXIST', { reason: 'lost-found' });
        }
        await this.#sql.addUsage(tx, cred.uid, 0, 1);
        const home = await this.#sql.touchDir(tx, target.homeIno, 1);
        changes.push({
          kind: 'upsert',
          ino: target.homeIno,
          version: home.version,
          type: 'd',
          nlink: home.nlink,
          mtime: home.mtimeMs,
          ctime: home.ctimeMs,
        });
        dirs.push(target.homeIno);
        createdDir = { homeIno: target.homeIno };
      } else {
        parentIno = target.lostFoundIno;
      }
      parentRow = locked.rows.get(parentIno);
    } else if (parentRow !== undefined) {
      owners.add(parentRow.uid);
    }

    const copyIno = deriveIno(this.#submit.opId, file.ino);
    const mode = file.mode & 0o777;
    const stamp = await this.#sql.insertFile(tx, {
      ino: copyIno,
      uid: cred.uid,
      gid: cred.gid,
      mode,
      blobId,
      size: this.#op.size,
      mtimeMs,
    });
    const date = isoDate(commitMs, this.#opts.timeZone);
    const tried = new Set<string>();
    let name: string | null = null;
    for (let i = 0; i < MAX_CONFLICT_NAMES && name === null; i++) {
      const candidate = conflictName(where.name, this.#username, date, (c) => tried.has(c));
      tried.add(candidate);
      if (
        await this.#sql.link(tx, {
          parentIno,
          name: candidate,
          ino: copyIno,
          type: 'f',
          uid: cred.uid,
        })
      )
        name = candidate;
    }
    if (name === null) throw new VfsError('EEXIST', { reason: 'conflict-names' });
    await this.#sql.addUsage(tx, cred.uid, this.#op.size, 1);
    const dir = await this.#sql.touchDir(tx, parentIno, 0);
    dirs.push(parentIno);
    changes.push(
      {
        kind: 'upsert',
        ino: copyIno,
        version: stamp.version,
        parentIno,
        name,
        type: 'f',
        mode,
        uid: cred.uid,
        gid: cred.gid,
        size: this.#op.size,
        nlink: 1,
        blob: this.#op.blob,
        mtime: stamp.mtimeMs,
        ctime: stamp.ctimeMs,
      },
      createdDir === null
        ? {
            kind: 'upsert',
            ino: parentIno,
            version: dir.version,
            type: 'd',
            ...(parentRow === undefined
              ? {}
              : { mode: parentRow.mode, uid: parentRow.uid, gid: parentRow.gid }),
            nlink: dir.nlink,
            mtime: dir.mtimeMs,
            ctime: dir.ctimeMs,
          }
        : {
            kind: 'upsert',
            ino: parentIno,
            version: dir.version,
            parentIno: createdDir.homeIno,
            name: LOST_FOUND,
            type: 'd',
            mode: LOST_FOUND_MODE,
            uid: cred.uid,
            gid: cred.gid,
            size: 0,
            nlink: dir.nlink,
            mtime: dir.mtimeMs,
            ctime: dir.ctimeMs,
          },
    );
    return {
      status: 'conflict',
      ...(decision.errno === undefined ? {} : { errno: decision.errno }),
      result: {
        keptAs: { ino: copyIno, parentIno, name },
        versions: [{ ino: file.ino, version: file.version }],
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      },
      effects: { changes, dirs },
      owners: [...owners],
    };
  }

  #located(): Location {
    if (this.#where === null) throw new VfsError('ENOENT', { ino: this.#op.ino });
    return this.#where;
  }

  async #credentials(tx: Tx): Promise<Cred> {
    if (this.#cred !== null) return this.#cred;
    const c = await this.#sql.credentials(tx, this.#submit.principal);
    if (c === null) throw new VfsError('EACCES', { reason: 'principal' });
    this.#username = c.username;
    this.#cred = {
      uid: this.#submit.principal,
      gid: c.primaryGid,
      groups: [c.primaryGid, ...c.groups],
    };
    return this.#cred;
  }
}
