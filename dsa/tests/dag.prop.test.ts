/**
 * S4 DAG + Kahn: property tests (specs/08-dsa/data-structures.md §8.5). Random DAGs are generated
 * in a hidden generation order (every node requires only earlier nodes) and then shuffled, so the
 * brute-force oracle can compute longest paths in generation order. Gated on IMPLEMENTED (C16).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../src/_shared/prng.ts';
import { buildDag, CycleError, IMPLEMENTED } from '../src/dag/index.ts';
import type { DagNode } from '../src/dag/index.ts';
import { PROP } from './helpers.ts';

interface RandomDag {
  /** Requirements by generation index (each < its node's index). */
  readonly reqs: readonly (readonly number[])[];
  /** The input, shuffled. */
  readonly nodes: readonly DagNode[];
}

function makeDag(n: number, seed: number, maxRequires: number): RandomDag {
  const rand = mulberry32(seed);
  const reqs: number[][] = [];
  for (let g = 0; g < n; g++) {
    const set = new Set<number>();
    const k = g === 0 ? 0 : Math.floor(rand() * (maxRequires + 1));
    for (let t = 0; t < k; t++) set.add(Math.floor(rand() * g));
    reqs.push([...set]);
  }
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j] ?? 0, perm[i] ?? 0];
  }
  const nodes = perm.map((g) => ({ name: `s${g}`, requires: (reqs[g] ?? []).map((r) => `s${r}`) }));
  return { reqs, nodes };
}

const randomDag = fc
  .record({
    n: fc.integer({ min: 1, max: 500 }),
    seed: fc.integer(),
    maxRequires: fc.integer({ min: 0, max: 4 }),
  })
  .map(({ n, seed, maxRequires }) => makeDag(n, seed, maxRequires));

/** Longest path from a source, by relaxation in generation order (test oracle). */
function bruteLevels(reqs: readonly (readonly number[])[]): number[] {
  const level: number[] = [];
  reqs.forEach((rs, g) => {
    level[g] = rs.reduce((max, r) => Math.max(max, (level[r] ?? 0) + 1), 0);
  });
  return level;
}

describe.runIf(IMPLEMENTED)('dsa/dag properties (S4)', () => {
  it('DSA-DAG-01 random DAGs (500 nodes) give a topological order that respects every edge and levels equal to brute-force longest paths', () => {
    fc.assert(
      fc.property(randomDag, ({ reqs, nodes }) => {
        const dag = buildDag(nodes);
        dag.checkInvariants();
        expect(dag.size).toBe(nodes.length);
        expect(dag.edges).toBe(reqs.reduce((sum, rs) => sum + rs.length, 0));
        const order = dag.topoOrder();
        expect([...order].sort((a, b) => a - b)).toEqual(
          Array.from({ length: dag.size }, (_, i) => i),
        );
        const position = new Int32Array(dag.size);
        order.forEach((v, i) => (position[v] = i));
        const backwards: Array<[number, number]> = [];
        for (let v = 0; v < dag.size; v++) {
          for (const u of dag.requires(v))
            if ((position[u] ?? 0) >= (position[v] ?? 0)) backwards.push([u, v]);
        }
        expect(backwards).toEqual([]);
        const expected = bruteLevels(reqs);
        expect(expected.map((_, g) => dag.levelOf(dag.indexOf(`s${g}`) ?? -1))).toEqual(expected);
        // levels() groups every node by levelOf, each level by increasing index.
        const grouped: number[][] = Array.from({ length: Math.max(...expected) + 1 }, () => []);
        for (let v = 0; v < dag.size; v++) grouped[dag.levelOf(v)]?.push(v);
        expect(dag.levels().map((members) => [...members])).toEqual(grouped);
      }),
      PROP,
    );
  });

  it('DSA-DAG-03 completing nodes in random ready order yields each node once and never before its requirements', () => {
    fc.assert(
      fc.property(randomDag, fc.integer(), ({ nodes }, pickSeed) => {
        const dag = buildDag(nodes);
        const pick = mulberry32(pickSeed);
        const cursor = dag.cursor();
        const ready = cursor.initial();
        const done = new Uint8Array(dag.size);
        let completed = 0;
        while (ready.length > 0) {
          const i = Math.floor(pick() * ready.length);
          const v = ready[i] ?? -1;
          ready.splice(i, 1);
          if (done[v] !== 0 || [...dag.requires(v)].some((u) => done[u] !== 1)) {
            expect.unreachable(`node ${v} became ready before its requirements or twice`);
          }
          ready.push(...cursor.complete(v));
          done[v] = 1;
          completed++;
        }
        expect(completed).toBe(dag.size);
        expect(cursor.remaining).toBe(0);
      }),
      PROP,
    );
  });

  it('BOOT-04 adding a random back edge always raises CycleError whose consecutive pairs are real edges', () => {
    fc.assert(
      fc.property(randomDag, fc.nat(), fc.nat(), ({ reqs, nodes }, gPick, aPick) => {
        const g = gPick % reqs.length;
        // Every proper ancestor a of g, found by a DFS over the requirements.
        const ancestors: number[] = [];
        const seen = new Set<number>();
        const stack = [...(reqs[g] ?? [])];
        while (stack.length > 0) {
          const a = stack.pop() as number;
          if (seen.has(a)) continue;
          seen.add(a);
          ancestors.push(a);
          stack.push(...(reqs[a] ?? []));
        }
        // a requires g closes the cycle a → … → g → a; with no ancestor it is the self-loop g → g.
        const a = ancestors.length === 0 ? g : (ancestors[aPick % ancestors.length] ?? g);
        const cyclic = nodes.map((n) =>
          n.name === `s${a}` ? { name: n.name, requires: [...n.requires, `s${g}`] } : n,
        );
        const requires = new Map(cyclic.map((n) => [n.name, new Set(n.requires)]));
        let thrown: unknown;
        try {
          buildDag(cyclic);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(CycleError);
        const path = (thrown as CycleError).path;
        expect(path.length).toBeGreaterThanOrEqual(2);
        expect(path[0]).toBe(path[path.length - 1]);
        expect(path[0]).toBe([...path].sort()[0]);
        expect(new Set(path).size).toBe(path.length - 1);
        for (let i = 0; i + 1 < path.length; i++) {
          expect(requires.get(path[i + 1] ?? '')?.has(path[i] ?? '')).toBe(true);
        }
      }),
      PROP,
    );
  });
});
