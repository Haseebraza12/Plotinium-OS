/**
 * `pmap [-x] [--json] PID` (memory-and-paging.md §3.17.3): the page table of one process from
 * `proc.info` (owner or root only).
 */
import type { ProcDetail } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { binSize, escapeName, table } from '../lib/format.ts';
import type { PageX } from '../lib/mem.ts';
import { commandLine } from '../lib/procs.ts';

export interface PmapOpts {
  readonly extended: boolean;
  readonly json: boolean;
  readonly pid: number;
}

export function pageFlags(p: PageX): string {
  const flags = `${p.dirty ? 'D' : ''}${p.pinned ? 'P' : ''}${p.speculative ? 'X' : ''}${p.io === true ? 'W' : ''}`;
  return flags === '' ? '-' : flags;
}

export function pmapLines(
  d: ProcDetail,
  softLimit: number | undefined,
  now: number,
  extended: boolean,
  tty: boolean,
): string[] {
  const pages: PageX[] = d.pages ?? [];
  const exe = d.state === 'SUSPENDED' || d.executor === null ? '-' : `e${d.executor}`;
  const limit = softLimit === undefined ? '' : `, soft limit ${binSize(softLimit)}`;
  const head = `${d.pid}:   ${escapeName(commandLine(d), tty)}   (${d.user}, ${d.state}, exec ${exe}${limit})`;
  const cols = ['PAGE', 'KIND', 'LABEL', 'SIZE', 'LOCATION', 'COPIES', 'FLAGS', 'AGE', 'SHA256'];
  if (extended) cols.push('GEN', 'PIN', 'SWAP KEY');
  const rows = pages.map((p) => {
    const cells = [
      String(p.pageId),
      p.kind ?? '-',
      escapeName(p.label ?? '-', tty),
      binSize(p.size),
      p.loc,
      p.copies ?? '-',
      pageFlags(p),
      `${(Math.max(0, now - p.lastAccess) / 1000).toFixed(1)}s`,
      extended ? (p.sha256 ?? '-') : (p.sha256?.slice(0, 8) ?? '-'),
    ];
    if (extended)
      cells.push(
        p.gen === undefined ? '-' : String(p.gen),
        (p.pinReasons ?? []).join(',') || '-',
        p.swapKey ?? '-',
      );
    return cells;
  });
  const sum = (loc: string): number =>
    pages.filter((p) => p.loc === loc).reduce((n, p) => n + p.size, 0);
  const total = pages.reduce((n, p) => n + p.size, 0);
  return [
    head,
    ...table([cols, ...rows], new Set([0, 3, 7]), 2, [4, 8, 20, 7, 11, 6, 5, 6]),
    `total ${pages.length} pages ${binSize(total)} | resident ${binSize(sum('RESIDENT'))}, local copies ${binSize(sum('LOCAL_SWAP'))}, remote copies ${binSize(sum('REMOTE_SWAP'))} | faults ${d.faults}, hit ${(d.hitRatio * 100).toFixed(1)}%`,
  ];
}

export default defineCommand<PmapOpts>({
  name: 'pmap',
  parse(args) {
    const p = parseFor('pmap', args);
    const [pidText, extra] = p.operands;
    if (pidText === undefined) throw new UsageError('missing PID');
    if (extra !== undefined) throw new UsageError(`extra operand '${extra}'`);
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid < 1) throw new UsageError(`invalid PID '${pidText}'`);
    return { extended: p.has('x'), json: p.has('json'), pid };
  },
  *run(io, opts) {
    try {
      const detail = yield* io.sys.call('proc.info', { pid: opts.pid });
      if (opts.json) {
        yield* io.line(JSON.stringify(detail));
        return 0;
      }
      let softLimit: number | undefined;
      try {
        softLimit = (yield* io.sys.call('mem.stat', { pid: opts.pid })).procs?.find(
          (p) => p.pid === opts.pid,
        )?.softLimit;
      } catch {
        softLimit = undefined;
      }
      yield* io.lines(
        pmapLines(detail, softLimit, yield* io.wallClock(), opts.extended, yield* io.isTty(1)),
      );
      return 0;
    } catch (e) {
      yield* io.error(`${opts.pid}: ${describe(e)}`);
      return 1;
    }
  },
});
