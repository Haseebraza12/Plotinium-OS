/**
 * SQLSTATE -> errno mapping and the persisted-outcome classification.
 *
 * Spec: specs/09-database/database.md §4.9 and §6.1 (the canonical mapping, DB-04, §11.3 rule 4);
 * reason names from specs/01-architecture/syscall-abi.md §4.3.1 and §4.9, which own the wire;
 * the persisted/transient split from specs/06-sync/offline-and-sync.md §3.10 (OFF-02, AGT-09).
 * Primary owner R2, secondary reviewer R5.
 *
 * Every constraint and unique index in db/schema.sql has an explicit rule in CONSTRAINT_RULES; the
 * test "DB-04 every constraint name in db/schema.sql is covered by the errno mapper" enforces it,
 * so a new constraint cannot ship without a decision about its errno.
 */
import type { Errno } from '../errno.ts';
import { LockSetChanged, VfsError } from '../vfs/types.ts';

export interface ConstraintRule {
  /** Errno for the violating statement (for a foreign key: the referencing, insert/update side). */
  readonly errno: Errno;
  readonly reason?: string;
  /** Foreign keys only: errno when the REFERENCED row is deleted or updated. */
  readonly referencedErrno?: Errno;
}

const rule = (errno: Errno, reason?: string, referencedErrno?: Errno): ConstraintRule => ({
  errno,
  ...(reason === undefined ? {} : { reason }),
  ...(referencedErrno === undefined ? {} : { referencedErrno }),
});

const EINVAL = rule('EINVAL');
const EEXIST = rule('EEXIST');
const ENOENT = rule('ENOENT');
/** An invariant that holds by construction; a violation means a lock or statement was skipped. */
const BUG = rule('EIO', 'server');

