/**
 * Read-only calls answered from the tree (virtual-file-system.md §3.10 class "fast"): `stat`,
 * `lstat`, `readlink`, `realpath`, `access` and paged `readdir`/`readdirPlus`. They need x on every
 * directory traversed; listings need r (plus x for `readdirPlus`) and are sorted by code point, not by
 * UTF-16 unit (PVFS-12).
 */
import type { Stat } from '@plotinium/protocol';

import { NotLoaded, VfsError, fail } from '../errors.ts';
import { READDIR_DEFAULT, READDIR_MAX } from '../limits.ts';
import { compareCodePoints } from '../names.ts';
import { resolve } from '../path.ts';
import type { ResolveOpts } from '../path.ts';
import { checkReaddir, may } from '../perm.ts';
import type { Cred } from '../perm.ts';
import { isSynthIno } from '../quota/quota.ts';
import type { InodeRec, InodeType, Uuid, VfsDetail } from '../store/records.ts';
import type { FsView } from '../view.ts';
import { cwdNode, viewSource } from '../view.ts';

export interface ReadCtx {
  readonly view: FsView;
  readonly cred: Cred;
  readonly cwd: Uuid;
  /** Whether a blob's bytes are on this device (`Stat.cached`). */
  readonly cached?: (sha: string) => boolean;
}

function find(c: ReadCtx, path: string, opts: ResolveOpts): { node: InodeRec; path: string } {
  const r = resolve(viewSource(c.view), c.cred, cwdNode(c.view, c.cwd), path, opts);
  if (r.kind === 'load') throw new NotLoaded(r.dir.ino);
  if (r.kind === 'err') throw new VfsError(r.errno, r.detail as VfsDetail | undefined);
  return { node: r.node ?? fail('ENOENT'), path: r.path };
}

export function toStat(n: InodeRec, cached?: (sha: string) => boolean): Stat {
  return {
    ino: n.ino,
    type: n.type,
    mode: n.type === 'l' ? 0o777 : n.mode,
    uid: n.uid,
    gid: n.gid,
    size: n.size,
    nlink: n.nlink,
    atime: n.atime,
    mtime: n.mtime,
    ctime: n.ctime,
    version: n.version,
    blob: n.blob,
    target: n.target,
    btime: n.btime,
    fs: n.fs,
    synth: isSynthIno(n.ino),
    cached: n.blob === null || (cached?.(n.blob) ?? true),
  };
}

/** `stat` follows a final symlink (ENOENT when it dangles, ELOOP on a loop); `lstat` does not. */
export function statPath(c: ReadCtx, path: string, follow = true): Stat {
  return toStat(find(c, path, { follow }).node, c.cached);
}

export function readlink(c: ReadCtx, path: string): string {
  const n = find(c, path, { follow: false }).node;
  if (n.type !== 'l' || n.target === null) return fail('EINVAL', 'not-a-link');
  return n.target;
}

/** The canonical absolute path, every symlink resolved. */
export function realpath(c: ReadCtx, path: string): string {
  return find(c, path, { follow: true }).path;
}

/** `access(path, want)`: EACCES when `want` (r=4, w=2, x=1; 0 = exists) is not granted. */
export function access(c: ReadCtx, path: string, want: number): void {
  const n = find(c, path, { follow: true }).node;
  if (want !== 0 && !may(c.cred, n, want)) fail('EACCES');
}

export interface ReaddirEntry {
  readonly name: string;
  readonly ino: Uuid;
  readonly type: InodeType;
  readonly stat?: Stat;
}

export interface ReaddirPage {
  readonly entries: readonly ReaddirEntry[];
  /** The last name returned; pass it back as `cursor` for the next page. */
  readonly next?: string;
  readonly dirVersion: number;
}

/** A page of a directory in code-point order, after `cursor` (exclusive). */
export function readdir(
  c: ReadCtx,
  path: string,
  opts: { cursor?: string; limit?: number; plus?: boolean } = {},
): ReaddirPage {
  const dir = find(c, path, { follow: true }).node;
  if (dir.type !== 'd') fail('ENOTDIR');
  const e = checkReaddir(c.cred, dir, opts.plus === true);
  if (e !== null) fail(e);
  const list = c.view.entries(dir.ino);
  if (list === 'NOT_LOADED') throw new NotLoaded(dir.ino);
  if (list === 'EAGAIN') return fail('EAGAIN', 'not-mirrored-offline');
  const limit = Math.min(opts.limit ?? READDIR_DEFAULT, READDIR_MAX);
  const sorted = [...list].sort((a, b) => compareCodePoints(a.name, b.name));
  const cursor = opts.cursor;
  const from =
    cursor === undefined ? 0 : sorted.findIndex((d) => compareCodePoints(d.name, cursor) > 0);
  const page = from < 0 ? [] : sorted.slice(from, from + limit);
  const entries = page.map((d) => {
    const n = c.view.inode(d.ino);
    const base = { name: d.name, ino: d.ino, type: d.dtype };
    return opts.plus === true && n !== undefined ? { ...base, stat: toStat(n, c.cached) } : base;
  });
  const last = page[page.length - 1];
  const more = from >= 0 && from + limit < sorted.length;
  return {
    entries,
    ...(more && last !== undefined ? { next: last.name } : {}),
    dirVersion: dir.version,
  };
}
