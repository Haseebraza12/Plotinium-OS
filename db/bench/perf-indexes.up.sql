-- db/bench/perf-indexes.up.sql: back to the DB-05 "after indexes" state (database.md §4.14).
-- Recreates exactly what perf-indexes.down.sql dropped, with the migration's definitions.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'plotinium_bench' THEN
    RAISE EXCEPTION 'perf-index toggle runs only on plotinium_bench';
  END IF;
END $$;
ALTER TABLE dentries ADD CONSTRAINT dentries_pkey PRIMARY KEY (parent_ino, name) INCLUDE (ino, d_type);
CREATE UNIQUE INDEX dentries_dir_one_parent ON dentries (ino) WHERE d_type = 'd';
CREATE INDEX dentries_ino ON dentries (ino);
CREATE INDEX dentries_owner_lname ON dentries (owner_uid, lower(name) text_pattern_ops);
CREATE INDEX inodes_uid_mtime ON inodes (uid, modified_at DESC);
CREATE INDEX blobs_sha256_hash ON blobs USING hash (sha256);
COMMIT;
VACUUM (ANALYZE);
