/**
 * Shared pieces of the structural op handlers (database.md §4.11.7-§4.11.14; offline-and-sync.md
 * §3.3, §3.10, §3.12.3; VFS-10). Every handler runs inside vfsTxn: lock-free `plan`, then L1 users,
 * L2 the rename lock, L3/L4 inodes in ino order, `recheck` against the LOCKED rows with the
 * isomorphic vfs/perm.ts rules, then set-based statements in `body`.
 */
import { sql, type Transaction } from 'kysely';

import { INO, type Change } from '@plotinium/protocol';
import { may, X, type Cred, type PermSubject } from '@plotinium/vfs/perm';

import type { DB } from '../../db/types.gen.ts';
import { kyselyContentSql } from '../../engine/sync/kysely-content.ts';
import { VfsError, type Ino, type Locked, type OpContext, type Uid } from '../types.ts';

export type Tx = Transaction<DB>;

/** Offline edits may not claim an mtime later than this after the commit (offline-and-sync §3.5). */
export const MTIME_CLAMP_MS = 60_000;

/** Well-known directories and synthesised files can be neither removed, renamed nor replaced. */
const WELL_KNOWN: ReadonlySet<string> = new Set(Object.values(INO));

export function isWellKnown(ino: Ino): boolean {
  return WELL_KNOWN.has(ino);
}

/** The principal's credentials, read inside the transaction (never from the client). */
export async function credOf(tx: Tx, op: OpContext): Promise<Cred> {
  const c = await kyselyContentSql.credentials(tx, op.principal.uid);
  if (c === null) throw new VfsError('EACCES', { reason: 'principal' });
  return { uid: op.principal.uid, gid: c.primaryGid, groups: [c.primaryGid, ...c.groups] };
}

/** x on `dirIno` and every ancestor up to '/' (EACCES otherwise). */
export async function checkTraverse(tx: Tx, cred: Cred, dirIno: Ino): Promise<void> {
  for (const a of await kyselyContentSql.ancestors(tx, dirIno)) {
    if (!may(cred, a, X)) throw new VfsError('EACCES', { ino: a.ino });
  }
}

