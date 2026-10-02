/**
 * Diagnostics (shell-and-terminal.md §3.13): `<cmd>: <operand>: <text>` with the exact errno texts
 * of the shell spec and an optional ` (<detail>)` from the failed call.
 */
import type { Errno } from '@plotinium/protocol';
import { strerror } from '@plotinium/protocol';

import { errnoOf } from './sys.ts';

/**
 * The shell spec's texts. They differ from protocol's `strerror` for EBUSY and ETIMEDOUT
 * ("Resource busy", "Timed out"); the shell spec is normative for terminal output.
 */
const SHELL_TEXT: Partial<Record<Errno, string>> = {
  EBUSY: 'Resource busy',
  ETIMEDOUT: 'Timed out',
};

export function errnoText(errno: Errno): string {
  return SHELL_TEXT[errno] ?? strerror(errno);
}

interface DetailLike {
  readonly reason?: unknown;
  readonly holder?: unknown;
}

/** The optional ` (<detail>)` suffix: the call's `msg`, or the lease holder of an EBUSY. */
function detailSuffix(e: unknown, errno: Errno): string {
  if (typeof e !== 'object' || e === null) return '';
  const detail: unknown = 'detail' in e ? e.detail : undefined;
  if (typeof detail === 'object' && detail !== null) {
    const d = detail as DetailLike;
    if (typeof d.holder === 'string') return ` (locked by ${d.holder})`;
  }
  const msg: unknown = 'msg' in e ? e.msg : 'message' in e ? e.message : undefined;
  if (typeof msg !== 'string' || msg.length === 0) return '';
  if (msg === strerror(errno) || msg === errnoText(errno)) return '';
  return ` (${msg})`;
}

/** `Text (detail)` for a failed system call; rethrows anything else (a real bug). */
export function describe(e: unknown): string {
  const errno = errnoOf(e);
  if (errno === undefined) throw e;
  return errnoText(errno) + detailSuffix(e, errno);
}

/** The errno of a failed call, rethrowing anything that is not a system-call failure. */
export function mustErrno(e: unknown): Errno {
  const errno = errnoOf(e);
  if (errno === undefined) throw e;
  return errno;
}

/** The registered `detail.reason` of a failed call, if any (syscall-abi.md §4.3.1). */
export function reasonOf(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null || !('detail' in e)) return undefined;
  const detail: unknown = e.detail;
  if (typeof detail !== 'object' || detail === null || !('reason' in detail)) return undefined;
  return typeof detail.reason === 'string' ? detail.reason : undefined;
}

function fromServer(e: unknown): boolean {
  const msg: unknown = typeof e === 'object' && e !== null && 'msg' in e ? e.msg : undefined;
  return msg === 'server' || reasonOf(e) === 'server';
}

/**
 * Bulk operations are all or nothing (spec §8.1): EIO means the transaction was rolled back; any
 * other server rejection means the local commit was undone (`— restored`).
 */
export function bulkSuffix(e: unknown): string {
  if (errnoOf(e) === 'EIO') return ' — rolled back';
  return fromServer(e) ? ' — restored' : '';
}
