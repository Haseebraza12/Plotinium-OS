/**
 * A copy-on-write overlay over a read snapshot of the tree (agentic-shell.md §3.11, §3.12).
 *
 * The validator applies a plan step by step to the overlay, so later steps see earlier effects
 * (a rename into a directory created by an earlier mkdir), and the same pass produces the dry run.
 * No readwrite transaction is open and the snapshot is never modified. Resolution follows the VFS
 * rules the validator needs: absolute or cwd-relative paths, `~`, lexical `.`/`..`, `x` on every
 * directory walked (EACCES), at most 40 symlink hops (ELOOP), names ≤ 255 and paths ≤ 4096 bytes
 * (ENAMETOOLONG).
 */
import { NAME_MAX, PATH_MAX, SYMLOOP_MAX } from '@plotinium/protocol';

import { utf8Length } from '../util/bytes.ts';
import type { Cred, PermOracle, PermSubject } from '../util/cred.ts';
import { type Result, fail, ok } from '../util/errors.ts';

export interface SnapNode extends PermSubject {
  readonly ino: string;
  readonly version: number;
  readonly size: number;
  readonly mtime: number;
  /** Symlink target. */
  readonly target?: string;
  /** Directory entries, name → ino. */
  readonly children?: ReadonlyMap<string, string>;
}

export interface FsSnapshot {
  readonly rootIno: string;
  readonly generation: number;
  node(ino: string): SnapNode | undefined;
}

export interface OvNode {
  ino: string;
  type: 'f' | 'd' | 'l';
  uid: number;
  gid: number;
  mode: number;
  version: number;
  size: number;
  mtime: number;
  target?: string;
  children?: Map<string, string>;
  /** Created by this plan (not in the snapshot). */
  created: boolean;
}

export interface Resolved {
  node: OvNode;
  /** The directory holding the final entry (undefined for `/`). */
  parent: OvNode | undefined;
  name: string;
  /** Normalised absolute path of the entry itself (symlinks in the prefix resolved). */
  path: string;
}

