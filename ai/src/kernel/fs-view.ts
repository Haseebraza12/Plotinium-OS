/**
 * The live file tree as the AI runtime reads it (rag-semantic-search.md §3.5 steps 3, 6, 8; §5.2).
 *
 * Every permission decision of the AI runtime reads the CURRENT in-memory tree and the kernel's
 * one permission function (`vfs/perm.ts may`), both injected: nothing about owners or modes is
 * ever copied into the index (I-A2), and a deleted inode is simply absent (I-A9).
 *
 * `vfsTreeView` adapts the kernel's `VfsTree` (vfs/src/tree/vfs-tree.ts) structurally, so the
 * composer passes `fs.tree` and `may` from `@plotinium/vfs/perm` and writes no glue.
 */
import type { Errno } from '@plotinium/protocol';

import type { LiveNode, LiveTree } from '../search/readable.ts';
import type { ResolvedPath } from '../search/results.ts';
import type { Cred, PermBit, PermOracle, PermSubject } from '../util/cred.ts';

/** One directory entry (hard link) of an inode. */
export interface LinkRef {
  readonly parent: string;
  readonly name: string;
}

/** The inode record fields the runtime reads. */
export interface InodeLike extends PermSubject {
  readonly ino: string;
  readonly version: number;
  readonly size: number;
}

/** Structural subset of the kernel's `VfsTree`. */
export interface VfsTreeLike {
  readonly rootIno: string;
  inode(ino: string): InodeLike | undefined;
  /** Every loaded link of `ino` (a directory has exactly one, the root none). */
  links(ino: string): readonly LinkRef[];
  /** A child by name: the record, null when absent, or a load/offline marker. */
  child(dir: string, name: string): InodeLike | null | 'NOT_LOADED' | 'EAGAIN';
}

/** `may(cred, node, want)` of `@plotinium/vfs/perm` (want: r = 4, w = 2, x = 1). */
export type MayFn = (cred: Cred, node: PermSubject, want: number) => boolean;

export interface AiFsView extends LiveTree {
  readonly oracle: PermOracle;
  links(ino: string): readonly LinkRef[];
  inode(ino: string): InodeLike | undefined;
  child(dir: string, name: string): InodeLike | null | 'NOT_LOADED' | 'EAGAIN';
}

const WANT: Record<PermBit, number> = { r: 4, w: 2, x: 1 };

/** A permission oracle over `vfs/perm.ts may`. */
export function oracleFrom(may: MayFn): PermOracle {
  return { may: (cred, node, bit) => may(cred, node, WANT[bit]) };
}

/** Adapt the kernel tree: `vfsTreeView(fs.tree, may)`. */
export function vfsTreeView(tree: VfsTreeLike, may: MayFn): AiFsView {
  return {
    get rootIno() {
      return tree.rootIno;
    },
    oracle: oracleFrom(may),
    node(ino: string): LiveNode | undefined {
      const rec = tree.inode(ino);
      if (rec === undefined) return undefined;
      return {
        ino: rec.ino,
        version: rec.version,
        type: rec.type,
        uid: rec.uid,
        gid: rec.gid,
        mode: rec.mode,
        parents: tree.links(ino).map((l) => l.parent),
      };
    },
    links: (ino) => tree.links(ino),
    inode: (ino) => tree.inode(ino),
    child: (dir, name) => tree.child(dir, name),
  };
}

function splitPath(path: string): string[] {
  return path.split('/').filter((p) => p.length > 0 && p !== '.');
}

export type Lookup = { ok: true; ino: string; node: InodeLike } | { ok: false; errno: Errno };

/**
 * Resolve a directory path as `cred` (semsearch `--dir`, the Files search box): x on every
 * directory walked. `..` is resolved lexically. Symlinks are not followed (a scope must be a real
 * directory). ENOENT, ENOTDIR or EACCES as the ABI lists for `ai.semsearch`.
 */
export function resolveDir(view: AiFsView, cred: Cred, path: string, cwd: string): Lookup {
  const abs = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`;
  const parts: string[] = [];
  for (const p of splitPath(abs)) {
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  let ino = view.rootIno;
  let node = view.inode(ino);
  if (node === undefined) return { ok: false, errno: 'ENOENT' };
  for (const name of parts) {
    if (node.type !== 'd') return { ok: false, errno: 'ENOTDIR' };
    if (!view.oracle.may(cred, node, 'x')) return { ok: false, errno: 'EACCES' };
    const next = view.child(ino, name);
    if (next === null) return { ok: false, errno: 'ENOENT' };
    if (next === 'NOT_LOADED' || next === 'EAGAIN') return { ok: false, errno: 'ENOENT' };
    ino = next.ino;
    node = next;
  }
  if (node.type !== 'd') return { ok: false, errno: 'ENOTDIR' };
  if (!view.oracle.may(cred, node, 'x')) return { ok: false, errno: 'EACCES' };
  return { ok: true, ino, node };
}

/** The directories from the root down to `dirIno` (root first), or undefined when detached. */
function chainTo(
  view: AiFsView,
  dirIno: string,
): { names: string[]; dirs: LiveNode[] } | undefined {
  const names: string[] = [];
  const dirs: LiveNode[] = [];
  const seen = new Set<string>();
  let cur = dirIno;
  for (;;) {
    if (seen.has(cur)) return undefined;
    seen.add(cur);
    const node = view.node(cur);
    if (node === undefined) return undefined;
    dirs.unshift(node);
    if (cur === view.rootIno) break;
    const link = view.links(cur)[0];
    if (link === undefined) return undefined;
    names.unshift(link.name);
    cur = link.parent;
  }
  return { names, dirs };
}

/**
 * The current path of `ino` through its first link that `cred` can traverse (§3.5 step 8), with
 * the directories on it (root first) for the foreign-result rule.
 */
export function resolvePathOf(view: AiFsView, cred: Cred, ino: string): ResolvedPath | undefined {
  for (const link of view.links(ino)) {
    const chain = chainTo(view, link.parent);
    if (chain === undefined) continue;
    if (!chain.dirs.every((d) => view.oracle.may(cred, d, 'x'))) continue;
    const dirPath = chain.names.length === 0 ? '' : `/${chain.names.join('/')}`;
    return { path: `${dirPath}/${link.name}`, ancestors: chain.dirs };
  }
  return undefined;
}

/** The basename of a file's first link (the BM25 name field, read at query time). */
export function nameOf(view: AiFsView, ino: string): string | undefined {
  return view.links(ino)[0]?.name;
}
