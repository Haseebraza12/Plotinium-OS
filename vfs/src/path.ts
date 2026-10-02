/**
 * @plotinium/vfs/path: path parsing, normalisation and resolution (VFS-03, VFS-05, VFS-08).
 *
 * ISOMORPHIC: imported by the kernel worker AND the Node server, so it uses neither DOM nor Node
 * APIs and imports only its sibling perm.ts and protocol TYPES (ESLint-enforced). The resolver
 * runs over an abstract `NodeSource`, so the kernel (in-memory tree), the server (database rows)
 * and the unit tests share one algorithm: virtual-file-system.md §3.5 and §5.1.
 */
import type { Errno } from '@plotinium/protocol';

import { may, X } from './perm.ts';
import type { Cred, InodeKind } from './perm.ts';

// These mirror @plotinium/protocol limits.ts; this module may not import protocol values (B3), so
// path.test.ts asserts that the two stay equal.
/** Spec VFS-08: a name is at most 255 bytes of UTF-8 after NFC. */
export const NAME_MAX = 255;
/** Spec VFS-08: a path is at most 4096 bytes of UTF-8 after NFC. */
export const PATH_MAX = 4096;
/** Spec VFS-03: at most 40 symlinks are followed; the 41st hop is ELOOP. */
export const SYMLOOP_MAX = 40;

/** UTF-8 byte length of a well-formed string, without TextEncoder. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export type Validated =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly errno: Errno };

/** Syscall-boundary validation of a path (§3.4, §5.1 step 0): NUL/lone surrogate, NFC, limits. */
export function validatePath(raw: string): Validated {
  if (raw.includes('\u0000') || !raw.isWellFormed()) return { ok: false, errno: 'EINVAL' };
  const value = raw.normalize('NFC');
  if (value === '') return { ok: false, errno: 'ENOENT' };
  if (utf8Length(value) > PATH_MAX) return { ok: false, errno: 'ENAMETOOLONG' };
  return { ok: true, value };
}

/** Validation of one stored name (§3.4, I8): non-empty, no '/', no NUL, not '.' or '..', ≤ 255 bytes. */
export function validateName(raw: string): Validated {
  if (raw === '' || raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\u0000')) {
    return { ok: false, errno: 'EINVAL' };
  }
  if (!raw.isWellFormed()) return { ok: false, errno: 'EINVAL' };
  const value = raw.normalize('NFC');
  if (utf8Length(value) > NAME_MAX) return { ok: false, errno: 'ENAMETOOLONG' };
  return { ok: true, value };
}

/** A symlink target: 1..4096 bytes (empty is ENOENT, as on Linux), no NUL (§3.7.1). */
export function validateSymlinkTarget(raw: string): Validated {
  if (raw.includes('\u0000') || !raw.isWellFormed()) return { ok: false, errno: 'EINVAL' };
  const value = raw.normalize('NFC');
  if (value === '') return { ok: false, errno: 'ENOENT' };
  if (utf8Length(value) > PATH_MAX) return { ok: false, errno: 'ENAMETOOLONG' };
  return { ok: true, value };
}

/** Components of a path, empty ones dropped: `//` is `/` and a trailing `/` disappears. */
export function splitPath(p: string): string[] {
  return p.split('/').filter((c) => c !== '');
}

export function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

/** Join a directory path and a name. */
export function joinPath(dir: string, name: string): string {
  return dir === '/' || dir === '' ? `/${name}` : `${dir}/${name}`;
}

/** Last component ('' for '/'). */
export function basename(p: string): string {
  const parts = splitPath(p);
  return parts[parts.length - 1] ?? '';
}