export interface ParentResolved {
  dir: OvNode;
  name: string;
  path: string;
  /** The entry, when it exists (not followed). */
  existing: OvNode | undefined;
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Lexical normalisation to an absolute path; undefined for an empty path. */
export function normalizePath(path: string, cwd: string, home: string): string | undefined {
  if (path === '') return undefined;
  let p = path.normalize('NFC');
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = `${home}${p.slice(1)}`;
  if (!p.startsWith('/')) p = `${cwd}/${p}`;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

export function isUnder(path: string, root: string): boolean {
  return root === '/' || path === root || path.startsWith(`${root}/`);
}

export class Overlay {
  private readonly base: FsSnapshot;
  private readonly nodes = new Map<string, OvNode>();
  private nextNew = 1;

  constructor(base: FsSnapshot) {
    this.base = base;
  }

  get rootIno(): string {
    return this.base.rootIno;
  }

  get generation(): number {
    return this.base.generation;
  }

  node(ino: string): OvNode | undefined {
    const own = this.nodes.get(ino);
    if (own !== undefined) return own;
    const b = this.base.node(ino);
    if (b === undefined) return undefined;
    const copy: OvNode = {
      ino: b.ino,
      type: b.type,
      uid: b.uid,
      gid: b.gid,
      mode: b.mode,
      version: b.version,
      size: b.size,
      mtime: b.mtime,
      created: false,
    };
    if (b.target !== undefined) copy.target = b.target;
    if (b.children !== undefined) copy.children = new Map(b.children);
    this.nodes.set(ino, copy);
    return copy;
  }

  /** The snapshot's version of an inode (undefined for inodes created by the plan). */
  baseVersion(ino: string): number | undefined {
    return this.base.node(ino)?.version;
  }

  create(fields: Omit<OvNode, 'ino' | 'created' | 'version'>): OvNode {
    const node: OvNode = { ...fields, ino: `new:${this.nextNew++}`, version: 0, created: true };
    this.nodes.set(node.ino, node);
    return node;
  }

  link(dir: OvNode, name: string, ino: string): void {
    dir.children ??= new Map();
    dir.children.set(name, ino);
  }

  unlinkEntry(dir: OvNode, name: string): void {
    dir.children?.delete(name);
  }

  /** Every node of a subtree, pre-order, iteratively. */
  subtree(root: OvNode): OvNode[] {
    const out: OvNode[] = [];
    const stack: OvNode[] = [root];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const n = stack.pop();
      if (n === undefined || seen.has(n.ino)) continue;
      seen.add(n.ino);
      out.push(n);
      if (n.type === 'd' && n.children !== undefined) {
        const kids = [...n.children.values()].reverse();
        for (const k of kids) {
          const c = this.node(k);
          if (c !== undefined) stack.push(c);
        }
      }
    }
    return out;
  }

  private checkNames(path: string): Result<string[]> {
    if (utf8Length(path) > PATH_MAX) return fail('ENAMETOOLONG');
    const parts = path.split('/').filter((s) => s !== '');
    for (const part of parts) if (utf8Length(part) > NAME_MAX) return fail('ENAMETOOLONG');
    return ok(parts);
  }

  /**
   * Resolve an absolute normalised path as `cred`. `follow` decides whether a final symlink is
   * followed. Intermediate symlinks are always followed.
   */
  resolve(path: string, cred: Cred, oracle: PermOracle, follow: boolean): Result<Resolved> {
    const names = this.checkNames(path);
    if (!names.ok) return names;
    const queue = [...names.value];
    const root = this.node(this.rootIno);
    if (root === undefined) return fail('ENOENT');
    let cur = root;
    let curPath = '/';
    let parent: OvNode | undefined;
    let name = '';
    let hops = 0;
    while (queue.length > 0) {
      const part = queue.shift() ?? '';
      if (cur.type !== 'd') return fail('ENOTDIR');
      if (!oracle.may(cred, cur, 'x')) return fail('EACCES');
      if (part === '..') {
        curPath = dirname(curPath);
        const up = this.resolve(curPath, cred, oracle, true);
        if (!up.ok) return up;
        cur = up.value.node;
        continue;
      }
      const childIno = cur.children?.get(part);
      const child = childIno === undefined ? undefined : this.node(childIno);
      if (child === undefined) return fail('ENOENT');
      const last = queue.length === 0;
      if (child.type === 'l' && (!last || follow)) {
        if (++hops > SYMLOOP_MAX) return fail('ELOOP');
        const target = child.target ?? '';
        if (target === '') return fail('ENOENT');
        const next = target.startsWith('/')
          ? target
          : `${curPath === '/' ? '' : curPath}/${target}`;
        const t = this.checkNames(next);
        if (!t.ok) return t;
        queue.unshift(...t.value);
        cur = root;
        curPath = '/';
        continue;
      }
      parent = cur;
      name = part;
      curPath = joinPath(curPath, part);
      cur = child;
    }
    return ok({ node: cur, parent, name, path: curPath });
  }

  /** Resolve the parent directory of `path` (followed) and look up the final entry (not followed). */
  resolveParent(path: string, cred: Cred, oracle: PermOracle): Result<ParentResolved> {
    if (path === '/') return fail('EINVAL');
    const name = basename(path);
    const d = this.resolve(dirname(path), cred, oracle, true);
    if (!d.ok) return d;
    if (d.value.node.type !== 'd') return fail('ENOTDIR');
    if (utf8Length(name) > NAME_MAX) return fail('ENAMETOOLONG');
    const ino = d.value.node.children?.get(name);
    return ok({
      dir: d.value.node,
      name,
      path: joinPath(d.value.path, name),
      existing: ino === undefined ? undefined : this.node(ino),
    });
  }
}