/** Constraint (and unique index / trigger) name -> errno. Grouped by table, as in db/schema.sql. */
export const CONSTRAINT_RULES: Readonly<Record<string, ConstraintRule>> = {
  // groups, users, user_groups
  groups_pkey: EEXIST,
  groups_gid_range: EINVAL,
  groups_name_key: EEXIST,
  groups_name_valid: EINVAL,
  users_pkey: EEXIST,
  users_uid_range: EINVAL,
  users_username_key: EEXIST,
  users_username_valid: EINVAL,
  users_kind_valid: EINVAL,
  users_password_version_pos: EINVAL,
  users_primary_gid_fk: rule('EINVAL', undefined, 'EINVAL'),
  users_quota_bytes_nonneg: EINVAL,
  users_quota_inodes_nonneg: EINVAL,
  users_root_kind: EINVAL,
  users_password_required: EINVAL,
  users_used_nonneg: BUG,
  users_quota_bytes_ok: rule('EDQUOT'),
  users_quota_inodes_ok: rule('EDQUOT'),
  users_feed_seq_order: BUG,
  user_groups_pkey: EEXIST,
  user_groups_uid_fk: ENOENT,
  user_groups_gid_fk: ENOENT,
  // auth_sessions, os_sessions
  auth_sessions_pkey: BUG,
  auth_sessions_id_valid: EINVAL,
  auth_sessions_hash_len: EINVAL,
  auth_sessions_uid_fk: ENOENT,
  auth_sessions_su_uid_fk: ENOENT,
  auth_sessions_ua_len: EINVAL,
  auth_sessions_expiry_order: EINVAL,
  auth_sessions_su_pair: EINVAL,
  os_sessions_pkey: EEXIST,
  os_sessions_owner_fk: ENOENT,
  os_sessions_auth_fk: ENOENT,
  os_sessions_epoch_nonneg: EINVAL,
  os_sessions_label_len: EINVAL,
  os_sessions_rev_nonneg: EINVAL,
  os_sessions_id_owner_key: EEXIST,
  // blobs
  blobs_pkey: BUG,
  blobs_sha256_len: EINVAL,
  blobs_size_nonneg: EINVAL,
  blobs_refcount_nonneg: BUG,
  blobs_sha256_key: EEXIST,
  blobs_zero_since_iff: BUG,
  // inodes
  inodes_pkey: EEXIST,
  inodes_type_valid: EINVAL,
  inodes_mode_range: EINVAL,
  inodes_uid_fk: rule('EINVAL', undefined, 'EINVAL'),
  inodes_gid_fk: rule('EINVAL', undefined, 'EINVAL'),
  inodes_size_nonneg: EINVAL,
  inodes_nlink_nonneg: BUG,
  inodes_version_pos: EINVAL,
  inodes_blob_fk: rule('EIO', 'server', 'EIO'),
  inodes_fence_nonneg: EINVAL,
  inodes_symlink_iff_target: EINVAL,
  inodes_symlink_target_nonempty: EINVAL,
  inodes_symlink_target_len: rule('ENAMETOOLONG'),
  inodes_blob_only_files: EINVAL,
  inodes_file_content: EINVAL,
  inodes_dir_size_zero: EINVAL,
  inodes_symlink_size: EINVAL,
  inodes_ino_type_key: EEXIST,
  inodes_ino_type_uid_key: EEXIST,
  // dentries (+ the acyclicity trigger's constraint name)
  dentries_pkey: EEXIST,
  dentries_parent_is_dir: EINVAL,
  dentries_name_nonempty: EINVAL,
  dentries_name_len: rule('ENAMETOOLONG'),
  dentries_name_chars: EINVAL,
  dentries_name_nfc: EINVAL,
  // missing parent or a file used as a parent / deleting a directory that still has entries
  dentries_parent_fk: rule('ENOENT', undefined, 'ENOTEMPTY'),
  // type or owner copy mismatch, missing inode / a named inode deleted (a bug)
  dentries_child_fk: rule('ENOENT', undefined, 'EIO'),
  dentries_dir_one_parent: rule('EPERM', 'directory'), // link(2) on a directory
  dentries_acyclic: EINVAL, // SQLSTATE PTC01, raised by the trigger
  // op_log, feed
  op_log_pkey: BUG, // L0 uses ON CONFLICT DO NOTHING
  op_log_uid_fk: ENOENT,
  op_log_cseq_nonneg: EINVAL,
  op_log_lamport_nonneg: EINVAL,
  op_log_call_valid: EINVAL,
  op_log_status_valid: EINVAL,
  op_log_errno_valid: EINVAL,
  op_log_session_cseq_key: EINVAL, // a different op claims an occupied lane slot
  op_log_errno_consistent: BUG,
  feed_pkey: BUG,
  feed_owner_op_key: BUG,
  feed_owner_fk: ENOENT,
  feed_op_fk: BUG,
  feed_seq_pos: BUG,
  // locks
  locks_pkey: rule('EBUSY', 'lease'),
  locks_ino_fk: ENOENT,
  locks_session_fk: ENOENT,
  locks_lease_id_key: BUG,
  locks_holder_fk: ENOENT,
  locks_mode_valid: EINVAL,
  locks_fence_pos: BUG,
  locks_lease_order: EINVAL,
  locks_sx_excl: rule('EBUSY', 'lease'), // SQLSTATE 23P01
  locks_one_writer: rule('EBUSY', 'lease'),
  // swap_pages
  swap_pages_pkey: EEXIST,
  swap_pages_owner_fk: ENOENT,
  swap_pages_pid_pos: EINVAL,
  swap_pages_page_nonneg: EINVAL,
  swap_pages_gen_nonneg: EINVAL,
  swap_pages_size_range: EINVAL,
  swap_pages_stored_nonneg: EINVAL,
  swap_pages_checksum_len: EINVAL,
  swap_pages_session_fk: rule('EACCES'), // a page filed under another user's OS session
  // audit_log
  audit_log_pkey: BUG,
  audit_uid_fk: ENOENT,
  audit_real_uid_fk: ENOENT,
  audit_actor_valid: EINVAL,
  audit_outcome_valid: EINVAL,
  audit_plan_hash_len: EINVAL,
  audit_agent_has_prompt: EINVAL,
  // file_chunks
  file_chunks_pkey: BUG,
  file_chunks_files_only: EINVAL,
  file_chunks_version_pos: EINVAL,
  file_chunks_model_key_valid: EINVAL,
  file_chunks_seq_nonneg: EINVAL,
  file_chunks_byte_start_nonneg: EINVAL,
  file_chunks_line_start_pos: EINVAL,
  file_chunks_hash_len: EINVAL,
  file_chunks_bytes_order: EINVAL,
  file_chunks_lines_order: EINVAL,
  file_chunks_ino_fk: ENOENT,
  file_chunks_ino_model_seq_key: BUG, // index.put holds the advisory lock
  // llm_usage, llm_requests
  llm_usage_pkey: EEXIST,
  llm_usage_pool_valid: EINVAL,
  llm_usage_period_valid: EINVAL,
  llm_usage_limit_nonneg: BUG,
  llm_usage_call_limit_nonneg: BUG,
  llm_usage_reserved_nonneg: BUG,
  llm_usage_spent_nonneg: BUG,
  llm_usage_calls_nonneg: BUG,
  llm_requests_pkey: BUG,
  llm_requests_uid_fk: ENOENT,
  llm_requests_turn_range: EINVAL,
  llm_requests_purpose_valid: EINVAL,
  llm_requests_status_valid: EINVAL,
  llm_requests_in_nonneg: EINVAL,
  llm_requests_cr_nonneg: EINVAL,
  llm_requests_cw_nonneg: EINVAL,
  llm_requests_out_nonneg: EINVAL,
  llm_requests_reserved_nonneg: EINVAL,
  llm_requests_cost_nonneg: EINVAL,
  llm_requests_charged_nonempty: EINVAL,
  llm_requests_latency_nonneg: EINVAL,
  llm_requests_settled_iff: BUG,
  // telemetry_events
  telemetry_events_pkey: EEXIST,
  telemetry_uid_fk: ENOENT,
  telemetry_app_valid: EINVAL,
  telemetry_kind_valid: EINVAL,
  // dbmate's own table
  schema_migrations_pkey: BUG,
};

