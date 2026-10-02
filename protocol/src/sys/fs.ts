/**
 * Files (syscall-abi.md §4.4.2; semantics owned by virtual-file-system.md).
 *
 * Where virtual-file-system.md §4.3 sketches different shapes (for example an `OpenArgs.flags`
 * object, a `writeFile` batch op, or `expectedVersions` as a record), syscall-abi.md wins on names
 * and shapes (its §1) and this module follows it; the differences are listed in protocol/README.md.
 */
import * as v from 'valibot';

import {
  BATCH_MAX_OPS,
  BATCH_WRITE_TEXT_MAX_BYTES,
  FIND_LIMIT_DEFAULT,
  FIND_LIMIT_MAX,
  GREP_PATTERN_MAX_BYTES,
  IO_MAX_BYTES,
  MULTI_PATH_MAX,
  READDIR_PAGE_MAX,
  TREE_DEPTH_ARG_MAX,
  WRITE_FILE_MAX_BYTES,
} from '../limits.ts';
import {
  ChmodMode,
  Conflict,
  Count,
  Cursor,
  DirEntry,
  EpochMs,
  Fd,
  Gid,
  Glob,
  Ino,
  InodeType,
  Mode,
  MutationFields,
  Name,
  Path,
  Pid,
  Stat,
  SymlinkTarget,
  SyncState,
  Uid,
} from './common.ts';

const noNul = (s: string): boolean => !s.includes('\u0000');

// ---------------------------------------------------------------------------------------------
// Shared shapes of this group
// ---------------------------------------------------------------------------------------------

export const LeaseMode = v.picklist(['S', 'X']);
export const LeaseScope = v.picklist(['server', 'local']);

/** A lease on a file, as shown by `lsof`, `lock.status` and `proc.info` (§4.4.2). */
export const LeaseInfo = v.strictObject({
  path: Path,
  /** `user@host`, for example `alice@lab-pc-3`. */
  holder: v.pipe(v.string(), v.maxLength(128)),
  mode: LeaseMode,
  expiresAt: EpochMs,
  scope: LeaseScope,
});

export const OpenFile = v.strictObject({
  pid: Pid,
  uid: Uid,
  fd: Fd,
  path: Path,
  flags: v.pipe(v.string(), v.maxLength(8)),
});

export const StatFs = v.strictObject({
  fsId: v.literal('plotinium'),
  /** From `navigator.storage.estimate()`. */
  usageBytes: Count,
  quotaBytes: v.nullable(Count),
  inodes: Count,
  persisted: v.boolean(),
  swapBytes: v.strictObject({ local: Count, remote: Count }),
});

export const Quota = v.strictObject({
  uid: Uid,
  usedBytes: Count,
  /** null: root is exempt (VFS-06). */
  quotaBytes: v.nullable(Count),
  usedInodes: Count,
  quotaInodes: v.nullable(Count),
  source: v.picklist(['server', 'mirror']),
});

const TimeSpec = v.union([EpochMs, v.literal('now')]);

// ---------------------------------------------------------------------------------------------
// open, read, write, writeFile, close, seek
// ---------------------------------------------------------------------------------------------

export const OpenFlags = v.picklist(['r', 'w', 'rw', 'a']);

export const OpenArgs = v.strictObject({
  path: Path,
  flags: OpenFlags,
  create: v.optional(v.boolean()),
  excl: v.optional(v.boolean()),
  trunc: v.optional(v.boolean()),
  /** Masked by the process umask (default 022). */
  mode: v.optional(Mode, 0o666),
  follow: v.optional(v.boolean(), true),
});
export const OpenRet = v.strictObject({
  fd: Fd,
  ino: Ino,
  type: InodeType,
  version: Count,
  size: Count,
});

export const ReadArgs = v.strictObject({
  fd: Fd,
  len: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(IO_MAX_BYTES)),
  offset: v.optional(Count),
});
/** The bytes read, transferred; length 0 means end of file. */
export const ReadRet = v.instance(ArrayBuffer);

export const WriteArgs = v.strictObject({
  fd: Fd,
  data: v.pipe(
    v.instance(ArrayBuffer),
    v.check((b) => b.byteLength <= IO_MAX_BYTES),
  ),
  offset: v.optional(Count),
  expectedVersion: v.optional(Count),
});
/** `{bytes}` for pipes and TTYs; regular files add the version, op and sync state (C4). */
export const WriteRet = v.strictObject({
  bytes: Count,
  version: v.optional(Count),
  opId: v.optional(Ino),
  sync: v.optional(SyncState),
  conflict: v.optional(Conflict),
});

