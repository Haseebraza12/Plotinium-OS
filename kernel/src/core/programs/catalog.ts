/**
 * The program catalog: the kernel-side half of the PROGRAM REGISTRY (processes-and-scheduling.md
 * §3.6, §4.4; boot-and-services.md §3.12).
 *
 * The kernel may not import apps (architecture.md §3.7, tools/eslint-rules/boundaries.js), so the
 * registry is INJECTED by the host that composes the OS:
 *
 *   - kernel side (this file): `ProgramCatalog`, the `/bin/<name>.json` manifests as data. The
 *     kernel worker receives it through `createKernel({ programs })` (web builds it from the apps'
 *     manifest lists, for example `DEMO_MANIFESTS` and the coreutils/shell/app manifests). `spawn`
 *     resolves a manifest path through it and sends `manifest.entry` to the executor.
 *   - executor side (runtime/sys.ts `ProgramLoaders`): `entry` → `() => import(...)`, passed by
 *     the host's executor bundle to `startExecutor({ loaders })`, so program code is imported only
 *     inside a sandboxed executor.
 *
 * Every manifest is validated with protocol's `AppManifestSchema`; an invalid one is refused at
 * registration (and would be EINVAL `bad-manifest` at spawn).
 */
import type { AppManifest, AppManifestInput } from '@plotinium/protocol';
import { AppManifestSchema } from '@plotinium/protocol';

import { safeParse } from '../ipc/parse.ts';

/** The manifest directory the catalog serves (`$PATH` default). */
export const BIN_DIR = '/bin';

export interface ProgramCatalog {
  /** The manifest named `name` (the file `/bin/<name>.json`), or undefined. */
  manifest(name: string): AppManifest | undefined;
  /** Every manifest name, sorted. */
  names(): string[];
  /** Bumps whenever the manifest set changes (the closure cache key, §3.6 rule 2). */
  readonly version: number;
}

/**
 * The manifest name a spawn path refers to: `/bin/ls.json`, `/bin/ls` or `ls` → `ls`. Paths
 * outside `/bin` (or its `lib/` subdirectory) are not manifests of this catalog: null.
 */
export function manifestNameOf(path: string): string | null {
  let p = path.trim();
  if (p.endsWith('.json')) p = p.slice(0, -'.json'.length);
  if (!p.includes('/')) return /^[a-z][a-z0-9.-]{0,31}$/.test(p) ? p : null;
  const m = /^\/bin\/(?:lib\/)?([a-z][a-z0-9.-]{0,31})$/.exec(p.replace(/\/+/g, '/'));
  return m?.[1] ?? null;
}

/** The canonical manifest path of a name. */
export function manifestPath(name: string): string {
  return `${BIN_DIR}/${name}.json`;
}

export type ManifestProblem = { readonly name: string; readonly why: string };

/** A catalog over an in-memory set of manifests (the host injects the list). */
export class StaticProgramCatalog implements ProgramCatalog {
  private readonly byName = new Map<string, AppManifest>();
  private ver = 1;
  /** Manifests refused by `add` (logged by the host). */
  readonly problems: ManifestProblem[] = [];

  constructor(manifests: Iterable<AppManifestInput> = []) {
    for (const m of manifests) this.add(m);
  }

  get version(): number {
    return this.ver;
  }

  /** Validate and register one manifest; returns false (and records a problem) if it is invalid. */
  add(input: AppManifestInput): boolean {
    const parsed = safeParse<AppManifest>(AppManifestSchema, input);
    if (!parsed.success) {
      const name = typeof input.name === 'string' ? input.name : '?';
      this.problems.push({ name, why: parsed.issue?.message ?? 'invalid manifest' });
      return false;
    }
    this.byName.set(parsed.output.name, parsed.output);
    this.ver++;
    return true;
  }

  remove(name: string): boolean {
    const had = this.byName.delete(name);
    if (had) this.ver++;
    return had;
  }

  manifest(name: string): AppManifest | undefined {
    return this.byName.get(name);
  }

  names(): string[] {
    return [...this.byName.keys()].sort();
  }
}

/** The empty catalog of a kernel built without programs (every spawn is ENOENT). */
export const EMPTY_CATALOG: ProgramCatalog = new StaticProgramCatalog();
