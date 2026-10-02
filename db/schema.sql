
-- Dumped from database version 18.6 (Debian 18.6-1.pgdg13+2)
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;


--
-- Name: EXTENSION pg_stat_statements; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_stat_statements IS 'track planning and execution statistics of all SQL statements executed';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: inodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inodes (
    ino uuid DEFAULT uuidv7() NOT NULL,
    type text NOT NULL,
    mode smallint NOT NULL,
    uid integer NOT NULL,
    gid integer NOT NULL,
    size bigint DEFAULT 0 NOT NULL,
    nlink integer DEFAULT 1 NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    blob_id bigint,
    symlink_target text,
    lock_fence bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    modified_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    accessed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inodes_blob_only_files CHECK (((type = 'f'::text) OR (blob_id IS NULL))),
    CONSTRAINT inodes_dir_size_zero CHECK (((type <> 'd'::text) OR (size = 0))),
    CONSTRAINT inodes_fence_nonneg CHECK ((lock_fence >= 0)),
    CONSTRAINT inodes_file_content CHECK (((type <> 'f'::text) OR (blob_id IS NOT NULL) OR (size = 0))),
    CONSTRAINT inodes_mode_range CHECK (((mode >= 0) AND (mode <= 4095))),
    CONSTRAINT inodes_nlink_nonneg CHECK ((nlink >= 0)),
    CONSTRAINT inodes_size_nonneg CHECK ((size >= 0)),
    CONSTRAINT inodes_symlink_iff_target CHECK (((type = 'l'::text) = (symlink_target IS NOT NULL))),
    CONSTRAINT inodes_symlink_size CHECK (((type <> 'l'::text) OR (size = octet_length(symlink_target)))),
    CONSTRAINT inodes_symlink_target_len CHECK ((octet_length(symlink_target) <= 4096)),
    CONSTRAINT inodes_symlink_target_nonempty CHECK ((symlink_target <> ''::text)),
    CONSTRAINT inodes_type_valid CHECK ((type = ANY (ARRAY['f'::text, 'd'::text, 'l'::text]))),
    CONSTRAINT inodes_version_pos CHECK ((version >= 1))
)
WITH (autovacuum_vacuum_insert_scale_factor='0.02');


