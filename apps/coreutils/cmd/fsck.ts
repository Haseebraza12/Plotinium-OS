/**
 * `fsck [-n | -y] [--checksum] [--server] [PATH]` (shell-and-terminal.md §3.14.39, VFS-11). Status
 * 0 clean or repaired, 1 problems left, 2 usage or error.
 *
 * TODO(R2): protocol `fsck` has no `path` and its report no directory or user counts; PATH is
 * shown in the checksum line only until FsckArgs gains `path` (syscall-abi.md §4.4.11).
 */
import type { FsckReport } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import { thousands } from '../lib/format.ts';

export interface FsckOpts {
  readonly repair: boolean;
  readonly checksum: boolean;
  readonly server: boolean;
  readonly path: string;
}

export function problems(r: FsckReport): number {
  return (
    r.unreachable +
    r.orphans +
    r.parentless +
    r.nlinkErrors +
    r.cycles +
    r.danglingLinks +
    r.quotaDrift
  );
}

export function fsckLines(r: FsckReport, opts: FsckOpts): { lines: string[]; status: number } {
  const lines = [
    `fsck: checked ${thousands(r.inodes)} inodes in ${(r.durationMs / 1000).toFixed(2)} s`,
    `fsck: unreachable ${r.unreachable + r.orphans + r.parentless} · wrong link counts ${r.nlinkErrors} · directory cycles ${r.cycles} · dangling dentries ${r.danglingLinks}`,
    r.quotaDrift === 0
      ? 'fsck: quota totals consistent'
      : `fsck: quota totals differ for ${r.quotaDrift} users`,
  ];
  if (opts.checksum && r.checksum !== undefined)
    lines.push(`sha256:${r.checksum}  ${opts.path} (${thousands(r.inodes)} nodes)`);
  if (r.serverChecksum !== undefined) lines.push(`server sha256:${r.serverChecksum}`);
  const found = problems(r);
  if (r.repaired !== undefined && r.repaired > 0) {
    lines.push(`fsck: repaired ${r.repaired} problem${r.repaired === 1 ? '' : 's'}`);
    return { lines, status: 0 };
  }
  if (found === 0) return { lines: [...lines, 'fsck: clean'], status: 0 };
  lines.push(
    `fsck: ${found} problem${found === 1 ? '' : 's'} found (run fsck -y as root to repair)`,
  );
  return { lines, status: 1 };
}

export default defineCommand<FsckOpts>({
  name: 'fsck',
  parse(args) {
    const p = parseFor('fsck', args);
    if (p.has('n') && p.has('y')) throw new UsageError('-n and -y are mutually exclusive');
    if (p.operands.length > 1) throw new UsageError(`extra operand '${p.operands[1] ?? ''}'`);
    return {
      repair: p.has('y'),
      checksum: p.has('checksum'),
      server: p.has('server'),
      path: p.operands[0] ?? '/',
    };
  },
  *run(io, opts) {
    try {
      const report = yield* io.sys.call('fsck', {
        repair: opts.repair,
        checksum: opts.checksum,
        ...(opts.server ? { scope: 'both' as const } : {}),
      });
      const out = fsckLines(report, opts);
      yield* io.lines(out.lines);
      return out.status;
    } catch (e) {
      const errno = mustErrno(e);
      if (errno === 'EPERM' && opts.repair) yield* io.error('repair requires root');
      else if (errno === 'EAGAIN' && opts.server) yield* io.error('--server needs a connection');
      else yield* io.error(describe(e));
      return 2;
    }
  },
});
