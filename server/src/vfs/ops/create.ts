/**
 * `create` (mkdir, create, symlink) on the server (database.md §4.11.14; virtual-file-system.md
 * §3.10, §3.7.1; offline-and-sync.md §3.3; VFS-06).
 *
 *   plan     the parent's owner (lock-free)                        L1 {principal, parent owner}
 *   locks    L3 the parent
 *   recheck  parent is a directory (ENOTDIR), w+x on it and x on every ancestor (EACCES)
 *   body     a file takes its blob (0 rows -> retry EAGAIN blob-missing; size must match), the
 *            inode (client UUIDv7 kept), the entry (a taken name -> EEXIST, rejected and
 *            persisted), the parent (version, mtime, nlink + 1 for a directory), the quota
 *            (the users CHECK raises EDQUOT, root exempt)
 * The new inode belongs to the principal; its group is the principal's primary group, or the
 * parent's when the parent has the setgid bit. setuid/setgid bits are never created.
 */
import { sql } from 'kysely';

import type { OpSubmit } from '@plotinium/protocol';
import { checkCreate, type Cred } from '@plotinium/vfs/perm';

import { kyselyContentSql } from '../../engine/sync/kysely-content.ts';
import type { StoredResult } from '../../engine/sync/outcome.ts';
import type { OpHandler } from '../tx.ts';
import { VfsError, type BodyResult, type LockPlan, type Locked, type OpContext } from '../types.ts';
import {
  addUsage,
  checkTraverse,
  credOf,
  fullRows,
  lockedRow,
  MTIME_CLAMP_MS,
  ownerOf,
  touchDir,
  txNow,
  uids,
  upsertOf,
  versionOf,
  type Tx,
} from './common.ts';

type CreateOp = Extract<OpSubmit['op'], { kind: 'create' }>;

const SETGID = 0o2000;

export class CreateHandler implements OpHandler<Tx, StoredResult> {
  readonly #op: CreateOp;
  #cred: Cred | null = null;
  #parentGid = 0;
  #parentSetgid = false;

  constructor(op: CreateOp) {
    this.#op = op;
  }

  async plan(tx: Tx, extraOwners: readonly number[]): Promise<LockPlan> {
    const parent = await ownerOf(tx, this.#op.parentIno);
    if (parent === null) throw new VfsError('ENOENT', { ino: this.#op.parentIno });
    return {
      owners: [parent.uid, ...extraOwners],
      renameLock: false,
      dirs: [this.#op.parentIno],
      files: [],
      subtreeRoots: [],
    };
  }

  async recheck(tx: Tx, op: OpContext, locked: Locked): Promise<void> {
    const parent = lockedRow(locked, this.#op.parentIno);
    if (parent.type !== 'd') throw new VfsError('ENOTDIR', { ino: parent.ino });
    const cred = await credOf(tx, op);
    const denied = checkCreate(cred, parent);
    if (denied !== null) throw new VfsError(denied, { ino: parent.ino });
    await checkTraverse(tx, cred, parent.ino);
    if (this.#op.type === 'l' && this.#op.symlinkTarget === undefined)
      throw new VfsError('EINVAL', { reason: 'symlink-target' });
    this.#cred = cred;
    this.#parentGid = parent.gid;
    this.#parentSetgid = (parent.mode & SETGID) !== 0;
  }

  async body(tx: Tx, _locked: Locked): Promise<BodyResult<StoredResult>> {
    const op = this.#op;
    const cred = this.#cred;
    if (cred === null) throw new VfsError('EIO', { reason: 'server' });
    const gid = this.#parentSetgid ? this.#parentGid : cred.gid;
    const mode =
      op.type === 'l'
        ? 0o777
        : (op.mode & 0o1777) | (op.type === 'd' && this.#parentSetgid ? SETGID : 0);

    let size = 0;
    let blobId: number | null = null;
    if (op.type === 'f' && op.blob !== undefined) {
      const blob = await kyselyContentSql.takeBlob(tx, op.blob);
      if (blob === null) throw new VfsError('EAGAIN', { reason: 'blob-missing', sha256: op.blob });
      if (op.size !== undefined && blob.size !== op.size)
        throw new VfsError('EINVAL', { reason: 'size-mismatch' });
      size = blob.size;
      blobId = blob.blobId;
    } else if (op.type === 'f' && (op.size ?? 0) !== 0) {
      throw new VfsError('EINVAL', { reason: 'size-without-blob' });
    }
    const target = op.type === 'l' ? (op.symlinkTarget ?? null) : null;
    if (target !== null) size = Buffer.byteLength(target, 'utf8');

    const commitMs = await txNow(tx);
    const mtimeMs = Math.min(op.mtime, commitMs + MTIME_CLAMP_MS);
    await sql`
      INSERT INTO inodes (ino, type, mode, uid, gid, size, nlink, blob_id, symlink_target, modified_at)
      VALUES (${op.ino}::uuid, ${op.type}, ${mode}, ${cred.uid}, ${gid}, ${size},
              ${op.type === 'd' ? 2 : 1}, ${blobId}, ${target},
              to_timestamp(${mtimeMs}::double precision / 1000))`.execute(tx);
    const linked = await sql<{ ino: string }>`
      INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid)
      VALUES (${op.parentIno}::uuid, ${op.name}, ${op.ino}::uuid, ${op.type}, ${cred.uid})
      ON CONFLICT ON CONSTRAINT dentries_pkey DO NOTHING
      RETURNING ino`.execute(tx);
    if (linked.rows.length !== 1)
      throw new VfsError('EEXIST', { parentIno: op.parentIno, name: op.name });
    await touchDir(tx, op.parentIno, op.type === 'd' ? 1 : 0);
    await addUsage(tx, cred.uid, size, 1);

    const rows = await fullRows(tx, [op.ino, op.parentIno]);
    const node = rows.get(op.ino);
    const parent = rows.get(op.parentIno);
    if (node === undefined || parent === undefined) throw new VfsError('EIO', { reason: 'server' });
    return {
      status: 'applied',
      result: { versions: [versionOf(node), versionOf(parent)] },
      effects: {
        changes: [upsertOf(node, { parentIno: op.parentIno, name: op.name }), upsertOf(parent)],
        dirs: [op.parentIno],
      },
      owners: uids([cred.uid, parent.uid]),
    };
  }
}
