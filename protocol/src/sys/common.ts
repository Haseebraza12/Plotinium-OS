/**
 * Shared primitives of the system-call ABI (syscall-abi.md §4.2).
 *
 * Conventions (§3.11, ABI-04): every object schema is `v.strictObject`, so a smuggled `uid` or
 * `pid` fails at dispatcher stage 3 with EINVAL; every string and array has a limit (ABI-13); the
 * only allowed schema message is the errno tag 'ENAMETOOLONG' (path and name byte limits), which
 * the dispatcher maps to ENAMETOOLONG. Every other issue maps to EINVAL.
 *
 * Plotinium design (virtual-file-system.md §3.4, PVFS-12): path and name strings are checked for
 * well-formed UTF-16 (a lone surrogate cannot be encoded as UTF-8, so it is EINVAL) and then
 * normalised to NFC BEFORE the byte-length checks, at the syscall boundary.
 */
import * as v from 'valibot';

import {
  FD_TABLE_SIZE,
  GLOB_MAX_BYTES,
  MODE_MAX,
  NAME_MAX,
  PATH_MAX,
  PID_MAX,
  UID_MAX,
} from '../limits.ts';
import { SignalName } from '../signals.ts';

/** The only schema message allowed besides "none" (§3.11 errno tags). */
export const ENAMETOOLONG_TAG = 'ENAMETOOLONG';

const noNul = (s: string): boolean => !s.includes('\u0000');
const wellFormed = (s: string): boolean => s.isWellFormed();

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/** A non-negative safe integer: sizes, counts, byte offsets, epoch milliseconds. */
export const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
/** Epoch milliseconds (kernel clock). */
export const EpochMs = Count;
/** A finite number (durations, scores, CSS pixels). */
export const Finite = v.pipe(v.number(), v.finite());
/** A request id: uint32 (§3.1 rule 2). */
export const RequestId = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(0xffff_ffff));

export const Fd = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(FD_TABLE_SIZE - 1));
export const Pid = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(PID_MAX));
/** A pid or 0 (0 = the caller, its group, or "the kernel itself" in logs). */
export const PidOrZero = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(PID_MAX));
export const Uid = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(UID_MAX));
export const Gid = Uid;
export const Mode = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MODE_MAX));
/** A window id (the compositor's registry key, dsa/hashtable keys are 0..2^31-1). */
export const Wid = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(UID_MAX));
export const Priority = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(39));
export const Nice = v.pipe(v.number(), v.integer(), v.minValue(-20), v.maxValue(19));
/** A number in [0, 1] (confidence, hit ratio). */
export const Ratio = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

// ---------------------------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------------------------

/** An absolute or relative path: 1..4096 UTF-8 bytes after NFC, no NUL (§4.2, VFS-08). */
export const Path = v.pipe(
  v.string(),
  v.check(wellFormed),
  v.normalize('NFC'),
  v.minLength(1),
  v.maxBytes(PATH_MAX, ENAMETOOLONG_TAG),
  v.check(noNul),
);

/** One directory entry name: 1..255 UTF-8 bytes after NFC, no NUL or '/', not '.' or '..'. */
export const Name = v.pipe(
  v.string(),
  v.check(wellFormed),
  v.normalize('NFC'),
  v.minLength(1),
  v.maxBytes(NAME_MAX, ENAMETOOLONG_TAG),
  v.check((s) => noNul(s) && !s.includes('/') && s !== '.' && s !== '..'),
);

/**
 * A symlink target: at most 4096 bytes, may dangle. Empty is allowed by the schema because the VFS
 * answers ENOENT for an empty target, as Linux does (virtual-file-system.md §3.4).
 */
export const SymlinkTarget = v.pipe(
  v.string(),
  v.check(wellFormed),
  v.normalize('NFC'),
  v.maxBytes(PATH_MAX, ENAMETOOLONG_TAG),
  v.check(noNul),
);

/** UUIDv7 (C5). The well-known fixed inodes use the v7 layout with a zero timestamp. */
export const Ino = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);

/** 64 lower-case hex digits. */
export const Sha256Hex = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

/** A basename glob: `*`, `?`, `[..]`, `**`; never a regular expression (§4.2, INV-ABI-7). */
export const Glob = v.pipe(v.string(), v.minLength(1), v.maxBytes(GLOB_MAX_BYTES), v.check(noNul));

/** A user name (database CHECK `users_username_valid`, database.md §4). */
export const Username = v.pipe(v.string(), v.regex(/^[a-z_][a-z0-9_-]{0,31}$/));

/** An application id: the name of a `/bin/<app>.json` manifest (boot-and-services.md §4.4). */
export const AppId = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,31}$/));

/** An opaque pagination cursor issued by the kernel. */
export const Cursor = v.pipe(v.string(), v.minLength(1), v.maxLength(256));

/** A short human-readable text (titles, reasons, error summaries). */
export const ShortText = v.pipe(v.string(), v.maxLength(256));

