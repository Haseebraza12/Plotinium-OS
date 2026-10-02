-- Q2: list a directory sorted by name (DB-05; database.md §4.11.2). Expected plan: Index Only Scan
-- on dentries_pkey, already in name order (pg_c_utf8 = code-point order): NO Sort node; Nested Loop
-- with an Index Scan on inodes_pkey.
-- $1 = directory inode
PREPARE q2 (uuid) AS
SELECT d.name, d.ino, d.d_type, i.mode, i.uid, i.gid, i.size, i.nlink, i.modified_at, i.version, i.symlink_target
FROM dentries d JOIN inodes i ON i.ino = d.ino
WHERE d.parent_ino = $1
ORDER BY d.name;