/** The shape of a node-postgres DatabaseError that the mapper reads. */
export interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
  message?: unknown;
  hint?: unknown;
}

export interface ErrCtx {
  /** The op's cancel flag was set before pg_cancel_backend was called (database.md §3.9.5). */
  readonly cancelled: boolean;
}

/** SQLSTATEs that vfsTxn retries (database.md §3.9.2, C7). */
export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01', '55P03']);

/** The SQLSTATE of a node-postgres error, or undefined. */
export function sqlstate(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as PgErrorLike).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

function constraintOf(e: PgErrorLike): string | undefined {
  return typeof e.constraint === 'string' ? e.constraint : undefined;
}

function detailFor(r: ConstraintRule, constraint: string | undefined): Record<string, unknown> {
  return {
    ...(r.reason === undefined ? {} : { reason: r.reason }),
    ...(constraint === undefined ? {} : { constraint }),
  };
}

/**
 * Maps any error thrown inside a VFS transaction to exactly one errno (§11.3 rule 4).
 * Called after vfsTxn's retries are exhausted, so 55P03/40001/40P01 here are final.
 */
export function toErrno(e: unknown, ctx: ErrCtx): VfsError {
  if (e instanceof VfsError) return e;
  if (e instanceof LockSetChanged) {
    return new VfsError('EAGAIN', { reason: 'retry-exhausted', cause: 'lockset' });
  }
  if (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError') {
    return new VfsError('ECANCELED', { reason: 'killed' }); // the op's AbortSignal (proc.signal)
  }
  const p = (typeof e === 'object' && e !== null ? e : {}) as PgErrorLike;
  const code = sqlstate(e);
  const constraint = constraintOf(p);
  const known = constraint === undefined ? undefined : CONSTRAINT_RULES[constraint];
  switch (code) {
    case '23505': {
      const r = known ?? EEXIST;
      return new VfsError(r.errno, detailFor(r, constraint));
    }
    case '23503': {
      // lc_messages = C (database.md §3.24): the referenced side's message starts like this.
      const referencedSide =
        typeof p.message === 'string' && p.message.startsWith('update or delete on table');
      const r = known ?? ENOENT;
      const errno = referencedSide ? (r.referencedErrno ?? r.errno) : r.errno;
      return new VfsError(errno, detailFor({ ...r, errno }, constraint));
    }
    case '23514': {
      const r = known ?? EINVAL;
      return new VfsError(r.errno, detailFor(r, constraint));
    }
    case '23P01': {
      const r = known ?? rule('EBUSY', 'lease');
      return new VfsError(r.errno, detailFor(r, constraint));
    }
    case 'PTC01':
      return new VfsError('EINVAL', { constraint: 'dentries_acyclic' });
    case 'P0001': {
      const injected = p.hint === 'plotinium.fault';
      return new VfsError('EIO', {
        reason: injected ? 'injected' : 'server',
        ...(typeof p.message === 'string' ? { message: p.message } : {}),
      });
    }
    case '55P03':
      return new VfsError('EBUSY', { reason: 'lock-timeout' });
    case '40001':
    case '40P01':
      return new VfsError('EAGAIN', { reason: 'retry-exhausted', sqlstate: code });
    case '57014':
      return ctx.cancelled
        ? new VfsError('ECANCELED', { reason: 'killed' })
        : new VfsError('ETIMEDOUT', { sqlstate: code });
    case '23502':
    case '22P02':
    case '22003':
    case '22021':
    case '22P05':
      return new VfsError('EINVAL', { sqlstate: code });
    case undefined:
    default:
      // 08xxx connection loss and 57P0x server shutdown: transient, the client resends and L0
      // resolves the ambiguity. 42501 (privilege: our bug), 53xxx, XX000 and anything else: EIO.
      return new VfsError('EIO', {
        reason: 'server',
        ...(code === undefined ? {} : { sqlstate: code }),
      });
  }
}

