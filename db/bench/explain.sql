-- db/bench/explain.sql: EXPLAIN (ANALYZE, BUFFERS) of Q1-Q5 and Qb for canonical parameters drawn
-- from the bench seed's fixtures (database.md §3.28 step 5). Run from the repository root on a
-- seeded plotinium_bench database, for example:
--   docker compose exec -T db psql -v ON_ERROR_STOP=1 -U plotinium_owner -d plotinium_bench < db/bench/explain.sql
-- (psql's \i paths are relative to the working directory; this script inlines nothing, it
--  expects the q*.sql files to be piped first, see db/bench/README.md).
SET plan_cache_mode = force_custom_plan;

-- Canonical parameters: user01's fixtures (the first fixture user of every profile).
SELECT d.ino AS home FROM dentries d
 WHERE d.parent_ino = '00000000-0000-7000-8000-000000000008' AND d.name = 'user01' \gset
SELECT ino AS big500 FROM dentries WHERE parent_ino = :'home' AND name = 'big500' \gset
SELECT ino AS fixtures FROM dentries WHERE parent_ino = :'home' AND name = 'fixtures' \gset
SELECT ino AS tree1000 FROM dentries WHERE parent_ino = :'fixtures' AND name = 'tree1000' \gset
SELECT encode(sha256, 'hex') AS blobsha FROM blobs ORDER BY blob_id LIMIT 1 \gset

\echo === Q1 resolve /home/user01/q1/a/b/c/d/e (8 components)
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q1('00000000-0000-7000-8000-000000000001', ARRAY['home','user01','q1','a','b','c','d','e']);
\echo === Q2 list big500 by name
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q2(:'big500');
\echo === Q3 prefix 'ärg' across user01's names
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q3(1001, 'ärg');
\echo === Q4 user01's files changed in the 7 days before the seed epoch
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q4(1001, '2026-09-24T12:00:00Z');
\echo === Q5 du of tree1000
EXPLAIN (ANALYZE, BUFFERS) EXECUTE q5(:'tree1000');
\echo === Qb blob lookup by sha256
EXPLAIN (ANALYZE, BUFFERS) EXECUTE qb(decode(:'blobsha', 'hex'));
