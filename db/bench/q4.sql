-- Q4: a user's files changed in the last 7 days, newest first (DB-05; database.md §4.11.4).
-- Expected plan: Index Scan on inodes_uid_mtime (Index Cond on uid and modified_at; Filter
-- type = 'f') + LIMIT 50 + one Index Scan on dentries_ino per row.
-- $1 = uid; $2 = "now" (production passes now(); the benchmark passes the seed epoch
-- 2026-09-24T12:00:00Z so results stay deterministic on later dates).
PREPARE q4 (integer, timestamptz) AS
SELECT i.ino, i.size, i.modified_at, i.version, n.parent_ino, n.name
FROM inodes i
CROSS JOIN LATERAL (SELECT d.parent_ino, d.name FROM dentries d WHERE d.ino = i.ino LIMIT 1) n
WHERE i.uid = $1 AND i.type = 'f' AND i.modified_at >= $2::timestamptz - interval '7 days'
ORDER BY i.modified_at DESC
LIMIT 50;
