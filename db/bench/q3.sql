-- Q3: prefix search across one user's names (DB-05; database.md §4.11.3). Expected plan: Index
-- Scan on dentries_owner_lname with Index Cond owner_uid = ... AND lower(name) ~>=~ ... AND
-- lower(name) ~<~ ..., NO Sort (ORDER BY ... USING ~<~ is the index order), LIMIT 50.
-- $1 = uid; $2 = the user's prefix with \ % _ escaped by the caller (LIKE's default escape is \).
-- lower() runs in SQL with the column's collation (pg_c_utf8 simple case mapping), never in JS.
-- The prefix must be known at plan time for the index range: run with a custom plan
-- (SET plan_cache_mode = force_custom_plan for a named prepared statement, as here).
PREPARE q3 (integer, text) AS
SELECT d.parent_ino, d.name, d.ino, d.d_type
FROM dentries d
WHERE d.owner_uid = $1
  AND lower(d.name) LIKE lower($2::text COLLATE pg_c_utf8) || '%'
ORDER BY lower(d.name) USING ~<~
LIMIT 50;
