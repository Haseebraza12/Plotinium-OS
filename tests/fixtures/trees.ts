/**
 * Seeded trees for the fault-injection matrix (spec §3.6.6) and the property suites.
 *
 * Paths are relative to the fixture's mount point (for example `~/fixtures`). The same generator
 * feeds the client seeding (through syscalls) and the server seeding (SQL), so both sides hold the
 * same tree and the oracle checksums are comparable.
 */
import type { DentryRow, InodeRow, StoreRows } from '../support/oracle.ts';

import { DEFAULT_SEED, intIn, mulberry32 } from './rng.ts';

export type NodeType = 'd' | 'f';

export interface FixtureNode {
  /** Relative path, `/`-separated, no leading slash; the top directory is the tree name. */
  path: string;
  type: NodeType;
  mode: number;
  size: number;
}

export interface FixtureTree {
  id: TreeId;
  nodes: FixtureNode[];
}

export type TreeId = 'tree1000' | 'flat1000' | 'flat500' | 'files20';

/** Node counts include the top directory, so `tree1000` is exactly 1,000 nodes. */
export const TREE_SIZES: Readonly<Record<TreeId, number>> = {
  tree1000: 1000,
  flat1000: 1001,
  flat500: 501,
  files20: 21,
};

const DIR_MODE = 0o755;
const FILE_MODE = 0o644;

function depthOf(path: string): number {
  return path.split('/').length - 1;
}

/**
 * 1,000 nodes, depth at least 6: a spine of 7 nested directories first, then files and
 * directories attached under random existing directories (about one in five is a directory).
 */
export function tree1000(seed: number = DEFAULT_SEED): FixtureTree {
  const rng = mulberry32(seed);
  const nodes: FixtureNode[] = [{ path: 'tree1000', type: 'd', mode: DIR_MODE, size: 0 }];
  const dirs = ['tree1000'];
  let spine = 'tree1000';
  for (let level = 1; level <= 7; level++) {
    spine = `${spine}/s${level}`;
    nodes.push({ path: spine, type: 'd', mode: DIR_MODE, size: 0 });
    dirs.push(spine);
  }
  while (nodes.length < TREE_SIZES.tree1000) {
    const parent = dirs[intIn(rng, 0, dirs.length - 1)] ?? 'tree1000';
    const n = nodes.length;
    if (rng() < 0.2) {
      const path = `${parent}/d${n}`;
      nodes.push({ path, type: 'd', mode: DIR_MODE, size: 0 });
      dirs.push(path);
    } else {
      nodes.push({
        path: `${parent}/f${n}.txt`,
        type: 'f',
        mode: FILE_MODE,
        size: intIn(rng, 0, 4096),
      });
    }
  }
  return { id: 'tree1000', nodes };
}

function flat(id: TreeId, files: number, size: (i: number) => number): FixtureTree {
  const nodes: FixtureNode[] = [{ path: id, type: 'd', mode: DIR_MODE, size: 0 }];
  for (let i = 0; i < files; i++) {
    nodes.push({
      path: `${id}/file-${String(i).padStart(4, '0')}.txt`,
      type: 'f',
      mode: FILE_MODE,
      size: size(i),
    });
  }
  return { id, nodes };
}

/** 1,000 files in one directory: the `mv` batch case. */
export const flat1000 = (): FixtureTree => flat('flat1000', 1000, () => 16);
/** 500 files in one directory: the batch rename case. */
export const flat500 = (): FixtureTree => flat('flat500', 500, () => 16);
/** 20 files with content: the blob-store fault case. */
export const files20 = (): FixtureTree => flat('files20', 20, (i) => 1024 * (i + 1));

export function treeById(id: TreeId): FixtureTree {
  switch (id) {
    case 'tree1000':
      return tree1000();
    case 'flat1000':
      return flat1000();
    case 'flat500':
      return flat500();
    case 'files20':
      return files20();
  }
}

export function maxDepth(tree: FixtureTree): number {
  return Math.max(...tree.nodes.map((n) => depthOf(n.path)));
}

/** Deterministic content for file `path` of `size` bytes (printable, so `cat` output is stable). */
export function contentOf(path: string, size: number): string {
  const line = `${path}\n`;
  return line.repeat(Math.ceil(size / line.length)).slice(0, size);
}

/**
 * Oracle rows for a fixture mounted under a synthetic root, with inode ids `n<index>`.
 * Used by the oracle unit tests and as the expected server rows after seeding.
 */
export function toRows(tree: FixtureTree, uid = 1000, gid = 100): StoreRows {
  const fsRoot = 'root';
  const inoOf = new Map<string, string>(tree.nodes.map((n, i) => [n.path, `n${i}`]));
  const subdirs = new Map<string, number>();
  const dentries: DentryRow[] = tree.nodes.map((n) => {
    const cut = n.path.lastIndexOf('/');
    const parentPath = cut < 0 ? null : n.path.slice(0, cut);
    const parent = parentPath === null ? fsRoot : (inoOf.get(parentPath) ?? fsRoot);
    if (n.type === 'd') subdirs.set(parent, (subdirs.get(parent) ?? 0) + 1);
    return { parent, name: n.path.slice(cut + 1), ino: inoOf.get(n.path) ?? '', dType: n.type };
  });
  const inodes: InodeRow[] = [
    {
      ino: fsRoot,
      type: 'd',
      mode: DIR_MODE,
      uid: 0,
      gid: 0,
      size: 0,
      nlink: 2 + (subdirs.get(fsRoot) ?? 0),
      version: 1,
      blob: null,
    },
    ...tree.nodes.map((n): InodeRow => {
      const ino = inoOf.get(n.path) ?? '';
      return {
        ino,
        type: n.type,
        mode: n.mode,
        uid,
        gid,
        size: n.size,
        nlink: n.type === 'd' ? 2 + (subdirs.get(ino) ?? 0) : 1,
        version: 1,
        blob: n.type === 'f' && n.size > 0 ? `b-${ino}` : null,
      };
    }),
  ];
  const blobs = inodes.flatMap((i) => (i.blob === null ? [] : [{ blob: i.blob, refcount: 1 }]));
  const usedBytes = tree.nodes.reduce((sum, n) => sum + n.size, 0);
  return {
    subtreeRoot: inoOf.get(tree.id) ?? fsRoot,
    fsRoot,
    inodes,
    dentries,
    blobs,
    quota: [{ uid, usedBytes, usedInodes: tree.nodes.length }],
    outboxLen: 0,
    undoLen: 0,
    fsckClean: true,
  };
}
