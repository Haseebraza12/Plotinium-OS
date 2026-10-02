/**
 * The dsa/dag branch of planLevels, exercised with a small TEST-ONLY double of `buildDag`
 * (C16: the real structure is the team's; production code never implements it).
 */
import { describe, expect, it, vi } from 'vitest';

import type * as Dsa from '@plotinium/dsa';

vi.mock('@plotinium/dsa', async (importOriginal) => {
  const real = await importOriginal<typeof Dsa>();
  interface N {
    name: string;
    requires: readonly string[];
  }
  const buildDag = (nodes: readonly N[]) => {
    const names = nodes.map((n) => n.name);
    const self = nodes.find((n) => n.requires.includes(n.name));
    if (self) throw new real.CycleError([self.name, self.name]);
    const level = new Map<string, number>();
    const visit = (n: N, depth: number): number => {
      if (depth > nodes.length) throw new real.CycleError(['a', 'b', 'a']);
      const known = level.get(n.name);
      if (known !== undefined) return known;
      const l = n.requires.reduce(
        (m, r) => Math.max(m, visit(nodes.find((x) => x.name === r) ?? n, depth + 1) + 1),
        0,
      );
      level.set(n.name, l);
      return l;
    };
    for (const n of nodes) visit(n, 0);
    const order = [...names].sort(
      (a, b) => (level.get(a) ?? 0) - (level.get(b) ?? 0) || names.indexOf(a) - names.indexOf(b),
    );
    const max = Math.max(...level.values());
    return {
      edges: nodes.reduce((e, n) => e + n.requires.length, 0),
      topoOrder: () => order.map((n) => names.indexOf(n)),
      name: (v: number) => names[v] ?? '',
      indexOf: (n: string) => names.indexOf(n),
      levelOf: (v: number) => level.get(names[v] ?? '') ?? 0,
      levels: () =>
        Array.from({ length: max + 1 }, (_, l) =>
          order.filter((n) => level.get(n) === l).map((n) => names.indexOf(n)),
        ),
    };
  };
  return { ...real, buildDag };
});

const { DependencyCycle, planLevels } = await import('../src/levels.ts');

describe('planLevels with dsa/dag', () => {
  it('BOOT-03 uses the structure for order and levels when it is implemented', () => {
    const plan = planLevels(
      [
        { name: 'kernel', requires: [] },
        { name: 'a', requires: ['kernel'] },
        { name: 'b', requires: ['a', 'kernel'] },
      ] as never,
      true,
    );
    expect(plan.source).toBe('dsa/dag');
    expect(plan.order).toEqual(['kernel', 'a', 'b']);
    expect(plan.levels).toEqual([['kernel'], ['a'], ['b']]);
    expect(plan.levelOf.get('b')).toBe(2);
    expect(plan.edges).toBe(3);
  });

  it('BOOT-04 a CycleError from the structure becomes an exact DependencyCycle', () => {
    expect(() => planLevels([{ name: 'a', requires: ['a'] }] as never, true)).toThrow(
      DependencyCycle,
    );
    try {
      planLevels([{ name: 'a', requires: ['a'] }] as never, true);
    } catch (e) {
      expect((e as InstanceType<typeof DependencyCycle>).exact).toBe(true);
      expect((e as Error).message).toBe('dependency cycle detected: a → a');
    }
  });
});
