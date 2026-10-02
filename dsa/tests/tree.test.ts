/**
 * S1 n-ary tree: edge cases (specs/08-dsa/data-structures.md §8.2). Gated on IMPLEMENTED (C16).
 */
import { describe, expect, it } from 'vitest';

import { createTree, IMPLEMENTED } from '../src/tree/index.ts';
import type { DirNode, NaryTree, TreeNode } from '../src/tree/index.ts';
import { expectDsaError } from './helpers.ts';

let nextId = 0;
const dir = (loaded = true): DirNode<string> => {
  const id = `d${nextId++}`;
  return { id, payload: id, parent: null, name: '', children: loaded ? new Map() : null };
};
const file = (): TreeNode<string> => {
  const id = `f${nextId++}`;
  return { id, payload: id };
};

/** walk() as [name, depth] pairs. */
function walkNames(
  tree: NaryTree<string>,
  from: DirNode<string>,
  order?: 'pre' | 'post',
): Array<[string, number]> {
  return [...tree.walk(from, order)].map((e) => [e.name, e.depth]);
}

/** A chain /d0/d1/…/d(n−1); returns the deepest directory. */
function chain(tree: NaryTree<string>, n: number): DirNode<string>[] {
  const dirs: DirNode<string>[] = [];
  let parent = tree.root;
  for (let i = 0; i < n; i++) {
    const d = dir();
    tree.attach(parent, `c${i}`, d);
    dirs.push(d);
    parent = d;
  }
  return dirs;
}

