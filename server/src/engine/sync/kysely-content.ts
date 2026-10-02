/**
 * The Kysely implementation of ContentSql: the statements of database.md §4.11.15 (content write
 * with version compare-and-swap and conflicted copy), §4.11.14 (create) and §3.13, as typed `sql`
 * templates with bind parameters. Every statement runs on the vfsTxn transaction handle.
 */
import { sql, type Transaction } from 'kysely';

import { INO } from '@plotinium/protocol';

import type { DB } from '../../db/types.gen.ts';
import type { Ino, Uid } from '../../vfs/types.ts';
import type { LeaseState } from '../locks/fencing.ts';
import type {
  ContentSql,
  DirStamp,
  FileContent,
  Location,
  NewFile,
  PermRow,
  Stamp,
} from './content-write.ts';

type Tx = Transaction<DB>;
type Time = Date | string;

const ms = (t: Time): number => (t instanceof Date ? t.getTime() : Date.parse(t));
const num = (n: number | string): number => Number(n);

interface StampRow {
  version: number | string;
  modified_at: Time;
  changed_at: Time;
}
const toStamp = (r: StampRow): Stamp => ({
  version: num(r.version),
  mtimeMs: ms(r.modified_at),
  ctimeMs: ms(r.changed_at),
});

export const kyselyContentSql: ContentSql<Tx> = {
  async locate(tx, ino): Promise<Location | null> {
    const r = await sql<{ owner: number; parent_ino: string; name: string; parent_owner: number }>`
      SELECT i.uid AS owner, d.parent_ino, d.name, p.uid AS parent_owner
      FROM inodes i
      JOIN LATERAL (SELECT parent_ino, name FROM dentries WHERE ino = i.ino ORDER BY parent_ino, name LIMIT 1) d ON true
      JOIN inodes p ON p.ino = d.parent_ino
      WHERE i.ino = ${ino}`.execute(tx);
    const row = r.rows[0];
    return row === undefined
      ? null
      : {
          owner: row.owner,
          parentIno: row.parent_ino,
          name: row.name,
          parentOwner: row.parent_owner,
        };
  },

  async content(tx, ino): Promise<FileContent | null> {
    const r = await sql<{ size: number | string; blob_id: number | string | null; nlink: number }>`
      SELECT size, blob_id, nlink FROM inodes WHERE ino = ${ino}`.execute(tx);
    const row = r.rows[0];
    return row === undefined
      ? null
      : {
          size: num(row.size),
          blobId: row.blob_id === null ? null : num(row.blob_id),
          nlink: row.nlink,
        };
  },

  async ancestors(tx, dirIno): Promise<readonly PermRow[]> {
    const r = await sql<PermRow>`
      WITH RECURSIVE up(ino, depth) AS (
        SELECT ${dirIno}::uuid, 0
        UNION ALL
        SELECT d.parent_ino, up.depth + 1 FROM up JOIN dentries d ON d.ino = up.ino AND d.d_type = 'd'
        WHERE up.depth < 4096)
      SELECT i.ino, i.type, i.mode, i.uid, i.gid FROM up JOIN inodes i ON i.ino = up.ino`.execute(
      tx,
    );
    return r.rows;
  },

  async credentials(tx, uid) {
    const r = await sql<{ username: string; primary_gid: number; groups: number[] | null }>`
      SELECT u.username, u.primary_gid, array(SELECT g.gid FROM user_groups g WHERE g.uid = u.uid) AS groups
      FROM users u WHERE u.uid = ${uid}`.execute(tx);
    const row = r.rows[0];
    return row === undefined
      ? null
      : { username: row.username, primaryGid: row.primary_gid, groups: row.groups ?? [] };
  },

  async leasesOn(tx, inos): Promise<readonly LeaseState[]> {
    if (inos.length === 0) return [];
    const r = await sql<{
      ino: string;
      os_session_id: string;
      mode: string;
      fence: number | string;
      live: boolean;
    }>`
      SELECT ino, os_session_id, mode, fence, lease_expires_at > clock_timestamp() AS live
      FROM locks WHERE ino = ANY(${[...inos]}::uuid[])`.execute(tx);
    return r.rows.map((row) => ({
      ino: row.ino,
      osSessionId: row.os_session_id,
      mode: row.mode === 'X' ? 'X' : 'S',
      fence: num(row.fence),
      live: row.live,
    }));
  },

  async homeOf(tx, username) {
    const r = await sql<{ home: string; lost_found: string | null }>`
      SELECT h.ino AS home, lf.ino AS lost_found
      FROM dentries h
      LEFT JOIN dentries lf ON lf.parent_ino = h.ino AND lf.name = 'lost+found' AND lf.d_type = 'd'
      WHERE h.parent_ino = ${INO.HOME} AND h.name = ${username} AND h.d_type = 'd'`.execute(tx);
    const row = r.rows[0];
    return row === undefined ? null : { homeIno: row.home, lostFoundIno: row.lost_found };
  },

  async txNow(tx) {
    const r = await sql<{ now: Time }>`SELECT now() AS now`.execute(tx);
    const t = r.rows[0]?.now;
    if (t === undefined) throw new Error('now() returned no row');
    return ms(t);
  },

  async takeBlob(tx, sha256) {
    const r = await sql<{ blob_id: number | string; size: number | string }>`
      UPDATE blobs SET refcount = refcount + 1, zero_since = NULL, first_ref_at = coalesce(first_ref_at, now())
      WHERE sha256 = decode(${sha256}, 'hex') RETURNING blob_id, size`.execute(tx);
    const row = r.rows[0];
    return row === undefined ? null : { blobId: num(row.blob_id), size: num(row.size) };
  },

  async releaseBlob(tx, blobId) {
    await sql`
      UPDATE blobs SET refcount = refcount - 1, zero_since = CASE WHEN refcount - 1 = 0 THEN now() END
      WHERE blob_id = ${blobId}`.execute(tx);
  },

  async casWrite(tx, a): Promise<Stamp | null> {
    const r = await sql<StampRow>`
      UPDATE inodes SET blob_id = ${a.blobId}, size = ${a.size}, modified_at = to_timestamp(${a.mtimeMs}::double precision / 1000),
                        changed_at = now(), version = version + 1
      WHERE ino = ${a.ino} AND version = ${a.expectedVersion}
      RETURNING version, modified_at, changed_at`.execute(tx);
    const row = r.rows[0];
    return row === undefined ? null : toStamp(row);
  },

  async addUsage(tx, uid: Uid, bytes: number, inodes: number) {
    if (bytes === 0 && inodes === 0) return;
    await sql`
      UPDATE users SET used_bytes = used_bytes + ${bytes}::bigint, used_inodes = used_inodes + ${inodes}::bigint
      WHERE uid = ${uid}`.execute(tx);
  },

  async insertFile(tx, f: NewFile): Promise<Stamp> {
    const r = await sql<StampRow>`
      INSERT INTO inodes (ino, type, mode, uid, gid, size, nlink, blob_id, modified_at)
      VALUES (${f.ino}, 'f', ${f.mode}, ${f.uid}, ${f.gid}, ${f.size}, 1, ${f.blobId},
              to_timestamp(${f.mtimeMs}::double precision / 1000))
      RETURNING version, modified_at, changed_at`.execute(tx);
    const row = r.rows[0];
    if (row === undefined) throw new Error('inode insert returned no row');
    return toStamp(row);
  },

  async link(tx, d: { parentIno: Ino; name: string; ino: Ino; type: 'f' | 'd'; uid: Uid }) {
    const r = await sql<{ ino: string }>`
      INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid)
      VALUES (${d.parentIno}, ${d.name}, ${d.ino}, ${d.type}, ${d.uid})
      ON CONFLICT ON CONSTRAINT dentries_pkey DO NOTHING
      RETURNING ino`.execute(tx);
    return r.rows.length === 1;
  },

  async createDir(tx, d): Promise<DirStamp> {
    const r = await sql<StampRow & { nlink: number }>`
      INSERT INTO inodes (ino, type, mode, uid, gid, nlink) VALUES (${d.ino}, 'd', ${d.mode}, ${d.uid}, ${d.gid}, 2)
      RETURNING version, nlink, modified_at, changed_at`.execute(tx);
    const row = r.rows[0];
    if (row === undefined) throw new Error('directory insert returned no row');
    return { ...toStamp(row), nlink: row.nlink };
  },

  async touchDir(tx, dirIno, nlinkDelta): Promise<DirStamp> {
    const r = await sql<StampRow & { nlink: number }>`
      UPDATE inodes SET version = version + 1, nlink = nlink + ${nlinkDelta}, modified_at = now(), changed_at = now()
      WHERE ino = ${dirIno} RETURNING version, nlink, modified_at, changed_at`.execute(tx);
    const row = r.rows[0];
    if (row === undefined) throw new Error('directory update returned no row');
    return { ...toStamp(row), nlink: row.nlink };
  },
};
