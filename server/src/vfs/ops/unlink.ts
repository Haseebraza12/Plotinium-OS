/**
 * `unlink` (unlink, rmdir, rm -r) on the server (database.md §4.11.7, §4.11.8; virtual-file-system.md
 * §3.11; offline-and-sync.md §3.12.3; DB-02, DB-03, VFS-10).
 *
 *   plan     the entry (parent, name) must still name op.ino (else EAGAIN stale-version: someone
 *            replaced it since the client planned); lock-free subtree for rm -r
 *   locks    L1 the parent's owner and every owner in the subtree; L3 the parent and every
 *            directory of the subtree; L4 every non-directory; re-planned under the locks
 *   recheck  w+x on the parent and the sticky rule (EACCES / EPERM), x on every ancestor, r+w+x on
 *            every directory of an rm -r subtree, an empty directory for a plain unlink
 *            (ENOTEMPTY), no live lease of another OS session on anything removed (EBUSY),
 *            well-known inodes are never removed (EPERM). The base versions are checked by
 *            withBaseCheck before this runs.
 *   body     one set-based statement (names, inodes whose every name is gone, nlink of hard links
 *            that keep a name elsewhere, quota, blob refcounts; locks and file_chunks rows go by
 *            cascade), then the parent as the last node op.
 */
import { sql } from 'kysely';

import type { Change, OpSubmit } from '@plotinium/protocol';
import { checkRemove, checkSubtreeDir } from '@plotinium/vfs/perm';

import { checkWriteLeases } from '../../engine/locks/fencing.ts';
import { kyselyContentSql } from '../../engine/sync/kysely-content.ts';
import type { StoredResult } from '../../engine/sync/outcome.ts';
import type { OpHandler } from '../tx.ts';
import {
  VfsError,
  type BodyResult,
  type Ino,
  type LockPlan,
  type Locked,
  type OpContext,
  type Uid,
} from '../types.ts';
import {
  checkTraverse,
  credOf,
  entryOf,
  fullRows,
  isEmptyDir,
  isWellKnown,
  lockedRow,
  ownerOf,
  subtreeOf,
  touchDir,
  uids,
  upsertOf,
  versionOf,
  type Tx,
} from './common.ts';

type UnlinkOp = Extract<OpSubmit['op'], { kind: 'unlink' }>;

export class UnlinkHandler implements OpHandler<Tx, StoredResult> {
  readonly #op: UnlinkOp;
  readonly #submit: OpSubmit;
  #type: 'f' | 'd' | 'l' = 'f';
  #subtree: readonly { ino: Ino; type: 'f' | 'd' | 'l'; uid: Uid }[] = [];

  constructor(submit: OpSubmit, op: UnlinkOp) {
    this.#submit = submit;
    this.#op = op;
  }

