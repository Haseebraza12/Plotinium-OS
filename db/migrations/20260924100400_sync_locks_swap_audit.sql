-- Plotinium migration 5: the op journal and per-owner feed, leases, remote swap, the audit log.
-- Spec: specs/09-database/database.md §4.5 (OFF-02, VFS-09, VFS-10, MEM-04, AGT-08; DBD-07..DBD-09).
-- Kind: expand.
-- Additions requested by other specs (cross-spec requests to database.md, all additive):
--   locks.lease_id (the ABI's leaseId, UUIDv7)                          (offline-and-sync.md §4.9)
--   swap_pages.gen (page generation; an older copy is never current)    (memory-and-paging.md §9)
--   audit_log.txn_id, target_ino, detail; outcomes 'denied', 'attempt'  (syscall-abi.md §4.7,
--                                                                        security-model.md §4.3)

-- migrate:up
CREATE TABLE op_log (
  op_id         uuid PRIMARY KEY,                        -- idempotency key: client UUIDv7 (C6)
  uid           integer NOT NULL CONSTRAINT op_log_uid_fk REFERENCES users (uid),  -- server-derived principal
  os_session_id uuid    NOT NULL,                        -- no FK: tombstones outlive sessions
  cseq          bigint  NOT NULL CONSTRAINT op_log_cseq_nonneg CHECK (cseq >= 0),
  lamport       bigint  NOT NULL CONSTRAINT op_log_lamport_nonneg CHECK (lamport >= 0),
  call          text    NOT NULL CONSTRAINT op_log_call_valid CHECK (call ~ '^[a-z][a-z0-9_.]{0,63}$'),
  args          jsonb,                                   -- purged after 30 days
  base          jsonb,                                   -- base versions / subtree digest; purged after 30 days
  effects       jsonb,                                   -- post-state for vfs.changed (sync spec); purged after 30 days
  status        text NOT NULL DEFAULT 'pending'
                CONSTRAINT op_log_status_valid CHECK (status IN ('pending','applied','conflict','rejected')),
  errno         text CONSTRAINT op_log_errno_valid CHECK (errno ~ '^E[A-Z]{2,15}$'),
  result        jsonb,                                   -- small reply body, kept forever (tombstone)
  client_ts     timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),
  applied_at    timestamptz NOT NULL DEFAULT now(),
  purged_at     timestamptz,
  CONSTRAINT op_log_session_cseq_key UNIQUE (os_session_id, cseq),
  CONSTRAINT op_log_errno_consistent CHECK (
    (status = 'rejected' AND errno IS NOT NULL)
    OR (status IN ('pending', 'applied') AND errno IS NULL)
    OR status = 'conflict')                              -- conflict: errno NULL (version) or 'EBUSY' (stale fence)
);
CREATE INDEX op_log_applied_brin ON op_log USING brin (applied_at);   -- retention job

CREATE TABLE feed (
  owner_uid    integer NOT NULL CONSTRAINT feed_owner_fk REFERENCES users (uid),
  owner_seq    bigint  NOT NULL CONSTRAINT feed_seq_pos CHECK (owner_seq >= 1),
  op_id        uuid    NOT NULL CONSTRAINT feed_op_fk REFERENCES op_log (op_id),
  committed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feed_pkey PRIMARY KEY (owner_uid, owner_seq),
  CONSTRAINT feed_owner_op_key UNIQUE (owner_uid, op_id)
);

CREATE SEQUENCE lock_fence_seq AS bigint START WITH 1;
CREATE TABLE locks (
  ino              uuid    NOT NULL CONSTRAINT locks_ino_fk REFERENCES inodes (ino) ON DELETE CASCADE,
  os_session_id    uuid    NOT NULL CONSTRAINT locks_session_fk REFERENCES os_sessions (os_session_id),
  lease_id         uuid    NOT NULL DEFAULT uuidv7() CONSTRAINT locks_lease_id_key UNIQUE,  -- ABI leaseId
  holder_uid       integer NOT NULL CONSTRAINT locks_holder_fk REFERENCES users (uid),
  mode             text    NOT NULL CONSTRAINT locks_mode_valid CHECK (mode IN ('S','X')),
  fence            bigint  NOT NULL CONSTRAINT locks_fence_pos CHECK (fence >= 1),
  granted_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at timestamptz NOT NULL,
  CONSTRAINT locks_pkey PRIMARY KEY (ino, os_session_id),
  CONSTRAINT locks_sx_excl EXCLUDE USING gist (ino WITH =, mode WITH <>),   -- S and X never coexist
  CONSTRAINT locks_lease_order CHECK (lease_expires_at > granted_at)
);
CREATE UNIQUE INDEX locks_one_writer ON locks (ino) WHERE mode = 'X';      -- at most one X holder
CREATE INDEX locks_expiry_brin ON locks USING brin (lease_expires_at);      -- keeps heartbeat updates HOT
CREATE INDEX locks_session ON locks (os_session_id);                        -- release-all on revoke

