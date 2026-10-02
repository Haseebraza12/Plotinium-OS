-- Plotinium migration 1: extensions, schema grant, advisory-lock keys, permission predicate.
-- Spec: specs/09-database/database.md §4.2 (DB-01). Owner R2, reviewer R5.
-- Kind: expand (additive; safe for the previous release to run on).
-- The role plotinium_app is cluster-wide and is created by the db init hook
-- (ops/db/initdb.d/10-app-role.sh), never by a migration (database.md §3.2, §4.1).

-- migrate:up
CREATE EXTENSION IF NOT EXISTS vector;              -- pgvector 0.8.6: vector(384) for file_chunks
CREATE EXTENSION IF NOT EXISTS btree_gist;          -- uuid/text equality inside the locks EXCLUDE constraint
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- server-side timings for DB-05
GRANT USAGE ON SCHEMA public TO plotinium_app;
-- dbmate creates schema_migrations before the first migration runs. The server reads the newest
-- applied version for its startup self-test and /api/readyz (backend-api.md §3.16, §3.18.2).
GRANT SELECT ON TABLE schema_migrations TO plotinium_app;

-- Advisory-lock keys shared by the application (lockPlan L2, index.put, blob GC) and by triggers.
-- One function per key so the application and the database can never disagree on the number.
CREATE FUNCTION plt_rename_lock_key() RETURNS bigint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT hashtextextended('plotinium:vfs.rename', 0) $$;
CREATE FUNCTION plt_index_put_lock_key() RETURNS bigint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT hashtextextended('plotinium:index.put', 0) $$;
-- blobKey(sha256) (backend-api.md §3.10, cross-spec request to database.md): held by PUT /api/blobs
-- and by the blob GC around the existence check, the rename or unlink, and the row change.
CREATE FUNCTION plt_blob_lock_key(p_sha256 bytea) RETURNS bigint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT hashtextextended('plotinium:blob:' || encode(p_sha256, 'hex'), 0) $$;

-- Permission predicate: a line-for-line mirror of vfs/perm.ts may() (C3, syscall-abi).
-- want: 4 = r, 2 = w, 1 = x. c_gids = primary gid plus supplementary gids of the caller.
-- Root rule (critic): root gets r and w always, and x on a file only if some x bit is set.
CREATE FUNCTION plt_may(p_type text, p_mode integer, p_uid integer, p_gid integer,
                        c_uid integer, c_gids integer[], want integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT CASE
      WHEN c_uid = 0            THEN (want & 1) = 0 OR p_type = 'd' OR (p_mode & 73) <> 0  -- 73 = 0o111
      WHEN c_uid = p_uid        THEN ((p_mode >> 6) & want) = want
      WHEN p_gid = ANY (c_gids) THEN ((p_mode >> 3) & want) = want
      ELSE (p_mode & want) = want
    END
  $$;

-- migrate:down
DROP FUNCTION plt_may(text, integer, integer, integer, integer, integer[], integer);
DROP FUNCTION plt_blob_lock_key(bytea);
DROP FUNCTION plt_index_put_lock_key();
DROP FUNCTION plt_rename_lock_key();
REVOKE SELECT ON TABLE schema_migrations FROM plotinium_app;
REVOKE USAGE ON SCHEMA public FROM plotinium_app;
DROP EXTENSION IF EXISTS pg_stat_statements;
DROP EXTENSION IF EXISTS btree_gist;
DROP EXTENSION IF EXISTS vector;
