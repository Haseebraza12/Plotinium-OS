/**
 * Boot DAG: topological order, levels and cycle detection (boot-and-services.md §5.1 and §5.4;
 * BOOT-03, BOOT-04, V10).
 *
 * The algorithm is `dsa/dag` (Kahn, owner R5, C16). While DAG_IMPLEMENTED is false the service
 * manager uses the FALLBACK below, which is deliberately not Kahn: it assigns each service the
 * level 1 + max(level of its requirements) by repeated relaxation over the manifest list
 * (O(V·E)), orders by (level, manifest order), and reports a cycle only as the set of services
 * whose level never settles. Every boot on the fallback logs
 * `WARN dsa/dag not implemented — using fallback order`.
 * TODO(dsa/dag): delete fallbackPlan once DAG_IMPLEMENTED is true.
 */
import { buildDag, CycleError, DAG_IMPLEMENTED } from '@plotinium/dsa';

import type { ServiceManifest, ServiceName } from './types.ts';

export const FALLBACK_WARNING = 'dsa/dag not implemented — using fallback order';

export interface DagPlan {
  /** Start order: every requirement before its dependents. */
  readonly order: readonly ServiceName[];
  readonly levelOf: ReadonlyMap<ServiceName, number>;
  readonly levels: readonly (readonly ServiceName[])[];
  readonly edges: number;
  readonly source: 'dsa/dag' | 'fallback';
}

export class DependencyCycle extends Error {
  /** Closed path in dependency direction (`dsa/dag`), or the unsettled services (fallback). */
  readonly cycle: readonly ServiceName[];
  readonly exact: boolean;

  constructor(cycle: readonly ServiceName[], exact: boolean) {
    super(
      exact
        ? `dependency cycle detected: ${cycle.join(' → ')}`
        : `dependency cycle detected among: ${cycle.join(', ')} (path needs dsa/dag)`,
    );
    this.name = 'DependencyCycle';
    this.cycle = cycle;
    this.exact = exact;
  }
}

function countEdges(manifests: readonly ServiceManifest[]): number {
  return manifests.reduce((n, m) => n + m.requires.length, 0);
}

function groupLevels(
  order: readonly ServiceName[],
  levelOf: ReadonlyMap<ServiceName, number>,
): ServiceName[][] {
  const levels: ServiceName[][] = [];
  for (const name of order) {
    const l = levelOf.get(name) ?? 0;
    (levels[l] ??= []).push(name);
  }
  return levels;
}

function dagPlan(manifests: readonly ServiceManifest[]): DagPlan {
  try {
    const dag = buildDag(manifests.map((m) => ({ name: m.name, requires: m.requires })));
    const order = dag.topoOrder().map((v) => dag.name(v));
    const levelOf = new Map(
      order.map((name) => [name, dag.levelOf(dag.indexOf(name) ?? 0)] as const),
    );
    const levels = dag.levels().map((level) => level.map((v) => dag.name(v)));
    return { order, levelOf, levels, edges: dag.edges, source: 'dsa/dag' };
  } catch (e) {
    if (e instanceof CycleError) throw new DependencyCycle(e.path, true);
    throw e;
  }
}

/** FALLBACK (see the module comment). Assumes V1–V9 passed (every requirement exists). */
export function fallbackPlan(manifests: readonly ServiceManifest[]): DagPlan {
  const level = new Map<ServiceName, number>(manifests.map((m) => [m.name, 0]));
  let changed = true;
  for (let pass = 0; pass <= manifests.length && changed; pass++) {
    changed = false;
    for (const m of manifests) {
      const l = m.requires.reduce((max, dep) => Math.max(max, (level.get(dep) ?? 0) + 1), 0);
      if (l !== level.get(m.name)) {
        level.set(m.name, l);
        changed = true;
      }
    }
  }
  if (changed) {
    // Any level at or above V cannot be a longest path in an acyclic graph.
    const unsettled = manifests
      .filter((m) => (level.get(m.name) ?? 0) >= manifests.length)
      .map((m) => m.name);
    throw new DependencyCycle([...unsettled].sort(), false);
  }
  const index = new Map(manifests.map((m, i) => [m.name, i] as const));
  const order = manifests
    .map((m) => m.name)
    .sort(
      (a, b) =>
        (level.get(a) ?? 0) - (level.get(b) ?? 0) || (index.get(a) ?? 0) - (index.get(b) ?? 0),
    );
  return {
    order,
    levelOf: level,
    levels: groupLevels(order, level),
    edges: countEdges(manifests),
    source: 'fallback',
  };
}

/** Throws `DependencyCycle` (V10). */
export function planLevels(
  manifests: readonly ServiceManifest[],
  useDag: boolean = DAG_IMPLEMENTED,
): DagPlan {
  return useDag ? dagPlan(manifests) : fallbackPlan(manifests);
}

export { ancestorClosure } from './closure.ts';
