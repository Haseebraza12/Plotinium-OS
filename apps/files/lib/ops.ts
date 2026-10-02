/**
 * File operations of the Files app, written once as generators over `GenSys` (see sys.ts): the
 * app's process runs them on `ctx.sys`, the view runs them through `drive()`. Every change to the
 * file system is a system call (VFS-07: "File Explorer create, rename, copy, move, delete and
 * properties use syscalls only"); nothing here touches storage.
 *
 * Loops yield at every iteration (a system call), so a long walk can be pre-empted (PROC-03).
 */
import type { DirEntry, LeaseInfo, SemsearchResult, Stat } from '@plotinium/protocol';
import { IO_MAX_BYTES, READDIR_PAGE_MAX } from '@plotinium/protocol';

import type { EntryView, KeywordHit, Who } from './model.ts';
import {
  bestWindow,
  formatTrashInfo,
  looksBinary,
  nameScore,
  parseTrashInfo,
  queryTerms,
  toEntry,
  trashInfoPath,
  trashOf,
  TRASH_INFO_DIR,
  uniqueName,
} from './model.ts';
import { basename, dirname, isInside, join, tildePath } from './path.ts';
import type { GenSys, SysGen } from './sys.ts';
import { AppError, encodeUtf8, isErrno } from './sys.ts';

const decoder = new TextDecoder('utf-8', { fatal: false });

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

/** The caller's identity (`proc.cred`). */
export function* whoami(sys: GenSys): SysGen<Who> {
  const cred = yield* sys.call('proc.cred', {});
  return {
    uid: cred.uid,
    gid: cred.gid,
    groups: cred.groups,
    user: cred.user,
    home: cred.home,
  };
}

function fillNames(
  list: readonly { uid: number; gid: number; name: string }[],
  users: Map<number, string>,
  groups: Map<number, string>,
): void {
  for (const u of list) {
    users.set(u.uid, u.name);
    if (!groups.has(u.gid)) groups.set(u.gid, u.name);
  }
}

