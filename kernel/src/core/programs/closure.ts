/**
 * Application start-up dependencies (processes-and-scheduling.md §3.6 rule 2, KPS-07; Spec §10.1
 * DAG row): `spawn` builds the closure of a manifest's `requires` over the program catalog with
 * `dsa/dag` (Kahn's algorithm, O(V + E)) and starts it in topological order.
 *
 * - `lib:<name>` requirements are manifests (kind `lib`) of the same catalog; their own `requires`
 *   are followed. A missing non-optional lib is ENOENT; an optional one (`lib:x?`) is skipped.
 * - `svc:<name>` requirements are leaves: the service must be up when the program starts.
 * - A cycle fails with EINVAL `dependency-cycle` and `detail.cycle`, the path extracted by
 *   dsa/dag (closed, starting at its smallest name), for example `['editor', 'spell', 'editor']`.
 *
 * The resolved order is cached per (catalog version, name).
 */
import type { AppManifest } from '@plotinium/protocol';
import { parseDepRef } from '@plotinium/protocol';
import { buildDag, CycleError } from '@plotinium/dsa/dag';

import { KernelError } from '../errors.ts';
import type { ProgramCatalog } from './catalog.ts';

export interface StartupPlan {
  /** The program being spawned. */
  readonly manifest: AppManifest;
  /** Lib manifests to load first, dependencies before dependents. */
  readonly libs: readonly AppManifest[];
  /** Services the closure needs; `optional` ones may be down. */
  readonly services: readonly { readonly name: string; readonly optional: boolean }[];
  /** Topological order of every node (`app`, then libs by name), for diagnostics and tests. */
  readonly order: readonly string[];
}

interface Node {
  readonly name: string;
  readonly requires: readonly string[];
}

const LIB = 'lib:';

/** Closure of `name` (KPS-07). Throws KernelError ENOENT, EINVAL `bad-manifest` or `dependency-cycle`. */
export function startupClosure(catalog: ProgramCatalog, name: string): StartupPlan {
  const root = catalog.manifest(name);
  if (root === undefined) throw new KernelError('ENOENT', undefined, `no manifest for ${name}`);
  const nodes = new Map<string, Node>();
  const manifests = new Map<string, AppManifest>();
  const services = new Map<string, boolean>();
  const stack: AppManifest[] = [root];
  manifests.set(root.name, root);
  while (stack.length > 0) {
    const m = stack.pop();
    /* v8 ignore next -- the loop condition guarantees an element */
    if (m === undefined) break;
    const requires: string[] = [];
    for (const ref of m.requires) {
      const dep = parseDepRef(ref);
      if (dep === undefined)
        throw new KernelError(
          'EINVAL',
          { reason: 'bad-manifest' },
          `${m.name}: bad requirement ${ref}`,
        );
      if (dep.kind === 'svc') {
        services.set(dep.name, (services.get(dep.name) ?? true) && dep.optional);
        continue;
      }
      const lib = catalog.manifest(dep.name);
      if (lib === undefined) {
        if (dep.optional) continue;
        throw new KernelError('ENOENT', undefined, `${m.name} requires missing lib ${dep.name}`);
      }
      requires.push(`${LIB}${lib.name}`);
      if (!manifests.has(lib.name)) {
        manifests.set(lib.name, lib);
        stack.push(lib);
      }
    }
    const key = m === root ? m.name : `${LIB}${m.name}`;
    nodes.set(key, { name: key, requires });
  }
  // Every node key: the app itself by name, libs as `lib:<name>` (an app may share a lib's name).
  const list = [...nodes.values()];
  let order: readonly number[];
  let dag;
  try {
    dag = buildDag(list);
    order = dag.topoOrder();
  } catch (e) {
    if (e instanceof CycleError) {
      const cycle = e.path.map((n) => (n.startsWith(LIB) ? n.slice(LIB.length) : n)).slice(0, 64);
      throw new KernelError(
        'EINVAL',
        { reason: 'dependency-cycle', cycle: cycle.map((c) => c.slice(0, 64)) },
        `dependency cycle: ${cycle.join(' → ')}`.slice(0, 256),
      );
    }
    throw e;
  }
  const names = order.map((v) => dag.name(v));
  const libs = names
    .filter((n) => n.startsWith(LIB))
    .map((n) => manifests.get(n.slice(LIB.length)))
    .filter((m): m is AppManifest => m !== undefined);
  return {
    manifest: root,
    libs,
    services: [...services].map(([svc, optional]) => ({ name: svc, optional })),
    order: names,
  };
}

/** `startupClosure` with a cache keyed by the catalog version (§3.6 rule 2). */
export class ClosureCache {
  private version = -1;
  private readonly plans = new Map<string, StartupPlan>();
  private readonly catalog: ProgramCatalog;

  constructor(catalog: ProgramCatalog) {
    this.catalog = catalog;
  }

  get(name: string): StartupPlan {
    if (this.catalog.version !== this.version) {
      this.plans.clear();
      this.version = this.catalog.version;
    }
    const hit = this.plans.get(name);
    if (hit !== undefined) return hit;
    const plan = startupClosure(this.catalog, name);
    this.plans.set(name, plan);
    return plan;
  }
}
