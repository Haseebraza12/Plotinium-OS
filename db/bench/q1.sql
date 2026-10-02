-- Q1: resolve a path of depth 8 (DB-05; database.md §4.11.1). Expected plan after indexes: a
-- recursive union with an Index Only Scan on dentries_pkey (Heap Fetches 0) per level and a unique
-- index probe on inodes_pkey per resolved component.
-- $1 = start inode (ROOT or cwd); $2 = the path components after the resolver removed '' and '.'
-- ('..' is handled by the resolver: SELECT parent_ino FROM dentries WHERE ino = $1 AND d_type = 'd').
PREPARE q1 (uuid, text[]) AS
WITH RECURSIVE walk(depth, ino, d_type) AS (
  SELECT 0, $1::uuid, 'd'::text
  UNION ALL
  SELECT w.depth + 1, d.ino, d.d_type
  FROM walk w
  JOIN dentries d ON d.parent_ino = w.ino AND d.name = ($2::text[])[w.depth + 1]
  WHERE w.depth < cardinality($2::text[]) AND w.d_type = 'd'
)
SELECT w.depth, i.ino, i.type, i.mode, i.uid, i.gid, i.size, i.nlink, i.version, i.symlink_target
FROM walk w JOIN inodes i ON i.ino = w.ino
ORDER BY w.depth;