export const WriteFileArgs = v.strictObject({
  path: Path,
  data: v.pipe(
    v.instance(ArrayBuffer),
    v.check((b) => b.byteLength <= WRITE_FILE_MAX_BYTES),
  ),
  expectedVersion: v.optional(Count),
  create: v.optional(v.boolean(), true),
  mode: v.optional(Mode),
});
export const WriteFileRet = v.strictObject({
  ino: Ino,
  version: Count,
  bytes: Count,
  ...MutationFields,
  conflict: v.optional(Conflict),
});

export const CloseArgs = v.strictObject({ fd: Fd });
export const CloseRet = v.strictObject({});

export const SeekArgs = v.strictObject({
  fd: Fd,
  offset: v.pipe(v.number(), v.safeInteger()),
  whence: v.picklist(['set', 'cur', 'end']),
});
export const SeekRet = v.strictObject({ offset: Count });

// ---------------------------------------------------------------------------------------------
// stat, lstat, fstat, readdir, readlink, statfs, quota
// ---------------------------------------------------------------------------------------------

export const StatArgs = v.strictObject({ path: Path, follow: v.optional(v.boolean(), true) });
export const StatRet = Stat;
export const LstatArgs = v.strictObject({ path: Path });
export const LstatRet = Stat;
export const FstatArgs = v.strictObject({ fd: Fd });
export const FstatRet = Stat;

export const ReaddirArgs = v.strictObject({
  path: Path,
  plus: v.optional(v.boolean()),
  cursor: v.optional(Cursor),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(READDIR_PAGE_MAX))),
});
export const ReaddirRet = v.strictObject({
  entries: v.pipe(v.array(DirEntry), v.maxLength(READDIR_PAGE_MAX)),
  next: v.optional(Cursor),
  dirVersion: Count,
});

export const ReadlinkArgs = v.strictObject({ path: Path });
export const ReadlinkRet = v.strictObject({ target: SymlinkTarget });

export const StatfsArgs = v.strictObject({ path: v.optional(Path) });
export const StatfsRet = StatFs;

export const QuotaArgs = v.strictObject({ uid: v.optional(Uid) });
export const QuotaRet = Quota;

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

export const MkdirArgs = v.strictObject({
  path: Path,
  mode: v.optional(Mode, 0o777),
  parents: v.optional(v.boolean()),
});
/** `created`: the number of directories created (0 with `parents` when all existed). */
export const MkdirRet = v.strictObject({ ino: Ino, created: Count, ...MutationFields });

export const RmdirArgs = v.strictObject({ path: Path });
export const RmdirRet = v.strictObject({ ...MutationFields });

export const UnlinkArgs = v.strictObject({ path: Path, recursive: v.optional(v.boolean()) });
export const UnlinkRet = v.strictObject({ removed: Count, bytes: Count, ...MutationFields });

export const RenameArgs = v.strictObject({
  from: Path,
  to: Path,
  noReplace: v.optional(v.boolean()),
});
/** `replaced`: the inode that the rename replaced, if any. */
export const RenameRet = v.strictObject({ ino: Ino, replaced: v.optional(Ino), ...MutationFields });

export const SymlinkArgs = v.strictObject({ target: SymlinkTarget, path: Path });
export const SymlinkRet = v.strictObject({ ino: Ino, ...MutationFields });

export const LinkArgs = v.strictObject({ existing: Path, path: Path });
export const LinkRet = v.strictObject({ ino: Ino, nlink: Count, ...MutationFields });

export const ChmodArgs = v.strictObject({
  path: Path,
  mode: ChmodMode,
  recursive: v.optional(v.boolean()),
});
export const ChmodRet = v.strictObject({ changed: Count, ...MutationFields });

export const ChownArgs = v.strictObject({
  path: Path,
  uid: v.optional(Uid),
  gid: v.optional(Gid),
  recursive: v.optional(v.boolean()),
});
export const ChownRet = v.strictObject({ changed: Count, ...MutationFields });

export const TruncateArgs = v.union([
  v.strictObject({ path: Path, size: Count }),
  v.strictObject({ fd: Fd, size: Count }),
]);
export const TruncateRet = v.strictObject({ version: Count, ...MutationFields });

