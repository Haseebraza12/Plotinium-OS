/**
 * The demonstration programs of the defence stress tests (testing-and-performance.md §3.16.5,
 * processes-and-scheduling.md §3.18.10, memory-and-paging.md §3.17.5): one program per
 * `/bin/<name>.json` manifest, each with a man page in ./man whose front matter is its only source
 * of flags (SHL-12). The `satisfies` clause makes a page without a program, or a program without a
 * page, a type error.
 *
 * | Program    | Demonstrates                                   | Requirement IDs          |
 * | ---------- | ---------------------------------------------- | ------------------------ |
 * | `burn`     | CPU load, round robin, aging bound, frame gate | PROC-03, PROC-04, PROC-05 |
 * | `memhog`   | 2× memory workload, verified page-in           | MEM-03, MEM-06, MEM-07   |
 * | `mktree`   | the seeded `tree1000` fixture                  | DB-02, VFS-07            |
 * | `lockdemo` | two users contending for one lease             | VFS-09, PROC-07          |
 * | `idx50k`   | a 50 KB file for index freshness               | RAG-02, RAG-06           |
 */
import type { AppManifestInput } from '@plotinium/protocol';
import type { Program } from '@plotinium/kernel/sys';

import burn from './cmd/burn.ts';
import idx50k from './cmd/idx50k.ts';
import lockdemo from './cmd/lockdemo.ts';
import memhog from './cmd/memhog.ts';
import mktree from './cmd/mktree.ts';
import { DEMO_ARGSPEC } from './lib/argspec.gen.ts';
import type { DemoName } from './lib/cli.ts';

export { DEMO_ARGSPEC };
export type { DemoName };

export const DEMO_PROGRAMS = {
  burn,
  idx50k,
  lockdemo,
  memhog,
  mktree,
} as const satisfies Record<DemoName, unknown>;

/** Every demo program by name, for a program registry keyed by string. */
export function demoProgram(name: string): Program<unknown> | undefined {
  if (!Object.hasOwn(DEMO_PROGRAMS, name)) return undefined;
  return DEMO_PROGRAMS[name as DemoName];
}

/**
 * The `/bin/<name>.json` manifests (protocol AppManifestSchema). `entry` is the executor module id
 * of the program; `caps` are intersected with the caller's bounding set at spawn.
 */
export const DEMO_MANIFESTS: readonly AppManifestInput[] = [
  {
    name: 'burn',
    kind: 'command',
    title: 'burn',
    entry: 'apps/demo/burn',
    requires: [],
    checkpointable: true,
    caps: ['proc'],
  },
  {
    name: 'memhog',
    kind: 'command',
    title: 'memhog',
    entry: 'apps/demo/memhog',
    requires: [],
    checkpointable: true,
    caps: ['proc', 'mem'],
  },
  {
    name: 'mktree',
    kind: 'command',
    title: 'mktree',
    entry: 'apps/demo/mktree',
    requires: [],
    caps: ['fs.read', 'fs.write'],
  },
  {
    name: 'lockdemo',
    kind: 'command',
    title: 'lockdemo',
    entry: 'apps/demo/lockdemo',
    requires: [],
    checkpointable: true,
    caps: ['fs.read', 'lock'],
  },
  {
    name: 'idx50k',
    kind: 'command',
    title: 'idx50k',
    entry: 'apps/demo/idx50k',
    requires: [],
    caps: ['fs.read', 'fs.write', 'ai.search'],
  },
];
