-- db/bench/perf-indexes.down.sql: the DB-05 "before indexes" state (database.md §3.25, §4.14).
-- Drops exactly the spec §11.4 indexes. Runs ONLY on the bench database: rolling back a migration
-- works only while it is the newest, so the before/after benchmark toggles indexes instead.
-- The "before" state is READ-ONLY: with dentries_pkey dropped, uniqueness is not enforced.
-- After `down` then `up`, the normalised schema dump MUST equal db/schema.sql (CI check).
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'plotinium_bench' THEN
    RAISE EXCEPTION 'perf-index toggle runs only on plotinium_bench';
  END IF;
END $$;
ALTER TABLE dentries DROP CONSTRAINT dentries_pkey;
DROP INDEX dentries_dir_one_parent, dentries_ino, dentries_owner_lname, inodes_uid_mtime, blobs_sha256_hash;
COMMIT;
ANALYZE;