export const UtimesArgs = v.strictObject({
  path: Path,
  atime: v.optional(TimeSpec),
  mtime: v.optional(TimeSpec),
});
export const UtimesRet = v.strictObject({ ...MutationFields });

export const CopyArgs = v.strictObject({
  from: Path,
  to: Path,
  recursive: v.optional(v.boolean()),
  noReplace: v.optional(v.boolean()),
  /** Keep owner, group and mode; preserving the owner needs root. */
  preserve: v.optional(v.boolean()),
});
export const CopyRet = v.strictObject({ copied: Count, bytes: Count, ...MutationFields });

// ---------------------------------------------------------------------------------------------
// Read-only scans (class R): find, grep, du, wc; lsof
// ---------------------------------------------------------------------------------------------

/** A relative time span (AGT-07 relative dates; count 1..365 as in agentic-shell.md §3.6). */
export const RelSpan = v.strictObject({
  unit: v.picklist(['hour', 'day', 'week', 'month']),
  count: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(365)),
  mode: v.optional(v.picklist(['rolling', 'calendar'])),
});

export const FindMtime = v.union([
  v.strictObject({ within: RelSpan }),
  v.strictObject({ olderThan: RelSpan }),
  v.strictObject({ after: v.optional(EpochMs), before: v.optional(EpochMs) }),
]);

export const FindArgs = v.strictObject({
  path: Path,
  /** Basename glob; the kernel never accepts a regular expression. */
  name: v.optional(Glob),
  type: v.optional(InodeType),
  mtime: v.optional(FindMtime),
  /** Sizes in bytes. */
  size: v.optional(v.strictObject({ gt: v.optional(Count), lt: v.optional(Count) })),
  maxDepth: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(TREE_DEPTH_ARG_MAX)),
  ),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(FIND_LIMIT_MAX)),
    FIND_LIMIT_DEFAULT,
  ),
  plus: v.optional(v.boolean()),
  cursor: v.optional(Cursor),
});
export const FindRet = v.strictObject({
  paths: v.pipe(v.array(Path), v.maxLength(FIND_LIMIT_MAX)),
  entries: v.optional(v.pipe(v.array(DirEntry), v.maxLength(FIND_LIMIT_MAX))),
  next: v.optional(Cursor),
  /** Unreadable directories that were skipped. */
  denied: Count,
  truncated: v.boolean(),
  /** The absolute interval computed for a relative `mtime`, in the caller's time zone (AGT-07). */
  resolved: v.optional(
    v.strictObject({
      from: v.pipe(v.string(), v.maxLength(40), v.isoTimestamp()),
      to: v.pipe(v.string(), v.maxLength(40), v.isoTimestamp()),
    }),
  ),
});

export const GrepArgs = v.strictObject({
  paths: v.pipe(v.array(Path), v.minLength(1), v.maxLength(MULTI_PATH_MAX)),
  /** A fixed string, never a regular expression (INV-ABI-7). */
  pattern: v.pipe(v.string(), v.minLength(1), v.maxBytes(GREP_PATTERN_MAX_BYTES), v.check(noNul)),
  recursive: v.optional(v.boolean()),
  ignoreCase: v.optional(v.boolean()),
  /** `l`: file names; `c`: counts. Matching lines are never returned. */
  mode: v.picklist(['l', 'c']),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(FIND_LIMIT_MAX))),
});
export const GrepRet = v.strictObject({
  matches: v.array(v.strictObject({ path: Path, count: Count })),
  denied: Count,
  skippedBinary: Count,
  next: v.optional(Cursor),
});

export const DuArgs = v.strictObject({
  path: Path,
  maxDepth: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(TREE_DEPTH_ARG_MAX)),
  ),
  /** Apparent sizes instead of charged sizes. */
  apparent: v.optional(v.boolean()),
});
export const DuRet = v.strictObject({
  bytes: Count,
  inodes: Count,
  children: v.optional(v.array(v.strictObject({ name: Name, bytes: Count, inodes: Count }))),
  denied: Count,
});

export const WcArgs = v.strictObject({
  paths: v.pipe(v.array(Path), v.minLength(1), v.maxLength(MULTI_PATH_MAX)),
});
const WcCounts = { lines: Count, words: Count, bytes: Count } as const;
export const WcRet = v.strictObject({
  files: v.array(v.strictObject({ path: Path, ...WcCounts })),
  total: v.strictObject({ ...WcCounts }),
});

