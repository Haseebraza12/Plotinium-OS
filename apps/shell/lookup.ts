/**
 * Command lookup (shell-and-terminal.md §3.7.2): builtins, then `$PATH` manifests with a
 * `name → manifest` cache, then `/`-paths (a manifest, or a `#!/bin/sh` script).
 */
import type { SysGen } from '../src/_sys.ts';
import { decodeText, errnoOf } from '../src/_sys.ts';
import type { Sh } from './state.ts';
import { varOr } from './state.ts';

export const SH_MANIFEST = '/bin/sh.json';

export type Target =
  | { kind: 'program'; path: string; argv: string[]; cached: boolean }
  | { kind: 'error'; status: number; message: string };

function manifestIn(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}.json` : `${dir}/${name}.json`;
}

function* statType(sh: Sh, path: string): SysGen<{ type: string; mode: number } | null> {
  try {
    const s = yield* sh.sys.call('stat', { path });
    return { type: s.type, mode: s.mode };
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
    return null;
  }
}

function* isFile(sh: Sh, path: string): SysGen<boolean> {
  return (yield* statType(sh, path))?.type === 'f';
}

/** The manifest for `name` in `$PATH`, from the cache when possible. */
export function* findInPath(sh: Sh, name: string): SysGen<string | null> {
  const cache = sh.st.cmdCache;
  if (Object.hasOwn(cache, name)) return cache[name] ?? null;
  const dirs = varOr(sh.st, 'PATH', '').split(':');
  for (const dir of dirs) {
    if (dir === '') continue;
    const path = manifestIn(dir, name);
    if (yield* isFile(sh, path)) {
      Object.defineProperty(cache, name, {
        value: path,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return path;
    }
  }
  return null;
}

export function forget(sh: Sh, name: string): void {
  Reflect.deleteProperty(sh.st.cmdCache, name);
}

/** The shell's own manifest, for `sh -c` children and scripts. */
export function* shPath(sh: Sh): SysGen<string> {
  return (yield* findInPath(sh, 'sh')) ?? SH_MANIFEST;
}

function* hasShebang(sh: Sh, path: string): SysGen<boolean> {
  let fd: number;
  try {
    fd = (yield* sh.sys.call('open', { path, flags: 'r' })).fd;
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
    return false;
  }
  let head = '';
  try {
    head = decodeText(yield* sh.sys.call('read', { fd, len: 16 }));
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
  try {
    yield* sh.sys.call('close', { fd });
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
  return head.startsWith('#!/bin/sh');
}

/** Resolves a command that is not a builtin to what `spawn` needs (§3.7.2). */
export function* resolveProgram(sh: Sh, argv: readonly string[]): SysGen<Target> {
  const name = argv[0] ?? '';
  if (name.includes('/')) {
    const manifest = `${name}.json`;
    if (yield* isFile(sh, manifest)) {
      return { kind: 'program', path: manifest, argv: [...argv], cached: false };
    }
    const s = yield* statType(sh, name);
    if (s === null) {
      return { kind: 'error', status: 127, message: `sh: ${name}: No such file or directory` };
    }
    if (s.type === 'f' && (s.mode & 0o111) !== 0 && (yield* hasShebang(sh, name))) {
      return { kind: 'program', path: yield* shPath(sh), argv: ['sh', ...argv], cached: false };
    }
    return { kind: 'error', status: 126, message: `sh: ${name}: cannot execute` };
  }
  const cached = Object.hasOwn(sh.st.cmdCache, name);
  const path = yield* findInPath(sh, name);
  if (path === null)
    return { kind: 'error', status: 127, message: `sh: ${name}: command not found` };
  return { kind: 'program', path, argv: [...argv], cached };
}
