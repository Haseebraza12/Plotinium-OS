-- Plotinium migration 3: the file tree (blobs, inodes, dentries), permission helpers, the
-- acyclicity trigger, the fault-injection hook and the canonical tree checksum.
-- Spec: specs/09-database/database.md §4.4 (DB-01..DB-04, DBD-02, DBD-04, DBD-06, DBD-13).
-- Kind: expand.

-- migrate:up
CREATE TABLE blobs (
  blob_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256       bytea  NOT NULL CONSTRAINT blobs_sha256_len CHECK (octet_length(sha256) = 32),
  size         bigint NOT NULL CONSTRAINT blobs_size_nonneg CHECK (size >= 0),
  storage_key  text   NOT NULL,                          -- FsBlobStore key: blobs/sha256/ab/cd/<hex>
  refcount     integer NOT NULL DEFAULT 0 CONSTRAINT blobs_refcount_nonneg CHECK (refcount >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  first_ref_at timestamptz,                              -- NULL = never referenced (GC after 1 h)
  zero_since   timestamptz DEFAULT now(),                -- set while refcount = 0 (GC after 14 days)
  CONSTRAINT blobs_sha256_key UNIQUE (sha256),           -- B-tree: integrity + ON CONFLICT target
  CONSTRAINT blobs_zero_since_iff CHECK ((refcount = 0) = (zero_since IS NOT NULL))
);
CREATE INDEX blobs_sha256_hash ON blobs USING hash (sha256);        -- spec 11.4 de-duplication lookup
CREATE INDEX blobs_gc ON blobs (zero_since) WHERE refcount = 0;      -- GC sweep

CREATE TABLE inodes (
  ino            uuid PRIMARY KEY DEFAULT uuidv7(),      -- C5: UUIDv7 everywhere; client-supplied when created offline
  type           text NOT NULL CONSTRAINT inodes_type_valid CHECK (type IN ('f','d','l')),
  mode           smallint NOT NULL CONSTRAINT inodes_mode_range CHECK (mode BETWEEN 0 AND 4095),
  uid            integer NOT NULL CONSTRAINT inodes_uid_fk REFERENCES users (uid),
  gid            integer NOT NULL CONSTRAINT inodes_gid_fk REFERENCES groups (gid),
  size           bigint  NOT NULL DEFAULT 0 CONSTRAINT inodes_size_nonneg CHECK (size >= 0),
  nlink          integer NOT NULL DEFAULT 1 CONSTRAINT inodes_nlink_nonneg CHECK (nlink >= 0),
  version        bigint  NOT NULL DEFAULT 1 CONSTRAINT inodes_version_pos CHECK (version >= 1),
  blob_id        bigint CONSTRAINT inodes_blob_fk REFERENCES blobs (blob_id),
  symlink_target text,
  lock_fence     bigint NOT NULL DEFAULT 0 CONSTRAINT inodes_fence_nonneg CHECK (lock_fence >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  modified_at    timestamptz NOT NULL DEFAULT now(),     -- mtime
  changed_at     timestamptz NOT NULL DEFAULT now(),     -- ctime
  accessed_at    timestamptz NOT NULL DEFAULT now(),     -- atime (relatime policy, see VFS spec)
  CONSTRAINT inodes_symlink_iff_target CHECK ((type = 'l') = (symlink_target IS NOT NULL)),
  CONSTRAINT inodes_symlink_target_nonempty CHECK (symlink_target <> ''),
  CONSTRAINT inodes_symlink_target_len CHECK (octet_length(symlink_target) <= 4096),
  CONSTRAINT inodes_blob_only_files CHECK (type = 'f' OR blob_id IS NULL),
  CONSTRAINT inodes_file_content    CHECK (type <> 'f' OR blob_id IS NOT NULL OR size = 0),
  CONSTRAINT inodes_dir_size_zero   CHECK (type <> 'd' OR size = 0),
  CONSTRAINT inodes_symlink_size    CHECK (type <> 'l' OR size = octet_length(symlink_target)),
  CONSTRAINT inodes_ino_type_key     UNIQUE (ino, type),       -- FK target: a parent must be a directory
  CONSTRAINT inodes_ino_type_uid_key UNIQUE (ino, type, uid)   -- FK target: dentries (ino, d_type, owner_uid)
) WITH (autovacuum_vacuum_insert_scale_factor = 0.02);
CREATE INDEX inodes_uid_mtime ON inodes (uid, modified_at DESC);          -- Q4, quota reports
CREATE INDEX inodes_blob ON inodes (blob_id) WHERE blob_id IS NOT NULL;   -- blob GC FK check, refcount probe

CREATE TABLE dentries (
  parent_ino  uuid NOT NULL,
  parent_type text NOT NULL DEFAULT 'd' CONSTRAINT dentries_parent_is_dir CHECK (parent_type = 'd'),
  name        text COLLATE pg_c_utf8 NOT NULL,
  ino         uuid NOT NULL,
  d_type      text NOT NULL,                             -- copy of inodes.type, pinned by dentries_child_fk
  owner_uid   integer NOT NULL,                          -- copy of inodes.uid, pinned by dentries_child_fk (Q3)
  CONSTRAINT dentries_pkey PRIMARY KEY (parent_ino, name) INCLUDE (ino, d_type),
  CONSTRAINT dentries_name_nonempty CHECK (name <> ''),
  CONSTRAINT dentries_name_len      CHECK (octet_length(name) <= 255),
  CONSTRAINT dentries_name_chars    CHECK (strpos(name, '/') = 0 AND name NOT IN ('.', '..')),
  CONSTRAINT dentries_name_nfc      CHECK (name IS NFC NORMALIZED),
  CONSTRAINT dentries_parent_fk FOREIGN KEY (parent_ino, parent_type) REFERENCES inodes (ino, type),
  CONSTRAINT dentries_child_fk  FOREIGN KEY (ino, d_type, owner_uid) REFERENCES inodes (ino, type, uid)
                                ON UPDATE CASCADE
) WITH (autovacuum_vacuum_insert_scale_factor = 0.02);
CREATE UNIQUE INDEX dentries_dir_one_parent ON dentries (ino) WHERE d_type = 'd';  -- no directory hard links; '..' and ancestor walks
CREATE INDEX dentries_ino ON dentries (ino);                                      -- reverse lookup: hard links, citations, FK checks
CREATE INDEX dentries_owner_lname ON dentries (owner_uid, lower(name) text_pattern_ops);  -- Q3

-- RAG-03 helpers used by the index API (rag-semantic-search.md 4.5): permission of the CURRENT inode row.
CREATE FUNCTION may_r(i inodes, c_uid integer, c_gids integer[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT plt_may(i.type, i.mode, i.uid, i.gid, c_uid, c_gids, 4) $$;
CREATE FUNCTION may_x(i inodes, c_uid integer, c_gids integer[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT plt_may(i.type, i.mode, i.uid, i.gid, c_uid, c_gids, 1) $$;

-- Acyclicity (spec 11.3 rule 3, DB-03): a directory may not move into its own subtree.
CREATE FUNCTION plt_dentries_no_cycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    -- Re-entrant with lockPlan L2. After this returns, every earlier directory move has committed,
    -- and the next statement takes a fresh READ COMMITTED snapshot (VOLATILE plpgsql).
    PERFORM pg_advisory_xact_lock(plt_rename_lock_key());
    IF EXISTS (
      WITH RECURSIVE up(ino) AS (
        SELECT NEW.parent_ino
        UNION
        SELECT d.parent_ino FROM dentries d JOIN up ON d.ino = up.ino AND d.d_type = 'd'
      )
      SELECT 1 FROM up WHERE up.ino = NEW.ino
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE    = 'PTC01',
        CONSTRAINT = 'dentries_acyclic',
        MESSAGE    = format('directory %s cannot become its own descendant', NEW.ino);
    END IF;
    RETURN NEW;
  END
  $$;
CREATE TRIGGER dentries_acyclic
  BEFORE UPDATE OF parent_ino, ino ON dentries
  FOR EACH ROW
  WHEN (NEW.d_type = 'd' AND (NEW.parent_ino IS DISTINCT FROM OLD.parent_ino OR NEW.ino IS DISTINCT FROM OLD.ino))
  EXECUTE FUNCTION plt_dentries_no_cycle();

-- Fault injection (spec 11.3 box, DB-02). Inert unless the transaction sets plotinium.fault_after.
-- plotinium.fault_after = N: the first N node ops succeed, node op N+1 raises P0001.
-- plotinium.fault_on selects the counted table: 'inodes' (default) or 'dentries' (mv, batch rename).
-- The GUCs are set only by vfsTxn for an op armed through the root-only, audited harness
-- (POST /api/debug/fault), which exists only when FAULT_INJECTION=1 and never in production.
CREATE FUNCTION plt_fault_hook() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    lim bigint := nullif(current_setting('plotinium.fault_after', true), '')::bigint;
    n   bigint;
  BEGIN
    IF lim IS NULL
       OR TG_TABLE_NAME <> coalesce(nullif(current_setting('plotinium.fault_on', true), ''), 'inodes') THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
    n := coalesce(nullif(current_setting('plotinium.fault_count', true), ''), '0')::bigint + 1;
    PERFORM set_config('plotinium.fault_count', n::text, true);
    IF n > lim THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = format('injected fault at node op %s on %s', n, TG_TABLE_NAME),
        HINT    = 'plotinium.fault';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END
  $$;
CREATE TRIGGER inodes_fault   BEFORE INSERT OR UPDATE OR DELETE ON inodes
  FOR EACH ROW EXECUTE FUNCTION plt_fault_hook();
CREATE TRIGGER dentries_fault BEFORE INSERT OR UPDATE OR DELETE ON dentries
  FOR EACH ROW EXECUTE FUNCTION plt_fault_hook();

-- Canonical tree checksum (fsck --checksum, fault-injection suite, backup manifest).
-- One line per node: parent|nameHex|ino|type|modeOctal|uid|gid|size|nlink|version|blobShaHex|targetHex
CREATE FUNCTION plt_tree_checksum(p_root uuid) RETURNS text
  LANGUAGE sql STABLE
  AS $$
    WITH RECURSIVE sub(ino, parent_ino, name, d_type) AS (
      SELECT p_root, NULL::uuid, ''::text COLLATE pg_c_utf8, 'd'::text
      UNION ALL
      SELECT d.ino, d.parent_ino, d.name, d.d_type
      FROM sub s JOIN dentries d ON d.parent_ino = s.ino
      WHERE s.d_type = 'd'
    )
    SELECT encode(sha256(convert_to(coalesce(string_agg(
             concat_ws('|',
               coalesce(s.parent_ino::text, '-'),
               encode(convert_to(s.name, 'UTF8'), 'hex'),
               i.ino, i.type, lpad(to_oct(i.mode::integer), 4, '0'), i.uid, i.gid, i.size, i.nlink, i.version,
               coalesce(encode(b.sha256, 'hex'), '-'),
               coalesce(encode(convert_to(i.symlink_target, 'UTF8'), 'hex'), '-')),
             E'\n' ORDER BY s.parent_ino NULLS FIRST, s.name), ''), 'UTF8')), 'hex')
    FROM sub s
    JOIN inodes i ON i.ino = s.ino
    LEFT JOIN blobs b ON b.blob_id = i.blob_id
  $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON blobs, inodes, dentries TO plotinium_app;

-- migrate:down
DROP FUNCTION plt_tree_checksum(uuid);
DROP TRIGGER dentries_fault ON dentries;
DROP TRIGGER inodes_fault ON inodes;
DROP FUNCTION plt_fault_hook();
DROP TRIGGER dentries_acyclic ON dentries;
DROP FUNCTION plt_dentries_no_cycle();
DROP FUNCTION may_x(inodes, integer, integer[]);
DROP FUNCTION may_r(inodes, integer, integer[]);
DROP TABLE dentries;
DROP TABLE inodes;
DROP TABLE blobs;
