/**
 * @plotinium/ai/programs: the AI processes as entries of the PROGRAM REGISTRY
 * (processes-and-scheduling.md §3.6; rag-semantic-search.md §3.1; agentic-shell.md §3.3;
 * predictive-prefetch.md §3.1, §3.5).
 *
 * The kernel never imports ai/ (C12), so the host that composes the OS injects both halves:
 *   - kernel side: `AI_MANIFESTS` go into the program catalog next to the apps' manifests
 *     (`createKernel({ programs: new StaticProgramCatalog([...apps, ...AI_MANIFESTS]) })`);
 *   - executor side: `AI_PROGRAM_LOADERS` go into `startExecutor({ loaders: {...apps, ...ai} })`,
 *     so program code is imported only inside a sandboxed executor.
 *
 * | Manifest      | Process (argv[0]) | Class  | PRI           | Caps                               |
 * | ------------- | ----------------- | ------ | ------------- | ---------------------------------- |
 * | `ai-indexer`  | `ai.indexer`      | system | 22 + NI 10    | fs.read mem ai.index               |
 * | `ai-predictor`| `ai.predictor`    | system | 22 + NI 10    | mem mm.hint ai.telemetry ai.predict |
 * | `prefetch`    | `prefetch:<app>`  | system | 39 (lowest)   | fs.read mm.speculative             |
 * | `ai-agent`    | `ai`              | agent  | inherits      | fs.read fs.scope ai.plan mem       |
 *
 * AppManifestSchema names are `[a-z][a-z0-9-]*` (no dots), so the manifests use `-` while the
 * processes keep the spec's names in argv[0], which is what `ps` and the Task Manager show. The
 * daemons run as the SESSION uid (never root): `spawnProcess({ parent: init, name, argv, cred:
 * sessionCred, priority, nice })`.
 */
import type { AppManifestInput } from '@plotinium/protocol';

import { INDEXER_NICE, INDEXER_PRIORITY } from './indexer.ts';
import { PREDICTOR_NICE, PREDICTOR_PRIORITY } from './predictor.ts';

/** `manifest.entry` module ids (the executor's loader keys). */
export const AI_ENTRY = {
  indexer: 'ai/indexer',
  predictor: 'ai/predictor',
  prefetch: 'ai/prefetch',
  agent: 'ai/agent',
} as const;

/** The pre-fetch job's priority: the lowest there is (PRE-04, I-C5). */
export const PREFETCH_PRIORITY = 39;

export const AI_MANIFESTS: readonly AppManifestInput[] = [
  {
    name: 'ai-indexer',
    kind: 'command',
    title: 'ai.indexer',
    entry: AI_ENTRY.indexer,
    requires: ['svc:ai.runtime', 'svc:vfs'],
    priority: INDEXER_PRIORITY,
    checkpointable: false,
    class: 'system',
    caps: ['fs.read', 'mem', 'ai.index'],
  },
  {
    name: 'ai-predictor',
    kind: 'command',
    title: 'ai.predictor',
    entry: AI_ENTRY.predictor,
    requires: ['svc:ai.runtime'],
    priority: PREDICTOR_PRIORITY,
    checkpointable: false,
    class: 'system',
    caps: ['fs.read', 'mem', 'mm.hint', 'ai.telemetry', 'ai.predict'],
  },
  {
    name: 'prefetch',
    kind: 'command',
    title: 'prefetch',
    entry: AI_ENTRY.prefetch,
    requires: [],
    priority: PREFETCH_PRIORITY,
    checkpointable: true,
    class: 'system',
    caps: ['fs.read', 'mm.speculative'],
  },
  {
    name: 'ai-agent',
    kind: 'command',
    title: 'ai',
    entry: AI_ENTRY.agent,
    requires: ['svc:ai.agent'],
    checkpointable: false,
    class: 'agent',
    caps: ['fs.read', 'fs.scope', 'ai.plan', 'mem'],
  },
];

/** `entry` → lazy module loader, for the executor bundle. */
export const AI_PROGRAM_LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {
  [AI_ENTRY.indexer]: () => import('./indexer.ts'),
  [AI_ENTRY.predictor]: () => import('./predictor.ts'),
  [AI_ENTRY.prefetch]: () => import('./prefetch.ts'),
  [AI_ENTRY.agent]: () => import('./agent.ts'),
};

/** How the kernel spawns each AI daemon (the `spawnDaemon` of `installAi`). */
export interface DaemonSpawn {
  /** Manifest name (`/bin/<name>.json`). */
  readonly manifest: string;
  readonly argv: readonly string[];
  readonly priority: number;
  readonly nice: number;
}

export const AI_DAEMONS: Readonly<Record<'ai.indexer' | 'ai.predictor', DaemonSpawn>> = {
  'ai.indexer': {
    manifest: 'ai-indexer',
    argv: ['ai.indexer'],
    priority: INDEXER_PRIORITY,
    nice: INDEXER_NICE,
  },
  'ai.predictor': {
    manifest: 'ai-predictor',
    argv: ['ai.predictor'],
    priority: PREDICTOR_PRIORITY,
    nice: PREDICTOR_NICE,
  },
};

/** argv of a `prefetch:<app>` job (up to 8 recent files as `--ino=`). */
export function prefetchArgv(app: string, inos: readonly string[] = []): string[] {
  return [`prefetch:${app}`, ...inos.slice(0, 8).map((ino) => `--ino=${ino}`)];
}

/** The manifest path the coreutils `ai` front end spawns (`AGENT_MANIFEST` there). */
export const AGENT_MANIFEST_PATH = '/bin/lib/ai-agent.json';
