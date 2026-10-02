/**
 * `su [-] [-l] [-c COMMAND] [USER]` (shell-and-terminal.md §3.14.36). The password is asked by the
 * compositor-owned secure prompt inside the `su` call, never through this process or the TTY.
 */
import type { Errno } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno, reasonOf } from '../lib/errors.ts';
import { envRecord, lookupCommand, waitExit } from '../lib/exec.ts';
import { findUser, loadUsers } from '../lib/users.ts';

export interface SuOpts {
  readonly login: boolean;
  readonly command: string | null;
  readonly user: string;
}

export function parseSu(args: readonly string[]): SuOpts {
  const p = parseFor(
    'su',
    args.map((a) => (a === '-' ? '--login' : a)),
  );
  if (p.operands.length > 1) throw new UsageError(`extra operand '${p.operands[1] ?? ''}'`);
  return { login: p.has('l'), command: p.value('c') ?? null, user: p.operands[0] ?? 'root' };
}

/** The exact messages of §3.14.36 for a failed `su` call. */
export function suError(e: unknown, user: string): string {
  const errno = mustErrno(e);
  const reason = reasonOf(e);
  const texts: Partial<Record<Errno, string>> = {
    EACCES: 'Authentication failure',
    ECANCELED: 'authentication cancelled',
    EAGAIN:
      reason === 'offline'
        ? 'authentication unavailable offline'
        : 'too many attempts, try again in 5 min',
    EINVAL: `user ${user} does not exist`,
    ENOTTY: 'must be run from a terminal',
    // The Terminal's own process host cannot start a process as another user; that needs the
    // kernel TTY path (UI-125). Not a developer message: what the user can and cannot do.
    ENOSYS: 'switching users is not available in this Terminal yet',
    ...(reason === 'guest' ? { EPERM: 'guests cannot use su' } : {}),
  };
  return texts[errno] ?? describe(e);
}

export default defineCommand<SuOpts>({
  name: 'su',
  parse: parseSu,
  *run(io, opts) {
    if (io.ctx.tty === null) {
      yield* io.error('must be run from a terminal');
      return 1;
    }
    const target = findUser(yield* loadUsers(io.sys), opts.user);
    if (target === undefined) {
      yield* io.error(`user ${opts.user} does not exist`);
      return 1;
    }
    const base = opts.login
      ? {
          PATH: '/bin',
          TERM: io.env('TERM') ?? 'xterm-256color',
          LANG: io.env('LANG') ?? 'C.UTF-8',
        }
      : envRecord(io);
    const env = {
      ...base,
      HOME: target.home,
      USER: target.name,
      LOGNAME: target.name,
      SHELL: '/bin/sh',
    };
    const argv = opts.command !== null ? ['sh', '-c', opts.command] : [opts.login ? '-sh' : 'sh'];
    const path = (yield* lookupCommand(io, 'sh')) ?? '/bin/sh.json';
    try {
      yield* io.flush();
      const res = yield* io.sys.call('su', { user: target.name, spawn: { path, argv, env } });
      return yield* waitExit(io, res.pid);
    } catch (e) {
      yield* io.error(suError(e, opts.user));
      return 1;
    }
  },
});
