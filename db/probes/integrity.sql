-- db/probes/integrity.sql: the nine integrity probes P1-P9 (VFS-11, DB-02, DB-03; DBD-13).
-- Spec: specs/09-database/database.md §3.29 and §4.15. Owner R2, reviewer R5.
--
-- EVERY PROBE MUST RETURN ZERO ROWS. The nine run in ONE `REPEATABLE READ READ ONLY` transaction,
-- so they all see the same snapshot. They run after every DB-02 and DB-03 test, in the restore
-- drill, and behind `fsck --server` (GET /api/admin/probes, root only).
--
-- Usage (psql):
--   psql -v ON_ERROR_STOP=1 -f db/probes/integrity.sql                 -- root = the well-known '/'
--   psql -v ON_ERROR_STOP=1 -v root=<uuid> -f db/probes/integrity.sql  -- another root
-- The output is one row per violation: (probe, detail). An empty result means the tree is sound.

\if :{?root}
\else
  \set root '00000000-0000-7000-8000-000000000001'
\endif

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- P1 orphan inodes: an inode with no name (root excluded)
SELECT 'P1_orphan' AS probe, i.ino::text AS detail FROM inodes i
 WHERE NOT EXISTS (SELECT 1 FROM dentries d WHERE d.ino = i.ino) AND i.ino <> :'root'
UNION ALL
-- P2 parentless dentries (spec 11.3 probe 2; the FK makes this impossible, the probe proves it)
SELECT 'P2_parentless', d.parent_ino::text || '/' || d.name FROM dentries d
 WHERE NOT EXISTS (SELECT 1 FROM inodes p WHERE p.ino = d.parent_ino)
UNION ALL
-- P3 unreachable: not reachable from / (catches detached cycles that P1 and P2 cannot see)
(WITH RECURSIVE reach(ino) AS (
   SELECT :'root'::uuid
   UNION
   SELECT d.ino FROM dentries d JOIN reach r ON d.parent_ino = r.ino)
 SELECT 'P3_unreachable', i.ino::text FROM inodes i WHERE NOT EXISTS (SELECT 1 FROM reach r WHERE r.ino = i.ino))
UNION ALL
-- P4 nlink: files and symlinks = number of names; directories = 2 + number of child directories
SELECT 'P4_nlink', i.ino::text || ' has ' || i.nlink || ' expected ' ||
       CASE WHEN i.type = 'd' THEN 2 + (SELECT count(*) FROM dentries c WHERE c.parent_ino = i.ino AND c.d_type = 'd')
            ELSE (SELECT count(*) FROM dentries n WHERE n.ino = i.ino) END
  FROM inodes i
 WHERE i.nlink <> CASE WHEN i.type = 'd' THEN 2 + (SELECT count(*) FROM dentries c WHERE c.parent_ino = i.ino AND c.d_type = 'd')
                       ELSE (SELECT count(*) FROM dentries n WHERE n.ino = i.ino) END
UNION ALL
-- P5 quota drift: users.used_* equals the owned inodes
SELECT 'P5_quota', u.uid::text || ' used ' || u.used_bytes || '/' || u.used_inodes || ' actual ' ||
       coalesce(a.bytes, 0) || '/' || coalesce(a.n, 0)
  FROM users u LEFT JOIN (SELECT uid, sum(size) AS bytes, count(*) AS n FROM inodes GROUP BY uid) a ON a.uid = u.uid
 WHERE u.used_bytes <> coalesce(a.bytes, 0) OR u.used_inodes <> coalesce(a.n, 0)
UNION ALL
-- P6 blob refcount equals the referencing inodes
SELECT 'P6_refcount', b.blob_id::text || ' refcount ' || b.refcount || ' actual ' || coalesce(r.n, 0)
  FROM blobs b LEFT JOIN (SELECT blob_id, count(*) AS n FROM inodes WHERE blob_id IS NOT NULL GROUP BY blob_id) r
       ON r.blob_id = b.blob_id
 WHERE b.refcount <> coalesce(r.n, 0)
UNION ALL
-- P7 file size equals its blob size
SELECT 'P7_blob_size', i.ino::text FROM inodes i JOIN blobs b ON b.blob_id = i.blob_id WHERE i.size <> b.size
UNION ALL
-- P8 per-owner feed is gap-free up to users.feed_seq
SELECT 'P8_feed_gap', u.uid::text FROM users u
 WHERE (SELECT count(*) FROM feed f WHERE f.owner_uid = u.uid) <> u.feed_seq - u.feed_purged_seq
    OR EXISTS (SELECT 1 FROM feed f WHERE f.owner_uid = u.uid AND (f.owner_seq <= u.feed_purged_seq OR f.owner_seq > u.feed_seq))
UNION ALL
-- P9 no committed op is left pending
SELECT 'P9_pending_op', op_id::text FROM op_log WHERE status = 'pending';

COMMIT;
