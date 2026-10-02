/**
 * `rename` (mv) on the server (database.md §4.11.10; virtual-file-system.md §3.11.2;
 * offline-and-sync.md §3.12.3; DB-03, VFS-10).
 *
 *   plan     the source entry must still name op.ino (else EAGAIN stale-version); the destination
 *            entry, if any, is the victim. L2 (the rename advisory lock) when a directory changes
 *            parent, so concurrent directory moves serialise and the acyclicity trigger sees them.
 *   locks    L3 both parents (and the moved or replaced directory), L4 the moved or replaced file
 *   recheck  vfs/perm checkRename (w+x on both parents, sticky, w on a directory changing parent),
 *            x on the ancestors of both parents; a destination that exists needs `replace` naming
 *            exactly it and its version (else EEXIST, or EAGAIN stale-version); a replaced
 *            directory must be empty and a directory can replace only a directory (ENOTEMPTY,
 *            EISDIR, ENOTDIR); no foreign live lease on the moved or replaced inode (EBUSY);
 *            well-known inodes never move (EPERM). A move into its own subtree is refused by the
 *            trigger (PTC01 -> EINVAL).
 *   body     the victim's single-name unlink, the one-row move, the moved inode's ctime/version,
 *            then each parent once (nlink moves only for a directory that changes parent).
 */
import { sql } from 'kysely';

import type { Change, OpSubmit } from '@plotinium/protocol';
import { checkRename } from '@plotinium/vfs/perm';

import { checkWriteLeases } from '../../engine/locks/fencing.ts';
import { kyselyContentSql } from '../../engine/sync/kysely-content.ts';
import type { StoredResult } from '../../engine/sync/outcome.ts';
import type { OpHandler } from '../tx.ts';
import {
  VfsError,
  type BodyResult,
  type Ino,
  type InodeRow,
  type LockPlan,
  type Locked,
  type OpContext,
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
  touchDir,
  uids,
  upsertOf,
  versionOf,
  type Tx,
} from './common.ts';

type RenameOp = Extract<OpSubmit['op'], { kind: 'rename' }>;

export class RenameHandler implements OpHandler<Tx, StoredResult> {
  readonly #op: RenameOp;
  readonly #submit: OpSubmit;
  #victim: Ino | null = null;

  constructor(submit: OpSubmit, op: RenameOp) {
    this.#submit = submit;
    this.#op = op;
  }

  async plan(tx: Tx, extraOwners: readonly number[]): Promise<LockPlan> {
    const op = this.#op;
    const from = await ownerOf(tx, op.fromParentIno);
    const to = await ownerOf(tx, op.toParentIno);
    if (from === null) throw new VfsError('ENOENT', { ino: op.fromParentIno });
    if (to === null) throw new VfsError('ENOENT', { ino: op.toParentIno });
    const src = await entryOf(tx, op.fromParentIno, op.fromName);
    if (src === null)
      throw new VfsError('ENOENT', { parentIno: op.fromParentIno, name: op.fromName });
    if (src.ino !== op.ino) throw new VfsError('EAGAIN', { reason: 'stale-version', ino: op.ino });
    const dst = await entryOf(tx, op.toParentIno, op.toName);
    this.#victim = dst === null || dst.ino === op.ino ? null : dst.ino;
    const dirs: Ino[] = [op.fromParentIno, op.toParentIno];
    const files: Ino[] = [];
    (src.dType === 'd' ? dirs : files).push(op.ino);
    if (dst !== null && dst.ino !== op.ino) (dst.dType === 'd' ? dirs : files).push(dst.ino);
    return {
      owners: [
        from.uid,
        to.uid,
        src.ownerUid,
        ...(dst === null ? [] : [dst.ownerUid]),
        ...extraOwners,
      ],
      renameLock: src.dType === 'd' && op.fromParentIno !== op.toParentIno,
      dirs,
      files,
      subtreeRoots: [],
    };
  }

  async recheck(tx: Tx, op: OpContext, locked: Locked): Promise<void> {
    const o = this.#op;
    const srcParent = lockedRow(locked, o.fromParentIno);
    const dstParent = lockedRow(locked, o.toParentIno);
    const moved = lockedRow(locked, o.ino);
    if (dstParent.type !== 'd') throw new VfsError('ENOTDIR', { ino: dstParent.ino });
    if (isWellKnown(moved.ino))
      throw new VfsError('EPERM', { reason: 'well-known', ino: moved.ino });
    const victim: InodeRow | null = this.#victim === null ? null : lockedRow(locked, this.#victim);
    if (victim !== null) {
      if (o.replace === undefined)
        throw new VfsError('EEXIST', { parentIno: o.toParentIno, name: o.toName });
      if (o.replace.ino !== victim.ino || o.replace.version !== victim.version)
        throw new VfsError('EAGAIN', { reason: 'stale-version', ino: victim.ino });
      if (isWellKnown(victim.ino))
        throw new VfsError('EPERM', { reason: 'well-known', ino: victim.ino });
      if (victim.type === 'd' && moved.type !== 'd')
        throw new VfsError('EISDIR', { ino: victim.ino });
      if (victim.type !== 'd' && moved.type === 'd')
        throw new VfsError('ENOTDIR', { ino: victim.ino });
      if (victim.type === 'd' && !(await isEmptyDir(tx, victim.ino)))
        throw new VfsError('ENOTEMPTY', { ino: victim.ino });
    }
    const cred = await credOf(tx, op);
    const denied = checkRename(
      cred,
      srcParent,
      moved,
      dstParent,
      victim,
      o.fromParentIno === o.toParentIno,
    );
    if (denied !== null) throw new VfsError(denied, { ino: moved.ino });
    await checkTraverse(tx, cred, srcParent.ino);
    if (dstParent.ino !== srcParent.ino) await checkTraverse(tx, cred, dstParent.ino);
    const targets = [moved, ...(victim === null ? [] : [victim])].map((r) => ({
      ino: r.ino,
      lockFence: r.lock_fence,
    }));
    const verdict = checkWriteLeases({
      osSessionId: op.osSessionId,
      fences: this.#submit.fences ?? [],
      targets,
      leases: await kyselyContentSql.leasesOn(
        tx,
        targets.map((t) => t.ino),
      ),
      bulk: false,
    });
    if (!verdict.ok) throw new VfsError('EBUSY', { reason: verdict.reason, ino: verdict.ino });
  }