CREATE TABLE swap_pages (
  owner_uid     integer NOT NULL CONSTRAINT swap_pages_owner_fk REFERENCES users (uid),
  os_session_id uuid    NOT NULL,
  pid           integer NOT NULL CONSTRAINT swap_pages_pid_pos CHECK (pid > 0),
  page_id       integer NOT NULL CONSTRAINT swap_pages_page_nonneg CHECK (page_id >= 0),
  gen           bigint  NOT NULL DEFAULT 0 CONSTRAINT swap_pages_gen_nonneg CHECK (gen >= 0),
  storage_key   text    NOT NULL,                        -- FsBlobStore key: swap/<owner_uid>/<os_session>/<pid>/<page>
  size          integer NOT NULL CONSTRAINT swap_pages_size_range CHECK (size BETWEEN 0 AND 67108864),
  stored_size   integer NOT NULL CONSTRAINT swap_pages_stored_nonneg CHECK (stored_size >= 0),
  checksum      bytea   NOT NULL CONSTRAINT swap_pages_checksum_len CHECK (octet_length(checksum) = 32),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT swap_pages_pkey PRIMARY KEY (owner_uid, os_session_id, pid, page_id),
  CONSTRAINT swap_pages_session_fk FOREIGN KEY (os_session_id, owner_uid)
                                   REFERENCES os_sessions (os_session_id, owner_uid)
);

CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts            timestamptz NOT NULL DEFAULT clock_timestamp(),
  uid           integer NOT NULL CONSTRAINT audit_uid_fk REFERENCES users (uid),       -- effective uid
  real_uid      integer NOT NULL CONSTRAINT audit_real_uid_fk REFERENCES users (uid),  -- login uid (differs under su)
  actor         text    NOT NULL CONSTRAINT audit_actor_valid CHECK (actor IN ('user','agent','system')),
  os_session_id uuid,
  pid           integer,
  syscall       text    NOT NULL,                        -- call name, or the security event name (backend-api §4.4)
  args          jsonb   NOT NULL DEFAULT '{}'::jsonb,
  result        jsonb,
  errno         text,
  outcome       text    NOT NULL CONSTRAINT audit_outcome_valid CHECK (outcome IN
                  ('ok','error','rejected','declined','confirmed','stale','killed_rolled_back','rolled_back',
                   'denied','attempt')),
  prompt_id     uuid,
  plan_hash     bytea CONSTRAINT audit_plan_hash_len CHECK (octet_length(plan_hash) = 32),
  op_id         uuid,                                    -- no FK: killed plans never reach op_log
  txn_id        uuid,                                    -- the agent batch transaction (AuditRecord.txnId)
  target_ino    uuid,                                    -- no FK: the audit trail outlives deleted inodes
  detail        jsonb,                                   -- never a password, token, key or file content
  CONSTRAINT audit_agent_has_prompt CHECK (actor <> 'agent' OR prompt_id IS NOT NULL)
);
CREATE INDEX audit_uid_ts ON audit_log (uid, ts DESC);
CREATE INDEX audit_prompt ON audit_log (prompt_id) WHERE prompt_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON op_log TO plotinium_app;           -- no DELETE: tombstones are permanent
GRANT SELECT, INSERT, DELETE ON feed TO plotinium_app;              -- DELETE for retention only
GRANT SELECT, INSERT, UPDATE, DELETE ON locks, swap_pages TO plotinium_app;
GRANT SELECT, INSERT ON audit_log TO plotinium_app;                 -- append-only (AGT-08)
GRANT USAGE ON SEQUENCE lock_fence_seq TO plotinium_app;

-- migrate:down
DROP TABLE audit_log;
DROP TABLE swap_pages;
DROP TABLE locks;
DROP SEQUENCE lock_fence_seq;
DROP TABLE feed;
DROP TABLE op_log;
