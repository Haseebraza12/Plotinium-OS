/**
 * Attribute ops on the server: `chmod` (and chmod -R), `chown` (and chown -R, root only) and
 * `utimes` (database.md §4.11.7, §4.11.12, §4.11.13; virtual-file-system.md §3.6, §5.4; VFS-10).
 *
 *   plan     the target (and, recursive, its subtree collected lock-free); its first parent
 *   locks    L1 every owner (and chown's new owner), L3 every directory, L4 every other node;
 *            recursive ops re-collect the subtree under the locks until stable
 *   recheck  x on the ancestors of the target's parent; chmod: owner or root on EVERY node
 *            (EPERM); chown: root only (EPERM); utimes: owner or w (EACCES); no foreign live lease
 *            on a changed node (EBUSY; `subtree-busy` for a recursive op)
 *   body     set-based updates (version + 1 and ctime on every changed row); chown moves quota
 *            between owners in the same statement (dentries.owner_uid follows by ON UPDATE CASCADE)
 * Symbolic chmod modes are evaluated with the default umask 022 (the wire carries no umask).
 */
import { sql } from 'kysely';

import { applyModeChange, parseMode, type Change, type OpSubmit } from '@plotinium/protocol';
import { checkChmod, checkChown, checkUtimes, DEFAULT_UMASK } from '@plotinium/vfs/perm';

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
  fullRows,
  lockedRow,
  MTIME_CLAMP_MS,
  ownerOf,
  parentOf,
  subtreeOf,
  txNow,
  uids,
  upsertOf,
  versionOf,
  type Tx,
} from './common.ts';

type ChmodOp = Extract<OpSubmit['op'], { kind: 'chmod' }>;
type ChownOp = Extract<OpSubmit['op'], { kind: 'chown' }>;
type UtimesOp = Extract<OpSubmit['op'], { kind: 'utimes' }>;
type AttrOp = ChmodOp | ChownOp | UtimesOp;

type Node = { readonly ino: Ino; readonly type: 'f' | 'd' | 'l'; readonly uid: Uid };

const SETID = 0o6000;

abstract class AttrHandler<O extends AttrOp> implements OpHandler<Tx, StoredResult> {
  protected readonly op: O;
  protected readonly submit: OpSubmit;
  protected nodes: readonly Node[] = [];
  #parent: Ino | null = null;

  constructor(submit: OpSubmit, op: O) {
    this.submit = submit;
    this.op = op;
  }

  protected get recursive(): boolean {
    return 'recursive' in this.op && this.op.recursive;
  }

  /** Extra L1 owners (chown's new owner). */
  protected extraOwners(): readonly Uid[] {
    return [];
  }

  async plan(tx: Tx, extraOwners: readonly number[]): Promise<LockPlan> {
    const target = await ownerOf(tx, this.op.ino);
    if (target === null) throw new VfsError('ENOENT', { ino: this.op.ino });
    this.#parent = (await parentOf(tx, this.op.ino))?.parentIno ?? null;
    this.nodes =
      this.recursive && target.type === 'd'
        ? await subtreeOf(tx, this.op.ino)
        : [{ ino: this.op.ino, type: target.type, uid: target.uid }];
    return {
      owners: [...this.nodes.map((n) => n.uid), ...this.extraOwners(), ...extraOwners],
      renameLock: false,
      dirs: this.nodes.filter((n) => n.type === 'd').map((n) => n.ino),
      files: this.nodes.filter((n) => n.type !== 'd').map((n) => n.ino),
      subtreeRoots: [],
    };
  }

  async replan(tx: Tx, locked: Locked): Promise<{ dirs: readonly Ino[]; owners: readonly Uid[] }> {
    const root = lockedRow(locked, this.op.ino);
    if (!(this.recursive && root.type === 'd'))
      return { dirs: locked.plan.dirs, owners: locked.plan.owners };
    this.nodes = await subtreeOf(tx, this.op.ino);
    return {
      dirs: this.nodes.filter((n) => n.type === 'd').map((n) => n.ino),
      owners: [...this.nodes.map((n) => n.uid), ...this.extraOwners()],
    };
  }

  async recheck(tx: Tx, op: OpContext, locked: Locked): Promise<void> {
    const cred = await credOf(tx, op);
    if (this.#parent !== null) await checkTraverse(tx, cred, this.#parent);
    for (const n of this.nodes) {
      const row = locked.rows.get(n.ino);
      if (row === undefined) continue; // files added after the plan are not part of this op
      const denied = this.check(cred, row);
      if (denied !== null) throw new VfsError(denied, { ino: row.ino });
    }
    const targets = this.nodes
      .filter((n) => locked.rows.has(n.ino))
      .map((n) => ({ ino: n.ino, lockFence: locked.rows.get(n.ino)?.lock_fence ?? 0 }));
    const verdict = checkWriteLeases({
      osSessionId: op.osSessionId,
      fences: this.submit.fences ?? [],
      targets,
      leases: await kyselyContentSql.leasesOn(
        tx,
        targets.map((t) => t.ino),
      ),
      bulk: this.recursive,
    });
    if (!verdict.ok) throw new VfsError('EBUSY', { reason: verdict.reason, ino: verdict.ino });
    this.checked(cred.uid);
  }

  protected abstract check(
    cred: { uid: number; gid: number; groups: readonly number[] },
    row: { type: 'f' | 'd' | 'l'; mode: number; uid: number; gid: number },
  ): ReturnType<typeof checkChmod>;

  /** Called once the checks passed, with the principal's uid. */
  protected checked(_uid: Uid): void {}

  abstract body(tx: Tx, locked: Locked): Promise<BodyResult<StoredResult>>;

  /** The op's result and feed entry from the changed rows. */
  protected async finish(
    tx: Tx,
    changed: readonly Ino[],
    extraOwners: readonly Uid[],
  ): Promise<BodyResult<StoredResult>> {
    const rows = await fullRows(tx, changed);
    const changes: Change[] = [];
    const versions = [];
    for (const ino of changed) {
      const r = rows.get(ino);
      if (r === undefined) continue;
      changes.push(upsertOf(r));
      versions.push(versionOf(r));
    }
    return {
      status: 'applied',
      // op.result carries at most 256 versions; the feed entry has every change.
      result: { versions: versions.slice(0, 256) },
      effects: { changes, dirs: [] },
      owners: uids([...[...rows.values()].map((r) => r.uid), ...extraOwners]),
    };
  }
}

export class ChmodHandler extends AttrHandler<ChmodOp> {
  #isRoot = false;

