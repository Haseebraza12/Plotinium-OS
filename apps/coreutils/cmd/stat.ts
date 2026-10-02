/** `stat [-L] [-t] FILE...` (shell-and-terminal.md §3.14.15, exact layout). */
import type { Stat } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { escapeName, fullTime, modeString, octal } from '../lib/format.ts';
import { tryStat } from '../lib/fs.ts';
import type { UserDb } from '../lib/users.ts';
import { groupName, loadUsers, userName } from '../lib/users.ts';

export interface StatOpts {
  readonly follow: boolean;
  readonly terse: boolean;
  readonly files: readonly string[];
}

const TYPE_NAME = { f: 'regular file', d: 'directory', l: 'symbolic link' } as const;

/**
 * The sync state is not in protocol `Stat` yet; it is shown when the kernel supplies it.
 * TODO(R2): add `sync: 'synced' | 'pending' | 'pending-offline'` to `Stat` (virtual-file-system.md §4.1).
 */
function syncText(stat: Stat): string {
  const sync: unknown = (stat as Stat & { sync?: unknown }).sync;
  if (sync === 'pending-offline') return 'pending (offline)';
  return typeof sync === 'string' ? sync : '-';
}

function ids(id: number, name: string): string {
  return `(${String(id).padStart(5)}/${name.padStart(8)})`;
}

export function statBlock(
  name: string,
  stat: Stat,
  users: UserDb,
  tz: number,
  tty: boolean,
): string[] {
  const shown = escapeName(name, tty);
  const file =
    stat.type === 'l' && stat.target !== null
      ? `${shown} -> ${escapeName(stat.target, tty)}`
      : shown;
  const perm = modeString(stat.type, stat.mode);
  return [
    `  File: ${file}`,
    `  Type: ${TYPE_NAME[stat.type].padEnd(20)}Size: ${String(stat.size).padEnd(13)}Links: ${stat.nlink}`,
    ` Inode: ${stat.ino}   Version: ${stat.version}   Sync: ${syncText(stat)}`,
    `Access: (${octal(stat.mode)}/${perm})   Uid: ${ids(stat.uid, userName(users, stat.uid))}   Gid: ${ids(stat.gid, groupName(users, stat.gid))}`,
    `Access: ${fullTime(stat.atime, tz)}`,
    `Modify: ${fullTime(stat.mtime, tz)}`,
    `Change: ${fullTime(stat.ctime, tz)}`,
  ];
}

export function terseLine(name: string, stat: Stat, tty: boolean): string {
  const fields = [
    stat.size,
    octal(stat.mode),
    stat.uid,
    stat.gid,
    stat.ino,
    stat.nlink,
    stat.atime,
    stat.mtime,
    stat.ctime,
    stat.version,
    stat.type,
  ];
  return [escapeName(name, tty), ...fields.map(String)].join(' ');
}

export default defineCommand<StatOpts>({
  name: 'stat',
  parse(args) {
    const p = parseFor('stat', args);
    if (p.operands.length === 0) throw new UsageError('missing operand');
    return { follow: p.has('L'), terse: p.has('t'), files: p.operands };
  },
  *run(io, opts) {
    const users = opts.terse ? { users: [], groups: [] } : yield* loadUsers(io.sys);
    const tz = yield* io.tzOffset();
    const tty = yield* io.isTty(1);
    let status = 0;
    for (const file of opts.files) {
      const st = yield* tryStat(io.sys, file, opts.follow);
      if (!st.ok) {
        yield* io.error(`cannot stat '${file}': ${describe(st.error)}`);
        status = 1;
        continue;
      }
      if (opts.terse) yield* io.line(terseLine(file, st.stat, tty));
      else yield* io.lines(statBlock(file, st.stat, users, tz, tty));
    }
    return status;
  },
});