export const LsofArgs = v.strictObject({ path: v.optional(Path), pid: v.optional(Pid) });
export const LsofRet = v.strictObject({
  open: v.array(OpenFile),
  leases: v.array(LeaseInfo),
});

// ---------------------------------------------------------------------------------------------
// batch (class X, `large`): one transaction for many ops (AGT-05)
// ---------------------------------------------------------------------------------------------

export const BatchOp = v.variant('op', [
  v.strictObject({
    op: v.literal('mkdir'),
    path: Path,
    mode: v.optional(Mode),
    parents: v.optional(v.boolean()),
  }),
  v.strictObject({
    op: v.literal('write'),
    path: Path,
    /** At most 64 KiB of UTF-8. */
    text: v.pipe(v.string(), v.maxBytes(BATCH_WRITE_TEXT_MAX_BYTES)),
    expectedVersion: v.optional(Count),
  }),
  v.strictObject({
    op: v.literal('rename'),
    from: Path,
    to: Path,
    noReplace: v.optional(v.boolean()),
  }),
  v.strictObject({
    op: v.literal('copy'),
    from: Path,
    to: Path,
    recursive: v.optional(v.boolean()),
  }),
  v.strictObject({ op: v.literal('unlink'), path: Path, recursive: v.optional(v.boolean()) }),
  v.strictObject({ op: v.literal('symlink'), target: SymlinkTarget, path: Path }),
  v.strictObject({
    op: v.literal('chmod'),
    path: Path,
    mode: ChmodMode,
    recursive: v.optional(v.boolean()),
  }),
  v.strictObject({
    op: v.literal('chown'),
    path: Path,
    uid: v.optional(Uid),
    gid: v.optional(Gid),
    recursive: v.optional(v.boolean()),
  }),
  v.strictObject({ op: v.literal('utimes'), path: Path, mtime: TimeSpec }),
]);

/** The ops a plan step or a batch may carry, in §4.4.2 order. */
export const BATCH_OP_NAMES = [
  'mkdir',
  'write',
  'rename',
  'copy',
  'unlink',
  'symlink',
  'chmod',
  'chown',
  'utimes',
] as const;

/**
 * A plan token `<planId>.<exp>.<b64url(HMAC-SHA256)>` issued by the kernel (§5.4): the 36-char
 * plan id, the expiry in epoch ms, and 43 base64url characters (32 bytes, no padding).
 */
export const PlanToken = v.pipe(
  v.string(),
  v.regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.\d{1,16}\.[A-Za-z0-9_-]{43}$/,
  ),
);

/** Bound on the dry-run fingerprint: keeps a `large` call near its 1 MiB worst case (§3.1). */
export const EXPECTED_VERSIONS_MAX = 16_384;

export const ExpectedVersion = v.strictObject({ ino: Ino, version: Count });

export const BatchArgs = v.strictObject({
  /** UUIDv7; becomes the outbox opId (idempotency key). */
  txnId: Ino,
  ops: v.pipe(v.array(BatchOp), v.minLength(1), v.maxLength(BATCH_MAX_OPS)),
  /** The dry-run fingerprint. */
  expectedVersions: v.pipe(v.array(ExpectedVersion), v.maxLength(EXPECTED_VERSIONS_MAX)),
  /** Required for agent-class callers (§5.4). */
  token: v.optional(PlanToken),
  planId: v.optional(Ino),
});
/** `applied`: the number of ops applied (all of them: the batch is one transaction). */
export const BatchRet = v.strictObject({
  txnId: Ino,
  applied: Count,
  inodes: Count,
  bytes: Count,
  undoId: Ino,
  ...MutationFields,
});

export type LeaseInfo = v.InferOutput<typeof LeaseInfo>;
export type OpenFile = v.InferOutput<typeof OpenFile>;
export type StatFs = v.InferOutput<typeof StatFs>;
export type Quota = v.InferOutput<typeof Quota>;
export type OpenArgs = v.InferOutput<typeof OpenArgs>;
export type FindArgs = v.InferOutput<typeof FindArgs>;
export type RelSpan = v.InferOutput<typeof RelSpan>;
export type BatchOp = v.InferOutput<typeof BatchOp>;
export type BatchOpName = (typeof BATCH_OP_NAMES)[number];
export type BatchArgs = v.InferOutput<typeof BatchArgs>;
export type ExpectedVersion = v.InferOutput<typeof ExpectedVersion>;