describe.runIf(IMPLEMENTED)('dsa/tree (S1)', () => {
  it("DSA-TREE-01 a root-only tree has size 1, depthOf(root) 0, pathOf(root) '/' and walk yields only the root", () => {
    const tree = createTree('root', 'r');
    expect(tree.size).toBe(1);
    expect(tree.root.id).toBe('root');
    expect(tree.root.payload).toBe('r');
    expect(tree.root.parent).toBeNull();
    expect(tree.root.name).toBe('');
    expect(tree.depthOf(tree.root)).toBe(0);
    expect(tree.pathOf(tree.root)).toBe('/');
    const steps = [...tree.walk(tree.root)];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ node: tree.root, dir: null, name: '', depth: 0 });
    expect(tree.isDir(tree.root)).toBe(true);
    tree.checkInvariants();
  });

  it('DSA-TREE-01 lookup of any name in an empty directory returns undefined', () => {
    const tree = createTree('root', 'r');
    expect(tree.lookup(tree.root, 'a')).toBeUndefined();
    expect(tree.lookup(tree.root, '')).toBeUndefined();
    const empty = dir();
    tree.attach(tree.root, 'empty', empty);
    expect(tree.lookup(empty, 'x')).toBeUndefined();
  });

  it('DSA-TREE-01 attach then lookup returns the node and sets parent and name on a directory child', () => {
    const tree = createTree('root', 'r');
    const home = dir();
    const notes = file();
    tree.attach(tree.root, 'home', home);
    tree.attach(home, 'notes.md', notes);
    expect(tree.lookup(tree.root, 'home')).toBe(home);
    expect(tree.lookup(home, 'notes.md')).toBe(notes);
    expect(home.parent).toBe(tree.root);
    expect(home.name).toBe('home');
    expect(tree.isDir(home)).toBe(true);
    expect(tree.isDir(notes)).toBe(false);
    expect(tree.size).toBe(3);
    expect(tree.pathOf(home)).toBe('/home');
    tree.checkInvariants();
  });

  it('DSA-TREE-01 attaching an existing name throws DUPLICATE and leaves the tree unchanged', () => {
    const tree = createTree('root', 'r');
    const a = file();
    tree.attach(tree.root, 'a', a);
    const other = dir();
    expectDsaError(() => tree.attach(tree.root, 'a', other), 'DUPLICATE');
    expect(tree.lookup(tree.root, 'a')).toBe(a);
    expect(other.parent).toBeNull();
    expect(tree.size).toBe(2);
    tree.checkInvariants();
  });

  it('DSA-TREE-01 detach of a missing name returns undefined and changes nothing', () => {
    const tree = createTree('root', 'r');
    tree.attach(tree.root, 'a', file());
    expect(tree.detach(tree.root, 'missing')).toBeUndefined();
    expect(tree.size).toBe(2);
    const a = tree.detach(tree.root, 'a');
    expect(a).toBeDefined();
    expect(tree.lookup(tree.root, 'a')).toBeUndefined();
    expect(tree.size).toBe(1);
    tree.checkInvariants();
  });

  it('DSA-TREE-01 detach and move of the root throw INVALID', () => {
    const tree = createTree('root', 'r');
    const d = dir();
    tree.attach(tree.root, 'd', d);
    expectDsaError(() => tree.detach(tree.root, ''), 'INVALID');
    expectDsaError(() => tree.move(tree.root, '', d, 'x'), 'INVALID');
    expect(tree.root.parent).toBeNull();
    expect(tree.size).toBe(2);
    tree.checkInvariants();
  });

  it('DSA-TREE-02 moving a directory into its own descendant throws INVALID and leaves the tree unchanged', () => {
    const tree = createTree('root', 'r');
    const [a, b, c] = chain(tree, 3) as [DirNode<string>, DirNode<string>, DirNode<string>];
    expectDsaError(() => tree.move(tree.root, 'c0', c, 'loop'), 'INVALID');
    expectDsaError(() => tree.move(tree.root, 'c0', a, 'self'), 'INVALID'); // into itself
    expect(a.parent).toBe(tree.root);
    expect(tree.lookup(tree.root, 'c0')).toBe(a);
    expect(tree.lookup(c, 'loop')).toBeUndefined();
    expect(tree.pathOf(c)).toBe('/c0/c1/c2');
    expect(b.parent).toBe(a);
    tree.checkInvariants();
  });

  it('DSA-TREE-02 moving a directory onto the same parent and name is a no-op', () => {
    const tree = createTree('root', 'r');
    const d = dir();
    tree.attach(tree.root, 'd', d);
    tree.move(tree.root, 'd', tree.root, 'd');
    expect(tree.lookup(tree.root, 'd')).toBe(d);
    expect(d.parent).toBe(tree.root);
    expect(d.name).toBe('d');
    expect(tree.size).toBe(2);
    tree.checkInvariants();
  });

  it('DSA-TREE-02 rename within one directory keeps the node identity and children', () => {
    const tree = createTree('root', 'r');
    const src = dir();
    const inner = file();
    tree.attach(tree.root, 'src', src);
    tree.attach(src, 'main.ts', inner);
    const children = src.children;
    tree.move(tree.root, 'src', tree.root, 'lib');
    expect(tree.lookup(tree.root, 'src')).toBeUndefined();
    expect(tree.lookup(tree.root, 'lib')).toBe(src);
    expect(src.name).toBe('lib');
    expect(src.children).toBe(children);
    expect(tree.lookup(src, 'main.ts')).toBe(inner);
    expect(tree.pathOf(src)).toBe('/lib');
    // A file can be renamed too, and a move onto an existing name is refused.
    tree.attach(tree.root, 'other', file());
    expectDsaError(() => tree.move(tree.root, 'lib', tree.root, 'other'), 'DUPLICATE');
    tree.checkInvariants();
  });

  it("DSA-TREE-02 after moving a subtree of 10^5 nodes only the moved root's parent changed and pathOf reflects the new location", () => {
    const tree = createTree('root', 'r');
    const src = dir();
    const dst = dir();
    const big = dir();
    tree.attach(tree.root, 'src', src);
    tree.attach(tree.root, 'dst', dst);
    tree.attach(src, 'big', big);
    const dirs: DirNode<string>[] = [];
    for (let i = 0; i < 100; i++) {
      const d = dir();
      tree.attach(big, `d${i}`, d);
      dirs.push(d);
      for (let j = 0; j < 999; j++) tree.attach(d, `f${j}`, file());
    }
    expect(tree.size).toBe(4 + 100 * 1_000);
    const parentsBefore = dirs.map((d) => d.parent);
    tree.move(src, 'big', dst, 'big2');
    expect(big.parent).toBe(dst);
    expect(big.name).toBe('big2');
    expect(dirs.map((d) => d.parent)).toEqual(parentsBefore);
    expect(dirs.every((d) => d.parent === big)).toBe(true);
    expect(tree.pathOf(dirs[7] as DirNode<string>)).toBe('/dst/big2/d7');
    expect(tree.lookup(src, 'big')).toBeUndefined();
    expect(tree.size).toBe(4 + 100 * 1_000);
    tree.checkInvariants();
  });

  it('DSA-TREE-01 a file linked from two directories is walked under both and survives detaching one link', () => {
    const tree = createTree('root', 'r');
    const a = dir();
    const b = dir();
    const shared = file();
    tree.attach(tree.root, 'a', a);
    tree.attach(tree.root, 'b', b);
    tree.attach(a, 'x', shared);
    tree.attach(b, 'y', shared);
    expect(tree.size).toBe(4); // distinct nodes: root, a, b and the file once
    const hits = [...tree.walk(tree.root)]
      .filter((e) => e.node === shared)
      .map((e) => [e.dir, e.name]);
    expect(hits).toEqual([
      [a, 'x'],
      [b, 'y'],
    ]);
    expect(tree.detach(a, 'x')).toBe(shared);
    expect(tree.lookup(b, 'y')).toBe(shared);
    expect(tree.size).toBe(4);
    expect(tree.detach(b, 'y')).toBe(shared);
    expect(tree.size).toBe(3);
    tree.checkInvariants();
  });

  it('VFS-01 resolve returns NOT_LOADED at the right component for an unloaded directory and succeeds after setLoaded', () => {
    const tree = createTree('root', 'r');
    const a = dir(false);
    tree.attach(tree.root, 'a', a);
    expect(tree.resolve(tree.root, ['a', 'b'])).toEqual({
      ok: false,
      code: 'NOT_LOADED',
      at: 1,
      dir: a,
    });
    const b = file();
    tree.setLoaded(a, [['b', b]]);
    expect(tree.resolve(tree.root, ['a', 'b'])).toEqual({ ok: true, node: b, parent: a, depth: 2 });
    expect(tree.resolve(tree.root, [])).toEqual({
      ok: true,
      node: tree.root,
      parent: null,
      depth: 0,
    });
    expect(tree.resolve(tree.root, ['a', 'zz'])).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      at: 1,
      dir: a,
    });
    expect(tree.size).toBe(3);
    tree.checkInvariants();
  });

  it('VFS-01 resolve returns NOT_DIR when a middle component is a file', () => {
    const tree = createTree('root', 'r');
    const a = dir();
    tree.attach(tree.root, 'a', a);
    tree.attach(a, 'f', file());
    expect(tree.resolve(tree.root, ['a', 'f', 'x'])).toEqual({
      ok: false,
      code: 'NOT_DIR',
      at: 2,
      dir: a,
    });
  });

  it('DSA-TREE-01 unload drops the children and lookup then reports NOT_LOADED', () => {
    const tree = createTree('root', 'r');
    const a = dir();
    tree.attach(tree.root, 'a', a);
    tree.attach(a, 'f', file());
    tree.unload(a);
    expect(a.children).toBeNull();
    expectDsaError(() => tree.lookup(a, 'f'), 'NOT_LOADED');
    expect(tree.resolve(tree.root, ['a', 'f'])).toEqual({
      ok: false,
      code: 'NOT_LOADED',
      at: 1,
      dir: a,
    });
    // An unloaded directory is still walked as a node, but not descended into.
    expect(walkNames(tree, tree.root)).toEqual([
      ['', 0],
      ['a', 1],
    ]);
  });

  it('DSA-TREE-01 walk pre-order and post-order produce the expected sequences on a fixed tree', () => {
    const tree = createTree('root', 'r');
    const a = dir();
    const y = dir();
    tree.attach(tree.root, 'a', a);
    tree.attach(tree.root, 'b', file());
    tree.attach(a, 'x', file());
    tree.attach(a, 'y', y);
    tree.attach(y, 'z', file());
    expect(walkNames(tree, tree.root)).toEqual([
      ['', 0],
      ['a', 1],
      ['x', 2],
      ['y', 2],
      ['z', 3],
      ['b', 1],
    ]);
    expect(walkNames(tree, tree.root, 'post')).toEqual([
      ['x', 2],
      ['z', 3],
      ['y', 2],
      ['a', 1],
      ['b', 1],
      ['', 0],
    ]);
    // A subtree walk starts at depth 0 with dir null and the start's own name.
    const sub = [...tree.walk(a)];
    expect(sub[0]).toEqual({ node: a, dir: null, name: 'a', depth: 0 });
    expect(sub.map((e) => e.name)).toEqual(['a', 'x', 'y', 'z']);
    expect(sub[1]?.dir).toBe(a);
  });

  it('VFS-08 a 32-level chain resolves, walks and computes depth 32', () => {
    const tree = createTree('root', 'r');
    const dirs = chain(tree, 32);
    const deepest = dirs[31] as DirNode<string>;
    const names = Array.from({ length: 32 }, (_, i) => `c${i}`);
    expect(tree.resolve(tree.root, names)).toEqual({
      ok: true,
      node: deepest,
      parent: dirs[30],
      depth: 32,
    });
    expect(tree.depthOf(deepest)).toBe(32);
    expect(tree.pathOf(deepest)).toBe(`/${names.join('/')}`);
    expect([...tree.walk(tree.root)]).toHaveLength(33);
    expect(tree.isAncestor(tree.root, deepest)).toBe(true);
    expect(tree.isAncestor(deepest, tree.root)).toBe(false);
  });

  it('DSA-TREE-03 a 10,000-level chain walks and checks ancestry without a stack overflow', () => {
    const tree = createTree('root', 'r');
    const dirs = chain(tree, 10_000);
    const deepest = dirs[9_999] as DirNode<string>;
    expect(tree.depthOf(deepest)).toBe(10_000);
    expect(tree.isAncestor(tree.root, deepest)).toBe(true);
    expect(tree.isAncestor(deepest, deepest)).toBe(true);
    expect([...tree.walk(tree.root)]).toHaveLength(10_001);
    expect([...tree.walk(tree.root, 'post')].at(-1)?.node).toBe(tree.root);
    expect(tree.pathOf(deepest).split('/')).toHaveLength(10_001);
    expectDsaError(() => tree.move(tree.root, 'c0', deepest, 'loop'), 'INVALID');
    tree.checkInvariants();
  });

  it('DSA-TREE-01 a 255-byte UTF-8 name is accepted and names differing only in case are distinct', () => {
    const tree = createTree('root', 'r');
    const long = `${'é'.repeat(127)}a`; // 127 × 2 bytes + 1
    expect(new TextEncoder().encode(long).length).toBe(255);
    const f = file();
    tree.attach(tree.root, long, f);
    expect(tree.lookup(tree.root, long)).toBe(f);
    const upper = file();
    const lower = file();
    tree.attach(tree.root, 'README', upper);
    tree.attach(tree.root, 'readme', lower);
    expect(tree.lookup(tree.root, 'README')).toBe(upper);
    expect(tree.lookup(tree.root, 'readme')).toBe(lower);
    expect(tree.lookup(tree.root, 'Readme')).toBeUndefined();
    tree.checkInvariants();
  });

  it('DSA-TREE-01 checkInvariants detects a corrupted parent pointer', () => {
    const tree = createTree('root', 'r');
    const a = dir();
    const b = dir();
    tree.attach(tree.root, 'a', a);
    tree.attach(tree.root, 'b', b);
    tree.checkInvariants();
    a.parent = b;
    expect(() => tree.checkInvariants()).toThrow(/T2/);
  });

  it('DSA-GEN-09 stats count the loaded nodes', () => {
    const tree = createTree('root', 'r');
    chain(tree, 10);
    const stats = tree.stats();
    expect(stats.size).toBe(11);
    expect(stats.size).toBe(tree.size);
  });

  // The cases below pin down the accounting of whole subtrees (T6 stays exact) and the refusals
  // that keep T2–T5; they were added with the implementation (R2).

  it('DSA-TREE-01 detaching a non-empty directory drops its subtree from size, keeps files linked elsewhere and can be attached again', () => {
    const tree = createTree('root', 'r');
    const a = dir();
    const b = dir();
    const shared = file();
    tree.attach(tree.root, 'a', a);
    tree.attach(a, 'b', b);
    tree.attach(b, 'x', shared);
    tree.attach(b, 'y', file());
    tree.attach(tree.root, 'link', shared);
    expect(tree.size).toBe(5);
    expect(tree.detach(tree.root, 'a')).toBe(a);
    expect(a.parent).toBeNull();
    expect(b.parent).toBe(a); // the detached subtree is intact
    expect(tree.size).toBe(2); // the root and the file still linked at /link
    tree.checkInvariants();
    expectDsaError(() => tree.attach(b, 'z', file()), 'INVALID'); // b is no longer in the tree
    const home = dir();
    tree.attach(tree.root, 'home', home);
    tree.attach(home, 'restored', a); // graft the whole subtree back
    expect(tree.size).toBe(6);
    expect(tree.pathOf(b)).toBe('/home/restored/b');
    tree.checkInvariants();
  });

  it('DSA-TREE-01 attach refuses a directory already in the tree and invalid names with INVALID and changes nothing', () => {
    const tree = createTree('root', 'r');
    const [a, b] = chain(tree, 2) as [DirNode<string>, DirNode<string>];
    expectDsaError(() => tree.attach(b, 'root', tree.root), 'INVALID');
    expectDsaError(() => tree.attach(b, 'up', a), 'INVALID'); // an ancestor: would close a cycle
    expectDsaError(() => tree.attach(b, 'self', b), 'INVALID');
    expectDsaError(() => tree.attach(tree.root, 'twice', b), 'INVALID'); // no directory hard links
    for (const bad of [
      '',
      '.',
      '..',
      'a/b',
      'nul\u0000',
      'é'.repeat(128),
      '\u{1F600}'.repeat(64),
    ]) {
      expectDsaError(() => tree.attach(b, bad, file()), 'INVALID');
    }
    tree.attach(b, `${'\u{1F600}'.repeat(63)}abc`, file()); // 63 × 4 + 3 = 255 bytes
    expect(tree.size).toBe(4);
    expect(b.parent).toBe(a);
    const unloaded = dir(false);
    tree.attach(tree.root, 'u', unloaded);
    expectDsaError(() => tree.attach(unloaded, 'x', file()), 'NOT_LOADED');
    tree.checkInvariants();
  });

  it('DSA-TREE-02 grafting a detached subtree that holds a cycle or a directory of the tree throws INVALID and changes nothing', () => {
    const tree = createTree('root', 'r');
    const top = dir();
    const inner = dir();
    top.children?.set('inner', inner);
    inner.children?.set('back', top);
    expectDsaError(() => tree.attach(tree.root, 'g', top), 'INVALID');
    const live = dir();
    tree.attach(tree.root, 'live', live);
    const other = dir();
    other.children?.set('live', live);
    expectDsaError(() => tree.attach(tree.root, 'other', other), 'INVALID');
    expect(other.parent).toBeNull();
    expect(tree.size).toBe(2);
    tree.checkInvariants();
  });

  it('DSA-TREE-01 move of a missing name throws NOT_FOUND, into an unloaded directory NOT_LOADED, and a file move keeps size', () => {
    const tree = createTree('root', 'r');
    const a = dir();
    const u = dir(false);
    tree.attach(tree.root, 'a', a);
    tree.attach(tree.root, 'u', u);
    expectDsaError(() => tree.move(tree.root, 'missing', a, 'x'), 'NOT_FOUND');
    expectDsaError(() => tree.move(tree.root, 'a', u, 'a'), 'NOT_LOADED');
    expectDsaError(() => tree.move(tree.root, 'a', tree.root, '..'), 'INVALID');
    const f = file();
    tree.attach(a, 'f', f);
    tree.move(a, 'f', tree.root, 'g');
    expect(tree.lookup(tree.root, 'g')).toBe(f);
    expect(tree.lookup(a, 'f')).toBeUndefined();
    expect(tree.size).toBe(4);
    tree.checkInvariants();
  });

  it('VFS-01 unload removes the dropped entries from size, keeps hard-linked files and setLoaded restores them', () => {
    const tree = createTree('root', 'r');
    const a = dir();
    const b = dir();
    const shared = file();
    const only = file();
    tree.attach(tree.root, 'a', a);
    tree.attach(a, 'shared', shared);
    tree.attach(a, 'only', only);
    tree.attach(tree.root, 'b', b);
    tree.attach(b, 'shared', shared);
    expect(tree.size).toBe(5);
    tree.unload(a);
    expect(tree.size).toBe(4); // `only` left; `shared` is still linked from b
    expect([...tree.walk(a, 'post')]).toEqual([{ node: a, dir: null, name: 'a', depth: 0 }]);
    tree.unload(a); // already unloaded: a no-op
    tree.checkInvariants();
    tree.setLoaded(a, [
      ['shared', shared],
      ['only', only],
    ]);
    expect(tree.size).toBe(5);
    tree.checkInvariants();
    // Unloading a directory that has loaded subdirectories drops everything below it.
    tree.unload(tree.root);
    expect(tree.size).toBe(1);
    expectDsaError(() => tree.attach(a, 'x', file()), 'INVALID'); // a left the tree with its parent's map
    expectDsaError(() => tree.unload(a), 'INVALID');
    tree.checkInvariants();
  });

  it('VFS-01 setLoaded checks every entry before installing any and refuses a loaded directory', () => {
    const tree = createTree('root', 'r');
    const a = dir(false);
    tree.attach(tree.root, 'a', a);
    const sub = dir();
    const deep = file();
    sub.children?.set('deep', deep);
    expectDsaError(() => tree.setLoaded(tree.root, []), 'INVALID');
    expectDsaError(
      () =>
        tree.setLoaded(a, [
          ['x', file()],
          ['x', file()],
        ]),
      'DUPLICATE',
    );
    expectDsaError(
      () =>
        tree.setLoaded(a, [
          ['s1', sub],
          ['s2', sub],
        ]),
      'INVALID',
    );
    expectDsaError(() => tree.setLoaded(a, [['up', tree.root]]), 'INVALID');
    expectDsaError(() => tree.setLoaded(a, [['', file()]]), 'INVALID');
    expect(a.children).toBeNull();
    expect(tree.size).toBe(2);
    tree.setLoaded(a, [['sub', sub]]); // a preloaded subdirectory is grafted with its content
    expect(sub.parent).toBe(a);
    expect(sub.name).toBe('sub');
    expect(tree.resolve(tree.root, ['a', 'sub', 'deep'])).toEqual({
      ok: true,
      node: deep,
      parent: sub,
      depth: 3,
    });
    expect(tree.size).toBe(4);
    tree.checkInvariants();
  });

  it('DSA-TREE-01 checkInvariants names T1, T3, T5 and T6 for the matching corruption', () => {
    const tree = createTree('root', 'r');
    const a = dir();
    const b = dir();
    tree.attach(tree.root, 'a', a);
    tree.attach(tree.root, 'b', b);
    b.children?.set('again', a);
    expect(() => tree.checkInvariants()).toThrow(/T3/);
    b.children?.delete('again');
    tree.root.name = 'x';
    expect(() => tree.checkInvariants()).toThrow(/T1/);
    tree.root.name = '';
    a.children?.set('..', file());
    expect(() => tree.checkInvariants()).toThrow(/T5/);
    a.children?.delete('..');
    a.children?.set('sneaked', file());
    expect(() => tree.checkInvariants()).toThrow(/T6/);
    a.children?.delete('sneaked');
    tree.checkInvariants();
  });
});
