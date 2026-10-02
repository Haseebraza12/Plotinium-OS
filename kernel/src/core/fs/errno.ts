/**
 * Errno mapping at the file-system syscall boundary (syscall-abi.md §4.3, §4.3.1, §4.9;
 * virtual-file-system.md §6.1, §6.2; INV-ABI-8).
 *
 * Everything that reaches a caller is a `KernelError` whose errno is in the closed protocol set:
 * - `VfsError` from a planner, the resolver or a store abort keeps its errno; its VFS detail becomes
 *   a registered `detail.reason` where §4.3.1 has one (for example `fencing` → EIO `storage`,
 *   `not-mirrored-offline` → EAGAIN `offline`), and stays as it is otherwise (the wire accepts any
 *   well-formed reason while the ABI owner registers it);
 * - an EPERM without a detail gets the reason its call implies (`chmod` → `owner`, `chown` →
 *   `root-only`, `unlink` → `sticky`, …);
 * - store exceptions (DOMException names from IndexedDB) go through vfs `toVfsError`;
 * - a batch op failure carries its op index in `detail.step`.
 */
import type { CallName, ErrDetail, Errno } from '@plotinium/protocol';
import { isErrno } from '@plotinium/protocol';
import { NotLoaded, VfsError, toVfsError, utf8Length } from '@plotinium/vfs';

import { KernelError } from '../errors.ts';

/** VFS details that map to a registered reason of a different name (§4.3.1). */
const REASON_OF: Readonly<Record<string, string>> = {
  fencing: 'storage',
  'not-mirrored-offline': 'offline',
  'content-not-cached': 'offline',
  'intent-timeout': 'lock-timeout',
  synthesised: 'system-path',
  'protected-hardlink': 'owner',
  'stale-base': 'stale-version',
};

/** The reason an EPERM without a VFS detail implies, per call (§3.6.2 "EACCES versus EPERM"). */
const EPERM_REASON: Partial<Record<CallName, string>> = {
  chmod: 'owner',
  chown: 'root-only',
  utimes: 'owner',
  link: 'owner',
  unlink: 'sticky',
  rmdir: 'sticky',
  rename: 'sticky',
  quota: 'root-only',
  batch: 'sticky',
};

/** The `detail.reason` for `errno` raised with VFS detail `detail` by `call`. */
export function reasonOf(
  errno: Errno,
  detail: string | undefined,
  call?: CallName,
): string | undefined {
  if (detail !== undefined) return REASON_OF[detail] ?? detail;
  if (errno === 'EPERM' && call !== undefined) return EPERM_REASON[call];
  return undefined;
}

/** A path that fits `ErrDetail.path` (1..4096 UTF-8 bytes), else undefined. */
function pathField(path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined;
  return utf8Length(path) <= 4096 ? path : undefined;
}

export interface ErrCtx {
  readonly call?: CallName;
  readonly path?: string;
  readonly msg?: string;
}

/** Build the syscall error for `errno` (with an optional VFS detail) raised by `ctx.call`. */
export function fsError(
  errno: Errno,
  detail?: string,
  ctx: ErrCtx = {},
  step?: number,
): KernelError {
  const reason = reasonOf(errno, detail, ctx.call);
  const path = pathField(ctx.path);
  const d: ErrDetail = {
    ...(reason === undefined ? {} : { reason }),
    ...(path === undefined ? {} : { path }),
    ...(step === undefined ? {} : { step }),
  };
  return new KernelError(errno, Object.keys(d).length === 0 ? undefined : d, ctx.msg);
}

/** A VfsError (planner, resolver, store abort) as a syscall error. */
export function fromVfsError(e: VfsError, ctx: ErrCtx = {}): KernelError {
  return fsError(e.errno, e.detail, ctx, e.index);
}

/**
 * Map anything a file-system handler caught to a syscall error. Kernel errors pass through; VFS
 * errors and store exceptions (anything with an IndexedDB DOMException `name`) are mapped; other
 * values are bugs and are rethrown, so the dispatcher logs them and answers EIO (ABI-12).
 */
export function toKernelError(e: unknown, ctx: ErrCtx = {}): KernelError {
  if (e instanceof KernelError) return e;
  if (e instanceof VfsError) return fromVfsError(e, ctx);
  if (e instanceof NotLoaded) return fsError('EIO', 'storage', ctx);
  if (isStoreException(e)) return fromVfsError(toVfsError(e), ctx);
  throw e;
}

const STORE_EXCEPTIONS = new Set([
  'AbortError',
  'ConstraintError',
  'DataError',
  'InvalidStateError',
  'NotFoundError',
  'QuotaExceededError',
  'ReadOnlyError',
  'TransactionInactiveError',
  'UnknownError',
  'VersionError',
]);

function isStoreException(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'name' in e &&
    typeof e.name === 'string' &&
    STORE_EXCEPTIONS.has(e.name)
  );
}

/** An errno from a planner `Outcome` or a check result. */
export function errnoOrEio(v: string): Errno {
  return isErrno(v) ? v : 'EIO';
}
