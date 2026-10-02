-- Plotinium migration 6: semantic-search chunks, the LLM budget tables, opt-in telemetry.
-- Spec: specs/09-database/database.md §4.6 (RAG-02, RAG-03, RAG-05, PRE-05, spec §12.6; DBD-15, DBD-16).
-- Kind: expand.
-- Additions requested by other specs (cross-spec requests to database.md, all additive):
--   llm_usage pool 'demo' (guests and the public demo account share one small pool)  (backend-api.md §3.13.2)
--   llm_requests.provider_request_id, refusal_category; purpose 'extract'; status 'replayed'
--                                                                                     (backend-api.md §3.13.3)
--   llm_requests purposes 'bakeoff' and 'health', pricing_version                   (ai-safety-and-evaluation.md §4.3)
-- The optional HNSW index (database.md §3.20) is NOT created here: it gets its own migration only
-- when the exact search misses its budget.

-- migrate:up
CREATE TABLE file_chunks (
  chunk_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- pull cursor (commit-ordered, DBD-15)
  ino           uuid NOT NULL,
  ino_type      text NOT NULL DEFAULT 'f' CONSTRAINT file_chunks_files_only CHECK (ino_type = 'f'),
  inode_version bigint  NOT NULL CONSTRAINT file_chunks_version_pos CHECK (inode_version >= 1),
  model_key     text    NOT NULL CONSTRAINT file_chunks_model_key_valid CHECK (model_key ~ '^[a-z0-9._@-]{1,64}$'),
  seq           integer NOT NULL CONSTRAINT file_chunks_seq_nonneg CHECK (seq >= 0),
  byte_start    integer NOT NULL CONSTRAINT file_chunks_byte_start_nonneg CHECK (byte_start >= 0),
  byte_end      integer NOT NULL,
  line_start    integer NOT NULL CONSTRAINT file_chunks_line_start_pos CHECK (line_start >= 1),
  line_end      integer NOT NULL,
  header        text    NOT NULL DEFAULT '',             -- heading trail, embedded but never shown
  text          text    NOT NULL,
  content_hash  bytea   NOT NULL CONSTRAINT file_chunks_hash_len CHECK (octet_length(content_hash) = 32),
  embedding     vector(384) NOT NULL,                    -- unit-length, MRL-truncated (C12)
  indexed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_chunks_bytes_order CHECK (byte_end > byte_start),
  CONSTRAINT file_chunks_lines_order CHECK (line_end >= line_start),
  CONSTRAINT file_chunks_ino_fk FOREIGN KEY (ino, ino_type) REFERENCES inodes (ino, type) ON DELETE CASCADE,
  CONSTRAINT file_chunks_ino_model_seq_key UNIQUE (ino, model_key, seq)
);
CREATE INDEX file_chunks_content_hash ON file_chunks USING hash (content_hash);

CREATE TABLE llm_usage (
  pool              text   NOT NULL CONSTRAINT llm_usage_pool_valid CHECK (pool ~ '^(global|examiners|demo|uid:[0-9]{1,10})$'),
  period            text   NOT NULL CONSTRAINT llm_usage_period_valid CHECK (period IN ('day','month','semester')),
  period_start      date   NOT NULL,
  limit_microusd    bigint NOT NULL CONSTRAINT llm_usage_limit_nonneg CHECK (limit_microusd >= 0),
  call_limit        integer CONSTRAINT llm_usage_call_limit_nonneg CHECK (call_limit >= 0),
  reserved_microusd bigint NOT NULL DEFAULT 0 CONSTRAINT llm_usage_reserved_nonneg CHECK (reserved_microusd >= 0),
  spent_microusd    bigint NOT NULL DEFAULT 0 CONSTRAINT llm_usage_spent_nonneg CHECK (spent_microusd >= 0),
  calls             integer NOT NULL DEFAULT 0 CONSTRAINT llm_usage_calls_nonneg CHECK (calls >= 0),
  CONSTRAINT llm_usage_pkey PRIMARY KEY (pool, period, period_start)
);

CREATE TABLE llm_requests (
  request_id          uuid PRIMARY KEY DEFAULT uuidv7(),
  uid                 integer NOT NULL CONSTRAINT llm_requests_uid_fk REFERENCES users (uid),
  os_session_id       uuid,
  pid                 integer,
  prompt_id           uuid,                               -- joins to audit_log.prompt_id
  turn                smallint NOT NULL DEFAULT 1 CONSTRAINT llm_requests_turn_range CHECK (turn BETWEEN 1 AND 6),
  purpose             text NOT NULL CONSTRAINT llm_requests_purpose_valid
                      CHECK (purpose IN ('plan','answer','eval','extract','bakeoff','health')),
  requested_model     text NOT NULL,
  served_model        text,
  effort              text,
  provider_request_id text,                               -- the provider's request id (support and audits)
  pricing_version     text,                               -- server/src/llm/pricing.ts table version
  status              text NOT NULL DEFAULT 'reserved'
                      CONSTRAINT llm_requests_status_valid
                      CHECK (status IN ('reserved','ok','error','refused','abandoned','replayed')),
  stop_reason         text,
  refusal_category    text,                               -- stop_details category of a refusal (EAIREFUSED)
  input_tokens        integer CONSTRAINT llm_requests_in_nonneg    CHECK (input_tokens >= 0),
  cache_read_tokens   integer CONSTRAINT llm_requests_cr_nonneg    CHECK (cache_read_tokens >= 0),
  cache_write_tokens  integer CONSTRAINT llm_requests_cw_nonneg    CHECK (cache_write_tokens >= 0),
  output_tokens       integer CONSTRAINT llm_requests_out_nonneg   CHECK (output_tokens >= 0),
  reserved_microusd   bigint  NOT NULL CONSTRAINT llm_requests_reserved_nonneg CHECK (reserved_microusd >= 0),
  cost_microusd       bigint  CONSTRAINT llm_requests_cost_nonneg CHECK (cost_microusd >= 0),
  charged_keys        text[]  NOT NULL CONSTRAINT llm_requests_charged_nonempty CHECK (cardinality(charged_keys) >= 1),
  latency_ms          integer CONSTRAINT llm_requests_latency_nonneg CHECK (latency_ms >= 0),
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz,
  CONSTRAINT llm_requests_settled_iff CHECK ((status = 'reserved') = (settled_at IS NULL))
);
CREATE INDEX llm_requests_uid_ts ON llm_requests (uid, created_at DESC);
CREATE INDEX llm_requests_open   ON llm_requests (created_at) WHERE status = 'reserved';

CREATE TABLE telemetry_events (
  event_id    uuid PRIMARY KEY,                          -- client UUIDv7: upload is idempotent
  uid         integer NOT NULL CONSTRAINT telemetry_uid_fk REFERENCES users (uid) ON DELETE CASCADE,
  app_id      text NOT NULL CONSTRAINT telemetry_app_valid CHECK (app_id ~ '^[a-z0-9._-]{1,64}$'),
  kind        text NOT NULL CONSTRAINT telemetry_kind_valid CHECK (kind IN ('launch','focus','close')),
  ts          timestamptz NOT NULL,
  context     jsonb NOT NULL DEFAULT '{}'::jsonb,       -- time bucket, weekday, previous app, session position
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telemetry_uid_ts ON telemetry_events (uid, ts);

GRANT SELECT, INSERT, UPDATE, DELETE ON file_chunks, llm_usage, llm_requests, telemetry_events TO plotinium_app;

-- migrate:down
DROP TABLE telemetry_events;
DROP TABLE llm_requests;
DROP TABLE llm_usage;
DROP TABLE file_chunks;
