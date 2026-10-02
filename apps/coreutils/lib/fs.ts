/** File-system call helpers shared by the file commands: paged listings and errno-returning stats. */
import type { DirEntry, Errno, FindArgs, Stat } from '@plotinium/protocol';

import { mustErrno } from './errors.ts';
import type { Sys, SysGen } from './sys.ts';
import { errnoOf } from './sys.ts';

/** Page size of `readdir` (spec: pages of at most 1,000 entries). */
export const READDIR_PAGE = 1_000;
/** Page size of `find`. */
export const FIND_PAGE = 1_000;

export type StatResult =
  | { readonly ok: true; readonly stat: Stat }
  | { readonly ok: false; readonly errno: Errno; readonly error: unknown };

/** `lstat`, or `stat` when `follow`, reporting the errno instead of throwing it. */
export function* tryStat(sys: Sys, path: string, follow = false): SysGen<StatResult> {
  try {
    const stat = follow ? yield* sys.call('stat', { path }) : yield* sys.call('lstat', { path });
    return { ok: true, stat };
  } catch (e) {
    return { ok: false, errno: mustErrno(e), error: e };
  }
}

/** Every entry of a directory (with `stat` when `plus`), paging through `readdir`. */
export function* listDir(sys: Sys, path: string, plus = true): SysGen<DirEntry[]> {
  const entries: DirEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = yield* sys.call('readdir', {
      path,
      plus,
      limit: READDIR_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    entries.push(...page.entries);
    cursor = page.next;
  } while (cursor !== undefined);
  return entries;
}

export interface FindHit {
  readonly path: string;
  readonly entry: DirEntry | undefined;
}

export interface FindWalk {
  readonly hits: FindHit[];
  /** Directories the caller could not read, skipped by the kernel. */
  readonly denied: number;
}

/** What `findAll` walks: a start path, stats or not, and a depth limit. */
export type FindWalkArgs = Pick<FindArgs, 'path' | 'plus' | 'maxDepth'>;

function byCodePoint(a: DirEntry, b: DirEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The walk of the kernel's `find`, made with `readdir` (UI-054): every entry below `path` in
 * pre-order and code-point order, paths spelled from `path` as given, symbolic links not
 * followed, `maxDepth` levels at most, and a count of the directories the caller could not read.
 * `grep -r` and `tree` walk the same way.
 */
export function* walkTree(sys: Sys, args: FindWalkArgs): SysGen<FindWalk> {
  const hits: FindHit[] = [];
  let denied = 0;
  const start = args.path.replace(/\/+$/, '') || '/';
  function* visit(dir: string, depth: number): SysGen<void> {
    if (args.maxDepth !== undefined && depth >= args.maxDepth) return;
    let entries: DirEntry[];
    try {
      entries = yield* listDir(sys, dir, args.plus === true);
    } catch (e) {
      // An unreadable directory is skipped and counted; one that went away meanwhile is skipped.
      if (mustErrno(e) === 'EACCES') denied += 1;
      return;
    }
    for (const entry of [...entries].sort(byCodePoint)) {
      if (entry.name === '.' || entry.name === '..') continue;
      const path = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
      hits.push({ path, entry });
      if (entry.type === 'd') yield* visit(path, depth + 1);
    }
  }
  yield* visit(start, 0);
  return { hits, denied };
}

/**
 * Runs a kernel `find` walk to the end, paging with its cursor. A kernel without `find` answers
 * ENOSYS: the walk is then made here with `readdir` (UI-054), so `find` and `du` still work.
 */
export function* findAll(sys: Sys, args: FindWalkArgs): SysGen<FindWalk> {
  const hits: FindHit[] = [];
  let denied = 0;
  let cursor: string | undefined;
  do {
    let page;
    try {
      page = yield* sys.call('find', {
        ...args,
        limit: FIND_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
    } catch (e) {
      if (cursor === undefined && errnoOf(e) === 'ENOSYS') return yield* walkTree(sys, args);
      throw e;
    }
    page.paths.forEach((path, i) => hits.push({ path, entry: page.entries?.[i] }));
    denied += page.denied;
    cursor = page.next;
  } while (cursor !== undefined);
  return { hits, denied };
}
