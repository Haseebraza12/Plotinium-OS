/**
 * Application manifests `/bin/<name>.json` (boot-and-services.md §3.12 and §4.4; syscall-abi.md
 * §3.5).
 *
 * `requires` drives the application start-up DAG resolved by `spawn` with dsa/dag (Spec §10.1 DAG
 * row). `class` and `caps` feed the capability derivation of syscall-abi.md §5.3:
 * `caps(child) = manifest.caps ∩ bounding(uid, class) ∖ dropCaps`.
 *
 * window-manager.md §4.2 and processes-and-scheduling.md §4.4 read further fields (`gui`,
 * `window`, `initialStateBytes`, `heavy`, …) that boot-and-services.md, the owner of this schema,
 * has not adopted yet; they are listed as open in protocol/README.md and are NOT accepted here.
 */
import * as v from 'valibot';

import { Cap, ProcClass } from './caps.ts';

/** `svc:<name>` or `lib:<name>`; a trailing `?` makes the requirement optional. */
export const DepRefSchema = v.pipe(v.string(), v.regex(/^(svc|lib):[a-z][a-z0-9.-]{0,31}\??$/));

export const AppManifestSchema = v.strictObject({
  /** Equals the file name. */
  name: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,31}$/)),
  kind: v.picklist(['app', 'command', 'lib']),
  title: v.optional(v.pipe(v.string(), v.maxLength(64))),
  icon: v.optional(v.pipe(v.string(), v.maxLength(64))),
  /** Executor program module id (app, command). */
  entry: v.optional(v.pipe(v.string(), v.maxLength(128))),
  /** Main-thread view chunk id (app). */
  view: v.optional(v.pipe(v.string(), v.maxLength(128))),
  /** Chunks to load (lib only). */
  chunks: v.optional(v.pipe(v.array(v.pipe(v.string(), v.maxLength(128))), v.maxLength(32))),
  requires: v.pipe(v.array(DepRefSchema), v.maxLength(32)),
  priority: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(39)), 10),
  checkpointable: v.optional(v.boolean(), false),
  // syscall-abi.md §3.5
  class: v.optional(ProcClass, 'user'),
  caps: v.optional(v.pipe(v.array(Cap), v.maxLength(22)), []),
});

export type AppManifestInput = v.InferInput<typeof AppManifestSchema>;
export type AppManifest = v.InferOutput<typeof AppManifestSchema>;

export interface DepRef {
  readonly kind: 'svc' | 'lib';
  readonly name: string;
  readonly optional: boolean;
}

/** Split a dependency reference such as `svc:lockd?` into its parts. */
export function parseDepRef(ref: string): DepRef | undefined {
  const m = /^(svc|lib):([a-z][a-z0-9.-]{0,31})(\?)?$/.exec(ref);
  if (m === null) return undefined;
  return { kind: m[1] === 'svc' ? 'svc' : 'lib', name: m[2] ?? '', optional: m[3] === '?' };
}
