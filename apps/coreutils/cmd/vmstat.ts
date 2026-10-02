/**
 * `vmstat [-w] [--json] [DELAY [COUNT]] [-p [PID...]]` (memory-and-paging.md §3.17.2). The first
 * line covers the time since boot, each later line one DELAY. The interval hit ratio is derived
 * from the cumulative ratio and fault count (hits = faults × r / (1 − r)).
 */
import type { MemStat } from '@plotinium/protocol';

import { defineCommand, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import { binSize, escapeName, table } from '../lib/format.ts';
import type { Io } from '../lib/io.ts';
import type { MemStatX, ProcMem } from '../lib/mem.ts';
import { freeBytes, orDash } from '../lib/mem.ts';
import type { ProcRow } from '../lib/procs.ts';
import { commandLine, listProcs } from '../lib/procs.ts';
import type { SysGen } from '../lib/sys.ts';

export interface VmstatOpts {
  readonly delayMs: number | null;
  readonly count: number | null;
  readonly perProcess: boolean;
  readonly pids: readonly number[];
  readonly wide: boolean;
  readonly json: boolean;
}

export function parseVmstat(args: readonly string[]): VmstatOpts {
  const numbers: number[] = [];
  const pids: number[] = [];
  let perProcess = false;
  let wide = false;
  let json = false;
  for (const a of args) {
    if (a === '-p') perProcess = true;
    else if (a === '-w' || a === '--wide') wide = true;
    else if (a === '--json') json = true;
    else if (/^\d+(\.\d+)?$/.test(a)) (perProcess ? pids : numbers).push(Number(a));
    else if (a.startsWith('-'))
      throw new UsageError(
        a.startsWith('--') ? `unrecognized option '${a}'` : `invalid option -- '${a.slice(1, 2)}'`,
      );
    else throw new UsageError(`invalid argument '${a}'`);
  }
  if (numbers.length > 2) throw new UsageError(`extra operand '${numbers[2] ?? ''}'`);
  const [delay, count] = numbers;
  if (delay !== undefined && delay <= 0) throw new UsageError('delay must be positive');
  if (count !== undefined && (!Number.isInteger(count) || count < 1))
    throw new UsageError('count must be a positive integer');
  return {
    delayMs: delay === undefined ? null : Math.round(delay * 1000),
    count: delay === undefined ? 1 : (count ?? null),
    perProcess,
    pids,
    wide,
    json,
  };
}

const TITLE =
  'procs ------memory (MiB)------- ---------paging--------- -----swap (KiB/s)----- ---cpu---';
const HEAD = [
  'r',
  'b',
  's',
  'used',
  'free',
  'rsv',
  'pin',
  'flt',
  'hit%',
  'pi',
  'po',
  'si',
  'so',
  'ro',
  'us',
  'ke',
  'id',
];
const WIDTHS = [2, 2, 2, 6, 5, 4, 4, 5, 5, 5, 5, 7, 7, 7, 3, 2, 2];

export interface Point {
  readonly at: number;
  readonly mem: MemStatX;
  readonly procs: readonly ProcRow[];
}

function hits(m: MemStat): number {
  return m.hitRatio >= 1 ? Number.POSITIVE_INFINITY : (m.faults * m.hitRatio) / (1 - m.hitRatio);
}

/** One system line: rates over `[prev, cur]`, or since boot when `prev` is null. */
export function systemCells(cur: Point, prev: Point | null, sinceBootMs: number): string[] {
  const secs = Math.max(0.001, (prev === null ? sinceBootMs : cur.at - prev.at) / 1000);
  const m = cur.mem;
  const count = (states: readonly string[]): number =>
    cur.procs.filter((p) => states.includes(p.state)).length;
  const delta = (f: (x: MemStatX) => number | undefined): number | undefined => {
    const now = f(m);
    const then = prev === null ? 0 : f(prev.mem);
    return now === undefined || then === undefined ? undefined : now - then;
  };
  const dh = prev === null ? hits(m) : hits(m) - hits(prev.mem);
  const df = delta((x) => x.faults) ?? 0;
  const ratio = Number.isFinite(dh) && dh + df > 0 ? dh / (dh + df) : m.hitRatio;
  const mib = (n: number | undefined): string => orDash(n, (x) => (x / 1_048_576).toFixed(1));
  const rate = (n: number | undefined, div = 1): string =>
    orDash(n, (x) => String(Math.round(x / div / secs)));
  return [
    String(count(['READY', 'RUNNING'])),
    String(count(['BLOCKED'])),
    String(count(['SUSPENDED'])),
    mib(m.accounted),
    mib(freeBytes(m)),
    mib(m.reservedWaiting),
    mib(m.pinned),
    rate(df),
    (ratio * 100).toFixed(1),
    rate(delta((x) => x.pagesIn)),
    rate(delta((x) => x.pagesOut)),
    rate(
      delta((x) => x.bytesIn),
      1024,
    ),
    rate(
      delta((x) => x.bytesOut),
      1024,
    ),
    rate(
      delta((x) => x.bytesUploaded),
      1024,
    ),
    '-',
    '-',
    '-',
  ];
}

export function systemLine(cells: readonly string[], wide: boolean): string {
  return cells.map((c, i) => c.padStart((WIDTHS[i] ?? 5) + (wide ? 2 : 0))).join(' ');
}

export function perProcessLines(
  mem: MemStatX,
  procs: readonly ProcRow[],
  pids: readonly number[],
  tty: boolean,
): string[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const rows: ProcMem[] = (mem.procs ?? []).filter(
    (p) => pids.length === 0 || pids.includes(p.pid),
  );
  const size = (n: number | undefined): string => orDash(n, binSize);
  return table(
    [
      [
        'PID',
        'USER',
        'RES',
        'SWAP-L',
        'SWAP-R',
        'WS',
        'FLT',
        'HIT%',
        'IN',
        'OUT',
        'LAST-IN',
        'COMMAND',
      ],
      ...rows.map((p) => {
        const info = byPid.get(p.pid);
        return [
          String(p.pid),
          info?.user ?? '?',
          size(p.resident),
          size(p.swapLocal),
          size(p.swapRemote),
          size(p.ws),
          String(p.faults),
          (p.hitRatio * 100).toFixed(1),
          size(p.bytesIn),
          size(p.bytesOut),
          orDash(p.lastPageInMs, (x) => `${Math.round(x)} ms`),
          escapeName(info === undefined ? '?' : commandLine(info), tty),
        ];
      }),
    ],
    new Set([0, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    1,
    [7, 8, 8, 8, 8, 8, 6, 6, 8, 8, 9],
  );
}

function* point(io: Io): SysGen<Point> {
  const mem = yield* io.sys.call('mem.stat', {});
  const procs = yield* listProcs(io.sys);
  return { at: io.ctx.now(), mem, procs };
}

export default defineCommand<VmstatOpts>({
  name: 'vmstat',
  parse: parseVmstat,
  *run(io, opts) {
    const tty = yield* io.isTty(1);
    let prev: Point | null = null;
    try {
      const { uptimeMs } = yield* io.sys.call('uptime', {});
      for (let i = 0; opts.count === null || i < opts.count; i++) {
        if (i > 0) {
          yield* io.flush();
          try {
            yield* io.sys.call('sleep', { ms: opts.delayMs ?? 1000 });
          } catch (e) {
            if (mustErrno(e) === 'ECANCELED') return 0;
            throw e;
          }
        }
        const cur = yield* point(io);
        if (opts.json) yield* io.line(JSON.stringify(cur.mem));
        else if (opts.perProcess) {
          if (i > 0) yield* io.line();
          yield* io.lines(perProcessLines(cur.mem, cur.procs, opts.pids, tty));
        } else {
          if (i === 0) yield* io.lines([TITLE, systemLine(HEAD, opts.wide)]);
          yield* io.line(systemLine(systemCells(cur, prev, uptimeMs), opts.wide));
        }
        prev = cur;
      }
    } catch (e) {
      yield* io.error(describe(e));
      return 1;
    }
    return 0;
  },
});
