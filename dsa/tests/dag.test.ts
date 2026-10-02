/**
 * S4 DAG + Kahn: edge cases (specs/08-dsa/data-structures.md §8.5). Gated on IMPLEMENTED (C16).
 */
import { DEFAULT_SERVICE_MANIFESTS } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { DsaError } from '../src/_shared/errors.ts';
import {
  buildDag,
  CycleError,
  IMPLEMENTED,
  topoLevels,
  UnknownNodeError,
} from '../src/dag/index.ts';
import type { Dag, DagNode } from '../src/dag/index.ts';
import { expectDsaError } from './helpers.ts';

const node = (name: string, ...requires: string[]): DagNode => ({ name, requires });

/** Levels as names. */
function levelNames(dag: Dag): string[][] {
  return dag.levels().map((level) => level.map((v) => dag.name(v)));
}

/** Run buildDag and return the CycleError it throws. */
function cycleOf(nodes: readonly DagNode[]): readonly string[] {
  let thrown: unknown;
  try {
    buildDag(nodes);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CycleError);
  const error = thrown as CycleError;
  expect(error.code).toBe('CYCLE');
  expect(error.message).toBe(error.path.join(' → '));
  return error.path;
}

const byIndex = (a: number, b: number): number => a - b;

const DIAMOND = [node('a'), node('b', 'a'), node('c', 'a'), node('d', 'b', 'c')];

