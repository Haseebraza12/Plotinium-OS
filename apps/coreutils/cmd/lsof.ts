/**
 * `lsof [-p PID] [-u USER] [PATH]` (shell-and-terminal.md §3.14.40): open descriptors of the
 * caller's processes (all, for root) and the leases on files, with a live countdown.
 */
import type { LeaseInfo, OpenFile } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { escapeName, table } from '../lib/format.ts';
import { basename } from '../lib/path.ts';
import { listProcs } from '../lib/procs.ts';
import { errnoOf } from '../lib/sys.ts';
import { loadUsers, userName } from '../lib/users.ts';

export interface LsofOpts {
  readonly pid: number | null;
  readonly user: string | null;
  readonly path: string | null;
}

export function fileType(path: string): string {
  if (path.startsWith('pipe:')) return 'PIPE';
  if (/^tty\d+$/.test(path)) return 'TTY';
  return 'REG';
}

export function leaseText(l: LeaseInfo, now: number): string {
  return `${l.mode} · expires in ${Math.max(0, Math.ceil((l.expiresAt - now) / 1000))} s`;
}

const holderUser = (holder: string): string => holder.split('@')[0] ?? holder;

export function lsofRows(
  open: readonly OpenFile[],
  leases: readonly LeaseInfo[],
  names: { command(pid: number): string; user(uid: number): string },
  now: number,
): string[][] {
  const used = new Set<LeaseInfo>();
  const rows = open.map((f) => {
    const user = names.user(f.uid);
    const lease = leases.find((l) => l.path === f.path && holderUser(l.holder) === user);
    if (lease !== undefined) used.add(lease);
    return [
      names.command(f.pid),
      String(f.pid),
      user,
      String(f.fd),
      fileType(f.path),
      f.flags,
      f.path,
      lease === undefined ? '-' : leaseText(lease, now),
    ];
  });
  for (const l of leases) {
    if (!used.has(l))
      rows.push(['-', '-', holderUser(l.holder), '-', 'REG', '-', l.path, leaseText(l, now)]);
  }
  return rows;
}

export default defineCommand<LsofOpts>({
  name: 'lsof',
  parse(args) {
    const p = parseFor('lsof', args);
    if (p.operands.length > 1) throw new UsageError(`extra operand '${p.operands[1] ?? ''}'`);
    const pidText = p.value('p');
    const pid = pidText === undefined ? null : Number(pidText);
    if (pid !== null && (!Number.isInteger(pid) || pid < 1))
      throw new UsageError(`invalid PID '${pidText ?? ''}'`);
    return { pid, user: p.value('u') ?? null, path: p.operands[0] ?? null };
  },
  *run(io, opts) {
    try {
      const res = yield* io.sys.call('lsof', {
        ...(opts.pid === null ? {} : { pid: opts.pid }),
        ...(opts.path === null ? {} : { path: opts.path }),
      });
      const db = yield* loadUsers(io.sys);
      const procs = new Map(
        (yield* listProcs(io.sys)).map((p) => [p.pid, basename(p.argv[0] ?? '?')]),
      );
      const names = {
        command: (pid: number) => procs.get(pid) ?? '?',
        user: (uid: number) => userName(db, uid),
      };
      let rows = lsofRows(res.open, res.leases, names, yield* io.wallClock());
      if (opts.user !== null) rows = rows.filter((r) => r[2] === opts.user);
      const tty = yield* io.isTty(1);
      const lines = table(
        [['COMMAND', 'PID', 'USER', 'FD', 'TYPE', 'MODE', 'NAME', 'LEASE'], ...rows],
        new Set(),
        2,
      );
      yield* io.lines(lines.map((l) => escapeName(l, tty)));
      return 0;
    } catch (e) {
      if (errnoOf(e) === 'ENOSYS') {
        yield* io.error('listing open files is not available here yet');
        return 1;
      }
      const what = opts.pid !== null ? `${opts.pid}: ` : opts.path !== null ? `${opts.path}: ` : '';
      yield* io.error(`${what}${describe(e)}`);
      return 1;
    }
  },
});
