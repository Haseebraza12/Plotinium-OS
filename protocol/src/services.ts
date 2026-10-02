/**
 * Service manifests (boot-and-services.md §3.3 and §4.1; C17; Spec §6.4).
 *
 * The spec's example fields `name, requires, critical, weight, timeoutMs, priority, safeMode` keep
 * their meaning; Plotinium extensions are optional with defaults, so the spec's example manifest
 * validates unchanged (SVC-01). `class` and `caps` are the fields syscall-abi.md §3.5 asks every
 * manifest to declare (optional here, defaults `system` and none); only executor-hosted services
 * make system calls, so only they list capabilities.
 *
 * DEFAULT_SERVICE_MANIFESTS is the built-in set of the 18 services of C17, in boot-level order. It
 * is the reference that services/manifests/*.json (owned by R5) must equal; the SVC-01 test here
 * checks it against the table of boot-and-services.md §3.3, and the DSA-DAG-03 test in dsa/dag
 * checks its shape (30 edges, 7 levels, a desktop closure of 9 services with weight 25).
 */
import * as v from 'valibot';

import { Cap } from './caps.ts';

export const ServiceNameSchema = v.pipe(
  v.string(),
  v.maxLength(32),
  v.regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/),
);
export type ServiceName = v.InferOutput<typeof ServiceNameSchema>;

export const RUNS_IN = [
  'kernel',
  'main',
  'executor',
  'kernel+main',
  'kernel+executor',
  'kernel+blkio',
  'main+sw',
] as const;

export const ServiceManifestSchema = v.strictObject({
  // --- fields of the spec's example manifest (§6.4) ---
  name: ServiceNameSchema,
  requires: v.pipe(v.array(ServiceNameSchema), v.maxLength(16)),
  critical: v.boolean(),
  /** Share of the progress bar. */
  weight: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(60_000)),
  /** 0 highest … 39 lowest. */
  priority: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(39)),
  /** Started in Safe mode. */
  safeMode: v.boolean(),
  // --- Plotinium extensions (optional, defaults applied here) ---
  description: v.optional(v.pipe(v.string(), v.maxLength(120)), ''),
  runsIn: v.optional(v.picklist(RUNS_IN), 'kernel'),
  /** Member of the Recovery-mode set. */
  recovery: v.optional(v.boolean(), false),
  /** May wait for the user; that time is excluded from the timeout. */
  userWait: v.optional(v.boolean(), false),
  onDegradedDependency: v.optional(v.picklist(['wait', 'start-degraded']), 'wait'),
  stopTimeoutMs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(10_000)),
    2000,
  ),
  // --- syscall-abi.md §3.5 (process class and capabilities of executor-hosted services) ---
  class: v.optional(v.literal('system'), 'system'),
  caps: v.optional(v.pipe(v.array(Cap), v.maxLength(22)), []),
});

export type ServiceManifestInput = v.InferInput<typeof ServiceManifestSchema>;
export type ServiceManifest = v.InferOutput<typeof ServiceManifestSchema>;

/** The boot target: its ancestor closure is the progress-bar set A (§5.5). */
export const BOOT_TARGET = 'desktop';

/**
 * The shipped manifests (boot-and-services.md §3.3), as authored in JSON: only the extension
 * fields that differ from the defaults are present.
 */