describe.runIf(IMPLEMENTED)('dsa/dag (S4)', () => {
  it('DSA-DAG-01 an empty graph has no order and no levels', () => {
    const dag = buildDag([]);
    expect(dag.size).toBe(0);
    expect(dag.edges).toBe(0);
    expect(dag.topoOrder()).toEqual([]);
    expect(dag.levels()).toEqual([]);
    expect(dag.cursor().initial()).toEqual([]);
    expect(dag.cursor().remaining).toBe(0);
    expect(dag.indexOf('a')).toBeUndefined();
    dag.checkInvariants();
  });

  it('DSA-DAG-01 a single node is level 0', () => {
    const dag = buildDag([node('kernel')]);
    expect(dag.size).toBe(1);
    expect(dag.indexOf('kernel')).toBe(0);
    expect(dag.name(0)).toBe('kernel');
    expect(dag.levelOf(0)).toBe(0);
    expect(dag.levels()).toEqual([[0]]);
    expect(dag.topoOrder()).toEqual([0]);
    expect([...dag.requires(0)]).toEqual([]);
    expect([...dag.dependents(0)]).toEqual([]);
    dag.checkInvariants();
  });

  it('DSA-DAG-01 a diamond gives levels [[a],[b,c],[d]]', () => {
    const dag = buildDag(DIAMOND);
    expect(dag.edges).toBe(4);
    expect(levelNames(dag)).toEqual([['a'], ['b', 'c'], ['d']]);
    expect(dag.topoOrder().map((v) => dag.name(v))).toEqual(['a', 'b', 'c', 'd']);
    expect([...dag.requires(3)].map((v) => dag.name(v))).toEqual(['b', 'c']);
    expect([...dag.dependents(0)].map((v) => dag.name(v))).toEqual(['b', 'c']);
    expect(dag.levelOf(3)).toBe(2);
    dag.checkInvariants();
  });

  it('DSA-DAG-01 multiple sources are all level 0 and ties follow input order', () => {
    const dag = buildDag([node('c'), node('a'), node('b'), node('z', 'b', 'c')]);
    expect(levelNames(dag)).toEqual([['c', 'a', 'b'], ['z']]);
    expect(dag.topoOrder().map((v) => dag.name(v))).toEqual(['c', 'a', 'b', 'z']);
    expect(dag.cursor().initial()).toEqual([0, 1, 2]);
  });

  it('DSA-DAG-01 a duplicate node name or duplicate edge throws DUPLICATE', () => {
    expectDsaError(() => buildDag([node('a'), node('a')]), 'DUPLICATE');
    expectDsaError(() => buildDag([node('a'), node('b', 'a', 'a')]), 'DUPLICATE');
  });

  it('DSA-DAG-01 an unknown requirement throws UnknownNodeError naming both nodes', () => {
    let thrown: unknown;
    try {
      buildDag([node('a'), node('b', 'a', 'ghost')]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnknownNodeError);
    const error = thrown as UnknownNodeError;
    expect(error.code).toBe('NOT_FOUND');
    expect(error.node).toBe('b');
    expect(error.missing).toBe('ghost');
    expect(error.message).toContain('b');
    expect(error.message).toContain('ghost');
  });

  it('BOOT-04 a self-loop is reported as the cycle a → a', () => {
    const path = cycleOf([node('x'), node('a', 'a')]);
    expect(path).toEqual(['a', 'a']);
  });

  it('BOOT-04 a 2-cycle and a 3-cycle are reported with real edges, rotated to the smallest name and closed', () => {
    expect(cycleOf([node('b', 'a'), node('a', 'b')])).toEqual(['a', 'b', 'a']);
    // Dependency direction: a → b → c → a means b requires a, c requires b and a requires c.
    const three = [node('c', 'b'), node('b', 'a'), node('a', 'c'), node('root')];
    expect(cycleOf(three)).toEqual(['a', 'b', 'c', 'a']);
  });

  it('DSA-DAG-02 a cycle reached through a tail reports only the cycle, not the tail', () => {
    // 'a' is the smallest remaining name but only depends on the cycle x ⇄ y.
    const nodes = [node('a', 'x'), node('x', 'y'), node('y', 'x'), node('ok')];
    expect(cycleOf(nodes)).toEqual(['x', 'y', 'x']);
  });

  it('DSA-DAG-02 two disjoint cycles report the same one on every run', () => {
    const nodes = [node('d', 'c'), node('c', 'd'), node('b', 'a'), node('a', 'b')];
    const first = cycleOf(nodes);
    expect(first).toEqual(['a', 'b', 'a']);
    expect(cycleOf(nodes)).toEqual(first);
    expect(cycleOf([...nodes].reverse())).toEqual(first);
  });

  it('DSA-DAG-01 a 10^5-node chain and 10^5 independent nodes build without recursion', () => {
    const n = 100_000;
    const chain = Array.from({ length: n }, (_, i) =>
      i === 0 ? node('n0') : node(`n${i}`, `n${i - 1}`),
    );
    const dag = buildDag(chain);
    expect(dag.edges).toBe(n - 1);
    expect(dag.levels()).toHaveLength(n);
    expect(dag.levelOf(n - 1)).toBe(n - 1);
    expect(dag.topoOrder()[n - 1]).toBe(n - 1);
    const all = dag.ancestors([n - 1]);
    expect(all.reduce((sum, bit) => sum + bit, 0)).toBe(n);
    dag.checkInvariants();

    const flat = buildDag(Array.from({ length: n }, (_, i) => node(`m${i}`)));
    expect(flat.levels()).toHaveLength(1);
    expect(flat.levels()[0]).toHaveLength(n);

    // A cycle at the far end of a long chain is found without recursion as well.
    const looped = [
      ...chain.slice(0, n - 1),
      node(`n${n - 1}`, `n${n - 2}`),
      node('n0x', `n${n - 1}`),
    ];
    looped[0] = node('n0', 'n0x');
    const path = cycleOf(looped);
    expect(path[0]).toBe(path[path.length - 1]);
    expect(path.length).toBe(n + 2);
  });

  it('DSA-DAG-03 the cursor rejects completing a node twice or a node that is not ready', () => {
    const dag = buildDag(DIAMOND);
    const cursor = dag.cursor();
    expect(cursor.remaining).toBe(4);
    expect(cursor.initial()).toEqual([0]);
    expectDsaError(() => cursor.complete(3), 'INVALID'); // d is not ready
    expect(cursor.complete(0)).toEqual([1, 2]);
    expectDsaError(() => cursor.complete(0), 'INVALID'); // twice
    expect(cursor.complete(2)).toEqual([]);
    expect(cursor.complete(1)).toEqual([3]);
    expect(cursor.complete(3)).toEqual([]);
    expect(cursor.remaining).toBe(0);
  });

  it('DSA-DAG-03 ancestors of a source is the source itself', () => {
    const dag = buildDag(DIAMOND);
    expect([...dag.ancestors([0])]).toEqual([1, 0, 0, 0]);
    expect([...dag.ancestors([1])]).toEqual([1, 1, 0, 0]);
    expect([...dag.ancestors([1, 2])]).toEqual([1, 1, 1, 0]);
    expect([...dag.ancestors([])]).toEqual([0, 0, 0, 0]);
  });

  it('DSA-DAG-03 the shipped 18 service manifests have 30 edges, 7 levels and a desktop closure of 9 services with weight 25', () => {
    const dag = buildDag(DEFAULT_SERVICE_MANIFESTS);
    expect(dag.size).toBe(18);
    expect(dag.edges).toBe(30);
    expect(dag.levels()).toHaveLength(7);
    const desktop = dag.indexOf('desktop') as number;
    const closure = dag.ancestors([desktop]);
    const members = DEFAULT_SERVICE_MANIFESTS.filter((_, v) => closure[v] === 1);
    expect(members.map((m) => m.name).sort()).toEqual(
      ['desktop', 'kernel', 'login', 'mm', 'sched', 'session', 'storage', 'vfs', 'wm'].sort(),
    );
    expect(members.reduce((sum, m) => sum + m.weight, 0)).toBe(25);
    dag.checkInvariants();
  });

  it('DSA-DAG-03 reversed topological order stops dependents before their requirements', () => {
    const dag = buildDag(DEFAULT_SERVICE_MANIFESTS);
    const rev = dag.reversed();
    expect(rev.size).toBe(dag.size);
    expect(rev.edges).toBe(dag.edges);
    const order = rev.topoOrder();
    const position = new Map(order.map((v, i) => [v, i]));
    for (let v = 0; v < dag.size; v++) {
      expect(rev.name(v)).toBe(dag.name(v));
      expect([...rev.requires(v)].sort(byIndex)).toEqual([...dag.dependents(v)].sort(byIndex));
      for (const u of dag.requires(v)) {
        // v requires u, so v stops first.
        expect(position.get(v) ?? -1).toBeLessThan(position.get(u) ?? -1);
      }
    }
    expect(rev.name(order[order.length - 1] ?? -1)).toBe('kernel');
    rev.checkInvariants();
  });

  it('DSA-DAG-01 topoLevels groups manifests exactly as levels() groups indices', () => {
    const dag = buildDag(DEFAULT_SERVICE_MANIFESTS);
    const grouped = topoLevels(DEFAULT_SERVICE_MANIFESTS);
    expect(grouped.map((level) => level.map((m) => m.name))).toEqual(levelNames(dag));
    expect(grouped[0]?.[0]).toBe(DEFAULT_SERVICE_MANIFESTS[0]); // the same objects, not copies
    let thrown: unknown;
    try {
      topoLevels([node('a', 'b'), node('b', 'a')]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CycleError);
  });

  it('DSA-DAG-01 name of an index outside 0..V−1 throws RANGE and errors are DsaErrors', () => {
    const dag = buildDag(DIAMOND);
    expectDsaError(() => dag.name(4), 'RANGE');
    expect(new CycleError(['a', 'a'])).toBeInstanceOf(DsaError);
    expect(new UnknownNodeError('a', 'b')).toBeInstanceOf(DsaError);
  });
});
