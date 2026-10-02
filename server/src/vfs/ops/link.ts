/**
 * `link` (a hard link) on the server (virtual-file-system.md §3.7.2; database.md §4.11.14).
 *
 *   locks    L3 the new parent, L4 the file
 *   recheck  vfs/perm checkLink: w+x on the new parent, a regular file (EPERM), owner or r+w on
 *            the file (protected_hardlinks); x on the parent's ancestors; a taken name is EEXIST
 *   body     the entry, nlink + 1 and ctime on the file, the parent's version and mtime. Quota is
 *            unchanged: the inode is the same.
 */
import { sql } from 'kysely';

import type { OpSubmit } from '@plotinium/protocol';
import { checkLink } from '@plotinium/vfs/perm';

import type { StoredResult } from '../../engine/sync/outcome.ts';
import type { OpHandler } from '../tx.ts';
import { VfsError, type BodyResult, type LockPlan, type Locked, type OpContext } from '../types.ts';
import {
  checkTraverse,
  credOf,
  fullRows,
  lockedRow,
  ownerOf,
  touchDir,
  uids,
  upsertOf,
  versionOf,
  type Tx,
} from './common.ts';

type LinkOp = Extract<OpSubmit['op'], { kind: 'link' }>;

export class LinkHandler implements OpHandler<Tx, StoredResult> {
  readonly #op: LinkOp;

  constructor(op: LinkOp) {
    this.#op = op;
  }

  async plan(tx: Tx, extraOwners: readonly number[]): Promise<LockPlan> {
    const parent = await ownerOf(tx, this.#op.parentIno);
    const file = await ownerOf(tx, this.#op.ino);
    if (parent === null) throw new VfsError('ENOENT', { ino: this.#op.parentIno });
    if (file === null) throw new VfsError('ENOENT', { ino: this.#op.ino });
    if (file.type === 'd') throw new VfsError('EPERM', { reason: 'directory', ino: this.#op.ino });
    return {
      owners: [parent.uid, file.uid, ...extraOwners],
      renameLock: false,
      dirs: [this.#op.parentIno],
      files: [this.#op.ino],
      subtreeRoots: [],
    };
  }

  async recheck(tx: Tx, op: OpContext, locked: Locked): Promise<void> {
    const parent = lockedRow(locked, this.#op.parentIno);
    const file = lockedRow(locked, this.#op.ino);
    if (parent.type !== 'd') throw new VfsError('ENOTDIR', { ino: parent.ino });
    const cred = await credOf(tx, op);
    const denied = checkLink(cred, file, parent);
    if (denied !== null) throw new VfsError(denied, { ino: file.ino });
    await checkTraverse(tx, cred, parent.ino);
  }

  async body(tx: Tx, locked: Locked): Promise<BodyResult<StoredResult>> {
    const o = this.#op;
    const file = lockedRow(locked, o.ino);
    const linked = await sql<{ ino: string }>`
      INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid)
      VALUES (${o.parentIno}::uuid, ${o.name}, ${o.ino}::uuid, ${file.type}, ${file.uid})
      ON CONFLICT ON CONSTRAINT dentries_pkey DO NOTHING
      RETURNING ino`.execute(tx);
    if (linked.rows.length !== 1)
      throw new VfsError('EEXIST', { parentIno: o.parentIno, name: o.name });
    await sql`
      UPDATE inodes SET nlink = nlink + 1, changed_at = now(), version = version + 1
      WHERE ino = ${o.ino}::uuid`.execute(tx);
    await touchDir(tx, o.parentIno, 0);
    const rows = await fullRows(tx, [o.ino, o.parentIno]);
    const f = rows.get(o.ino);
    const p = rows.get(o.parentIno);
    if (f === undefined || p === undefined) throw new VfsError('EIO', { reason: 'server' });
    return {
      status: 'applied',
      result: { versions: [versionOf(f), versionOf(p)] },
      effects: {
        changes: [upsertOf(f, { parentIno: o.parentIno, name: o.name }), upsertOf(p)],
        dirs: [o.parentIno],
      },
      owners: uids([f.uid, p.uid]),
    };
  }
}
