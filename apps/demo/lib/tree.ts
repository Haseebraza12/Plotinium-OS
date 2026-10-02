/**
 * The seeded fixture tree of the fault-injection demonstrations (testing-and-performance.md
 * §3.6.6: `tree1000`, 1,000 nodes, depth ≥ 6).
 *
 * The algorithm, the random draws and their order are exactly those of `tree1000` in
 * tests/fixtures/trees.ts, generalised to any top-directory name and node count: with the name
 * `tree1000`, 1,000 nodes and seed 42 the output is node-for-node that fixture, which the server
 * seed and the fault-injection oracle also use, so client and server checksums are comparable.
 * apps/ may not import tests/, hence the copy; tests/demo-tree.test.ts pins it to the fixture.
 */
import { sha256Hex } from '@plotinium/protocol';

import { DEFAULT_SEED, intIn, mulberry32 } from './pattern.ts';

export type NodeType = 'd' | 'f';

export interface TreeNode {
  /** Relative path, `/`-separated, no leading slash; the first component is the tree's name. */
  readonly path: string;
  readonly type: NodeType;
  readonly mode: number;
  readonly size: number;
}

export const DIR_MODE = 0o755;
export const FILE_MODE = 0o644;
/** Nested directories `s1`…`s7` created first, so the tree is at least 7 levels deep. */
export const SPINE = 7;
export const DEFAULT_NODES = 1000;

/** The nodes of the tree `name` with `count` nodes (the top directory included), in creation order. */
export function fixtureTree(
  name: string,
  count: number = DEFAULT_NODES,
  seed: number = DEFAULT_SEED,
): TreeNode[] {
  const rng = mulberry32(seed);
  const nodes: TreeNode[] = [{ path: name, type: 'd', mode: DIR_MODE, size: 0 }];
  const dirs = [name];
  let spine = name;
  for (let level = 1; level <= SPINE && nodes.length < count; level++) {
    spine = `${spine}/s${String(level)}`;
    nodes.push({ path: spine, type: 'd', mode: DIR_MODE, size: 0 });
    dirs.push(spine);
  }
  while (nodes.length < count) {
    const parent = dirs[intIn(rng, 0, dirs.length - 1)] ?? name;
    const n = nodes.length;
    if (rng() < 0.2) {
      const path = `${parent}/d${String(n)}`;
      nodes.push({ path, type: 'd', mode: DIR_MODE, size: 0 });
      dirs.push(path);
    } else {
      nodes.push({
        path: `${parent}/f${String(n)}.txt`,
        type: 'f',
        mode: FILE_MODE,
        size: intIn(rng, 0, 4096),
      });
    }
  }
  return nodes;
}

/** Deterministic, printable content of a file (identical to `contentOf` in tests/fixtures/trees.ts). */
export function contentOf(path: string, size: number): string {
  const line = `${path}\n`;
  return line.repeat(Math.ceil(size / line.length)).slice(0, size);
}

export function depthOf(path: string): number {
  return path.split('/').length - 1;
}

export interface TreeSummary {
  readonly nodes: number;
  readonly dirs: number;
  readonly files: number;
  readonly bytes: number;
  readonly depth: number;
  /** SHA-256 of one `<type> <octal mode> <size> <path>` line per node, in creation order. */
  readonly manifestSha256: string;
}

export function manifestLines(nodes: readonly TreeNode[]): string {
  return nodes.map((n) => `${n.type} ${n.mode.toString(8)} ${String(n.size)} ${n.path}\n`).join('');
}

export function summarize(nodes: readonly TreeNode[]): TreeSummary {
  let dirs = 0;
  let bytes = 0;
  let depth = 0;
  for (const n of nodes) {
    if (n.type === 'd') dirs++;
    bytes += n.size;
    depth = Math.max(depth, depthOf(n.path));
  }
  return {
    nodes: nodes.length,
    dirs,
    files: nodes.length - dirs,
    bytes,
    depth,
    manifestSha256: sha256Hex(manifestLines(nodes)),
  };
}
