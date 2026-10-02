/**
 * S1 n-ary tree: model-based property tests (specs/08-dsa/data-structures.md §8.2). The model maps
 * every path to the node object reachable there (a hard-linked file appears under several paths).
 * Gated on IMPLEMENTED (C16).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DsaError } from '../src/_shared/errors.ts';
import { createTree, IMPLEMENTED } from '../src/tree/index.ts';
import type { DirNode, NaryTree, TreeNode } from '../src/tree/index.ts';
import { PROP } from './helpers.ts';

type TreeOp =
  | { kind: 'mkdir' | 'create'; parent: number; name: string }
  | { kind: 'link'; file: number; parent: number; name: string }
  | { kind: 'unlink' | 'rmdir'; target: number }
  | { kind: 'mv'; source: number; parent: number; name: string };

/**
 * Per-test timeout. Vitest's default 5 s cannot hold the nightly 10,000 runs of spec §8 (about
 * 20 s on a dev laptop) and is tight for 1,000 runs on a loaded runner, so allow 20 ms per run
 * (about 10× the measured cost), never less than the default. Added with the implementation (R2).
 */
const TIMEOUT_MS = Math.max(5_000, PROP.numRuns * 20);

const name = fc.constantFrom('a', 'b', 'c', 'd');
const index = fc.nat(1_000);
const treeOp: fc.Arbitrary<TreeOp> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constantFrom('mkdir' as const, 'create' as const),
      parent: index,
      name,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('link' as const), file: index, parent: index, name }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constantFrom('unlink' as const, 'rmdir' as const),
      target: index,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('mv' as const), source: index, parent: index, name }),
  },
);

let ids = 0;
const newDir = (): DirNode<null> => ({
  id: `d${ids++}`,
  payload: null,
  parent: null,
  name: '',
  children: new Map(),
});
const newFile = (): TreeNode<null> => ({ id: `f${ids++}`, payload: null });

const join = (parent: string, child: string): string => `${parent}/${child}`;
const splitPath = (path: string): [string, string] => {
  const cut = path.lastIndexOf('/');
  return [path.slice(0, cut), path.slice(cut + 1)];
};

class Model {
  /** path → node; the root is ''. */
  readonly nodes = new Map<string, TreeNode<null>>();

  constructor(root: DirNode<null>) {
    this.nodes.set('', root);
  }
  isDir(n: TreeNode<null>): n is DirNode<null> {
    return 'children' in n;
  }
  dirs(): string[] {
    return [...this.nodes]
      .filter(([, n]) => this.isDir(n))
      .map(([p]) => p)
      .sort();
  }
  files(): string[] {
    return [...this.nodes]
      .filter(([, n]) => !this.isDir(n))
      .map(([p]) => p)
      .sort();
  }
  hasChildren(path: string): boolean {
    return [...this.nodes.keys()].some((p) => p.startsWith(`${path}/`));
  }
  distinct(): number {
    return new Set(this.nodes.values()).size;
  }
}

/** Every (path, node) reached by walk(root), paths rebuilt with pathOf. */
function walked(tree: NaryTree<null>): Map<string, TreeNode<null>> {
  const out = new Map<string, TreeNode<null>>();
  for (const e of tree.walk(tree.root)) {
    const base = e.dir === null ? null : tree.pathOf(e.dir);
    out.set(base === null ? '' : join(base === '/' ? '' : base, e.name), e.node);
  }
  return out;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof DsaError) return error.code;
    throw error;
  }
}

function dirAt(model: Model, path: string): DirNode<null> {
  return model.nodes.get(path) as DirNode<null>;
}

