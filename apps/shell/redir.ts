/**
 * Redirections (shell-and-terminal.md §3.7.4). Files are opened by the shell before `spawn` and
 * passed in `fds`; a builtin run inside the shell gets its descriptors swapped with `dup`/`dup2`
 * and restored afterwards.
 */
import type { SysGen } from '../src/_sys.ts';
import { errnoOf, errText } from '../src/_sys.ts';
import type { RedirOp } from './ast.ts';
import type { Sh } from './state.ts';

export interface XRedir {
  fd: number;
  op: RedirOp;
  /** A path for `>`, `>>`, `<`; a descriptor number for `>&`. */
  target: string | number;
}

/** The child's fds 0, 1 and 2, as descriptors of the shell. */
export type FdMap = [number, number, number];

export type Prepared = { ok: true; fds: FdMap; opened: number[] } | { ok: false; message: string };

const OPEN_ARGS = {
  '>': { flags: 'w', create: true, trunc: true },
  '>>': { flags: 'a', create: true },
  '<': { flags: 'r' },
} as const;

/** Opens a redirection target; the message is `sh: out.txt: Permission denied` on failure. */
function* openTarget(
  sh: Sh,
  op: '>' | '>>' | '<',
  path: string,
): SysGen<{ fd: number } | { message: string }> {
  try {
    const { fd } = yield* sh.sys.call('open', { path, ...OPEN_ARGS[op] });
    return { fd };
  } catch (e) {
    if (errnoOf(e) === 'EMFILE') return { message: `sh: cannot open '${path}': ${errText(e)}` };
    return { message: `sh: ${path}: ${errText(e)}` };
  }
}

export function* closeAll(sh: Sh, fds: readonly number[]): SysGen<void> {
  for (const fd of fds) {
    try {
      yield* sh.sys.call('close', { fd });
    } catch (e) {
      if (errnoOf(e) === undefined) throw e;
    }
  }
}

function badFd(n: number): string {
  return `sh: ${n}: Bad file descriptor`;
}

/**
 * Applies redirections left to right on top of `base` (the pipe ends), for a spawned program.
 * `spawn` maps only fds 0–2, so another target descriptor is refused with EBADF.
 */
export function* prepareFds(sh: Sh, redirs: readonly XRedir[], base: FdMap): SysGen<Prepared> {
  const fds: FdMap = [...base];
  const opened: number[] = [];
  for (const r of redirs) {
    if (r.fd > 2) {
      yield* closeAll(sh, opened);
      return { ok: false, message: badFd(r.fd) };
    }
    if (typeof r.target === 'number') {
      fds[r.fd] = r.target <= 2 ? (fds[r.target] ?? r.target) : r.target;
      continue;
    }
    if (r.op === '>&') continue;
    const res = yield* openTarget(sh, r.op, r.target);
    if ('message' in res) {
      yield* closeAll(sh, opened);
      return { ok: false, message: res.message };
    }
    opened.push(res.fd);
    fds[r.fd] = res.fd;
  }
  return { ok: true, fds, opened };
}

/** A descriptor of the shell saved while a builtin runs; `copy` null means it was closed. */
export interface Saved {
  fd: number;
  copy: number | null;
}

function* save(sh: Sh, fd: number): SysGen<Saved> {
  try {
    return { fd, copy: (yield* sh.sys.call('dup', { fd })).fd };
  } catch (e) {
    if (errnoOf(e) !== 'EBADF') throw e;
    return { fd, copy: null };
  }
}

/** Applies redirections to the shell's own table for a builtin. Always restore `saved`. */
export function* applyInShell(
  sh: Sh,
  redirs: readonly XRedir[],
): SysGen<{ saved: Saved[]; message: string | null }> {
  const saved: Saved[] = [];
  for (const r of redirs) {
    saved.push(yield* save(sh, r.fd));
    let from: number;
    if (typeof r.target === 'number') {
      from = r.target;
    } else {
      if (r.op === '>&') continue;
      const res = yield* openTarget(sh, r.op, r.target);
      if ('message' in res) return { saved, message: res.message };
      from = res.fd;
    }
    try {
      yield* sh.sys.call('dup2', { fd: from, to: r.fd });
    } catch (e) {
      if (errnoOf(e) === undefined) throw e;
      return { saved, message: badFd(from) };
    } finally {
      if (typeof r.target !== 'number') yield* closeAll(sh, [from]);
    }
  }
  return { saved, message: null };
}

/** Puts the shell's descriptors back, last saved first. */
export function* restoreInShell(sh: Sh, saved: readonly Saved[]): SysGen<void> {
  for (const s of [...saved].reverse()) {
    try {
      if (s.copy === null) {
        yield* sh.sys.call('close', { fd: s.fd });
      } else {
        yield* sh.sys.call('dup2', { fd: s.copy, to: s.fd });
        yield* sh.sys.call('close', { fd: s.copy });
      }
    } catch (e) {
      if (errnoOf(e) === undefined) throw e;
    }
  }
}
