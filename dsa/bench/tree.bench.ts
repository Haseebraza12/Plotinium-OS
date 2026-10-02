/**
 * S1 n-ary tree benchmarks (specs/08-dsa/data-structures.md §7, §8.2). Gated on IMPLEMENTED.
 * Workload: random trees with fan-out 20 and a depth cap (seed 42). Shape (§7.2): resolve at a
 * fixed depth of 32 is independent of the tree size (≤ 2×); move is independent of the subtree
 * size (≤ 2×); attach/detach and walk per node ≤ 2×.
 */
import { describe, it } from 'vitest';

import { measureBytesPerEntry } from '../src/_shared/mem.ts';
import { mulberry32 } from '../src/_shared/prng.ts';
import { createTree, IMPLEMENTED } from '../src/tree/index.ts';
import type { DirNode, NaryTree, TreeNode } from '../src/tree/index.ts';
import { BATCH, measureCurve, recordMemory, SEED, SIZES } from './harness.ts';

const FAN_OUT = 20;
const DEPTH = 32;

let ids = 0;
const dir = (): DirNode<null> => ({
  id: `d${ids++}`,
  payload: null,
  parent: null,
  name: '',
  children: new Map(),
});
const file = (): TreeNode<null> => ({ id: `f${ids++}`, payload: null });

/**
 * A tree of about n nodes: a 32-level spine /s0/…/s31 (the resolve target) plus random
 * directories and files with fan-out ≤ 20 hanging off existing directories.
 */
function randomTree(n: number): { tree: NaryTree<null>; spine: string[]; deepest: DirNode<null> } {
  const rand = mulberry32(SEED);
  const tree = createTree<null>('root', null);
  const dirs: DirNode<null>[] = [tree.root];
  const spine: string[] = [];
  let parent = tree.root;
  for (let i = 0; i < DEPTH; i++) {
    const d = dir();
    tree.attach(parent, `s${i}`, d);
    spine.push(`s${i}`);
    dirs.push(d);
    parent = d;
  }
  while (tree.size < n) {
    const host = dirs[Math.floor(rand() * dirs.length)] as DirNode<null>;
    if ((host.children?.size ?? FAN_OUT) >= FAN_OUT) continue;
    const name = `n${tree.size}`;
    if (rand() < 0.3) {
      const d = dir();
      tree.attach(host, name, d);
      dirs.push(d);
    } else {
      tree.attach(host, name, file());
    }
  }
  return { tree, spine, deepest: parent };
}

/** A directory holding a subtree of `size` descendants (100 files per directory). */
function subtree(tree: NaryTree<null>, host: DirNode<null>, size: number): DirNode<null> {
  const top = dir();
  tree.attach(host, 'moving', top);
  let current = top;
  for (let i = 0; i < size; i++) {
    if (i % 100 === 99) {
      const d = dir();
      tree.attach(current, `d${i}`, d);
      current = d;
    } else {
      tree.attach(current, `f${i}`, file());
    }
  }
  return top;
}

describe.runIf(IMPLEMENTED)('dsa/tree benchmarks (S1)', () => {
  it('DSA-TREE-01 resolve cost at depth 32 is independent of tree size', async ({
    bench,
    expect,
  }) => {
    const resolve = await measureCurve(bench, {
      structure: 'tree',
      op: 'resolve depth 32',
      batch: BATCH,
      shape: { expected: 'O(d)', limit: 2 },
      setup: (n) => {
        const { tree, spine } = randomTree(n);
        return () => {
          for (let i = 0; i < BATCH; i++) tree.resolve(tree.root, spine);
        };
      },
    });
    const attach = await measureCurve(bench, {
      structure: 'tree',
      op: 'attach+detach',
      batch: BATCH,
      shape: { expected: 'O(1)', limit: 2 },
      setup: (n) => {
        const { tree, deepest } = randomTree(n);
        const leaf = file();
        return () => {
          for (let i = 0; i < BATCH; i++) {
            tree.attach(deepest, 'tmp', leaf);
            tree.detach(deepest, 'tmp');
          }
        };
      },
    });
    const walk = await measureCurve(bench, {
      structure: 'tree',
      op: 'walk per node',
      batch: (n) => n,
      shape: { expected: 'O(n)', limit: 2 },
      setup: (n) => {
        const { tree } = randomTree(n);
        return () => {
          for (const _entry of tree.walk(tree.root)) {
            // visiting is the measured work
          }
        };
      },
    });
    expect(resolve.ratio).toBeLessThanOrEqual(2);
    expect(attach.ratio).toBeLessThanOrEqual(2);
    expect(walk.ratio).toBeLessThanOrEqual(2);
  });

  it('DSA-TREE-02 move cost is independent of subtree size', async ({ bench, expect }) => {
    const move = await measureCurve(bench, {
      structure: 'tree',
      op: 'move (subtree size)',
      sizes: [10, 1_000, 100_000],
      batch: BATCH,
      shape: { expected: 'O(1)', limit: 2 },
      setup: (size) => {
        const { tree, deepest } = randomTree(1_000);
        const a = tree.root;
        const b = deepest;
        subtree(tree, a, size);
        return () => {
          for (let i = 0; i < BATCH; i += 2) {
            tree.move(a, 'moving', b, 'moving');
            tree.move(b, 'moving', a, 'moving');
          }
        };
      },
    });
    expect(move.ratio).toBeLessThanOrEqual(2);
  });

  it('DSA-TREE-01 bytes per loaded node at 10^5', ({ expect }) => {
    for (const n of SIZES) {
      const { value, bytesPerEntryMeasured } = measureBytesPerEntry(n, () => randomTree(n).tree);
      const rec = recordMemory('tree', n, bytesPerEntryMeasured, value.stats());
      expect(rec.n).toBe(n);
    }
  });
});
