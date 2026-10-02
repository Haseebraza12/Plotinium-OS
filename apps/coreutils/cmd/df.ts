/**
 * `df [-h] [-i] [PATH]` (shell-and-terminal.md §3.14.19): row 1 is the caller's quota (root is
 * exempt, so its Size and Avail are `-`), row 2 the browser's storage estimate for this origin.
 */
import type { Quota, StatFs } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { humanSize, table } from '../lib/format.ts';

export interface DfOpts {
  readonly human: boolean;
  readonly inodes: boolean;
  readonly path: string | null;
}

function pct(used: number, size: number | null): string {
  if (size === null || size === 0) return '-';
  return `${Math.ceil((used / size) * 100)}%`;
}

/** `humanSize` with a `B` on sizes below 1 KiB, so every -h column carries a unit (UI-159). */
export function humanUnit(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : humanSize(bytes);
}

export function dfRows(fs: StatFs, quota: Quota, home: string, opts: DfOpts): string[] {
  const size = (n: number | null): string =>
    n === null ? '-' : opts.human ? humanUnit(n) : String(Math.ceil(n / 1024));
  const label = quota.source === 'mirror' ? 'plotinium (quota, offline)' : 'plotinium (quota)';
  if (opts.inodes) {
    const free =
      quota.quotaInodes === null ? null : Math.max(0, quota.quotaInodes - quota.usedInodes);
    return table(
      [
        ['Filesystem', 'Inodes', 'IUsed', 'IFree', 'IUse%', 'Mounted on'],
        [
          label,
          quota.quotaInodes === null ? '-' : String(quota.quotaInodes),
          String(quota.usedInodes),
          free === null ? '-' : String(free),
          pct(quota.usedInodes, quota.quotaInodes),
          home,
        ],
        ['browser storage', '-', String(fs.inodes), '-', '-', '(this device)'],
      ],
      new Set([1, 2, 3, 4]),
      1,
      [19, 6, 6, 6, 5],
    );
  }
  const avail = quota.quotaBytes === null ? null : Math.max(0, quota.quotaBytes - quota.usedBytes);
  const devAvail = fs.quotaBytes === null ? null : Math.max(0, fs.quotaBytes - fs.usageBytes);
  return table(
    [
      ['Filesystem', opts.human ? 'Size' : '1K-blocks', 'Used', 'Avail', 'Use%', 'Mounted on'],
      [
        label,
        size(quota.quotaBytes),
        size(quota.usedBytes),
        size(avail),
        pct(quota.usedBytes, quota.quotaBytes),
        home,
      ],
      [
        'browser storage',
        size(fs.quotaBytes),
        size(fs.usageBytes),
        size(devAvail),
        pct(fs.usageBytes, fs.quotaBytes),
        '(this device)',
      ],
    ],
    new Set([1, 2, 3, 4]),
    1,
    [19, 4, 6, 6, 4],
  );
}

export default defineCommand<DfOpts>({
  name: 'df',
  parse(args) {
    const p = parseFor('df', args);
    if (p.operands.length > 1) throw new UsageError(`extra operand '${p.operands[1] ?? ''}'`);
    return { human: p.has('h'), inodes: p.has('i'), path: p.operands[0] ?? null };
  },
  *run(io, opts) {
    try {
      const fs = yield* io.sys.call('statfs', opts.path === null ? {} : { path: opts.path });
      const quota = yield* io.sys.call('quota', {});
      const cred = yield* io.sys.call('proc.cred', {});
      yield* io.lines(dfRows(fs, quota, cred.home, opts));
      return 0;
    } catch (e) {
      yield* io.error(opts.path === null ? describe(e) : `'${opts.path}': ${describe(e)}`);
      return 1;
    }
  },
});