export const DEFAULT_SERVICE_MANIFEST_INPUTS: readonly ServiceManifestInput[] = [
  {
    name: 'kernel',
    requires: [],
    critical: true,
    weight: 3,
    timeoutMs: 1000,
    priority: 0,
    safeMode: true,
    recovery: true,
  },
  {
    name: 'sched',
    requires: ['kernel'],
    critical: true,
    weight: 1,
    timeoutMs: 500,
    priority: 0,
    safeMode: true,
    recovery: true,
  },
  {
    name: 'storage',
    requires: ['kernel'],
    critical: true,
    weight: 4,
    timeoutMs: 3000,
    priority: 2,
    safeMode: true,
    recovery: true,
  },
  {
    name: 'wm',
    requires: ['kernel'],
    critical: true,
    weight: 2,
    timeoutMs: 1000,
    priority: 2,
    safeMode: true,
    runsIn: 'kernel+main',
    recovery: true,
  },
  {
    name: 'mm',
    requires: ['sched', 'storage'],
    critical: true,
    weight: 2,
    timeoutMs: 2000,
    priority: 2,
    safeMode: true,
    runsIn: 'kernel+blkio',
  },
  {
    name: 'vfs',
    requires: ['storage'],
    critical: true,
    weight: 5,
    timeoutMs: 3000,
    priority: 4,
    safeMode: true,
    recovery: true,
  },
  {
    name: 'login',
    requires: ['vfs', 'wm'],
    critical: true,
    weight: 2,
    timeoutMs: 2000,
    priority: 8,
    safeMode: true,
    runsIn: 'kernel+main',
    userWait: true,
    caps: ['window', 'auth.session'],
  },
  {
    name: 'session',
    requires: ['login', 'mm'],
    critical: true,
    weight: 3,
    timeoutMs: 2000,
    priority: 10,
    safeMode: true,
    caps: ['proc', 'mm.speculative'],
  },
  {
    name: 'desktop',
    requires: ['session', 'wm'],
    critical: true,
    weight: 3,
    timeoutMs: 3000,
    priority: 10,
    safeMode: true,
    runsIn: 'main',
    caps: ['window', 'auth.session', 'proc'],
  },
  {
    name: 'auth',
    requires: ['login'],
    critical: false,
    weight: 1,
    timeoutMs: 4000,
    priority: 15,
    safeMode: true,
  },
  {
    name: 'sync',
    requires: ['auth', 'vfs'],
    critical: false,
    weight: 2,
    timeoutMs: 4000,
    priority: 20,
    safeMode: true,
    stopTimeoutMs: 4000,
  },
  {
    name: 'lockd',
    requires: ['sync'],
    critical: false,
    weight: 1,
    timeoutMs: 2000,
    priority: 20,
    safeMode: true,
    onDegradedDependency: 'start-degraded',
  },
  {
    name: 'ai.runtime',
    requires: ['sched', 'mm'],
    critical: false,
    weight: 1,
    timeoutMs: 4000,
    priority: 32,
    safeMode: false,
    runsIn: 'kernel+executor',
  },
  {
    name: 'ai.indexer',
    requires: ['ai.runtime', 'vfs', 'session'],
    critical: false,
    weight: 3,
    timeoutMs: 4000,
    priority: 32,
    safeMode: false,
    runsIn: 'executor',
    caps: ['fs.read', 'mem', 'ai.index'],
  },
  {
    name: 'ai.predictor',
    requires: ['sched', 'storage', 'login'],
    critical: false,
    weight: 1,
    timeoutMs: 2000,
    priority: 32,
    safeMode: false,
    runsIn: 'executor',
    caps: ['mem', 'mm.hint', 'ai.telemetry', 'ai.predict'],
  },
  {
    name: 'ai.agent',
    requires: ['vfs', 'sched', 'sync'],
    critical: false,
    weight: 1,
    timeoutMs: 2000,
    priority: 20,
    safeMode: false,
    onDegradedDependency: 'start-degraded',
  },
  {
    name: 'complete',
    requires: ['vfs', 'desktop'],
    critical: false,
    weight: 1,
    timeoutMs: 10000,
    priority: 36,
    safeMode: true,
    runsIn: 'executor',
    caps: ['fs.read', 'mem'],
  },
  {
    name: 'update',
    requires: ['desktop'],
    critical: false,
    weight: 1,
    timeoutMs: 10000,
    priority: 38,
    safeMode: true,
    runsIn: 'main+sw',
  },
];

/** The 18 manifests with every default applied. */
export const DEFAULT_SERVICE_MANIFESTS: readonly ServiceManifest[] =
  DEFAULT_SERVICE_MANIFEST_INPUTS.map((m) => v.parse(ServiceManifestSchema, m));
