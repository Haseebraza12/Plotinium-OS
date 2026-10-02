/** `quota [-h] [-u USER]` (shell-and-terminal.md §3.14.20). */
import type { Quota } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import { binSize } from '../lib/format.ts';
import { findUser, loadUsers } from '../lib/users.ts';

export interface QuotaOpts {
  readonly human: boolean;
  readonly user: string | null;
}

/** `18.2M`, `100M` (a whole number drops its `.0`). */
export function quotaSize(bytes: number, human: boolean): string {
  return human ? binSize(bytes).replace(/\.0(?=[KMGT]$)/, '') : String(bytes);
}

/**
 * TODO(R2): the confirmation time of `source: server (confirmed HH:MM:SS)` needs a
 * `confirmedAt` field in protocol `Quota` (virtual-file-system.md §3.8).
 */
export function quotaLines(name: string, q: Quota, human: boolean): string[] {
  const limit = (n: number | null, f: (x: number) => string): string => (n === null ? '-' : f(n));
  const bytes = (n: number): string => quotaSize(n, human);
  return [
    `Disk quotas for user ${name} (uid ${q.uid}):`,
    `  ${'bytes used'.padEnd(11)}${bytes(q.usedBytes).padStart(7)}   of ${limit(q.quotaBytes, bytes)}`,
    `  ${'inodes used'.padEnd(11)}${String(q.usedInodes).padStart(7)}   of ${limit(q.quotaInodes, String)}`,
    q.source === 'server'
      ? '  source: server'
      : '  source: local mirror (offline; the server value may differ)',
  ];
}

export default defineCommand<QuotaOpts>({
  name: 'quota',
  parse(args) {
    const p = parseFor('quota', args);
    if (p.operands.length > 0) throw new UsageError(`extra operand '${p.operands[0] ?? ''}'`);
    return { human: p.has('h'), user: p.value('u') ?? null };
  },
  *run(io, opts) {
    let name: string;
    let uid: number | undefined;
    if (opts.user === null) {
      name = (yield* io.sys.call('proc.cred', {})).user;
    } else {
      const rec = findUser(yield* loadUsers(io.sys), opts.user);
      if (rec === undefined) {
        yield* io.error(`no such user '${opts.user}'`);
        return 1;
      }
      name = rec.name;
      uid = rec.uid;
    }
    try {
      const q = yield* io.sys.call('quota', uid === undefined ? {} : { uid });
      yield* io.lines(quotaLines(name, q, opts.human));
      return 0;
    } catch (e) {
      yield* io.error(mustErrno(e) === 'EPERM' ? 'permission denied for other users' : describe(e));
      return 1;
    }
  },
});