--
-- Name: may_r(public.inodes, integer, integer[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.may_r(i public.inodes, c_uid integer, c_gids integer[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT plt_may(i.type, i.mode, i.uid, i.gid, c_uid, c_gids, 4) $$;


--
-- Name: may_x(public.inodes, integer, integer[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.may_x(i public.inodes, c_uid integer, c_gids integer[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT plt_may(i.type, i.mode, i.uid, i.gid, c_uid, c_gids, 1) $$;


--
-- Name: plt_blob_lock_key(bytea); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.plt_blob_lock_key(p_sha256 bytea) RETURNS bigint
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT hashtextextended('plotinium:blob:' || encode(p_sha256, 'hex'), 0) $$;


--
-- Name: plt_dentries_no_cycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.plt_dentries_no_cycle() RETURNS trigger
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


--
-- Name: plt_fault_hook(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.plt_fault_hook() RETURNS trigger
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


--
-- Name: plt_index_put_lock_key(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.plt_index_put_lock_key() RETURNS bigint
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT hashtextextended('plotinium:index.put', 0) $$;


--
-- Name: plt_may(text, integer, integer, integer, integer, integer[], integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.plt_may(p_type text, p_mode integer, p_uid integer, p_gid integer, c_uid integer, c_gids integer[], want integer) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
    SELECT CASE
      WHEN c_uid = 0            THEN (want & 1) = 0 OR p_type = 'd' OR (p_mode & 73) <> 0  -- 73 = 0o111
      WHEN c_uid = p_uid        THEN ((p_mode >> 6) & want) = want
      WHEN p_gid = ANY (c_gids) THEN ((p_mode >> 3) & want) = want
      ELSE (p_mode & want) = want
    END
  $$;


--
-- Name: plt_rename_lock_key(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.plt_rename_lock_key() RETURNS bigint
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT hashtextextended('plotinium:vfs.rename', 0) $$;


--
-- Name: plt_tree_checksum(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.plt_tree_checksum(p_root uuid) RETURNS text
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


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    uid integer NOT NULL,
    real_uid integer NOT NULL,
    actor text NOT NULL,
    os_session_id uuid,
    pid integer,
    syscall text NOT NULL,
    args jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb,
    errno text,
    outcome text NOT NULL,
    prompt_id uuid,
    plan_hash bytea,
    op_id uuid,
    txn_id uuid,
    target_ino uuid,
    detail jsonb,
    CONSTRAINT audit_actor_valid CHECK ((actor = ANY (ARRAY['user'::text, 'agent'::text, 'system'::text]))),
    CONSTRAINT audit_agent_has_prompt CHECK (((actor <> 'agent'::text) OR (prompt_id IS NOT NULL))),
    CONSTRAINT audit_outcome_valid CHECK ((outcome = ANY (ARRAY['ok'::text, 'error'::text, 'rejected'::text, 'declined'::text, 'confirmed'::text, 'stale'::text, 'killed_rolled_back'::text, 'rolled_back'::text, 'denied'::text, 'attempt'::text]))),
    CONSTRAINT audit_plan_hash_len CHECK ((octet_length(plan_hash) = 32))
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    id text NOT NULL,
    secret_hash bytea NOT NULL,
    uid integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    absolute_expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    su_uid integer,
    su_expires_at timestamp with time zone,
    user_agent text,
    CONSTRAINT auth_sessions_expiry_order CHECK ((expires_at <= absolute_expires_at)),
    CONSTRAINT auth_sessions_hash_len CHECK ((octet_length(secret_hash) = 32)),
    CONSTRAINT auth_sessions_id_valid CHECK ((id ~ '^[A-Za-z0-9_-]{16,64}$'::text)),
    CONSTRAINT auth_sessions_su_pair CHECK (((su_uid IS NULL) = (su_expires_at IS NULL))),
    CONSTRAINT auth_sessions_ua_len CHECK ((octet_length(user_agent) <= 512))
);


--
-- Name: blobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blobs (
    blob_id bigint NOT NULL,
    sha256 bytea NOT NULL,
    size bigint NOT NULL,
    storage_key text NOT NULL,
    refcount integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    first_ref_at timestamp with time zone,
    zero_since timestamp with time zone DEFAULT now(),
    CONSTRAINT blobs_refcount_nonneg CHECK ((refcount >= 0)),
    CONSTRAINT blobs_sha256_len CHECK ((octet_length(sha256) = 32)),
    CONSTRAINT blobs_size_nonneg CHECK ((size >= 0)),
    CONSTRAINT blobs_zero_since_iff CHECK (((refcount = 0) = (zero_since IS NOT NULL)))
);


--
-- Name: blobs_blob_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.blobs ALTER COLUMN blob_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.blobs_blob_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: dentries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dentries (
    parent_ino uuid NOT NULL,
    parent_type text DEFAULT 'd'::text NOT NULL,
    name text NOT NULL COLLATE pg_catalog.pg_c_utf8,
    ino uuid NOT NULL,
    d_type text NOT NULL,
    owner_uid integer NOT NULL,
    CONSTRAINT dentries_name_chars CHECK (((strpos(name, '/'::text) = 0) AND (name <> ALL (ARRAY['.'::text, '..'::text])))),
    CONSTRAINT dentries_name_len CHECK ((octet_length(name) <= 255)),
    CONSTRAINT dentries_name_nfc CHECK ((name IS NFC NORMALIZED)),
    CONSTRAINT dentries_name_nonempty CHECK ((name <> ''::text)),
    CONSTRAINT dentries_parent_is_dir CHECK ((parent_type = 'd'::text))
)
WITH (autovacuum_vacuum_insert_scale_factor='0.02');


--
-- Name: feed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feed (
    owner_uid integer NOT NULL,
    owner_seq bigint NOT NULL,
    op_id uuid NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT feed_seq_pos CHECK ((owner_seq >= 1))
);


--
-- Name: file_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_chunks (
    chunk_id bigint NOT NULL,
    ino uuid NOT NULL,
    ino_type text DEFAULT 'f'::text NOT NULL,
    inode_version bigint NOT NULL,
    model_key text NOT NULL,
    seq integer NOT NULL,
    byte_start integer NOT NULL,
    byte_end integer NOT NULL,
    line_start integer NOT NULL,
    line_end integer NOT NULL,
    header text DEFAULT ''::text NOT NULL,
    text text NOT NULL,
    content_hash bytea NOT NULL,
    embedding public.vector(384) NOT NULL,
    indexed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT file_chunks_byte_start_nonneg CHECK ((byte_start >= 0)),
    CONSTRAINT file_chunks_bytes_order CHECK ((byte_end > byte_start)),
    CONSTRAINT file_chunks_files_only CHECK ((ino_type = 'f'::text)),
    CONSTRAINT file_chunks_hash_len CHECK ((octet_length(content_hash) = 32)),
    CONSTRAINT file_chunks_line_start_pos CHECK ((line_start >= 1)),
    CONSTRAINT file_chunks_lines_order CHECK ((line_end >= line_start)),
    CONSTRAINT file_chunks_model_key_valid CHECK ((model_key ~ '^[a-z0-9._@-]{1,64}$'::text)),
    CONSTRAINT file_chunks_seq_nonneg CHECK ((seq >= 0)),
    CONSTRAINT file_chunks_version_pos CHECK ((inode_version >= 1))
);


--
-- Name: file_chunks_chunk_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.file_chunks ALTER COLUMN chunk_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.file_chunks_chunk_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    gid integer NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT groups_gid_range CHECK ((gid >= 0)),
    CONSTRAINT groups_name_valid CHECK ((name ~ '^[a-z_][a-z0-9_-]{0,31}$'::text))
);


--
-- Name: TABLE groups; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.groups IS 'Unix groups (spec 11.1 groups). gid 0 = root.';


--
-- Name: llm_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_requests (
    request_id uuid DEFAULT uuidv7() NOT NULL,
    uid integer NOT NULL,
    os_session_id uuid,
    pid integer,
    prompt_id uuid,
    turn smallint DEFAULT 1 NOT NULL,
    purpose text NOT NULL,
    requested_model text NOT NULL,
    served_model text,
    effort text,
    provider_request_id text,
    pricing_version text,
    status text DEFAULT 'reserved'::text NOT NULL,
    stop_reason text,
    refusal_category text,
    input_tokens integer,
    cache_read_tokens integer,
    cache_write_tokens integer,
    output_tokens integer,
    reserved_microusd bigint NOT NULL,
    cost_microusd bigint,
    charged_keys text[] NOT NULL,
    latency_ms integer,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT llm_requests_charged_nonempty CHECK ((cardinality(charged_keys) >= 1)),
    CONSTRAINT llm_requests_cost_nonneg CHECK ((cost_microusd >= 0)),
    CONSTRAINT llm_requests_cr_nonneg CHECK ((cache_read_tokens >= 0)),
    CONSTRAINT llm_requests_cw_nonneg CHECK ((cache_write_tokens >= 0)),
    CONSTRAINT llm_requests_in_nonneg CHECK ((input_tokens >= 0)),
    CONSTRAINT llm_requests_latency_nonneg CHECK ((latency_ms >= 0)),
    CONSTRAINT llm_requests_out_nonneg CHECK ((output_tokens >= 0)),
    CONSTRAINT llm_requests_purpose_valid CHECK ((purpose = ANY (ARRAY['plan'::text, 'answer'::text, 'eval'::text, 'extract'::text, 'bakeoff'::text, 'health'::text]))),
    CONSTRAINT llm_requests_reserved_nonneg CHECK ((reserved_microusd >= 0)),
    CONSTRAINT llm_requests_settled_iff CHECK (((status = 'reserved'::text) = (settled_at IS NULL))),
    CONSTRAINT llm_requests_status_valid CHECK ((status = ANY (ARRAY['reserved'::text, 'ok'::text, 'error'::text, 'refused'::text, 'abandoned'::text, 'replayed'::text]))),
    CONSTRAINT llm_requests_turn_range CHECK (((turn >= 1) AND (turn <= 6)))
);


--
-- Name: llm_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_usage (
    pool text NOT NULL,
    period text NOT NULL,
    period_start date NOT NULL,
    limit_microusd bigint NOT NULL,
    call_limit integer,
    reserved_microusd bigint DEFAULT 0 NOT NULL,
    spent_microusd bigint DEFAULT 0 NOT NULL,
    calls integer DEFAULT 0 NOT NULL,
    CONSTRAINT llm_usage_call_limit_nonneg CHECK ((call_limit >= 0)),
    CONSTRAINT llm_usage_calls_nonneg CHECK ((calls >= 0)),
    CONSTRAINT llm_usage_limit_nonneg CHECK ((limit_microusd >= 0)),
    CONSTRAINT llm_usage_period_valid CHECK ((period = ANY (ARRAY['day'::text, 'month'::text, 'semester'::text]))),
    CONSTRAINT llm_usage_pool_valid CHECK ((pool ~ '^(global|examiners|demo|uid:[0-9]{1,10})$'::text)),
    CONSTRAINT llm_usage_reserved_nonneg CHECK ((reserved_microusd >= 0)),
    CONSTRAINT llm_usage_spent_nonneg CHECK ((spent_microusd >= 0))
);


--
-- Name: lock_fence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lock_fence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.locks (
    ino uuid NOT NULL,
    os_session_id uuid NOT NULL,
    lease_id uuid DEFAULT uuidv7() NOT NULL,
    holder_uid integer NOT NULL,
    mode text NOT NULL,
    fence bigint NOT NULL,
    granted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    CONSTRAINT locks_fence_pos CHECK ((fence >= 1)),
    CONSTRAINT locks_lease_order CHECK ((lease_expires_at > granted_at)),
    CONSTRAINT locks_mode_valid CHECK ((mode = ANY (ARRAY['S'::text, 'X'::text])))
);


--
-- Name: op_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.op_log (
    op_id uuid NOT NULL,
    uid integer NOT NULL,
    os_session_id uuid NOT NULL,
    cseq bigint NOT NULL,
    lamport bigint NOT NULL,
    call text NOT NULL,
    args jsonb,
    base jsonb,
    effects jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    errno text,
    result jsonb,
    client_ts timestamp with time zone,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    purged_at timestamp with time zone,
    CONSTRAINT op_log_call_valid CHECK ((call ~ '^[a-z][a-z0-9_.]{0,63}$'::text)),
    CONSTRAINT op_log_cseq_nonneg CHECK ((cseq >= 0)),
    CONSTRAINT op_log_errno_consistent CHECK ((((status = 'rejected'::text) AND (errno IS NOT NULL)) OR ((status = ANY (ARRAY['pending'::text, 'applied'::text])) AND (errno IS NULL)) OR (status = 'conflict'::text))),
    CONSTRAINT op_log_errno_valid CHECK ((errno ~ '^E[A-Z]{2,15}$'::text)),
    CONSTRAINT op_log_lamport_nonneg CHECK ((lamport >= 0)),
    CONSTRAINT op_log_status_valid CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'conflict'::text, 'rejected'::text])))
);


--
-- Name: os_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.os_sessions (
    os_session_id uuid NOT NULL,
    owner_uid integer NOT NULL,
    auth_session_id text,
    device_id uuid,
    kernel_epoch bigint,
    device_label text DEFAULT ''::text NOT NULL,
    window_layout jsonb DEFAULT '{}'::jsonb NOT NULL,
    layout_rev bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT os_sessions_epoch_nonneg CHECK ((kernel_epoch >= 0)),
    CONSTRAINT os_sessions_label_len CHECK ((octet_length(device_label) <= 64)),
    CONSTRAINT os_sessions_rev_nonneg CHECK ((layout_rev >= 0))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: swap_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.swap_pages (
    owner_uid integer NOT NULL,
    os_session_id uuid NOT NULL,
    pid integer NOT NULL,
    page_id integer NOT NULL,
    gen bigint DEFAULT 0 NOT NULL,
    storage_key text NOT NULL,
    size integer NOT NULL,
    stored_size integer NOT NULL,
    checksum bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT swap_pages_checksum_len CHECK ((octet_length(checksum) = 32)),
    CONSTRAINT swap_pages_gen_nonneg CHECK ((gen >= 0)),
    CONSTRAINT swap_pages_page_nonneg CHECK ((page_id >= 0)),
    CONSTRAINT swap_pages_pid_pos CHECK ((pid > 0)),
    CONSTRAINT swap_pages_size_range CHECK (((size >= 0) AND (size <= 67108864))),
    CONSTRAINT swap_pages_stored_nonneg CHECK ((stored_size >= 0))
);


--
-- Name: telemetry_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telemetry_events (
    event_id uuid NOT NULL,
    uid integer NOT NULL,
    app_id text NOT NULL,
    kind text NOT NULL,
    ts timestamp with time zone NOT NULL,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT telemetry_app_valid CHECK ((app_id ~ '^[a-z0-9._-]{1,64}$'::text)),
    CONSTRAINT telemetry_kind_valid CHECK ((kind = ANY (ARRAY['launch'::text, 'focus'::text, 'close'::text])))
);


--
-- Name: user_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_groups (
    uid integer NOT NULL,
    gid integer NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    uid integer NOT NULL,
    username text NOT NULL,
    account_kind text DEFAULT 'user'::text NOT NULL,
    password_hash text,
    password_version integer DEFAULT 1 NOT NULL,
    primary_gid integer NOT NULL,
    quota_bytes bigint NOT NULL,
    quota_inodes bigint NOT NULL,
    used_bytes bigint DEFAULT 0 NOT NULL,
    used_inodes bigint DEFAULT 0 NOT NULL,
    feed_seq bigint DEFAULT 0 NOT NULL,
    feed_purged_seq bigint DEFAULT 0 NOT NULL,
    telemetry_opt_in boolean DEFAULT false NOT NULL,
    telemetry_opt_in_at timestamp with time zone,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_feed_seq_order CHECK (((feed_seq >= 0) AND ((feed_purged_seq >= 0) AND (feed_purged_seq <= feed_seq)))),
    CONSTRAINT users_kind_valid CHECK ((account_kind = ANY (ARRAY['root'::text, 'user'::text, 'guest'::text, 'demo'::text, 'examiner'::text]))),
    CONSTRAINT users_password_required CHECK (((password_hash IS NOT NULL) OR (account_kind = 'guest'::text))),
    CONSTRAINT users_password_version_pos CHECK ((password_version >= 1)),
    CONSTRAINT users_quota_bytes_nonneg CHECK ((quota_bytes >= 0)),
    CONSTRAINT users_quota_bytes_ok CHECK (((uid = 0) OR (used_bytes <= quota_bytes))),
    CONSTRAINT users_quota_inodes_nonneg CHECK ((quota_inodes >= 0)),
    CONSTRAINT users_quota_inodes_ok CHECK (((uid = 0) OR (used_inodes <= quota_inodes))),
    CONSTRAINT users_root_kind CHECK (((uid = 0) = (account_kind = 'root'::text))),
    CONSTRAINT users_uid_range CHECK ((uid >= 0)),
    CONSTRAINT users_used_nonneg CHECK (((used_bytes >= 0) AND (used_inodes >= 0))),
    CONSTRAINT users_username_valid CHECK ((username ~ '^[a-z_][a-z0-9_-]{0,31}$'::text))
);


--
-- Name: COLUMN users.used_bytes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.used_bytes IS 'Maintained aggregate: sum(inodes.size) owned by uid; verified by the quota-drift probe.';


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: blobs blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_pkey PRIMARY KEY (blob_id);


--
-- Name: blobs blobs_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_sha256_key UNIQUE (sha256);


--
-- Name: dentries dentries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dentries
    ADD CONSTRAINT dentries_pkey PRIMARY KEY (parent_ino, name) INCLUDE (ino, d_type);


--
-- Name: feed feed_owner_op_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed
    ADD CONSTRAINT feed_owner_op_key UNIQUE (owner_uid, op_id);


--
-- Name: feed feed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed
    ADD CONSTRAINT feed_pkey PRIMARY KEY (owner_uid, owner_seq);


--
-- Name: file_chunks file_chunks_ino_model_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_chunks
    ADD CONSTRAINT file_chunks_ino_model_seq_key UNIQUE (ino, model_key, seq);


--
-- Name: file_chunks file_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_chunks
    ADD CONSTRAINT file_chunks_pkey PRIMARY KEY (chunk_id);


--
-- Name: groups groups_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_name_key UNIQUE (name);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (gid);


--
-- Name: inodes inodes_ino_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inodes
    ADD CONSTRAINT inodes_ino_type_key UNIQUE (ino, type);


--
-- Name: inodes inodes_ino_type_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inodes
    ADD CONSTRAINT inodes_ino_type_uid_key UNIQUE (ino, type, uid);


--
-- Name: inodes inodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inodes
    ADD CONSTRAINT inodes_pkey PRIMARY KEY (ino);


--
-- Name: llm_requests llm_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_requests
    ADD CONSTRAINT llm_requests_pkey PRIMARY KEY (request_id);


--
-- Name: llm_usage llm_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_pkey PRIMARY KEY (pool, period, period_start);


--
-- Name: locks locks_lease_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locks
    ADD CONSTRAINT locks_lease_id_key UNIQUE (lease_id);


--
-- Name: locks locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locks
    ADD CONSTRAINT locks_pkey PRIMARY KEY (ino, os_session_id);


--
-- Name: locks locks_sx_excl; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locks
    ADD CONSTRAINT locks_sx_excl EXCLUDE USING gist (ino WITH =, mode WITH <>);


--
-- Name: op_log op_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.op_log
    ADD CONSTRAINT op_log_pkey PRIMARY KEY (op_id);


--
-- Name: op_log op_log_session_cseq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.op_log
    ADD CONSTRAINT op_log_session_cseq_key UNIQUE (os_session_id, cseq);


--
-- Name: os_sessions os_sessions_id_owner_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.os_sessions
    ADD CONSTRAINT os_sessions_id_owner_key UNIQUE (os_session_id, owner_uid);


--
-- Name: os_sessions os_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.os_sessions
    ADD CONSTRAINT os_sessions_pkey PRIMARY KEY (os_session_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: swap_pages swap_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swap_pages
    ADD CONSTRAINT swap_pages_pkey PRIMARY KEY (owner_uid, os_session_id, pid, page_id);


--
-- Name: telemetry_events telemetry_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry_events
    ADD CONSTRAINT telemetry_events_pkey PRIMARY KEY (event_id);


--
-- Name: user_groups user_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT user_groups_pkey PRIMARY KEY (uid, gid);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (uid);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: audit_prompt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_prompt ON public.audit_log USING btree (prompt_id) WHERE (prompt_id IS NOT NULL);


--
-- Name: audit_uid_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_uid_ts ON public.audit_log USING btree (uid, ts DESC);


--
-- Name: auth_sessions_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_expiry ON public.auth_sessions USING btree (absolute_expires_at);


--
-- Name: auth_sessions_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_uid ON public.auth_sessions USING btree (uid);


--
-- Name: blobs_gc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX blobs_gc ON public.blobs USING btree (zero_since) WHERE (refcount = 0);


--
-- Name: blobs_sha256_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX blobs_sha256_hash ON public.blobs USING hash (sha256);


--
-- Name: dentries_dir_one_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dentries_dir_one_parent ON public.dentries USING btree (ino) WHERE (d_type = 'd'::text);


--
-- Name: dentries_ino; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dentries_ino ON public.dentries USING btree (ino);


--
-- Name: dentries_owner_lname; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dentries_owner_lname ON public.dentries USING btree (owner_uid, lower(name) text_pattern_ops);


--
-- Name: file_chunks_content_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_chunks_content_hash ON public.file_chunks USING hash (content_hash);


--
-- Name: inodes_blob; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inodes_blob ON public.inodes USING btree (blob_id) WHERE (blob_id IS NOT NULL);


--
-- Name: inodes_uid_mtime; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inodes_uid_mtime ON public.inodes USING btree (uid, modified_at DESC);


--
-- Name: llm_requests_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_requests_open ON public.llm_requests USING btree (created_at) WHERE (status = 'reserved'::text);


--
-- Name: llm_requests_uid_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_requests_uid_ts ON public.llm_requests USING btree (uid, created_at DESC);


--
-- Name: locks_expiry_brin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX locks_expiry_brin ON public.locks USING brin (lease_expires_at);


--
-- Name: locks_one_writer; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX locks_one_writer ON public.locks USING btree (ino) WHERE (mode = 'X'::text);


--
-- Name: locks_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX locks_session ON public.locks USING btree (os_session_id);


--
-- Name: op_log_applied_brin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX op_log_applied_brin ON public.op_log USING brin (applied_at);


--
-- Name: os_sessions_owner_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX os_sessions_owner_recent ON public.os_sessions USING btree (owner_uid, updated_at DESC);


--
-- Name: telemetry_uid_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telemetry_uid_ts ON public.telemetry_events USING btree (uid, ts);


--
-- Name: user_groups_gid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_groups_gid ON public.user_groups USING btree (gid);


--
-- Name: dentries dentries_acyclic; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER dentries_acyclic BEFORE UPDATE OF parent_ino, ino ON public.dentries FOR EACH ROW WHEN (((new.d_type = 'd'::text) AND ((new.parent_ino IS DISTINCT FROM old.parent_ino) OR (new.ino IS DISTINCT FROM old.ino)))) EXECUTE FUNCTION public.plt_dentries_no_cycle();


--
-- Name: dentries dentries_fault; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER dentries_fault BEFORE INSERT OR DELETE OR UPDATE ON public.dentries FOR EACH ROW EXECUTE FUNCTION public.plt_fault_hook();


--
-- Name: inodes inodes_fault; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inodes_fault BEFORE INSERT OR DELETE OR UPDATE ON public.inodes FOR EACH ROW EXECUTE FUNCTION public.plt_fault_hook();


--
-- Name: audit_log audit_real_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_real_uid_fk FOREIGN KEY (real_uid) REFERENCES public.users(uid);


--
-- Name: audit_log audit_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_uid_fk FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: auth_sessions auth_sessions_su_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_su_uid_fk FOREIGN KEY (su_uid) REFERENCES public.users(uid);


--
-- Name: auth_sessions auth_sessions_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_uid_fk FOREIGN KEY (uid) REFERENCES public.users(uid) ON DELETE CASCADE;


--
-- Name: dentries dentries_child_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dentries
    ADD CONSTRAINT dentries_child_fk FOREIGN KEY (ino, d_type, owner_uid) REFERENCES public.inodes(ino, type, uid) ON UPDATE CASCADE;


--
-- Name: dentries dentries_parent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dentries
    ADD CONSTRAINT dentries_parent_fk FOREIGN KEY (parent_ino, parent_type) REFERENCES public.inodes(ino, type);


--
-- Name: feed feed_op_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed
    ADD CONSTRAINT feed_op_fk FOREIGN KEY (op_id) REFERENCES public.op_log(op_id);


--
-- Name: feed feed_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed
    ADD CONSTRAINT feed_owner_fk FOREIGN KEY (owner_uid) REFERENCES public.users(uid);


--
-- Name: file_chunks file_chunks_ino_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_chunks
    ADD CONSTRAINT file_chunks_ino_fk FOREIGN KEY (ino, ino_type) REFERENCES public.inodes(ino, type) ON DELETE CASCADE;


--
-- Name: inodes inodes_blob_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inodes
    ADD CONSTRAINT inodes_blob_fk FOREIGN KEY (blob_id) REFERENCES public.blobs(blob_id);


--
-- Name: inodes inodes_gid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inodes
    ADD CONSTRAINT inodes_gid_fk FOREIGN KEY (gid) REFERENCES public.groups(gid);


--
-- Name: inodes inodes_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inodes
    ADD CONSTRAINT inodes_uid_fk FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: llm_requests llm_requests_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_requests
    ADD CONSTRAINT llm_requests_uid_fk FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: locks locks_holder_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locks
    ADD CONSTRAINT locks_holder_fk FOREIGN KEY (holder_uid) REFERENCES public.users(uid);


--
-- Name: locks locks_ino_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locks
    ADD CONSTRAINT locks_ino_fk FOREIGN KEY (ino) REFERENCES public.inodes(ino) ON DELETE CASCADE;


--
-- Name: locks locks_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locks
    ADD CONSTRAINT locks_session_fk FOREIGN KEY (os_session_id) REFERENCES public.os_sessions(os_session_id);


--
-- Name: op_log op_log_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.op_log
    ADD CONSTRAINT op_log_uid_fk FOREIGN KEY (uid) REFERENCES public.users(uid);


--
-- Name: os_sessions os_sessions_auth_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.os_sessions
    ADD CONSTRAINT os_sessions_auth_fk FOREIGN KEY (auth_session_id) REFERENCES public.auth_sessions(id) ON DELETE SET NULL;


--
-- Name: os_sessions os_sessions_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.os_sessions
    ADD CONSTRAINT os_sessions_owner_fk FOREIGN KEY (owner_uid) REFERENCES public.users(uid) ON DELETE CASCADE;


--
-- Name: swap_pages swap_pages_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swap_pages
    ADD CONSTRAINT swap_pages_owner_fk FOREIGN KEY (owner_uid) REFERENCES public.users(uid);


--
-- Name: swap_pages swap_pages_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.swap_pages
    ADD CONSTRAINT swap_pages_session_fk FOREIGN KEY (os_session_id, owner_uid) REFERENCES public.os_sessions(os_session_id, owner_uid);


--
-- Name: telemetry_events telemetry_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetry_events
    ADD CONSTRAINT telemetry_uid_fk FOREIGN KEY (uid) REFERENCES public.users(uid) ON DELETE CASCADE;


--
-- Name: user_groups user_groups_gid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT user_groups_gid_fk FOREIGN KEY (gid) REFERENCES public.groups(gid) ON DELETE CASCADE;


--
-- Name: user_groups user_groups_uid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT user_groups_uid_fk FOREIGN KEY (uid) REFERENCES public.users(uid) ON DELETE CASCADE;


--
-- Name: users users_primary_gid_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_primary_gid_fk FOREIGN KEY (primary_gid) REFERENCES public.groups(gid);


--
-- PostgreSQL database dump complete
--



--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260924100000'),
    ('20260924100100'),
    ('20260924100200'),
    ('20260924100300'),
    ('20260924100400'),
    ('20260924100500');