/** Lexical parent of an absolute path ('/' for '/'). */
export function dirname(p: string): string {
  const parts = splitPath(p);
  parts.pop();
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

/**
 * Lexical normalisation of an absolute path: collapses '//', '.', '..' (at '/' it stays). Only for
 * display and keys: real resolution is physical (`..` after a symlink goes to the target's parent).
 */
export function normalizeLexical(p: string): string {
  const out: string[] = [];
  for (const c of splitPath(p)) {
    if (c === '.') continue;
    if (c === '..') out.pop();
    else out.push(c);
  }
  return `/${out.join('/')}`;
}

// ---------------------------------------------------------------------------------------------
// Resolution (§5.1)
// ---------------------------------------------------------------------------------------------

/** What the resolver needs to know about a node. */
export interface PathNode {
  readonly ino: string;
  readonly type: InodeKind;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly target: string | null;
}

/**
 * A child lookup: the node, null when absent, 'EAGAIN' when the directory is not mirrored and the
 * device is offline (PVFS-18: never a false ENOENT), or 'NOT_LOADED' when the caller must load the
 * directory first (§5.8) and resolve again.
 */
export type Lookup<N> = N | null | 'EAGAIN' | 'NOT_LOADED';

export interface NodeSource<N extends PathNode> {
  readonly root: N;
  lookup(dir: N, name: string): Lookup<N>;
  /** A directory's unique parent; the root's parent is the root. */
  parent(dir: N): N;
  /** A removed directory still referenced as a cwd (§3.5): relative lookups give ENOENT. */
  isDeleted?(dir: N): boolean;
  /** Absolute path of a directory, so relative resolutions report a canonical path. */
  pathOf?(dir: N): string;
}

export interface ResolveOpts {
  /** Follow a final symlink. */
  readonly follow: boolean;
  /** Stop one step early and return the parent plus the final name (create or remove). */
  readonly parent?: 'create' | 'remove';
}

export type Resolution<N> =
  | {
      readonly kind: 'ok';
      /** The final node; null only in parent mode when the name is free. */
      readonly node: N | null;
      /** Parent mode only: the directory holding `name`. */
      readonly parent: N | null;
      readonly name: string | null;
      /** Canonical absolute path of the result (physical, symlinks resolved). */
      readonly path: string;
    }
  | { readonly kind: 'err'; readonly errno: Errno; readonly detail?: string }
  | { readonly kind: 'load'; readonly dir: N };

const err = (errno: Errno, detail?: string): Resolution<never> =>
  detail === undefined ? { kind: 'err', errno } : { kind: 'err', errno, detail };

/**
 * Resolve `rawPath` for `cred` from `cwd` (§5.1). Synchronous: a directory that is not loaded yields
 * `{kind: 'load', dir}` and the caller loads it and calls again (`resolveAsync` does this).
 */
export function resolve<N extends PathNode>(
  src: NodeSource<N>,
  cred: Cred,
  cwd: N,
  rawPath: string,
  opts: ResolveOpts,
): Resolution<N> {
  const v = validatePath(rawPath);
  if (!v.ok) return err(v.errno);
  const p = v.value;
  let mustBeDir = p.length > 1 && p.endsWith('/');
  const work = splitPath(p);
  for (const c of work) if (utf8Length(c) > NAME_MAX) return err('ENAMETOOLONG');
  if (opts.parent !== undefined) {
    const lastName = work[work.length - 1];
    if (lastName === undefined) return err(opts.parent === 'create' ? 'EEXIST' : 'EBUSY');
    if (lastName === '.' || lastName === '..')
      return err(opts.parent === 'create' ? 'EEXIST' : 'EINVAL');
  }
  const absolute = isAbsolute(p);
  let cur = absolute ? src.root : cwd;
  if (!absolute && src.isDeleted?.(cwd) === true) return err('ENOENT');
  // Canonical names from the root to `cur`; unknown for a relative start until '..' or a hop resets.
  const cwdPath = absolute ? '/' : src.pathOf?.(cwd);
  let names: string[] | null = cwdPath === undefined ? null : splitPath(cwdPath);
  let hops = 0;
  const stack = work.reverse();
  while (stack.length > 0) {
    const c = stack.pop() as string; // non-empty stack
    const last = stack.length === 0;
    if (cur.type !== 'd') return err('ENOTDIR');
    if (!may(cred, cur, X)) return err('EACCES');
    if (c === '.') continue;
    if (c === '..') {
      cur = src.parent(cur);
      names?.pop();
      continue;
    }
    const child = src.lookup(cur, c);
    if (child === 'NOT_LOADED') return { kind: 'load', dir: cur };
    if (last && opts.parent !== undefined) {
      if (child === 'EAGAIN') return err('EAGAIN', 'not-mirrored-offline');
      if (mustBeDir && child !== null && child.type !== 'd') return err('ENOTDIR');
      return { kind: 'ok', node: child, parent: cur, name: c, path: pathOf(names, c) };
    }
    if (child === 'EAGAIN') return err('EAGAIN', 'not-mirrored-offline');
    if (child === null) return err('ENOENT');
    if (child.type === 'l' && (!last || opts.follow || mustBeDir)) {
      hops++;
      if (hops > SYMLOOP_MAX) return err('ELOOP');
      const t = child.target ?? '';
      if (t === '') return err('ENOENT');
      if (last && t.endsWith('/')) mustBeDir = true;
      const comps = splitPath(t);
      for (let i = comps.length - 1; i >= 0; i--) {
        const comp = comps[i] as string;
        if (utf8Length(comp) > NAME_MAX) return err('ENAMETOOLONG');
        stack.push(comp);
      }
      if (isAbsolute(t)) {
        cur = src.root;
        names = [];
      }
      continue;
    }
    cur = child;
    names?.push(c);
  }
  if (mustBeDir && cur.type !== 'd') return err('ENOTDIR');
  return { kind: 'ok', node: cur, parent: null, name: null, path: pathOf(names, null) };
}

function pathOf(names: readonly string[] | null, extra: string | null): string {
  if (names === null) return extra ?? '.';
  const all = extra === null ? names : [...names, extra];
  return `/${all.join('/')}`;
}

/**
 * Resolve, loading directories on demand (§5.8). A reload restarts the O(d) walk, which keeps the
 * algorithm in one place; `maxLoads` bounds a source that never finishes loading.
 */
export async function resolveAsync<N extends PathNode>(
  src: NodeSource<N>,
  cred: Cred,
  cwd: N,
  rawPath: string,
  opts: ResolveOpts,
  ensureLoaded: (dir: N) => Promise<void>,
  maxLoads = 4096,
): Promise<Resolution<N>> {
  for (let i = 0; i <= maxLoads; i++) {
    const r = resolve(src, cred, cwd, rawPath, opts);
    if (r.kind !== 'load') return r;
    await ensureLoaded(r.dir);
  }
  return err('EIO', 'storage');
}
