/**
 * S4 DAG + Kahn benchmarks (specs/08-dsa/data-structures.md §7, §8.5). Gated on IMPLEMENTED.
 * Workload: random layered DAGs with E = 5V (seed 42). Shape (§7.2): build + Kahn + levels time
 * per (V + E) grows at most 2× from 10^3 to 10^5; app closure ≤ 1 ms at 32 nodes.
 */
import { DEFAULT_SERVICE_MANIFESTS } from '@plotinium/protocol';
import { describe, it } from 'vitest';

import { measureBytesPerEntry } from '../src/_shared/mem.ts';
import { mulberry32 } from '../src/_shared/prng.ts';
import { buildDag, IMPLEMENTED } from '../src/dag/index.ts';
import type { DagNode } from '../src/dag/index.ts';
import { measureCurve, record, recordMemory, SEED, SIZES } from './harness.ts';

const EDGES_PER_NODE = 5;

/** A layered DAG of v nodes: each node requires 5 distinct nodes from earlier layers. */
function layeredDag(v: number): DagNode[] {
  const rand = mulberry32(SEED);
  const layer = Math.max(8, Math.floor(Math.sqrt(v)));
  const nodes: DagNode[] = [];
  for (let i = 0; i < v; i++) {
    const firstOfLayer = i - (i % layer);
    const requires = new Set<string>();
    if (firstOfLayer >= EDGES_PER_NODE) {
      while (requires.size < EDGES_PER_NODE) requires.add(`n${Math.floor(rand() * firstOfLayer)}`);
    }
    nodes.push({ name: `n${i}`, requires: [...requires] });
  }
  return nodes;
}

describe.runIf(IMPLEMENTED)('dsa/dag benchmarks (S4)', () => {
  it('DSA-DAG-01 build + Kahn time per (V + E) is flat from 10^3 to 10^5', async ({
    bench,
    expect,
  }) => {
    const graphs = new Map<number, DagNode[]>();
    const graph = (v: number): DagNode[] => {
      const cached = graphs.get(v) ?? layeredDag(v);
      graphs.set(v, cached);
      return cached;
    };
    const curve = await measureCurve(bench, {
      structure: 'dag',
      op: 'build+kahn+levels',
      // One call builds the whole graph: report ns per (V + E).
      batch: (v) => v + graph(v).reduce((sum, n) => sum + n.requires.length, 0),
      shape: { expected: 'O(V+E)', limit: 2 },
      setup: (v) => {
        const nodes = graph(v);
        return () => {
          buildDag(nodes).levels();
        };
      },
    });
    expect(curve.ratio).toBeLessThanOrEqual(2);
  });

  it('DSA-DAG-03 app closure resolution is at most 1 ms at 32 nodes', async ({ bench }) => {
    const curve = await measureCurve(bench, {
      structure: 'dag',
      op: 'app closure (build + ancestors + levels)',
      sizes: [8, 32, 128],
      batch: 1,
      setup: (v) => {
        const nodes = layeredDag(v);
        const target = [v - 1];
        return () => {
          const dag = buildDag(nodes);
          dag.ancestors(target);
          dag.levels();
        };
      },
    });
    const at32 = curve.timings.find((t) => t.n === 32);
    // Absolute targets warn off the lab machine (§7.2): recorded, not asserted.
    if (at32 !== undefined) {
      record({
        structure: 'dag',
        op: 'app closure budget',
        timing: at32,
        budget: {
          metric: 'p95 ns at 32 nodes',
          limit: 1e6,
          value: at32.p95Ns,
          pass: at32.p95Ns <= 1e6,
          hard: false,
        },
      });
    }
  });

  it('BOOT-03 the 18 shipped service manifests build, sort and level within 50 µs', async ({
    bench,
  }) => {
    const curve = await measureCurve(bench, {
      structure: 'dag',
      op: 'boot DAG (18 services)',
      sizes: [DEFAULT_SERVICE_MANIFESTS.length],
      batch: 1,
      setup: () => () => {
        buildDag(DEFAULT_SERVICE_MANIFESTS).levels();
      },
    });
    const t = curve.timings[0];
    if (t !== undefined) {
      record({
        structure: 'dag',
        op: 'boot DAG budget',
        timing: t,
        budget: {
          metric: 'mean ns for 18 services',
          limit: 50_000,
          value: t.meanNs,
          pass: t.meanNs <= 50_000,
          hard: false,
        },
      });
    }
  });

  it('DSA-GEN-09 dag bytes per node at 10^3, 10^4 and 10^5 are recorded', ({ expect }) => {
    for (const v of SIZES) {
      const nodes = layeredDag(v);
      const e = nodes.reduce((sum, n) => sum + n.requires.length, 0);
      // Measured with levels() and topoOrder() materialised: the whole footprint a consumer keeps.
      const { value: dag, bytesPerEntryMeasured } = measureBytesPerEntry(v, () => {
        const built = buildDag(nodes);
        built.levels();
        built.topoOrder();
        return built;
      });
      const rec = recordMemory('dag', v, bytesPerEntryMeasured, dag.stats());
      // §3.5 layout, exactly sized: inStart and outStart (V + 1 each), indeg, level and order (V
      // each) and inFrom and outTo (E each), all Int32.
      expect(rec.bytesPerEntryAllocated).toBe((4 * (5 * v + 2 + 2 * e)) / v);
    }
  });
});