  async body(tx: Tx, locked: Locked): Promise<BodyResult<StoredResult>> {
    const o = this.#op;
    const moved = lockedRow(locked, o.ino);
    const victim = this.#victim === null ? null : lockedRow(locked, this.#victim);
    const changes: Change[] = [];
    const owners = [moved.uid];

    if (victim !== null) {
      // (a) the single-name unlink of the destination (database.md §4.11.8).
      const r = await sql<{ deleted_owner: number | null }>`
        WITH d AS (DELETE FROM dentries WHERE parent_ino = ${o.toParentIno}::uuid AND name = ${o.toName}
                   RETURNING ino, d_type),
        del AS (DELETE FROM inodes i USING d WHERE i.ino = d.ino AND (i.type = 'd' OR i.nlink = 1)
                RETURNING i.uid, i.size, i.blob_id),
        keep AS (UPDATE inodes i SET nlink = i.nlink - 1, changed_at = now(), version = i.version + 1
                 FROM d WHERE i.ino = d.ino AND i.type <> 'd' AND i.nlink > 1 RETURNING i.ino),
        q AS (UPDATE users u SET used_bytes = u.used_bytes - del.size, used_inodes = u.used_inodes - 1
              FROM del WHERE u.uid = del.uid RETURNING u.uid),
        b AS (UPDATE blobs b SET refcount = b.refcount - 1,
                                 zero_since = CASE WHEN b.refcount - 1 = 0 THEN now() END
              FROM del WHERE b.blob_id = del.blob_id RETURNING b.blob_id)
        SELECT (SELECT uid FROM del LIMIT 1) AS deleted_owner`.execute(tx);
      owners.push(victim.uid);
      if (r.rows[0]?.deleted_owner !== undefined && r.rows[0].deleted_owner !== null)
        owners.push(r.rows[0].deleted_owner);
      changes.push({
        kind: 'unlink',
        ino: victim.ino,
        version: victim.version,
        parentIno: o.toParentIno,
        name: o.toName,
        type: victim.type,
      });
    }

    // (b) the move itself; the acyclicity trigger fires if a directory changes parent.
    const movedRow = await sql<{ ino: string }>`
      UPDATE dentries SET parent_ino = ${o.toParentIno}::uuid, name = ${o.toName}
      WHERE parent_ino = ${o.fromParentIno}::uuid AND name = ${o.fromName}
      RETURNING ino`.execute(tx);
    if (movedRow.rows.length !== 1)
      throw new VfsError('ENOENT', { parentIno: o.fromParentIno, name: o.fromName });
    await sql`
      UPDATE inodes SET changed_at = now(), version = version + 1 WHERE ino = ${o.ino}::uuid`.execute(
      tx,
    );

    // (c) each parent once: a directory changing parent moves one link; a replaced directory
    // takes one from the destination.
    const deltas = new Map<Ino, number>([
      [o.fromParentIno, 0],
      [o.toParentIno, 0],
    ]);
    if (moved.type === 'd' && o.fromParentIno !== o.toParentIno) {
      deltas.set(o.fromParentIno, (deltas.get(o.fromParentIno) ?? 0) - 1);
      deltas.set(o.toParentIno, (deltas.get(o.toParentIno) ?? 0) + 1);
    }
    if (victim?.type === 'd') deltas.set(o.toParentIno, (deltas.get(o.toParentIno) ?? 0) - 1);
    for (const [dir, delta] of deltas) await touchDir(tx, dir, delta);

    const rows = await fullRows(tx, [o.ino, ...deltas.keys()]);
    const m = rows.get(o.ino);
    if (m === undefined) throw new VfsError('EIO', { reason: 'server' });
    changes.push({
      kind: 'move',
      ino: m.ino,
      version: m.version,
      fromParentIno: o.fromParentIno,
      fromName: o.fromName,
      parentIno: o.toParentIno,
      name: o.toName,
      type: m.type,
      mode: m.mode,
      uid: m.uid,
      gid: m.gid,
      ctime: m.ctimeMs,
    });
    const versions = [versionOf(m)];
    for (const dir of deltas.keys()) {
      const p = rows.get(dir);
      if (p === undefined) continue;
      changes.push(upsertOf(p));
      versions.push(versionOf(p));
      owners.push(p.uid);
    }
    return {
      status: 'applied',
      result: { versions },
      effects: { changes, dirs: [...deltas.keys()] },
      owners: uids(owners),
    };
  }
}