/** ISO 8601 timestamp with a `Z` or numeric offset. */
export const IsoTimestamp = v.pipe(v.string(), v.maxLength(40), v.isoTimestamp());

/** An IANA time-zone name such as `Asia/Karachi` or `UTC`. */
export const TimeZone = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/),
  v.maxLength(64),
);

// ---------------------------------------------------------------------------------------------
// Picklists (§4.2). `SignalName`, `Cap`, `Errno` and `ProcClass` live in signals.ts, caps.ts and
// errno.ts under the same names (schema and type).
// ---------------------------------------------------------------------------------------------

export const SyncState = v.picklist(['applied', 'pending']);
export const Bytes = v.instance(ArrayBuffer);

/** `chmod` in set or delta form (symbolic modes such as `o-w` become deltas). */
export const ModeChange = v.variant('op', [
  v.strictObject({ op: v.literal('set'), bits: Mode }),
  v.strictObject({ op: v.literal('delta'), add: Mode, clear: Mode }),
]);

/** setuid (0o4000) and setgid (0o2000) are rejected in v1 with EINVAL (§4.4.2 `chmod`). */
export const SETID_BITS = 0o6000;

/** A `ModeChange` that sets no setuid or setgid bit. */
export const ChmodMode = v.pipe(
  ModeChange,
  v.check((m) => ((m.op === 'set' ? m.bits : m.add) & SETID_BITS) === 0),
);

// ---------------------------------------------------------------------------------------------
// Shared result shapes (§4.2)
// ---------------------------------------------------------------------------------------------

export const InodeType = v.picklist(['f', 'd', 'l']);

/**
 * `Stat` (Spec §9.3 inode fields). `btime`, `fs`, `synth` and `cached` are the optional extensions
 * of virtual-file-system.md §4.1 (adding return fields does not bump ABI_VERSION, §3.10).
 */
export const Stat = v.strictObject({
  ino: Ino,
  type: InodeType,
  mode: Mode,
  uid: Uid,
  gid: Gid,
  size: Count,
  nlink: Count,
  atime: EpochMs,
  mtime: EpochMs,
  ctime: EpochMs,
  version: Count,
  blob: v.nullable(Sha256Hex),
  target: v.nullable(SymlinkTarget),
  btime: v.optional(EpochMs),
  fs: v.optional(v.picklist(['root', 'tmp'])),
  synth: v.optional(v.boolean()),
  cached: v.optional(v.boolean()),
});

export const DirEntry = v.strictObject({
  name: Name,
  ino: Ino,
  type: InodeType,
  stat: v.optional(Stat),
});

export const Cred = v.strictObject({
  uid: Uid,
  gid: Gid,
  groups: v.pipe(v.array(Gid), v.maxLength(64)),
});

/** VFS-10: a version conflict is a SUCCESS that reports where the write was kept. */
export const Conflict = v.strictObject({
  keptAs: v.strictObject({ ino: Ino, path: Path }),
});

export const WaitStatus = v.variant('kind', [
  v.strictObject({
    kind: v.literal('exited'),
    code: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(255)),
  }),
  v.strictObject({
    kind: v.literal('signaled'),
    signal: SignalName,
    code: v.pipe(v.number(), v.integer(), v.minValue(129), v.maxValue(255)),
  }),
  v.strictObject({ kind: v.literal('stopped'), signal: SignalName }),
  v.strictObject({ kind: v.literal('continued') }),
]);

export const Rect = v.strictObject({
  x: Finite,
  y: Finite,
  w: v.pipe(v.number(), v.finite(), v.minValue(0)),
  h: v.pipe(v.number(), v.finite(), v.minValue(0)),
});

/** Process states (Spec §9.1). */
export const PState = v.picklist(['NEW', 'READY', 'RUNNING', 'BLOCKED', 'SUSPENDED', 'TERMINATED']);

/** The empty argument or result object `{}`. */
export const Empty = v.strictObject({});

/** The fields every mutating call reports (§3.4 rule 4). */
export const MutationFields = {
  opId: Ino,
  sync: SyncState,
} as const;

export type Path = v.InferOutput<typeof Path>;
export type Name = v.InferOutput<typeof Name>;
export type Ino = v.InferOutput<typeof Ino>;
export type Sha256Hex = v.InferOutput<typeof Sha256Hex>;
export type ModeChange = v.InferOutput<typeof ModeChange>;
export type InodeType = v.InferOutput<typeof InodeType>;
export type Stat = v.InferOutput<typeof Stat>;
export type DirEntry = v.InferOutput<typeof DirEntry>;
export type Cred = v.InferOutput<typeof Cred>;
export type Conflict = v.InferOutput<typeof Conflict>;
export type WaitStatus = v.InferOutput<typeof WaitStatus>;
export type Rect = v.InferOutput<typeof Rect>;
export type PState = v.InferOutput<typeof PState>;
export type SyncState = v.InferOutput<typeof SyncState>;
