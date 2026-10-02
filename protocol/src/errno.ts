/**
 * The closed errno set of the Plotinium ABI (C3; syscall-abi.md §4.3, ABI-05).
 *
 * Spec: MUST, §9.3 fixes the twelve file-system errnos. Plotinium design (C3): thirteen extras are
 * the only other errnos allowed on the wire. Codes are the Linux x86-64 values; the two AI errnos use
 * the Plotinium range 1000..1099. The wire carries the NAME; the code is for audit rows, the klog
 * ring and `$?`-style reporting. Adding an errno needs a cross-spec request, bumps ABI_VERSION, and
 * must be reflected in syscall-abi.md §4.3 first (the ABI-05 conformance test compares this table
 * with the spec table).
 */
import * as v from 'valibot';

export type ErrnoSource = 'spec' | 'plotinium';

export interface ErrnoInfo {
  readonly code: number;
  readonly source: ErrnoSource;
  /** `strerror` text, exactly as in syscall-abi.md §4.3. */
  readonly message: string;
}

/** The master table, in code order (syscall-abi.md §4.3). */
export const ERRNO = {
  EPERM: { code: 1, source: 'spec', message: 'Operation not permitted' },
  ENOENT: { code: 2, source: 'spec', message: 'No such file or directory' },
  ESRCH: { code: 3, source: 'plotinium', message: 'No such process' },
  EIO: { code: 5, source: 'plotinium', message: 'Input/output error' },
  EBADF: { code: 9, source: 'plotinium', message: 'Bad file descriptor' },
  EAGAIN: { code: 11, source: 'plotinium', message: 'Resource temporarily unavailable' },
  EACCES: { code: 13, source: 'spec', message: 'Permission denied' },
  EBUSY: { code: 16, source: 'spec', message: 'Device or resource busy' },
  EEXIST: { code: 17, source: 'spec', message: 'File exists' },
  EXDEV: { code: 18, source: 'plotinium', message: 'Invalid cross-device link' },
  ENOTDIR: { code: 20, source: 'spec', message: 'Not a directory' },
  EISDIR: { code: 21, source: 'spec', message: 'Is a directory' },
  EINVAL: { code: 22, source: 'spec', message: 'Invalid argument' },
  EMFILE: { code: 24, source: 'plotinium', message: 'Too many open files' },
  ENOTTY: { code: 25, source: 'plotinium', message: 'Not a terminal' },
  EPIPE: { code: 32, source: 'plotinium', message: 'Broken pipe' },
  ENAMETOOLONG: { code: 36, source: 'spec', message: 'File name too long' },
  ENOSYS: { code: 38, source: 'plotinium', message: 'Function not implemented' },
  ENOTEMPTY: { code: 39, source: 'spec', message: 'Directory not empty' },
  ELOOP: { code: 40, source: 'spec', message: 'Too many levels of symbolic links' },
  ETIMEDOUT: { code: 110, source: 'plotinium', message: 'Operation timed out' },
  EDQUOT: { code: 122, source: 'spec', message: 'Disk quota exceeded' },
  ECANCELED: { code: 125, source: 'plotinium', message: 'Operation canceled' },
  EAIUNAVAIL: { code: 1001, source: 'plotinium', message: 'AI service unavailable' },
  EAIREFUSED: { code: 1002, source: 'plotinium', message: 'AI model refused the request' },
} as const satisfies Record<string, ErrnoInfo>;

export type Errno = keyof typeof ERRNO;

/** Every errno name, in code order. */
export const ERRNO_NAMES = Object.keys(ERRNO) as Errno[];

/** The twelve errnos fixed by Spec §9.3 (C3). */
export const SPEC_ERRNOS = ERRNO_NAMES.filter((name) => ERRNO[name].source === 'spec');

/** Valibot schema for an errno name on the wire (INV-ABI-8: nothing else may appear). */
export const Errno = v.picklist(ERRNO_NAMES);

export function isErrno(value: unknown): value is Errno {
  return typeof value === 'string' && Object.hasOwn(ERRNO, value);
}

/** The numeric code of an errno (audit rows, klog, `$?`). */
export function errnoCode(errno: Errno): number {
  return ERRNO[errno].code;
}

/** The `strerror` text of an errno. */
export function strerror(errno: Errno): string {
  return ERRNO[errno].message;
}

/** Reverse lookup from a numeric code; undefined for codes outside the closed set. */
export function errnoFromCode(code: number): Errno | undefined {
  return ERRNO_NAMES.find((name) => ERRNO[name].code === code);
}

/**
 * Registered `detail.reason` values per errno, exactly as syscall-abi.md §4.3.1 lists them.
 *
 * EINVAL additionally reports schema issues through `detail.field`. Reasons requested by other
 * specs but not yet registered in §4.3.1 are deliberately NOT listed here; the wire schema for
 * `detail.reason` (see `Reason`) accepts any well-formed reason so that the kernel can use
 * them while the ABI owner decides.
 */
export const REGISTERED_REASONS = {
  EPERM: [
    'capability',
    'scope',
    'system-path',
    'owner',
    'root-only',
    'sticky',
    'init',
    'no-token',
    'outside-grant',
    'foreign',
    'directory',
  ],
  EAGAIN: [
    'stale-plan',
    'stale-version',
    'retry-exhausted',
    'executors-exhausted',
    'thrashing',
    'pid-space',
    'window-limit',
    'view-backlog',
    'rate',
    'offline',
    'not-idle',
    'no-free-memory',
  ],
  EBUSY: ['lease', 'stale-fence', 'lock-timeout', 'subtree-busy', 'starting'],
  EIO: ['injected', 'storage', 'abort', 'checksum', 'server'],
  EINVAL: [
    'bad-manifest',
    'dependency-cycle',
    'exceeds-budget',
    'turn-limit',
    'unknown-plan',
    'expired',
    'unknown-job',
    'unknown-lease',
    'unknown-segment',
    'unknown-service',
    'unknown-txn',
    'no-such-window',
    'not-a-link',
    'not-seekable',
  ],
  ECANCELED: ['signal', 'declined', 'killed'],
  EAIUNAVAIL: ['offline', 'rate', 'budget', 'no-key', 'upstream', 'timeout'],
  ESRCH: ['no-child', 'identity-mismatch'],
  ENOENT: ['unlinked'],
} as const satisfies Partial<Record<Errno, readonly string[]>>;

/** Whether `reason` is registered for `errno` in syscall-abi.md §4.3.1. */
export function isRegisteredReason(errno: Errno, reason: string): boolean {
  const list: readonly string[] | undefined = (
    REGISTERED_REASONS as Partial<Record<Errno, readonly string[]>>
  )[errno];
  return list?.includes(reason) ?? false;
}

/**
 * Wire form of a `detail.reason`: lower-case kebab, at most 40 characters. The same pattern is the
 * `Reason` definition of the WebSocket protocol (offline-and-sync.md §4.2).
 */
export const Reason = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,39}$/));
export type Reason = v.InferOutput<typeof Reason>;
