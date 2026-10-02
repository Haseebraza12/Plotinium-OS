/**
 * The read interface every planner runs against (virtual-file-system.md §3.11 phase 1).
 *
 * The kernel's in-memory tree (tree/vfs-tree.ts), the copy-on-write overlay of a plan in progress
 * (ops/overlay.ts) and test fixtures all implement `FsView`, so one planner serves a single call, a
 * `batch` (op i sees ops 0..i-1) and the property tests. Everything is keyed by ino, like the
 * store, and `viewSource` adapts a view to the path resolver's `NodeSource`.
 */
import { joinPath } from './path.ts';
import type { Lookup, NodeSource } from './path.ts';
import type { DentryRec, InodeRec, UserRec, Uuid } from './store/records.ts';

/** A child lookup: its inode, null when absent, or why the answer is not known (path.ts `Lookup`). */
export type ChildLookup = Lookup<InodeRec>;

export type EntryList = readonly DentryRec[] | 'NOT_LOADED' | 'EAGAIN';

export interface FsView {
  readonly rootIno: Uuid;
  inode(ino: Uuid): InodeRec | undefined;
  child(dir: Uuid, name: string): ChildLookup;
  /** Entries of a directory, in no particular order (listings sort by code point themselves). */
  entries(dir: Uuid): EntryList;
  /** The unique dentry of a directory; undefined for the root (§3.2). */
  dirEntry(dir: Uuid): DentryRec | undefined;
  /** The known dentries naming `ino` (hard links; a directory's single entry). */
  links(ino: Uuid): readonly DentryRec[];
  user(uid: number): UserRec | undefined;
}

/** Depth bound for walks up the parent chain: a corrupted cycle must not hang the kernel. */
const MAX_DEPTH = 4096;

/** Canonical absolute path of a directory, O(depth). */
export function dirPath(view: FsView, dir: Uuid): string {
  const names: string[] = [];
  let cur = dir;
  for (let i = 0; i < MAX_DEPTH && cur !== view.rootIno; i++) {
    const d = view.dirEntry(cur);
    if (d === undefined) break;
    names.push(d.name);
    cur = d.parent;
  }
  return `/${names.reverse().join('/')}`;
}

export function entryPath(view: FsView, parent: Uuid, name: string): string {
  return joinPath(dirPath(view, parent), name);
}

/** Whether directory `dir` is `ancestor` or lies below it (walk up from `dir`, O(depth)). */
export function isWithin(view: FsView, dir: Uuid, ancestor: Uuid): boolean {
  let cur = dir;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (cur === ancestor) return true;
    if (cur === view.rootIno) return false;
    const d = view.dirEntry(cur);
    if (d === undefined) return false;
    cur = d.parent;
  }
  return false;
}

/**
 * The resolver's view of `view`. A cwd whose inode is gone (removed while it was a process's working
 * directory, §3.5) is represented by `deletedCwd`: relative lookups from it give ENOENT.
 */
export function viewSource(view: FsView): NodeSource<InodeRec> {
  const root = view.inode(view.rootIno);
  if (root === undefined) throw new Error('view has no root inode');
  return {
    root,
    lookup: (dir, name) => view.child(dir.ino, name),
    parent(dir) {
      const d = view.dirEntry(dir.ino);
      return d === undefined ? root : (view.inode(d.parent) ?? root);
    },
    isDeleted: (dir) => view.inode(dir.ino) === undefined,
    pathOf: (dir) => dirPath(view, dir.ino),
  };
}

/** The cwd node for a resolution: the inode, or a placeholder the resolver treats as deleted. */
export function cwdNode(view: FsView, cwd: Uuid): InodeRec {
  const n = view.inode(cwd);
  if (n !== undefined) return n;
  const root = view.inode(view.rootIno);
  if (root === undefined) throw new Error('view has no root inode');
  return { ...root, ino: cwd };
}