function step(tree: NaryTree<null>, model: Model, op: TreeOp): void {
  const dirs = model.dirs();
  switch (op.kind) {
    case 'mkdir':
    case 'create': {
      const parent = dirs[op.parent % dirs.length] ?? '';
      const node = op.kind === 'mkdir' ? newDir() : newFile();
      const path = join(parent, op.name);
      if (model.nodes.has(path)) {
        expect(codeOf(() => tree.attach(dirAt(model, parent), op.name, node))).toBe('DUPLICATE');
      } else {
        tree.attach(dirAt(model, parent), op.name, node);
        model.nodes.set(path, node);
      }
      break;
    }
    case 'link': {
      const files = model.files();
      if (files.length === 0) return;
      const node = model.nodes.get(files[op.file % files.length] ?? '') as TreeNode<null>;
      const parent = dirs[op.parent % dirs.length] ?? '';
      const path = join(parent, op.name);
      if (model.nodes.has(path)) {
        expect(codeOf(() => tree.attach(dirAt(model, parent), op.name, node))).toBe('DUPLICATE');
      } else {
        tree.attach(dirAt(model, parent), op.name, node);
        model.nodes.set(path, node);
      }
      break;
    }
    case 'unlink':
    case 'rmdir': {
      const candidates =
        op.kind === 'unlink'
          ? model.files()
          : dirs.filter((p) => p !== '' && !model.hasChildren(p));
      if (candidates.length === 0) return;
      const path = candidates[op.target % candidates.length] ?? '';
      const [parent, leaf] = splitPath(path);
      expect(tree.detach(dirAt(model, parent), leaf)).toBe(model.nodes.get(path));
      model.nodes.delete(path);
      break;
    }
    case 'mv': {
      const sources = [...model.nodes.keys()].filter((p) => p !== '').sort();
      if (sources.length === 0) return;
      const source = sources[op.source % sources.length] ?? '';
      const [srcParent, srcName] = splitPath(source);
      const parent = dirs[op.parent % dirs.length] ?? '';
      const target = join(parent, op.name);
      const node = model.nodes.get(source) as TreeNode<null>;
      const move = (): void =>
        tree.move(dirAt(model, srcParent), srcName, dirAt(model, parent), op.name);
      if (model.isDir(node) && (parent === source || parent.startsWith(`${source}/`))) {
        expect(codeOf(move)).toBe('INVALID');
      } else if (target === source) {
        move(); // no-op
      } else if (model.nodes.has(target)) {
        expect(codeOf(move)).toBe('DUPLICATE');
      } else {
        move();
        for (const [p, n] of [...model.nodes]) {
          if (p === source || p.startsWith(`${source}/`)) {
            model.nodes.delete(p);
            model.nodes.set(target + p.slice(source.length), n);
          }
        }
      }
      break;
    }
  }
}

describe.runIf(IMPLEMENTED)('dsa/tree properties (S1)', () => {
  it(
    'DSA-TREE-01 random mkdir, create, link, unlink, rmdir and mv sequences match a path-set model and keep invariants T1–T6',
    () => {
      fc.assert(
        fc.property(fc.array(treeOp, { size: 'max', maxLength: 120 }), (ops) => {
          const tree = createTree<null>('root', null);
          const model = new Model(tree.root);
          for (const op of ops) {
            step(tree, model, op);
            tree.checkInvariants();
            expect(walked(tree)).toEqual(model.nodes);
            expect(tree.size).toBe(model.distinct());
          }
        }),
        PROP,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'DSA-TREE-02 random attempts to move an ancestor under a descendant are always rejected',
    () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ parent: index, name }), {
            size: 'max',
            minLength: 1,
            maxLength: 60,
          }),
          index,
          index,
          (mkdirs, aPick, dPick) => {
            const tree = createTree<null>('root', null);
            const model = new Model(tree.root);
            for (const m of mkdirs)
              step(tree, model, { kind: 'mkdir', parent: m.parent, name: m.name });
            const dirs = model.dirs().filter((p) => p !== '');
            if (dirs.length === 0) return;
            const a = dirs[aPick % dirs.length] ?? '';
            const below = model.dirs().filter((p) => p === a || p.startsWith(`${a}/`));
            const d = below[dPick % below.length] ?? a;
            const [aParent, aName] = splitPath(a);
            const before = walked(tree);
            expect(
              codeOf(() => tree.move(dirAt(model, aParent), aName, dirAt(model, d), 'x')),
            ).toBe('INVALID');
            expect(walked(tree)).toEqual(before);
            tree.checkInvariants();
          },
        ),
        PROP,
      );
    },
    TIMEOUT_MS,
  );

  // Added with the implementation (R2): a differential test of the T5 name check against the
  // platform's UTF-8 encoder, including surrogate pairs and lone surrogates (encoded as U+FFFD).
  it(
    "DSA-TREE-01 attach accepts a name exactly when it is 1–255 UTF-8 bytes without '/' or NUL and not '.' or '..'",
    () => {
      const encoder = new TextEncoder();
      const piece = fc.constantFrom(
        'a',
        '.',
        '/',
        '\u0000',
        'é',
        '€',
        '\u{1F600}',
        '\uD800',
        '\uDC00',
      );
      const candidates = fc.oneof(
        fc.string({ unit: piece, maxLength: 130 }),
        fc.string({ unit: 'binary', maxLength: 100 }),
        fc.constantFrom('', '.', '..', '...', 'a'.repeat(255), 'a'.repeat(256)),
      );
      fc.assert(
        fc.property(candidates, (candidate) => {
          const bytes = encoder.encode(candidate).length;
          const valid =
            bytes >= 1 &&
            bytes <= 255 &&
            candidate !== '.' &&
            candidate !== '..' &&
            !candidate.includes('/') &&
            !candidate.includes('\u0000');
          const tree = createTree<null>('root', null);
          expect(codeOf(() => tree.attach(tree.root, candidate, newFile()))).toBe(
            valid ? undefined : 'INVALID',
          );
          expect(tree.size).toBe(valid ? 2 : 1);
        }),
        PROP,
      );
    },
    TIMEOUT_MS,
  );
});
