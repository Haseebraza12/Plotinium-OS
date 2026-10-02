/**
 * Starting another program (shell-and-terminal.md §3.7.2): a name without `/` is looked up as
 * `D/<name>.json` for each directory D of `$PATH`; the child inherits the environment, working
 * directory and standard descriptors, and its exit status (128 + n for a signal) is returned.
 */
import type { WaitStatus } from '@plotinium/protocol';

import type { Io } from './io.ts';
import { join } from './path.ts';
import type { SysGen } from './sys.ts';

/** The manifest path of a command, or null when no `$PATH` directory has it. */
export function* lookupCommand(io: Io, name: string): SysGen<string | null> {
  const candidates = name.includes('/')
    ? [`${name}.json`]
    : (io.env('PATH') ?? '/bin')
        .split(':')
        .filter((dir) => dir.length > 0)
        .map((dir) => join(dir, `${name}.json`));
  for (const path of candidates) {
    try {
      const st = yield* io.sys.call('stat', { path });
      if (st.type === 'f') return path;
    } catch {
      // not in this directory
    }
  }
  return null;
}

export function envRecord(io: Io): Record<string, string> {
  return Object.fromEntries(io.ctx.env);
}

/** 0-255 for an exit, 128 + n for a signal. */
export function statusCode(status: WaitStatus): number | null {
  if (status.kind === 'exited' || status.kind === 'signaled') return status.code;
  return null;
}

/** Waits until the child exits or is killed and returns its status code. */
export function* waitExit(io: Io, pid: number): SysGen<number> {
  for (;;) {
    const res = yield* io.sys.call('wait', { pid });
    if ('status' in res) {
      const code = statusCode(res.status);
      if (code !== null) return code;
    }
  }
}

export interface SpawnOptions {
  readonly nice?: number;
  readonly env?: Record<string, string>;
}

export function* spawnAndWait(
  io: Io,
  path: string,
  argv: readonly string[],
  options: SpawnOptions = {},
): SysGen<number> {
  yield* io.flush();
  const { pid } = yield* io.sys.call('spawn', {
    path,
    argv: [...argv],
    env: options.env ?? envRecord(io),
    cwd: io.ctx.cwd,
    ...(options.nice === undefined ? {} : { nice: options.nice }),
  });
  return yield* waitExit(io, pid);
}