/**
 * True when a resend of the same opId must reproduce this rejection instead of executing again,
 * so vfsTxn records it in op_log after the rollback (database.md §3.9.3 refined by
 * offline-and-sync.md §3.10): "every outcome after which the client reverts or finishes is
 * persisted; every outcome after which the client sends the same op again is not".
 */
export function isDeterministic(err: VfsError): boolean {
  const reason = err.reason;
  switch (err.errno) {
    case 'ENOENT':
    case 'EEXIST':
    case 'ENOTDIR':
    case 'EISDIR':
    case 'ENOTEMPTY':
    case 'EINVAL':
    case 'EPERM':
    case 'ELOOP':
    case 'EDQUOT':
    case 'ENAMETOOLONG':
    case 'EXDEV':
      return true;
    case 'EACCES':
      return reason !== 'principal'; // an ungranted principal is held and resent (sync §3.8.6)
    case 'EIO':
      return reason === 'injected'; // the harness is one-shot; a server EIO is transient
    case 'ECANCELED':
      return reason === 'killed'; // a killed op must never re-execute on resend (AGT-09)
    case 'EBUSY':
      return reason === 'lease' || reason === 'subtree-busy'; // not 'lock-timeout'
    case 'EAGAIN':
      return reason === 'stale-version' || reason === 'stale-plan' || reason === 'stale-base';
    case 'ETIMEDOUT':
    case 'ESRCH':
    case 'ENOSYS':
    case 'EBADF':
    case 'EMFILE':
    case 'ENOTTY':
    case 'EPIPE':
    case 'EAIUNAVAIL':
    case 'EAIREFUSED':
      return false;
  }
}
