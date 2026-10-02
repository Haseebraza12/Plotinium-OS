/**
 * `renice [-n] N [-p] PID... | -g PGID... | -u USER...` (processes-and-scheduling.md §3.18.6):
 * sets the absolute nice value through `setpriority` (O(log n) `changeKey` in the scheduler).
 */
import { defineCommand, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import type { Io } from '../lib/io.ts';
import { listProcs } from '../lib/procs.ts';
import type { SysGen } from '../lib/sys.ts';
import { SysError } from '../lib/sys.ts';
import { findUid, loadUsers } from '../lib/users.ts';
import { clampNice } from './nice.ts';

type Which = 'pid' | 'pgid' | 'user';

export interface ReniceOpts {
  readonly nice: number;
  readonly targets: readonly { readonly which: Which; readonly id: string }[];
}

const SWITCH: Readonly<Record<string, Which>> = {
  '-p': 'pid',
  '--pid': 'pid',
  '-g': 'pgid',
  '--pgrp': 'pgid',
  '-u': 'user',
  '--user': 'user',
};

export function parseRenice(args: readonly string[]): ReniceOpts {
  let rest = [...args];
  if (rest[0] === '-n' || rest[0] === '--priority') rest = rest.slice(1);
  const text = rest.shift();
  if (text === undefined) throw new UsageError('missing priority');
  if (!/^[+-]?\d+$/.test(text)) throw new UsageError(`invalid priority '${text}'`);
  let which: Which = 'pid';
  const targets: { which: Which; id: string }[] = [];
  for (const a of rest) {
    const next = SWITCH[a];
    if (next !== undefined) which = next;
    else targets.push({ which, id: a });
  }
  if (targets.length === 0) throw new UsageError('no process, group or user given');
  return { nice: clampNice(Number(text)), targets };
}

const LABEL: Readonly<Record<Which, string>> = {
  pid: 'process ID',
  pgid: 'process group ID',
  user: 'user ID',
};

function failText(e: unknown): string {
  const errno = mustErrno(e);
  return errno === 'EPERM' || errno === 'EACCES' ? 'Permission denied' : describe(e);
}

/** Old and new nice of one target; throws the call's errno. */
function* setOne(
  io: Io,
  which: Which,
  id: number,
  nice: number,
): SysGen<{ old: number; now: number }> {
  if (which === 'pid') {
    const before = yield* io.sys.call('getpriority', { pid: id });
    const after = yield* io.sys.call('setpriority', { pid: id, nice });
    return { old: before.nice, now: after.nice };
  }
  const procs = yield* listProcs(io.sys, which === 'pgid' ? { pgid: id } : { uid: id });
  const first = procs[0];
  if (first === undefined) throw new SysError('ESRCH');
  if (which === 'pgid') {
    const after = yield* io.sys.call('setpriority', { pid: id, group: true, nice });
    return { old: first.nice, now: after.nice };
  }
  for (const proc of procs) yield* io.sys.call('setpriority', { pid: proc.pid, nice });
  return { old: first.nice, now: nice };
}

export default defineCommand<ReniceOpts>({
  name: 'renice',
  parse: parseRenice,
  *run(io, opts) {
    let status = 0;
    const needUsers = opts.targets.some((t) => t.which === 'user');
    const db = needUsers ? yield* loadUsers(io.sys) : { users: [], groups: [] };
    for (const t of opts.targets) {
      const id =
        t.which === 'user' ? findUid(db, t.id) : /^\d+$/.test(t.id) ? Number(t.id) : undefined;
      if (id === undefined) {
        yield* io.error(t.which === 'user' ? `unknown user ${t.id}` : `bad value ${t.id}`);
        status = 1;
        continue;
      }
      try {
        const r = yield* setOne(io, t.which, id, opts.nice);
        yield* io.line(`${id} (${LABEL[t.which]}) old priority ${r.old}, new priority ${r.now}`);
      } catch (e) {
        yield* io.error(`failed to set priority for ${id} (${LABEL[t.which]}): ${failText(e)}`);
        status = 1;
      }
    }
    return status;
  },
});
