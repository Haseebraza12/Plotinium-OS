SET search_path = vfs, public;
TRUNCATE file_chunks;
SELECT setseed(0.7);
-- 20,000 chunks of 384-d unit vectors attached to random files of all users
INSERT INTO file_chunks (ino, seq, line_start, text, content_hash, embedding)
SELECT f.ino, g.s, g.s * 40, 'chunk', '\x00'::bytea,
       l2_normalize(ARRAY(SELECT random() - 0.5 FROM generate_series(1, 384) WHERE g.s IS NOT NULL AND f.ino IS NOT NULL)::vector)
FROM (SELECT ino FROM inodes WHERE type = 'f' ORDER BY random() LIMIT 5000) f
CROSS JOIN generate_series(1, 4) AS g(s);
ANALYZE file_chunks;
SELECT count(*) AS chunks, pg_size_pretty(pg_total_relation_size('file_chunks')) AS size FROM file_chunks;