  protected check(
    cred: { uid: number; gid: number; groups: readonly number[] },
    row: { type: 'f' | 'd' | 'l'; mode: number; uid: number; gid: number },
  ) {
    return checkChmod(cred, row);
  }

  protected override checked(uid: Uid): void {
    this.#isRoot = uid === 0;
  }

  async body(tx: Tx, locked: Locked): Promise<BodyResult<StoredResult>> {
    const change =
      'absolute' in this.op.change
        ? ({ op: 'set', bits: this.op.change.absolute & 0o7777 } as const)
        : parseMode(this.op.change.symbolic, DEFAULT_UMASK);
    if (change === undefined) throw new VfsError('EINVAL', { reason: 'mode' });
    const inos: Ino[] = [];
    const modes: number[] = [];
    for (const n of this.nodes) {
      const row = locked.rows.get(n.ino);
      if (row === undefined || row.type === 'l') continue; // a symlink's mode is fixed (0777)
      let mode = applyModeChange(row.mode, change) & 0o7777;
      if (!this.#isRoot) mode &= ~SETID;
      inos.push(row.ino);
      modes.push(mode);
    }
    if (inos.length > 0) {
      await sql`
        UPDATE inodes i SET mode = v.mode, changed_at = now(), version = i.version + 1
        FROM unnest(${inos}::uuid[], ${modes}::smallint[]) AS v(ino, mode)
        WHERE i.ino = v.ino`.execute(tx);
    }
    return this.finish(tx, inos, []);
  }
}

export class ChownHandler extends AttrHandler<ChownOp> {
  protected override extraOwners(): readonly Uid[] {
    return this.op.uid === undefined ? [] : [this.op.uid];
  }

  protected check(cred: { uid: number; gid: number; groups: readonly number[] }) {
    return checkChown(cred);
  }

  async body(tx: Tx, locked: Locked): Promise<BodyResult<StoredResult>> {
    const inos = this.nodes.filter((n) => locked.rows.has(n.ino)).map((n) => n.ino);
    const uid = this.op.uid ?? null;
    const gid = this.op.gid ?? null;
    if (inos.length > 0) {
      await sql`
        WITH old AS (SELECT i.ino, i.uid AS old_uid FROM inodes i WHERE i.ino = ANY(${inos}::uuid[])),
        upd AS (
          UPDATE inodes i SET uid = coalesce(${uid}::int, i.uid), gid = coalesce(${gid}::int, i.gid),
                              changed_at = now(), version = i.version + 1
          FROM old WHERE i.ino = old.ino
          RETURNING i.ino, old.old_uid, i.uid AS new_uid, i.size),
        moves AS (
          SELECT u AS uid, sum(db) AS db, sum(dn) AS dn FROM (
            SELECT old_uid AS u, -size AS db, -1 AS dn FROM upd WHERE old_uid <> new_uid
            UNION ALL
            SELECT new_uid, size, 1 FROM upd WHERE old_uid <> new_uid) x
          GROUP BY u)
        UPDATE users s SET used_bytes = s.used_bytes + m.db, used_inodes = s.used_inodes + m.dn
        FROM moves m WHERE s.uid = m.uid`.execute(tx);
    }
    return this.finish(tx, inos, uid === null ? [] : [uid]);
  }
}

export class UtimesHandler extends AttrHandler<UtimesOp> {
  protected check(
    cred: { uid: number; gid: number; groups: readonly number[] },
    row: { type: 'f' | 'd' | 'l'; mode: number; uid: number; gid: number },
  ) {
    return checkUtimes(cred, row, false);
  }

  async body(tx: Tx, locked: Locked): Promise<BodyResult<StoredResult>> {
    const row = lockedRow(locked, this.op.ino);
    const commitMs = await txNow(tx);
    const mtimeMs = Math.min(this.op.mtime, commitMs + MTIME_CLAMP_MS);
    await sql`
      UPDATE inodes SET modified_at = to_timestamp(${mtimeMs}::double precision / 1000),
                        changed_at = now(), version = version + 1
      WHERE ino = ${row.ino}::uuid`.execute(tx);
    return this.finish(tx, [row.ino], []);
  }
}
