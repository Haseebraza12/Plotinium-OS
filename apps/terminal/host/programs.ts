/**
 * The programs the Terminal's process host can run, and the `/bin` manifests it serves for them
 * (shell-and-terminal.md §3.7.2 command lookup; boot-and-services.md §4.4 manifests).
 *
 * The shell finds a command by `stat`-ing `$PATH/<name>.json`; `spawn` then runs the program that
 * manifest names. When the VFS already holds the manifests the host uses the VFS; when it does not
 * (a fresh volume before the /bin seed lands), the host serves a read-only `/bin` overlay for the
 * programs bundled with the Terminal, so a command is never "not found" only because the seed is
 * missing. Programs are looked up by the manifest's base name.
 */
import type { AppManifestInput, SignalName, Stat } from '@plotinium/protocol';

import { AI_PROGRAMS, PROGRAMS } from '../../coreutils/index.ts';
import { DEMO_PROGRAMS } from '../../demo/index.ts';
import shell from '../../shell/proc.ts';
import { clear, complete, head, sleep } from './extras.ts';

/**
 * A runnable program. Parameters are typed `never` so both program models (apps/src/_sys.ts and
 * @plotinium/kernel/sys) fit; the host calls them with its own context (host.ts).
 */
export interface HostProgram {
  readonly checkpointable?: boolean;
  init(argv: readonly string[]): unknown;
  run(ctx: never, st: never): Generator<unknown, number | undefined, unknown>;
  signal?(ctx: never, st: never, sig: SignalName): void;
}

export interface ProgramRegistry {
  /** The program for a base name such as `ls`, or undefined. */
  get(name: string): HostProgram | undefined;
  /** Every registered name, sorted in code-point order. */
  names(): readonly string[];
}

export interface RegistryOptions {
  /** Leave out `ai`, `semsearch` and `predict` (the AI-off build, SHL-18). */
  readonly ai?: boolean;
  /** More programs, for example the agent from the web composition (`ai.agent`). */
  readonly extra?: Readonly<Record<string, HostProgram>>;
}

/** The shell, coreutils, the demo programs and the Terminal's extras. */
export function bundledPrograms(opts: RegistryOptions = {}): ProgramRegistry {
  const table = new Map<string, HostProgram>();
  const add = (name: string, program: HostProgram): void => {
    table.set(name, program);
  };
  add('sh', shell);
  add('sleep', sleep);
  add('head', head);
  add('clear', clear);
  add('complete', complete);
  for (const [name, program] of Object.entries(PROGRAMS)) {
    if (opts.ai === false && AI_PROGRAMS.includes(name as (typeof AI_PROGRAMS)[number])) continue;
    add(name, program);
  }
  for (const [name, program] of Object.entries(DEMO_PROGRAMS)) add(name, program);
  for (const [name, program] of Object.entries(opts.extra ?? {})) add(name, program);
  const names = [...table.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    get: (name) => table.get(name),
    names: () => names,
  };
}

/** Where the overlay lives. */
export const BIN_DIR = '/bin';

/** `/bin/ls.json` → `ls`; `/bin/lib/ai.agent.json` → `ai.agent`; anything else → null. */
export function programName(path: string): string | null {
  const m = /\/([^/]+)\.json$/.exec(path);
  return m === null ? null : (m[1] ?? null);
}

/** The overlay manifest of a bundled program (a `command`, or `sh`). */
export function manifestFor(name: string): AppManifestInput {
  return {
    name: name.replace(/[^a-z0-9-]/g, '-'),
    kind: 'command',
    title: name,
    entry: `apps/${name === 'sh' ? 'shell' : 'coreutils'}/${name}`,
    requires: [],
    checkpointable: name === 'sh',
  };
}

export function manifestText(name: string): string {
  return `${JSON.stringify(manifestFor(name), null, 2)}\n`;
}

/** A stable UUIDv7-shaped inode id for an overlay entry (FNV-1a of the name). */
export function overlayIno(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hex = h.toString(16).padStart(8, '0');
  return `00000000-0000-7000-8000-0000${hex}`;
}

const BIN_INO = '00000000-0000-7000-8000-00000000b1d0';
const LIB_INO = '00000000-0000-7000-8000-00000000b1d1';

/** Where library programs live (`/bin/lib/ai.agent.json`, started by `ai`). */
export const LIB_DIR = `${BIN_DIR}/lib`;

/** A library program's name has a dot (`ai.agent`); commands never do. */
function isLibName(name: string): boolean {
  return name.includes('.');
}

/**
 * The `stat` of an overlay path (`/bin`, `/bin/<name>.json`, `/bin/lib` or
 * `/bin/lib/<name>.json`), or null when it is not one.
 */
export function overlayStat(path: string, registry: ProgramRegistry, now: number): Stat | null {
  const base = {
    uid: 0,
    gid: 0,
    nlink: 1,
    atime: now,
    mtime: now,
    ctime: now,
    version: 1,
    blob: null,
    target: null,
    synth: true,
  };
  if (path === BIN_DIR) {
    return { ...base, ino: BIN_INO, type: 'd', mode: 0o755, size: 0, nlink: 2 };
  }
  const libs = registry.names().some(isLibName);
  if (path === LIB_DIR) {
    return libs ? { ...base, ino: LIB_INO, type: 'd', mode: 0o755, size: 0, nlink: 2 } : null;
  }
  const inLib = path.startsWith(`${LIB_DIR}/`);
  const dir = inLib ? LIB_DIR : BIN_DIR;
  if (!path.startsWith(`${dir}/`) || path.indexOf('/', dir.length + 1) >= 0) return null;
  const name = programName(path);
  if (name === null || registry.get(name) === undefined || isLibName(name) !== inLib) return null;
  return {
    ...base,
    ino: overlayIno(name),
    type: 'f',
    mode: 0o644,
    size: new TextEncoder().encode(manifestText(name)).byteLength,
  };
}
