-- Plotinium migration 2: identity (groups, users, user_groups, auth_sessions, os_sessions).
-- Spec: specs/09-database/database.md §4.3 (DB-01, DB-04), §3.16 (auth vs OS sessions).
-- Kind: expand.
-- Additions requested by other specs (cross-spec requests to database.md, all additive):
--   users.password_version, users.disabled_at, users.telemetry_opt_in_at  (backend-api.md §4.4, §9.2)
--   os_sessions.device_id, os_sessions.kernel_epoch                     (offline-and-sync.md §4.9)

-- migrate:up
CREATE TABLE groups (
  gid        integer PRIMARY KEY CONSTRAINT groups_gid_range CHECK (gid >= 0),
  name       text NOT NULL
             CONSTRAINT groups_name_key UNIQUE
             CONSTRAINT groups_name_valid CHECK (name ~ '^[a-z_][a-z0-9_-]{0,31}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE groups IS 'Unix groups (spec 11.1 groups). gid 0 = root.';

CREATE TABLE users (
  uid              integer PRIMARY KEY CONSTRAINT users_uid_range CHECK (uid >= 0),
  username         text NOT NULL
                   CONSTRAINT users_username_key UNIQUE
                   CONSTRAINT users_username_valid CHECK (username ~ '^[a-z_][a-z0-9_-]{0,31}$'),
  account_kind     text NOT NULL DEFAULT 'user'
                   CONSTRAINT users_kind_valid CHECK (account_kind IN ('root','user','guest','demo','examiner')),
  password_hash    text,                                  -- argon2id PHC string (C10); NULL only for guests
  password_version integer NOT NULL DEFAULT 1
                   CONSTRAINT users_password_version_pos CHECK (password_version >= 1),  -- AuthMe.passwordVersion
  primary_gid      integer NOT NULL CONSTRAINT users_primary_gid_fk REFERENCES groups (gid),
  quota_bytes      bigint  NOT NULL CONSTRAINT users_quota_bytes_nonneg  CHECK (quota_bytes  >= 0),
  quota_inodes     bigint  NOT NULL CONSTRAINT users_quota_inodes_nonneg CHECK (quota_inodes >= 0),
  used_bytes       bigint  NOT NULL DEFAULT 0,
  used_inodes      bigint  NOT NULL DEFAULT 0,
  feed_seq         bigint  NOT NULL DEFAULT 0,            -- last owner_seq handed out (C6 per-owner feed)
  feed_purged_seq  bigint  NOT NULL DEFAULT 0,            -- feed rows with owner_seq <= this were purged
  telemetry_opt_in boolean NOT NULL DEFAULT false,        -- PRE-05: server accepts telemetry only when true
  telemetry_opt_in_at timestamptz,                        -- time of the last consent change (ConsentRes.since)
  disabled_at      timestamptz,                           -- a disabled account cannot log in; sessions revoked
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_root_kind         CHECK ((uid = 0) = (account_kind = 'root')),
  CONSTRAINT users_password_required CHECK (password_hash IS NOT NULL OR account_kind = 'guest'),
  CONSTRAINT users_used_nonneg       CHECK (used_bytes >= 0 AND used_inodes >= 0),
  CONSTRAINT users_quota_bytes_ok    CHECK (uid = 0 OR used_bytes  <= quota_bytes),    -- 23514 -> EDQUOT
  CONSTRAINT users_quota_inodes_ok   CHECK (uid = 0 OR used_inodes <= quota_inodes),   -- 23514 -> EDQUOT
  CONSTRAINT users_feed_seq_order    CHECK (feed_seq >= 0 AND feed_purged_seq BETWEEN 0 AND feed_seq)
);
COMMENT ON COLUMN users.used_bytes IS 'Maintained aggregate: sum(inodes.size) owned by uid; verified by the quota-drift probe.';

CREATE TABLE user_groups (
  uid integer NOT NULL CONSTRAINT user_groups_uid_fk REFERENCES users (uid)  ON DELETE CASCADE,
  gid integer NOT NULL CONSTRAINT user_groups_gid_fk REFERENCES groups (gid) ON DELETE CASCADE,
  CONSTRAINT user_groups_pkey PRIMARY KEY (uid, gid)
);
CREATE INDEX user_groups_gid ON user_groups (gid);

CREATE TABLE auth_sessions (
  id                  text PRIMARY KEY CONSTRAINT auth_sessions_id_valid CHECK (id ~ '^[A-Za-z0-9_-]{16,64}$'),
  secret_hash         bytea NOT NULL CONSTRAINT auth_sessions_hash_len CHECK (octet_length(secret_hash) = 32),
  uid                 integer NOT NULL CONSTRAINT auth_sessions_uid_fk REFERENCES users (uid) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,              -- sliding window (10 days; guests 2 h)
  absolute_expires_at timestamptz NOT NULL,              -- hard cap (30 days; guests 2 h)
  revoked_at          timestamptz,
  su_uid              integer CONSTRAINT auth_sessions_su_uid_fk REFERENCES users (uid),
  su_expires_at       timestamptz,                       -- su grant: 15 min (C10)
  user_agent          text CONSTRAINT auth_sessions_ua_len CHECK (octet_length(user_agent) <= 512),
  CONSTRAINT auth_sessions_expiry_order CHECK (expires_at <= absolute_expires_at),
  CONSTRAINT auth_sessions_su_pair      CHECK ((su_uid IS NULL) = (su_expires_at IS NULL))
);
CREATE INDEX auth_sessions_uid    ON auth_sessions (uid);
CREATE INDEX auth_sessions_expiry ON auth_sessions (absolute_expires_at);

CREATE TABLE os_sessions (
  os_session_id   uuid PRIMARY KEY,                      -- UUIDv7 minted by the kernel at boot
  owner_uid       integer NOT NULL CONSTRAINT os_sessions_owner_fk REFERENCES users (uid) ON DELETE CASCADE,
  auth_session_id text CONSTRAINT os_sessions_auth_fk REFERENCES auth_sessions (id) ON DELETE SET NULL,
  device_id       uuid,                                  -- meta.deviceId of the registering device (sync §3.8.1)
  kernel_epoch    bigint CONSTRAINT os_sessions_epoch_nonneg CHECK (kernel_epoch >= 0),  -- fencing epoch (C2)
  device_label    text NOT NULL DEFAULT '' CONSTRAINT os_sessions_label_len CHECK (octet_length(device_label) <= 64),
  window_layout   jsonb NOT NULL DEFAULT '{}'::jsonb,    -- WM-06 layout; per-window (os_session_id, pid, page_ids) for MEM-04
  layout_rev      bigint NOT NULL DEFAULT 0 CONSTRAINT os_sessions_rev_nonneg CHECK (layout_rev >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  CONSTRAINT os_sessions_id_owner_key UNIQUE (os_session_id, owner_uid)   -- FK target for swap_pages
);
CREATE INDEX os_sessions_owner_recent ON os_sessions (owner_uid, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON groups, users, user_groups, auth_sessions, os_sessions TO plotinium_app;

-- migrate:down
DROP TABLE os_sessions;
DROP TABLE auth_sessions;
DROP TABLE user_groups;
DROP TABLE users;
DROP TABLE groups;
