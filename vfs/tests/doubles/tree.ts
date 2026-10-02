/**
 * TEST-ONLY double of `dsa/tree` (C16: the real n-ary tree is written by the team and stays
 * IMPLEMENTED = false until then). It implements just the `NaryTree` contract the VFS uses, over
 * plain Maps, with no attempt at the structure's performance guarantees.
 */
import type { DirNode, NaryTree, ResolveResult, TreeNode, WalkEntry } from '@plotinium/dsa/tree';

function isDir<P>(n: TreeNode<P>): n is DirNode<P> {
  return 'children' in n;
}

function collect<P>(from: DirNode<P>, order: 'pre' | 'post'): WalkEntry<P>[] {
  const out: WalkEntry<P>[] = [];
  const visit = (node: TreeNode<P>, dir: DirNode<P> | null, name: string, depth: number): void => {
    if (order === 'pre') out.push({ node, dir, name, depth });
    if (isDir(node) && node.children !== null)
      for (const [n, c] of node.children) visit(c, node, n, depth + 1);
    if (order === 'post') out.push({ node, dir, name, depth });
  };
  visit(from, null, from.name, 0);
  return out;
}

export function createTreeDouble<P>(rootId: string, rootPayload: P): NaryTree<P> {
  const root: DirNode<P> = {
    id: rootId,
    payload: rootPayload,
    parent: null,
    name: '',
    children: new Map(),
  };
  const children = (dir: DirNode<P>): Map<string, TreeNode<P>> => {
    if (dir.children === null) throw new Error('NOT_LOADED');
    return dir.children;
  };
  const tree: NaryTree<P> = {
    root,
    get size() {
      return new Set(collect(root, 'pre').map((e) => e.node)).size;
    },
    isDir,
    lookup: (dir, name) => children(dir).get(name),
    attach(dir, name, node) {
      const m = children(dir);
      if (m.has(name)) throw new Error('DUPLICATE');
      m.set(name, node);
      if (isDir(node)) {
        node.parent = dir;
        node.name = name;
      }
    },
    detach(dir, name) {
      const m = children(dir);
      const n = m.get(name);
      if (n === undefined) return undefined;
      m.delete(name);
      if (isDir(n) && n.parent === dir) n.parent = null;
      return n;
    },
    move(src, name, dst, newName) {
      const n = tree.detach(src, name);
      if (n === undefined) throw new Error('NOT_FOUND');
      tree.attach(dst, newName, n);
    },
    isAncestor(a, b) {
      for (let c: DirNode<P> | null = b; c !== null; c = c.parent) if (c === a) return true;
      return false;
    },
    depthOf(n) {
      let d = 0;
      for (let c = n.parent; c !== null; c = c.parent) d++;
      return d;
    },
    pathOf(n) {
      const names: string[] = [];
      for (let c: DirNode<P> | null = n; c !== null && c.parent !== null; c = c.parent)
        names.push(c.name);
      return `/${names.reverse().join('/')}`;
    },
    resolve(start, components): ResolveResult<P> {
      let cur: TreeNode<P> = start;
      let parent: DirNode<P> | null = start.parent;
      for (let i = 0; i < components.length; i++) {
        if (!isDir(cur)) return { ok: false, code: 'NOT_DIR', at: i, dir: parent ?? root };
        if (cur.children === null) return { ok: false, code: 'NOT_LOADED', at: i, dir: cur };
        const next = cur.children.get(components[i] ?? '');
        if (next === undefined) return { ok: false, code: 'NOT_FOUND', at: i, dir: cur };
        parent = cur;
        cur = next;
      }
      return { ok: true, node: cur, parent, depth: components.length };
    },
    *walk(from, order = 'pre') {
      for (const e of collect(from, order)) yield e;
    },
    setLoaded(dir, entries) {
      dir.children = new Map(entries);
      for (const [name, n] of dir.children) {
        if (isDir(n)) {
          n.parent = dir;
          n.name = name;
        }
      }
    },
    unload(dir) {
      dir.children = null;
    },
    stats: () => ({ size: tree.size, capacity: tree.size, bytesAllocated: 0, bytesUsed: 0 }),
    checkInvariants() {},
  };
  return tree;
}