  async plan(tx: Tx, extraOwners: readonly number[]): Promise<LockPlan> {
    const op = this.#op;
    const parent = await ownerOf(tx, op.parentIno);
    if (parent === null) throw new VfsError('ENOENT', { ino: op.parentIno });
    const entry = await entryOf(tx, op.parentIno, op.name);
    if (entry === null) throw new VfsError('ENOENT', { parentIno: op.parentIno, name: op.name });
    if (entry.ino !== op.ino)
      throw new VfsError('EAGAIN', { reason: 'stale-version', ino: op.ino });
    this.#type = entry.dType;
    const recursive = op.recursive && entry.dType === 'd';
    this.#subtree = recursive
      ? await subtreeOf(tx, op.ino)
      : [{ ino: op.ino, type: entry.dType, uid: entry.ownerUid }];
    return {
      owners: [parent.uid, ...this.#subtree.map((n) => n.uid), ...extraOwners],
      renameLock: false,
      dirs: [op.parentIno, ...this.#subtree.filter((n) => n.type === 'd').map((n) => n.ino)],
      files: this.#subtree.filter((n) => n.type !== 'd').map((n) => n.ino),
      subtreeRoots: [{ parent: op.parentIno, name: op.name }],
    };
  }

  /** rm -r: the subtree re-collected under the locks until stable (new directories, owners). */
  async replan(tx: Tx, locked: Locked): Promise<{ dirs: readonly Ino[]; owners: readonly Uid[] }> {
    if (!(this.#op.recursive && this.#type === 'd')) {
      return { dirs: locked.plan.dirs, owners: locked.plan.owners };
    }
    this.#subtree = await subtreeOf(tx, this.#op.ino);
    return {
      dirs: [this.#op.parentIno, ...this.#subtree.filter((n) => n.type === 'd').map((n) => n.ino)],
      owners: this.#subtree.map((n) => n.uid),
    };
  }

  async recheck(tx: Tx, op: OpContext, locked: Locked): Promise<void> {
    const parent = lockedRow(locked, this.#op.parentIno);
    const target = lockedRow(locked, this.#op.ino);
    if (isWellKnown(target.ino))
      throw new VfsError('EPERM', { reason: 'well-known', ino: target.ino });
    const cred = await credOf(tx, op);
    const denied = checkRemove(cred, parent, target);
    if (denied !== null) throw new VfsError(denied, { ino: target.ino });
    await checkTraverse(tx, cred, parent.ino);
    const recursive = this.#op.recursive && target.type === 'd';
    if (target.type === 'd' && !recursive && !(await isEmptyDir(tx, target.ino)))
      throw new VfsError('ENOTEMPTY', { ino: target.ino });
    if (recursive) {
      // Files hard-linked from outside are unlinked here but kept there, so they need no lock
      // beyond L4; every directory must be enumerable and writable (r, w, x).
      for (const n of this.#subtree) {
        const row = locked.rows.get(n.ino);
        if (row === undefined) continue;
        if (isWellKnown(row.ino))
          throw new VfsError('EPERM', { reason: 'well-known', ino: row.ino });
        if (row.type === 'd') {
          const d = checkSubtreeDir(cred, row);
          if (d !== null) throw new VfsError(d, { ino: row.ino });
        }
      }
    }
    const targets = this.#subtree.map((n) => ({
      ino: n.ino,
      lockFence: locked.rows.get(n.ino)?.lock_fence ?? 0,
    }));
    const verdict = checkWriteLeases({
      osSessionId: op.osSessionId,
      fences: this.#submit.fences ?? [],
      targets,
      leases: await kyselyContentSql.leasesOn(
        tx,
        targets.map((t) => t.ino),
      ),
      bulk: recursive,
    });
    if (!verdict.ok) throw new VfsError('EBUSY', { reason: verdict.reason, ino: verdict.ino });
  }

  async body(tx: Tx, locked: Locked): Promise<BodyResult<StoredResult>> {
    const op = this.#op;
    const target = lockedRow(locked, op.ino);
    const recursive = op.recursive && target.type === 'd';
    const r = await sql<{
      names_removed: number | string;
      deleted_owners: number[] | null;
      kept: string[] | null;
      kept_owners: number[] | null;
    }>`
      WITH RECURSIVE sub(parent_ino, name, ino, d_type, depth) AS (
        SELECT d.parent_ino, d.name, d.ino, d.d_type, 0 FROM dentries d
        WHERE d.parent_ino = ${op.parentIno}::uuid AND d.name = ${op.name}
        UNION ALL
        SELECT c.parent_ino, c.name, c.ino, c.d_type, s.depth + 1
        FROM sub s JOIN dentries c ON c.parent_ino = s.ino
        WHERE ${recursive}::boolean AND s.d_type = 'd' AND s.depth < 4096
      ),
      del_d AS (
        DELETE FROM dentries d USING sub s
        WHERE d.parent_ino = s.parent_ino AND d.name = s.name
        RETURNING d.ino
      ),
      links AS (SELECT ino, count(*) AS removed FROM del_d GROUP BY ino),
      del_i AS (
        DELETE FROM inodes i USING links l
        WHERE i.ino = l.ino AND (i.type = 'd' OR i.nlink = l.removed)
        RETURNING i.ino, i.uid, i.size, i.blob_id
      ),
      kept AS (
        UPDATE inodes i SET nlink = i.nlink - l.removed, changed_at = now(), version = i.version + 1
        FROM links l
        WHERE i.ino = l.ino AND i.type <> 'd' AND i.nlink > l.removed
        RETURNING i.ino, i.uid
      ),
      quota AS (
        UPDATE users u SET used_bytes = u.used_bytes - q.bytes, used_inodes = u.used_inodes - q.n
        FROM (SELECT uid, sum(size) AS bytes, count(*) AS n FROM del_i GROUP BY uid) q
        WHERE u.uid = q.uid
        RETURNING u.uid
      ),
      refs AS (
        UPDATE blobs b SET refcount = b.refcount - r.n,
                           zero_since = CASE WHEN b.refcount - r.n = 0 THEN now() END
        FROM (SELECT blob_id, count(*) AS n FROM del_i WHERE blob_id IS NOT NULL GROUP BY blob_id) r
        WHERE b.blob_id = r.blob_id
        RETURNING b.blob_id
      )
      SELECT (SELECT count(*) FROM del_d) AS names_removed,
             (SELECT array_agg(DISTINCT uid) FROM del_i) AS deleted_owners,
             (SELECT array_agg(ino::text) FROM kept) AS kept,
             (SELECT array_agg(DISTINCT uid) FROM kept) AS kept_owners`.execute(tx);
    const row = r.rows[0];
    if (row === undefined || Number(row.names_removed) === 0)
      throw new VfsError('ENOENT', { parentIno: op.parentIno, name: op.name });
    await touchDir(tx, op.parentIno, target.type === 'd' ? -1 : 0);

    const keptInos = row.kept ?? [];
    const rows = await fullRows(tx, [op.parentIno, ...keptInos]);
    const parent = rows.get(op.parentIno);
    if (parent === undefined) throw new VfsError('EIO', { reason: 'server' });
    const changes: Change[] = [
      {
        kind: 'unlink',
        ino: target.ino,
        version: target.version,
        parentIno: op.parentIno,
        name: op.name,
        type: target.type,
        ...(target.type === 'd' ? { subtree: true } : {}),
      },
    ];
    const versions = [versionOf(parent)];
    for (const ino of keptInos) {
      const k = rows.get(ino);
      if (k === undefined) continue;
      changes.push(upsertOf(k));
      versions.push(versionOf(k));
    }
    changes.push(upsertOf(parent));
    return {
      status: 'applied',
      result: { versions },
      effects: { changes, dirs: [op.parentIno] },
      owners: uids([
        parent.uid,
        target.uid,
        ...(row.deleted_owners ?? []),
        ...(row.kept_owners ?? []),
      ]),
    };
  }
}