/** The owner of an inode (lock-free), or null when it does not exist. */
export async function ownerOf(
  tx: Tx,
  ino: Ino,
): Promise<{ uid: Uid; type: 'f' | 'd' | 'l' } | null> {
  const r = await sql<{ uid: number; type: 'f' | 'd' | 'l' }>`
    SELECT uid, type FROM inodes WHERE ino = ${ino}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

/** The entry (parent, name), lock-free. */
export async function entryOf(
  tx: Tx,
  parentIno: Ino,
  name: string,
): Promise<{ ino: Ino; dType: 'f' | 'd' | 'l'; ownerUid: Uid } | null> {
  const r = await sql<{ ino: string; d_type: 'f' | 'd' | 'l'; owner_uid: number }>`
    SELECT ino, d_type, owner_uid FROM dentries WHERE parent_ino = ${parentIno}::uuid AND name = ${name}`.execute(
    tx,
  );
  const row = r.rows[0];
  return row === undefined ? null : { ino: row.ino, dType: row.d_type, ownerUid: row.owner_uid };
}

/** One (dentry-less) parent of an inode: the first link in key order; null for '/'. */
export async function parentOf(tx: Tx, ino: Ino): Promise<{ parentIno: Ino; name: string } | null> {
  const r = await sql<{ parent_ino: string; name: string }>`
    SELECT parent_ino, name FROM dentries WHERE ino = ${ino}::uuid ORDER BY parent_ino, name LIMIT 1`.execute(
    tx,
  );
  const row = r.rows[0];
  return row === undefined ? null : { parentIno: row.parent_ino, name: row.name };
}

/** Every node of the subtree rooted at `root` (root included), lock-free or under the locks. */
export async function subtreeOf(
  tx: Tx,
  root: Ino,
): Promise<readonly { ino: Ino; type: 'f' | 'd' | 'l'; uid: Uid }[]> {
  const r = await sql<{ ino: string; type: 'f' | 'd' | 'l'; uid: number }>`
    WITH RECURSIVE sub(ino, d_type, depth) AS (
      SELECT i.ino, i.type, 0 FROM inodes i WHERE i.ino = ${root}::uuid
      UNION ALL
      SELECT c.ino, c.d_type, s.depth + 1 FROM sub s JOIN dentries c ON c.parent_ino = s.ino
      WHERE s.d_type = 'd' AND s.depth < 4096)
    SELECT DISTINCT i.ino, i.type, i.uid FROM sub JOIN inodes i ON i.ino = sub.ino`.execute(tx);
  return r.rows;
}

/** A full inode row as the feed and op.result carry it. */
export interface FullRow extends PermSubject {
  readonly ino: Ino;
  readonly size: number;
  readonly nlink: number;
  readonly version: number;
  readonly blob: string | null;
  readonly symlinkTarget: string | null;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

type Time = Date | string;
const ms = (t: Time): number => (t instanceof Date ? t : new Date(t)).getTime();

export async function fullRows(tx: Tx, inos: readonly Ino[]): Promise<Map<Ino, FullRow>> {
  const out = new Map<Ino, FullRow>();
  if (inos.length === 0) return out;
  const r = await sql<{
    ino: string;
    type: 'f' | 'd' | 'l';
    mode: number;
    uid: number;
    gid: number;
    size: number | string;
    nlink: number;
    version: number | string;
    blob: string | null;
    symlink_target: string | null;
    modified_at: Time;
    changed_at: Time;
  }>`
    SELECT i.ino, i.type, i.mode, i.uid, i.gid, i.size, i.nlink, i.version,
           encode(b.sha256, 'hex') AS blob, i.symlink_target, i.modified_at, i.changed_at
    FROM inodes i LEFT JOIN blobs b ON b.blob_id = i.blob_id
    WHERE i.ino = ANY(${[...new Set(inos)]}::uuid[])`.execute(tx);
  for (const row of r.rows) {
    out.set(row.ino, {
      ino: row.ino,
      type: row.type,
      mode: row.mode,
      uid: row.uid,
      gid: row.gid,
      size: Number(row.size),
      nlink: row.nlink,
      version: Number(row.version),
      blob: row.blob,
      symlinkTarget: row.symlink_target,
      mtimeMs: ms(row.modified_at),
      ctimeMs: ms(row.changed_at),
    });
  }
  return out;
}

/** An `upsert` change carrying every attribute of the row (and its entry, when given). */
export function upsertOf(row: FullRow, entry?: { parentIno: Ino; name: string }): Change {
  return {
    kind: 'upsert',
    ino: row.ino,
    version: row.version,
    ...(entry === undefined ? {} : { parentIno: entry.parentIno, name: entry.name }),
    type: row.type,
    mode: row.mode,
    uid: row.uid,
    gid: row.gid,
    size: row.size,
    nlink: row.nlink,
    ...(row.blob === null ? {} : { blob: row.blob }),
    ...(row.symlinkTarget === null ? {} : { symlinkTarget: row.symlinkTarget }),
    mtime: row.mtimeMs,
    ctime: row.ctimeMs,
  };
}

export function versionOf(row: FullRow): {
  ino: Ino;
  version: number;
  mtime: number;
  ctime: number;
} {
  return { ino: row.ino, version: row.version, mtime: row.mtimeMs, ctime: row.ctimeMs };
}

/** The locked row of `ino`, or ENOENT (it vanished between plan and lock). */
export function lockedRow(
  locked: Locked,
  ino: Ino,
): NonNullable<ReturnType<Locked['rows']['get']>> {
  const row = locked.rows.get(ino);
  if (row === undefined) throw new VfsError('ENOENT', { ino });
  return row;
}

/** The commit time now() of the transaction, in ms. */
export function txNow(tx: Tx): Promise<number> {
  return kyselyContentSql.txNow(tx);
}

/** A directory whose entries changed: version + 1, mtime and ctime now, nlink + delta. */
export async function touchDir(tx: Tx, dirIno: Ino, nlinkDelta: number): Promise<void> {
  await kyselyContentSql.touchDir(tx, dirIno, nlinkDelta);
}

export async function addUsage(tx: Tx, uid: Uid, bytes: number, inodes: number): Promise<void> {
  await kyselyContentSql.addUsage(tx, uid, bytes, inodes);
}

/** Directories must be empty for a plain unlink / rmdir / replace. */
export async function isEmptyDir(tx: Tx, dirIno: Ino): Promise<boolean> {
  const r = await sql<{ n: number }>`
    SELECT 1 AS n FROM dentries WHERE parent_ino = ${dirIno}::uuid LIMIT 1`.execute(tx);
  return r.rows.length === 0;
}

/** Sorted, de-duplicated uids. */
export function uids(xs: Iterable<Uid>): Uid[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}