/** uid → name and gid → group name maps from `users.list`; empty when the call fails. */
export function* userNames(
  sys: GenSys,
): SysGen<{ users: Map<number, string>; groups: Map<number, string> }> {
  const users = new Map<number, string>();
  const groups = new Map<number, string>();
  try {
    const list = yield* sys.call('users.list', {});
    fillNames(list.users, users, groups);
  } catch {
    // Names are cosmetic: rows fall back to `uid N`.
  }
  return { users, groups };
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

export interface Listing {
  readonly path: string;
  /** The folder itself (its ino identifies vfs events about it). */
  readonly dir: Stat;
  readonly entries: EntryView[];
  readonly dirVersion: number;
  /** More than `max` entries: the rest were not listed. */
  readonly truncated: boolean;
}

/** Hard cap on one listing (the view virtualises; 10,000 rows is far beyond a demo folder). */
export const LISTING_MAX = 10_000;

/**
 * `readdir` (with `plus`, paged by cursor) plus `lstat` for any entry that came without a stat,
 * mapped to rows. Hidden files (a leading dot) are left out unless `hidden` is true.
 */
export function* listDir(
  sys: GenSys,
  path: string,
  who: Who,
  names: ReadonlyMap<number, string>,
  opts: { hidden?: boolean; groups?: ReadonlyMap<number, string> } = {},
): SysGen<Listing> {
  const dir = yield* sys.call('stat', { path });
  const raw: DirEntry[] = [];
  let cursor: string | undefined;
  let dirVersion: number;
  let truncated = false;
  for (;;) {
    const page = yield* sys.call('readdir', {
      path,
      plus: true,
      limit: READDIR_PAGE_MAX,
      ...(cursor === undefined ? {} : { cursor }),
    });
    dirVersion = page.dirVersion;
    raw.push(...page.entries);
    if (raw.length >= LISTING_MAX) {
      truncated = page.next !== undefined || raw.length > LISTING_MAX;
      break;
    }
    if (page.next === undefined) break;
    cursor = page.next;
  }
  const entries: EntryView[] = [];
  for (const e of raw.slice(0, LISTING_MAX)) {
    if (opts.hidden !== true && e.name.startsWith('.')) continue;
    let stat = e.stat;
    if (stat === undefined) {
      try {
        stat = yield* sys.call('lstat', { path: join(path, e.name) });
      } catch {
        // Gone between readdir and lstat: skip it; the next refresh settles the listing.
        continue;
      }
    }
    entries.push(toEntry(path, e.name, stat, who, names, opts.groups));
  }
  return { path, dir, entries, dirVersion, truncated };
}

/** The folder's version, cheaply (one `readdir` of one entry), for change polling. */
export function* dirVersionOf(sys: GenSys, path: string): SysGen<number> {
  const page = yield* sys.call('readdir', { path, limit: 1 });
  return page.dirVersion;
}

/** Which of `paths` exist (for the optional sidebar places). */
export function* existing(sys: GenSys, paths: readonly string[]): SysGen<Set<string>> {
  const found = new Set<string>();
  for (const path of paths) {
    try {
      const st = yield* sys.call('stat', { path });
      if (st.type === 'd') found.add(path);
    } catch {
      // Missing or unreadable: not listed.
    }
  }
  return found;
}

/** Quota as `{used, total}` bytes, or undefined when there is no limit (root) or no data. */
export function* quotaOf(sys: GenSys): SysGen<{ used: number; total: number } | undefined> {
  try {
    const q = yield* sys.call('quota', {});
    if (q.quotaBytes !== null) return { used: q.usedBytes, total: q.quotaBytes };
  } catch {
    // Fall through to the device figures.
  }
  try {
    const fs = yield* sys.call('statfs', {});
    if (fs.quotaBytes !== null) return { used: fs.usageBytes, total: fs.quotaBytes };
  } catch {
    // No quota information at all.
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Create, rename, copy, move, trash, delete, chmod
// ---------------------------------------------------------------------------------------------

/** `mkdir dir/name` (mode 0777 masked by the umask). Returns the new path. */
export function* makeFolder(sys: GenSys, dir: string, name: string): SysGen<string> {
  const path = join(dir, name);
  yield* sys.call('mkdir', { path, mode: 0o777 });
  return path;
}

/** An empty file `dir/name`; EEXIST when the name is taken (never overwrites). */
export function* makeFile(sys: GenSys, dir: string, name: string): SysGen<string> {
  const path = join(dir, name);
  const fd = yield* sys.call('open', { path, flags: 'w', create: true, excl: true, mode: 0o666 });
  yield* sys.call('close', { fd: fd.fd });
  return path;
}

/** Renames in place (`noReplace`: an existing name is EEXIST, never overwritten). */
export function* renameEntry(sys: GenSys, from: string, name: string): SysGen<string> {
  const to = join(dirname(from), name);
  if (to === from) return from;
  yield* sys.call('rename', { from, to, noReplace: true });
  return to;
}

/** One item's outcome in a bulk operation. */
export interface ItemResult {
  readonly path: string;
  /** Where it ended up (copies, moves and trash). */
  readonly to?: string;
  readonly error?: unknown;
}

function addNames(names: Set<string>, entries: readonly DirEntry[]): void {
  for (const e of entries) names.add(e.name);
}

/** The names in `dir`, including hidden ones (for unique naming). */
function* namesIn(sys: GenSys, dir: string): SysGen<Set<string>> {
  const names = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = yield* sys.call('readdir', {
      path: dir,
      limit: READDIR_PAGE_MAX,
      ...(cursor === undefined ? {} : { cursor }),
    });
    addNames(names, page.entries);
    if (page.next === undefined || names.size >= LISTING_MAX) return names;
    cursor = page.next;
  }
}

/**
 * Moves `from` to `to` with `rename`; across file systems (EXDEV, for example out of /tmp) it
 * copies recursively and then removes the source, as `mv` does (VFS-07).
 */
function* moveOne(sys: GenSys, from: string, to: string): SysGen<void> {
  try {
    yield* sys.call('rename', { from, to, noReplace: true });
  } catch (e) {
    if (!isErrno(e, 'EXDEV')) throw e;
    yield* sys.call('copy', { from, to, recursive: true, noReplace: true });
    yield* sys.call('unlink', { path: from, recursive: true });
  }
}

/** Copies each path into `destDir`; a clash gets `name copy.ext` or `name 2.ext`. */
export function* copyInto(
  sys: GenSys,
  paths: readonly string[],
  destDir: string,
): SysGen<ItemResult[]> {
  const taken = yield* namesIn(sys, destDir);
  const out: ItemResult[] = [];
  for (const from of paths) {
    const base = basename(from);
    const same = dirname(from) === destDir;
    const name = same || taken.has(base) ? uniqueName(base, taken, same ? 'copy' : 'number') : base;
    const to = join(destDir, name);
    try {
      if (isInside(destDir, from))
        throw new AppError('EINVAL', 'A folder cannot be copied into itself');
      yield* sys.call('copy', { from, to, recursive: true, noReplace: true });
      taken.add(name);
      out.push({ path: from, to });
    } catch (error) {
      out.push({ path: from, error });
    }
  }
  return out;
}

/** Moves each path into `destDir` (drag and drop, cut and paste). Clashes are EEXIST. */
export function* moveInto(
  sys: GenSys,
  paths: readonly string[],
  destDir: string,
): SysGen<ItemResult[]> {
  const out: ItemResult[] = [];
  for (const from of paths) {
    const to = join(destDir, basename(from));
    try {
      if (dirname(from) === destDir) {
        out.push({ path: from, to: from });
        continue;
      }
      if (isInside(destDir, from))
        throw new AppError('EINVAL', 'A folder cannot be moved into itself');
      yield* moveOne(sys, from, to);
      out.push({ path: from, to });
    } catch (error) {
      out.push({ path: from, error });
    }
  }
  return out;
}

/** Creates `~/.Trash` (0700) when it is missing. Returns its path. */
export function* ensureTrash(sys: GenSys, who: Who): SysGen<string> {
  const trash = trashOf(who);
  try {
    yield* sys.call('mkdir', { path: trash, mode: 0o700 });
  } catch (e) {
    if (!isErrno(e, 'EEXIST')) throw e;
  }
  return trash;
}

/**
 * Moves each path to `/home/<user>/.Trash` under a free name (`report 2.md` when `report.md` is
 * already there). Items already in the Trash are refused with EINVAL: delete those instead.
 * Each move leaves a Put Back record (`.Trash/.trashinfo/<name>.trashinfo`, the original path);
 * a record that cannot be written costs only Put Back, never the move.
 */
export function* trashEntries(
  sys: GenSys,
  paths: readonly string[],
  who: Who,
  now?: number,
): SysGen<ItemResult[]> {
  const trash = yield* ensureTrash(sys, who);
  const taken = yield* namesIn(sys, trash);
  const out: ItemResult[] = [];
  let infoDir: boolean | undefined;
  for (const from of paths) {
    try {
      if (isInside(from, trash) || isInside(trash, from)) {
        throw new AppError('EINVAL', 'Already in the Trash: delete it instead');
      }
      const name = uniqueName(basename(from), taken);
      const to = join(trash, name);
      yield* moveOne(sys, from, to);
      taken.add(name);
      out.push({ path: from, to });
      infoDir ??= yield* ensureDir(sys, join(trash, TRASH_INFO_DIR));
      if (infoDir) {
        try {
          yield* sys.call('writeFile', {
            path: trashInfoPath(trash, name),
            data: encodeUtf8(formatTrashInfo(from, now)),
            create: true,
          });
        } catch {
          // Put Back will say the original location is unknown.
        }
      }
    } catch (error) {
      out.push({ path: from, error });
    }
  }
  return out;
}

/** `mkdir -p` of one level with mode 0700; false when it neither exists nor can be made. */
function* ensureDir(sys: GenSys, path: string): SysGen<boolean> {
  try {
    yield* sys.call('mkdir', { path, mode: 0o700 });
    return true;
  } catch (e) {
    return isErrno(e, 'EEXIST');
  }
}

/**
 * Put Back: moves each Trash item to where it was trashed from, read from its Put Back record
 * (or from `known`, trash path to original path, for an Undo right after the move). Never
 * overwrites (EEXIST when the name is taken again); a missing folder is named in the error.
 */
export function* putBackEntries(
  sys: GenSys,
  paths: readonly string[],
  who: Who,
  known: ReadonlyMap<string, string> = new Map(),
): SysGen<ItemResult[]> {
  const trash = trashOf(who);
  const out: ItemResult[] = [];
  for (const path of paths) {
    try {
      if (dirname(path) !== trash)
        throw new AppError('EINVAL', 'Only items at the top of the Trash can be put back');
      const name = basename(path);
      const record = trashInfoPath(trash, name);
      let origin = known.get(path);
      if (origin === undefined) {
        try {
          const f = yield* readFile(sys, record, 64 * 1024);
          origin = parseTrashInfo(decoder.decode(f.bytes));
        } catch {
          origin = undefined;
        }
      }
      if (origin === undefined)
        throw new AppError('ENOENT', `The original location of “${name}” is not known`);
      const parent = dirname(origin);
      try {
        const st = yield* sys.call('stat', { path: parent });
        if (st.type !== 'd')
          throw new AppError('ENOTDIR', `${tildePath(parent, who.home)} is not a folder`);
      } catch (e) {
        if (e instanceof AppError) throw e;
        if (isErrno(e, 'ENOENT'))
          throw new AppError(
            'ENOENT',
            `The folder ${tildePath(parent, who.home)} no longer exists`,
          );
        throw e;
      }
      yield* moveOne(sys, path, origin);
      out.push({ path, to: origin });
      try {
        yield* sys.call('unlink', { path: record });
      } catch {
        // The record was only a hint.
      }
    } catch (error) {
      out.push({ path, error });
    }
  }
  return out;
}

/** Removes the Put Back records of items deleted from the Trash (best effort). */
export function* forgetTrashInfo(
  sys: GenSys,
  who: Who,
  paths: readonly string[],
  all = false,
): SysGen<void> {
  const trash = trashOf(who);
  if (all) {
    try {
      yield* sys.call('unlink', { path: join(trash, TRASH_INFO_DIR), recursive: true });
    } catch {
      // Nothing recorded, or already gone.
    }
    return;
  }
  for (const path of paths) {
    if (dirname(path) !== trash) continue;
    try {
      yield* sys.call('unlink', { path: trashInfoPath(trash, basename(path)) });
    } catch {
      // No record for this item.
    }
  }
}

/** Deletes each path for good (`rm -r` for folders). The view confirms first (DSN-15). */
export function* deleteEntries(sys: GenSys, paths: readonly string[]): SysGen<ItemResult[]> {
  const out: ItemResult[] = [];
  for (const path of paths) {
    try {
      yield* sys.call('unlink', { path, recursive: true });
      out.push({ path });
    } catch (error) {
      out.push({ path, error });
    }
  }
  return out;
}

/** Sets the permission bits of each path (`chmod` set form; owner or root). */
export function* chmodEntries(
  sys: GenSys,
  paths: readonly string[],
  mode: number,
): SysGen<ItemResult[]> {
  const out: ItemResult[] = [];
  for (const path of paths) {
    try {
      yield* sys.call('chmod', { path, mode: { op: 'set', bits: mode & 0o7777 } });
      out.push({ path });
    } catch (error) {
      out.push({ path, error });
    }
  }
  return out;
}

/** Writes a new file from bytes (a drop from the host), never over an existing one. */
export function* uploadFile(
  sys: GenSys,
  dir: string,
  name: string,
  data: ArrayBuffer,
): SysGen<string> {
  const taken = yield* namesIn(sys, dir);
  const path = join(dir, uniqueName(name, taken));
  yield* sys.call('writeFile', { path, data, create: true });
  return path;
}

// ---------------------------------------------------------------------------------------------
// Locks (VFS-09)
// ---------------------------------------------------------------------------------------------

export interface Lease {
  readonly leaseId: string;
  readonly expiresAt: number;
  readonly fence: number;
  readonly scope: 'server' | 'local';
}

/** An exclusive lease on `path` (fails at once with EBUSY when someone else holds one). */
export function* acquireLock(sys: GenSys, path: string): SysGen<Lease> {
  const r = yield* sys.call('lock.acquire', { path, mode: 'X', wait: false });
  return { leaseId: r.leaseId, expiresAt: r.expiresAt, fence: r.fence, scope: r.scope };
}

export function* releaseLock(sys: GenSys, leaseId: string): SysGen<void> {
  yield* sys.call('lock.release', { leaseId });
}

/** The leases on `path`; an empty list when the lock service is not available. */
export function* lockHolders(sys: GenSys, path: string): SysGen<LeaseInfo[]> {
  try {
    const r = yield* sys.call('lock.status', { path });
    return r.holders;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Reading text (keyword search; the Editor uses the same routine)
// ---------------------------------------------------------------------------------------------

export interface TextFile {
  readonly path: string;
  readonly ino: string;
  readonly version: number;
  readonly size: number;
  readonly bytes: Uint8Array;
}

/** Largest file the apps read whole (the Editor and the keyword scan). */
export const READ_MAX_BYTES = 8 * 1_048_576;

function tooLarge(max: number): string {
  return `The file is larger than ${String(Math.round(max / 1_048_576))} MB`;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return bytes;
}

/** Reads a whole regular file (`open`, `read` until end of file, `close`). EINVAL over `max`. */
export function* readFile(sys: GenSys, path: string, max = READ_MAX_BYTES): SysGen<TextFile> {
  const f = yield* sys.call('open', { path, flags: 'r' });
  try {
    if (f.type === 'd') throw new AppError('EISDIR', 'That is a folder');
    if (f.size > max) throw new AppError('EINVAL', tooLarge(max));
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const want = Math.min(IO_MAX_BYTES, Math.max(1, f.size - total + 1));
      const buf = yield* sys.call('read', { fd: f.fd, len: want });
      if (buf.byteLength === 0) break;
      chunks.push(new Uint8Array(buf));
      total += buf.byteLength;
      if (total > max) throw new AppError('EINVAL', tooLarge(max));
    }
    return { path, ino: f.ino, version: f.version, size: total, bytes: concat(chunks, total) };
  } finally {
    yield* sys.call('close', { fd: f.fd });
  }
}

export interface WriteOutcome {
  readonly ino: string;
  readonly version: number;
  readonly sync: 'applied' | 'pending';
  /** VFS-10: the base was stale; these bytes were kept as a conflicted copy here. */
  readonly keptAs?: { readonly ino: string; readonly path: string };
}

/** Replaces a file's content with `text`, based on `expectedVersion` (VFS-10). */
export function* writeText(
  sys: GenSys,
  path: string,
  text: string,
  expectedVersion?: number,
): SysGen<WriteOutcome> {
  const r = yield* sys.call('writeFile', {
    path,
    data: encodeUtf8(text),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });
  const base = { ino: r.ino, version: r.version, sync: r.sync };
  return r.conflict === undefined ? base : { ...base, keptAs: r.conflict.keptAs };
}

/** Creates `path` with `text`; EEXIST when the name is taken (Save As never overwrites). */
export function* createText(sys: GenSys, path: string, text: string): SysGen<WriteOutcome> {
  try {
    yield* sys.call('lstat', { path });
  } catch (e) {
    if (!isErrno(e, 'ENOENT')) throw e;
    const r = yield* sys.call('writeFile', { path, data: encodeUtf8(text), create: true });
    return { ino: r.ino, version: r.version, sync: r.sync };
  }
  throw new AppError('EEXIST', `“${basename(path)}” already exists`);
}

// ---------------------------------------------------------------------------------------------
// Search (RAG-06)
// ---------------------------------------------------------------------------------------------

/** `ai.semsearch` over `scope` (`auto` lets the kernel choose semantic or keyword). */
export function* semanticSearch(
  sys: GenSys,
  q: string,
  scope: string,
  mode: 'auto' | 'keyword',
  k = 20,
): SysGen<SemsearchResult> {
  return yield* sys.call('ai.semsearch', { q: q.slice(0, 1000), k, scope, mode });
}

export interface KeywordResult {
  readonly hits: KeywordHit[];
  /** Files looked at. */
  readonly scanned: number;
  /** Folders or files that could not be read. */
  readonly denied: number;
  /** File contents could not be read (names only). */
  readonly namesOnly: boolean;
  /** The walk stopped at a limit. */
  readonly truncated: boolean;
}

export interface KeywordLimits {
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly maxFileBytes: number;
  readonly k: number;
}

export const KEYWORD_LIMITS: KeywordLimits = {
  maxFiles: 2_000,
  maxDepth: 8,
  maxFileBytes: 1_048_576,
  k: 20,
};

/**
 * The keyword path when `ai.semsearch` is not available (AI-off build, service down): a bounded
 * breadth-first walk of `scope` with `readdir`, reading text files through `open`/`read` and
 * ranking the best 3-line window of each (model.bestWindow). Unreadable files are skipped, and
 * when file contents cannot be read at all the names alone are matched. Hidden folders are
 * skipped, as the indexer does.
 */
export function* keywordSearch(
  sys: GenSys,
  query: string,
  scope: string,
  limits: KeywordLimits = KEYWORD_LIMITS,
): SysGen<KeywordResult> {
  const terms = queryTerms(query);
  const hits: KeywordHit[] = [];
  let scanned = 0;
  let denied = 0;
  let namesOnly = false;
  let truncated = false;
  const queue: { path: string; depth: number }[] = [{ path: scope, depth: 0 }];
  while (queue.length > 0 && terms.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    let page: DirEntry[];
    try {
      page = (yield* sys.call('readdir', { path: next.path, plus: true, limit: READDIR_PAGE_MAX }))
        .entries;
    } catch {
      denied += 1;
      continue;
    }
    for (const e of page) {
      if (e.name.startsWith('.')) continue;
      const path = join(next.path, e.name);
      if (e.type === 'd') {
        if (next.depth + 1 <= limits.maxDepth) queue.push({ path, depth: next.depth + 1 });
        continue;
      }
      if (e.type !== 'f') continue;
      if (scanned >= limits.maxFiles) {
        truncated = true;
        break;
      }
      scanned += 1;
      const uid = e.stat?.uid ?? 0;
      const size = e.stat?.size ?? 0;
      let best: ReturnType<typeof bestWindow>;
      if (!namesOnly && size <= limits.maxFileBytes) {
        try {
          const f = yield* readFile(sys, path, limits.maxFileBytes);
          if (!looksBinary(f.bytes)) best = bestWindow(decoder.decode(f.bytes), terms);
        } catch (err) {
          if (isErrno(err, 'ENOSYS') || isErrno(err, 'EPERM')) namesOnly = true;
          else denied += 1;
        }
      }
      const byName = nameScore(e.name, terms);
      if (best !== undefined) {
        hits.push({ path, ino: e.ino, uid, ...best, score: Math.max(best.score, byName) });
      } else if (byName > 0) {
        hits.push({
          path,
          ino: e.ino,
          uid,
          lineStart: 1,
          lineEnd: 1,
          score: byName,
          snippet: e.name,
        });
      }
    }
    if (truncated) break;
  }
  hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return { hits: hits.slice(0, limits.k), scanned, denied, namesOnly, truncated };
}
