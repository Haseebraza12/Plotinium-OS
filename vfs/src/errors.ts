/**
 * VFS failures (virtual-file-system.md §6.1). Planners throw `VfsError` deep inside a plan and the
 * syscall boundary turns it into `{ok: false, errno, detail}`; the errno is always one of the
 * closed protocol set (C3).
 */
import type { Errno } from '@plotinium/protocol';

import type { Uuid, VfsDetail } from './store/records.ts';

export class VfsError extends Error {
  readonly errno: Errno;
  readonly detail: VfsDetail | undefined;
  /** `batch` only: the index of the op that failed (§3.12.7). */
  readonly index: number | undefined;

  constructor(errno: Errno, detail?: VfsDetail, index?: number) {
    super(detail === undefined ? errno : `${errno} (${detail})`);
    this.name = 'VfsError';
    this.errno = errno;
    this.detail = detail;
    this.index = index;
  }

  withIndex(index: number): VfsError {
    return new VfsError(this.errno, this.detail, index);
  }
}

/**
 * A planner reached a directory whose entries are not in memory. The kernel loads it (§5.8,
 * chunked read-only scans) and plans again; this is a control signal, never a syscall result.
 */
export class NotLoaded extends Error {
  readonly dir: Uuid;

  constructor(dir: Uuid) {
    super(`directory not loaded: ${dir}`);
    this.name = 'NotLoaded';
    this.dir = dir;
  }
}

export function fail(errno: Errno, detail?: VfsDetail): never {
  throw new VfsError(errno, detail);
}

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly errno: Errno;
      readonly detail?: VfsDetail;
      readonly index?: number;
    }
  | { readonly ok: 'load'; readonly dir: Uuid };

/** Run a planner and turn its throw into a value (the syscall boundary). */
export function attempt<T>(run: () => T): Outcome<T> {
  try {
    return { ok: true, value: run() };
  } catch (e) {
    if (e instanceof NotLoaded) return { ok: 'load', dir: e.dir };
    if (e instanceof VfsError) {
      return {
        ok: false,
        errno: e.errno,
        ...(e.detail === undefined ? {} : { detail: e.detail }),
        ...(e.index === undefined ? {} : { index: e.index }),
      };
    }
    throw e;
  }
}
