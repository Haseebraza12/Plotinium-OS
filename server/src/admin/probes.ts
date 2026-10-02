/**
 * The integrity probes P1-P9 and the canonical subtree checksum behind GET /api/admin/probes
 * (backend-api.md §3.15, §4.3 Probes; database.md §3.29, §4.15; VFS-11, DB-02, DBD-13).
 *
 * The same nine queries as db/probes/integrity.sql (the psql file stays the source for CI, the
 * restore drill and developers), run in ONE `REPEATABLE READ READ ONLY` transaction so they all see
 * the same snapshot. Every probe must return zero rows; `violations` lists what they found.
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../db/types.gen.ts';

export interface Probes {
  readonly rootIno: string;
  readonly checksum: string;
  readonly orphanInodes: number;
  readonly danglingEntries: number;
  readonly quotaDrift: readonly {
    readonly uid: number;
    readonly bytes: number;
    readonly inodes: number;
  }[];
  readonly refcountDrift: readonly {
    readonly sha256: string;
    readonly stored: number;
    readonly actual: number;
  }[];
  /** Every probe row (probe name and detail); empty when the tree is sound. */
  readonly violations: readonly { readonly probe: string; readonly detail: string }[];
}

export interface AdminDb {
  /** The owner of an OS session, or null when it does not exist. */
  osSessionOwner(osSessionId: string): Promise<number | null>;
  /** null when `root` is not a directory inode. */
  probes(root: string): Promise<Probes | null>;
  /** audit_log row written by the harness (actor 'system'). */
  audit(e: {
    readonly uid: number;
    readonly realUid: number;
    readonly osSessionId: string | null;
    readonly syscall: string;
    readonly outcome: 'ok' | 'attempt' | 'denied';
    readonly detail: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}

export class KyselyAdminDb implements AdminDb {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async osSessionOwner(osSessionId: string): Promise<number | null> {
    const r = await sql<{ owner_uid: number }>`
      SELECT owner_uid FROM os_sessions WHERE os_session_id = ${osSessionId}::uuid`.execute(
      this.#db,
    );
    return r.rows[0]?.owner_uid ?? null;
  }

  async audit(e: Parameters<AdminDb['audit']>[0]): Promise<void> {
    await sql`
      INSERT INTO audit_log (uid, real_uid, actor, os_session_id, syscall, outcome, detail)
      VALUES (${e.uid}, ${e.realUid}, 'system', ${e.osSessionId}::uuid, ${e.syscall}, ${e.outcome},
              ${JSON.stringify(e.detail)}::jsonb)`.execute(this.#db);
  }

  probes(root: string): Promise<Probes | null> {
    return this.#db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (tx) => {
        const dir = await sql<{ type: string }>`
          SELECT type FROM inodes WHERE ino = ${root}::uuid`.execute(tx);
        if (dir.rows[0]?.type !== 'd') return null;
        const checksum = await sql<{
          c: string;
        }>`SELECT plt_tree_checksum(${root}::uuid) AS c`.execute(tx);
        const v = await sql<{ probe: string; detail: string }>`
          SELECT 'P1_orphan' AS probe, i.ino::text AS detail FROM inodes i
           WHERE NOT EXISTS (SELECT 1 FROM dentries d WHERE d.ino = i.ino) AND i.ino <> ${root}::uuid
          UNION ALL
          SELECT 'P2_parentless', d.parent_ino::text || '/' || d.name FROM dentries d
           WHERE NOT EXISTS (SELECT 1 FROM inodes p WHERE p.ino = d.parent_ino)
          UNION ALL
          (WITH RECURSIVE reach(ino) AS (
             SELECT ${root}::uuid
             UNION
             SELECT d.ino FROM dentries d JOIN reach r ON d.parent_ino = r.ino)
           SELECT 'P3_unreachable', i.ino::text FROM inodes i
            WHERE NOT EXISTS (SELECT 1 FROM reach r WHERE r.ino = i.ino))
          UNION ALL
          SELECT 'P4_nlink', i.ino::text || ' has ' || i.nlink || ' expected ' ||
                 CASE WHEN i.type = 'd' THEN 2 + (SELECT count(*) FROM dentries c WHERE c.parent_ino = i.ino AND c.d_type = 'd')
                      ELSE (SELECT count(*) FROM dentries n WHERE n.ino = i.ino) END
            FROM inodes i
           WHERE i.nlink <> CASE WHEN i.type = 'd' THEN 2 + (SELECT count(*) FROM dentries c WHERE c.parent_ino = i.ino AND c.d_type = 'd')
                                 ELSE (SELECT count(*) FROM dentries n WHERE n.ino = i.ino) END
          UNION ALL
          SELECT 'P5_quota', u.uid::text || ':' || (u.used_bytes - coalesce(a.bytes, 0)) || ':' ||
                 (u.used_inodes - coalesce(a.n, 0))
            FROM users u LEFT JOIN (SELECT uid, sum(size) AS bytes, count(*) AS n FROM inodes GROUP BY uid) a ON a.uid = u.uid
           WHERE u.used_bytes <> coalesce(a.bytes, 0) OR u.used_inodes <> coalesce(a.n, 0)
          UNION ALL
          SELECT 'P6_refcount', encode(b.sha256, 'hex') || ':' || b.refcount || ':' || coalesce(r.n, 0)
            FROM blobs b LEFT JOIN (SELECT blob_id, count(*) AS n FROM inodes WHERE blob_id IS NOT NULL GROUP BY blob_id) r
                 ON r.blob_id = b.blob_id
           WHERE b.refcount <> coalesce(r.n, 0)
          UNION ALL
          SELECT 'P7_blob_size', i.ino::text FROM inodes i JOIN blobs b ON b.blob_id = i.blob_id WHERE i.size <> b.size
          UNION ALL
          SELECT 'P8_feed_gap', u.uid::text FROM users u
           WHERE (SELECT count(*) FROM feed f WHERE f.owner_uid = u.uid) <> u.feed_seq - u.feed_purged_seq
              OR EXISTS (SELECT 1 FROM feed f WHERE f.owner_uid = u.uid AND (f.owner_seq <= u.feed_purged_seq OR f.owner_seq > u.feed_seq))
          UNION ALL
          SELECT 'P9_pending_op', op_id::text FROM op_log WHERE status = 'pending'`.execute(tx);
        const violations = v.rows;
        const count = (p: string): number => violations.filter((x) => x.probe === p).length;
        const quotaDrift = violations
          .filter((x) => x.probe === 'P5_quota')
          .map((x) => {
            const [uid = '0', bytes = '0', inodes = '0'] = x.detail.split(':');
            return { uid: Number(uid), bytes: Number(bytes), inodes: Number(inodes) };
          });
        const refcountDrift = violations
          .filter((x) => x.probe === 'P6_refcount')
          .map((x) => {
            const [sha256 = '', stored = '0', actual = '0'] = x.detail.split(':');
            return { sha256, stored: Number(stored), actual: Number(actual) };
          });
        return {
          rootIno: root,
          checksum: checksum.rows[0]?.c ?? '',
          orphanInodes: count('P1_orphan'),
          danglingEntries: count('P2_parentless') + count('P3_unreachable'),
          quotaDrift,
          refcountDrift,
          violations,
        };
      });
  }
}
