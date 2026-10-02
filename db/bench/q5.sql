-- Q5: total size of a subtree, `du` (DB-05; database.md §4.11.5). A recursive CTE, not a
-- maintained aggregate (§3.28); IN (...) counts a hard-linked inode once. Expected plan: recursive
-- union with an Index Only Scan on dentries_pkey (Heap Fetches 0) + Nested Loop Index Scan on
-- inodes_pkey. Grows linearly with the subtree (about 3.3 ms per 1,000 nodes at 100k inodes;
-- pilot figure — re-measure on the lab machine).
-- $1 = subtree root inode
PREPARE q5 (uuid) AS
WITH RECURSIVE sub(ino, d_type) AS (
  SELECT $1::uuid, 'd'::text
  UNION ALL
  SELECT d.ino, d.d_type FROM sub s JOIN dentries d ON d.parent_ino = s.ino WHERE s.d_type = 'd'
)
SELECT count(*) AS inodes, coalesce(sum(i.size), 0) AS bytes
FROM inodes i WHERE i.ino IN (SELECT ino FROM sub);
