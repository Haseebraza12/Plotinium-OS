/**
 * Reference bulk operations: the normative statements of database.md §4.11.8-§4.11.13, run in one
 * transaction with the fault GUCs set exactly as `vfsTxn` sets them (§3.14 rule 5: after locks and
 * checks, immediately before the op's statements).
 *
 * This driver proves the database half of DB-02 (trigger, atomic rollback, probes) independently
 * of the server. TODO(R2/R5): add a second driver that goes through server/src/vfs/tx.ts
 * (`vfsTxn`) once it lands, and run the same matrix against both.
 */
import type { PoolClient, Pool } from '../support/sql.ts';
import { inTransaction } from '../support/sql.ts';

import { faultAfter, type CountedTable } from './matrix.ts';

export interface Move {
  sp: string;
  sn: string;
  dp: string;
  dn: string;
}

export type OpBody = (c: PoolClient) => Promise<void>;

/** Runs `body` with the fault armed at `failAt`; returns the node ops the trigger counted. */
export async function runWithFault(
  pool: Pool,
  on: CountedTable,
  failAt: number,
  body: OpBody,
): Promise<number> {
  return inTransaction(pool, async (c) => {
    await c.query(
      `SELECT set_config('plotinium.fault_on', $1, true), set_config('plotinium.fault_after', $2, true)`,
      [on, String(faultAfter(failAt))],
    );
    await body(c);
    const r = await c.query<{ n: string | null }>(
      `SELECT current_setting('plotinium.fault_count', true) AS n`,
    );
    const n = r.rows[0]?.n;
    return n === null || n === undefined || n === '' ? 0 : Number(n);
  });
}

const touchParent = `UPDATE inodes SET modified_at = now(), changed_at = now(), version = version + 1,
       nlink = nlink + $2::int WHERE ino = $1`;

/** §4.11.8 rm -r of `parent/name` (a directory). */
export function rmR(parent: string, name: string): OpBody {
  return async (c) => {
    await c.query(
      `WITH RECURSIVE sub(parent_ino, name, ino, d_type) AS (
         SELECT d.parent_ino, d.name, d.ino, d.d_type FROM dentries d WHERE d.parent_ino = $1 AND d.name = $2
         UNION ALL
         SELECT c.parent_ino, c.name, c.ino, c.d_type FROM sub s JOIN dentries c ON c.parent_ino = s.ino WHERE s.d_type = 'd'),
       del_d AS (DELETE FROM dentries d USING sub s WHERE d.parent_ino = s.parent_ino AND d.name = s.name RETURNING d.ino),
       links AS (SELECT ino, count(*) AS removed FROM del_d GROUP BY ino),
       del_i AS (DELETE FROM inodes i USING links l WHERE i.ino = l.ino AND (i.type = 'd' OR i.nlink = l.removed)
                 RETURNING i.ino, i.uid, i.size, i.blob_id, i.version),
       kept AS (UPDATE inodes i SET nlink = i.nlink - l.removed, changed_at = now(), version = i.version + 1
                FROM links l WHERE i.ino = l.ino AND i.type <> 'd' AND i.nlink > l.removed RETURNING i.ino, i.uid),
       quota AS (UPDATE users u SET used_bytes = u.used_bytes - q.bytes, used_inodes = u.used_inodes - q.n
                 FROM (SELECT uid, sum(size) AS bytes, count(*) AS n FROM del_i GROUP BY uid) q WHERE u.uid = q.uid RETURNING u.uid),
       refs AS (UPDATE blobs b SET refcount = b.refcount - r.n, zero_since = CASE WHEN b.refcount - r.n = 0 THEN now() END
                FROM (SELECT blob_id, count(*) AS n FROM del_i WHERE blob_id IS NOT NULL GROUP BY blob_id) r
                WHERE b.blob_id = r.blob_id RETURNING b.blob_id)
       SELECT (SELECT count(*) FROM del_d) AS names_removed, (SELECT count(*) FROM del_i) AS inodes_removed,
              (SELECT count(*) FROM kept) AS links_kept`,
      [parent, name],
    );
    await c.query(touchParent, [parent, -1]);
  };
}

/** §4.11.9 cp -r of `parent/name` to `dstParent/dstName` as `uid:gid` with `umask`. */
export function cpR(
  parent: string,
  name: string,
  dstParent: string,
  dstName: string,
  uid: number,
  gid: number,
  umask = 0o022,
): OpBody {
  return async (c) => {
    await c.query(
      `WITH RECURSIVE sub(depth, parent_ino, name, ino, d_type) AS (
         SELECT 0, d.parent_ino, d.name, d.ino, d.d_type FROM dentries d WHERE d.parent_ino = $1 AND d.name = $2
         UNION ALL
         SELECT s.depth + 1, c.parent_ino, c.name, c.ino, c.d_type FROM sub s JOIN dentries c ON c.parent_ino = s.ino WHERE s.d_type = 'd'),
       m AS MATERIALIZED (SELECT s.*, uuidv7() AS new_ino FROM sub s),
       ins_i AS (
         INSERT INTO inodes (ino, type, mode, uid, gid, size, nlink, blob_id, symlink_target)
         SELECT m.new_ino, i.type, CASE WHEN i.type = 'l' THEN 511 ELSE i.mode & 511 & ~ $7::int END, $5, $6, i.size,
                CASE WHEN i.type = 'd' THEN i.nlink ELSE 1 END, i.blob_id, i.symlink_target
         FROM m JOIN inodes i ON i.ino = m.ino
         RETURNING ino, size, blob_id),
       ins_d AS (
         INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid)
         SELECT CASE WHEN m.depth = 0 THEN $3::uuid ELSE p.new_ino END, CASE WHEN m.depth = 0 THEN $4 ELSE m.name END,
                m.new_ino, m.d_type, $5
         FROM m LEFT JOIN m p ON p.ino = m.parent_ino AND p.d_type = 'd'
         RETURNING ino),
       quota AS (UPDATE users u SET used_bytes = u.used_bytes + q.bytes, used_inodes = u.used_inodes + q.n
                 FROM (SELECT coalesce(sum(size), 0) AS bytes, count(*) AS n FROM ins_i) q WHERE u.uid = $5 RETURNING u.uid),
       refs AS (UPDATE blobs b SET refcount = b.refcount + r.n, zero_since = NULL, first_ref_at = coalesce(b.first_ref_at, now())
                FROM (SELECT blob_id, count(*) AS n FROM ins_i WHERE blob_id IS NOT NULL GROUP BY blob_id) r
                WHERE b.blob_id = r.blob_id RETURNING b.blob_id)
       SELECT (SELECT count(*) FROM ins_i) AS inodes_created, (SELECT count(*) FROM ins_d) AS names_created`,
      [parent, name, dstParent, dstName, uid, gid, umask],
    );
    await c.query(touchParent, [dstParent, 1]);
  };
}

/** §4.11.11 single-phase batch rename (also the 1,000-file `mv`): one dentry UPDATE, then parents. */
export function moveBatch(moves: readonly Move[]): OpBody {
  return async (c) => {
    const res = await c.query(
      `WITH v AS (SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[]) AS t(sp, sn, dp, dn))
       UPDATE dentries d SET parent_ino = v.dp, name = v.dn FROM v WHERE d.parent_ino = v.sp AND d.name = v.sn`,
      [
        moves.map((m) => m.sp),
        moves.map((m) => m.sn),
        moves.map((m) => m.dp),
        moves.map((m) => m.dn),
      ],
    );
    if (res.rowCount !== moves.length)
      throw new Error(`ENOENT: moved ${res.rowCount} of ${moves.length}`);
    const parents = [...new Set(moves.flatMap((m) => [m.sp, m.dp]))];
    await c.query(
      `UPDATE inodes SET modified_at = now(), changed_at = now(), version = version + 1 WHERE ino = ANY($1::uuid[])`,
      [parents],
    );
  };
}

/** §4.11.10 mv of one directory to another parent: the dentry, then both parents' nlink. */
export function moveDir(sp: string, sn: string, dp: string, dn: string): OpBody {
  return async (c) => {
    const res = await c.query(
      `UPDATE dentries SET parent_ino = $3, name = $4 WHERE parent_ino = $1 AND name = $2 RETURNING ino, d_type`,
      [sp, sn, dp, dn],
    );
    if (res.rowCount !== 1) throw new Error('ENOENT');
    await c.query(
      `UPDATE inodes SET modified_at = now(), changed_at = now(), version = version + 1,
              nlink = nlink + CASE WHEN $1::uuid <> $2::uuid THEN CASE WHEN ino = $2::uuid THEN 1 ELSE -1 END ELSE 0 END
       WHERE ino IN ($1, $2)`,
      [sp, dp],
    );
  };
}

/** §4.11.12 chmod -R: clear, set and symbolic-X masks. */
export function chmodR(parent: string, name: string, clear: number, set: number, setX = 0): OpBody {
  return async (c) => {
    await c.query(
      `WITH RECURSIVE sub(ino, d_type) AS (
         SELECT d.ino, d.d_type FROM dentries d WHERE d.parent_ino = $1 AND d.name = $2
         UNION ALL
         SELECT c.ino, c.d_type FROM sub s JOIN dentries c ON c.parent_ino = s.ino WHERE s.d_type = 'd')
       UPDATE inodes i
          SET mode = (i.mode & ~ $3::int | $4::int | CASE WHEN i.type = 'd' OR (i.mode & 73) <> 0 THEN $5::int ELSE 0 END),
              changed_at = now(), version = i.version + 1
         FROM (SELECT DISTINCT ino FROM sub) s
        WHERE i.ino = s.ino AND i.type <> 'l'`,
      [parent, name, clear, set, setX],
    );
  };
}

/** §4.11.13 chown -R (root only): moves quota between the old and the new owner. */
export function chownR(
  parent: string,
  name: string,
  uid: number | null,
  gid: number | null,
): OpBody {
  return async (c) => {
    await c.query(
      `WITH RECURSIVE sub(ino, d_type) AS (
         SELECT d.ino, d.d_type FROM dentries d WHERE d.parent_ino = $1 AND d.name = $2
         UNION ALL
         SELECT c.ino, c.d_type FROM sub s JOIN dentries c ON c.parent_ino = s.ino WHERE s.d_type = 'd'),
       old AS (SELECT i.ino, i.uid AS old_uid FROM inodes i WHERE i.ino IN (SELECT ino FROM sub)),
       upd AS (UPDATE inodes i SET uid = coalesce($3, i.uid), gid = coalesce($4, i.gid), changed_at = now(), version = i.version + 1
               FROM old WHERE i.ino = old.ino RETURNING i.ino, old.old_uid, i.uid AS new_uid, i.size),
       moves AS (SELECT uid, sum(db) AS db, sum(dn) AS dn FROM (
                   SELECT old_uid AS uid, -size AS db, -1 AS dn FROM upd WHERE old_uid <> new_uid
                   UNION ALL
                   SELECT new_uid, size, 1 FROM upd WHERE old_uid <> new_uid) x GROUP BY uid)
       UPDATE users u SET used_bytes = u.used_bytes + m.db, used_inodes = u.used_inodes + m.dn FROM moves m WHERE u.uid = m.uid`,
      [parent, name, uid, gid],
    );
  };
}
