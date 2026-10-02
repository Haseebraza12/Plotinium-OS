/**
 * `top [-b] [-n N] [-d SECS] [-u USER] [-p PID] [-o FIELD] [--json]`
 * (processes-and-scheduling.md §3.18.3). `%CPU` is the CPU time of the last interval divided by
 * the interval; the first frame uses the kernel's figure.
 *
 * Interactive screen (UI-120): the TTY is put in raw mode without echo, and between frames `top`
 * blocks in a `read` of the keyboard while a `sleep` child times the frame; the child's exit
 * (SIGCHLD) interrupts the read, which draws the next frame. `q` quits at once, as do SIGINT
 * (Ctrl-C), SIGTERM and SIGHUP; keys typed while it runs are read by `top`, so none reaches the
 * shell afterwards. Where no `sleep` program can be started, it falls back to sleeping itself
 * (keys then wait until it ends, as before).
 *
 * TODO(R1): the `Sched:` line and the CPU `us/id/kernel` split need a `sched.info` call; the other
 * interactive keys (`k`, `r`, `P`, `M`, `T`, `s`) are read and ignored for now.
 */
import type { MemStat } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import { envRecord, lookupCommand } from '../lib/exec.ts';
import { binSize, clock, escapeName, hms } from '../lib/format.ts';
import type { Io } from '../lib/io.ts';
import { freeBytes } from '../lib/mem.ts';
import type { FieldEnv, ProcRow } from '../lib/procs.ts';
import { fieldName, listProcs, renderTable, sortRows } from '../lib/procs.ts';
import { decodeText } from '../lib/sys.ts';
import type { SysGen } from '../lib/sys.ts';
import { findUid, loadUsers } from '../lib/users.ts';
import type { CommandState } from '../lib/command.ts';

export interface TopOpts {
  readonly batch: boolean;
  readonly iterations: number | null;
  readonly delayMs: number;
  readonly user: string | null;
  readonly pids: readonly number[];
  readonly sort: string;
  readonly json: boolean;
}

export const TOP_FIELDS = [
  'pid',
  'user',
  'pri',
  'ni',
  'eprio',
  'cls',
  'stat',
  'pcpu',
  'rss',
  'swap',
  'flt',
  'exe',
  'time',
  'args',
] as const;
const HEADERS = { rss: 'RES', time: 'TIME+' } as const;

export interface Sample {
  /** Wall-clock epoch ms (`time.now`): the header's time of day and the ELAPSED column. */
  readonly now: number;
  /** Monotonic ms (`ctx.now()`): the %CPU interval between frames. */
  readonly mono: number;
  readonly tz: number;
  readonly up: {
    readonly uptimeMs: number;
    readonly users: number;
    readonly load: readonly number[];
  };
  readonly rows: readonly ProcRow[];
  readonly mem: MemStat | null;
}

const n3 = (n: number): string => String(n).padStart(3);

export function taskLine(rows: readonly ProcRow[]): string {
  const count = (states: readonly string[]): number =>
    rows.filter((r) => states.includes(r.state)).length;
  return `Tasks: ${n3(rows.length)} total, ${n3(count(['RUNNING']))} running, ${n3(count(['READY']))} ready, ${n3(count(['BLOCKED']))} blocked, ${n3(count(['SUSPENDED']))} suspended, ${n3(count(['TERMINATED']))} zombie`;
}

export function memLines(mem: MemStat | null): string[] {
  if (mem === null) return ['Mem:  unavailable'];
  return [
    `Memory: see free; faults ${Math.round(mem.faultsPerSec)}/s, hit ${(mem.hitRatio * 100).toFixed(1)}%`,
    `Mem:  ${binSize(mem.budget)} total, ${binSize(mem.accounted)} used, ${binSize(mem.reservedWaiting)} rsv, ${binSize(freeBytes(mem))} free   Swap: L ${binSize(mem.swappedLocal)}  R ${binSize(mem.swappedRemote)}`,
  ];
}

export function frame(s: Omit<Sample, 'mono'>, sort: string): string[] {
  const users = `${s.up.users} user${s.up.users === 1 ? '' : 's'}`;
  const load = s.up.load.map((l) => l.toFixed(2)).join(', ');
  const env: FieldEnv = { now: s.now, tz: s.tz };
  const rows = [...s.rows];
  sortRows(rows, [{ field: sort, desc: sort !== 'pid' }], env);
  return [
    `top - ${clock(s.now, s.tz)} up ${hms(s.up.uptimeMs)},  ${users},  load average: ${load}`,
    taskLine(s.rows),
    ...memLines(s.mem),
    '',
    ...renderTable(rows, TOP_FIELDS, env, { headerOverride: HEADERS }),
  ];
}

/** Interval CPU% from two samples of `cpuTimeMs`; the first frame keeps the kernel's figure. */
export function withIntervalCpu(
  rows: readonly ProcRow[],
  prev: ReadonlyMap<number, number> | null,
  intervalMs: number,
): ProcRow[] {
  if (prev === null || intervalMs <= 0) return [...rows];
  return rows.map((r) => {
    const before = prev.get(r.pid) ?? r.cpuTimeMs;
    return {
      ...r,
      cpuPct: Math.min(100, Math.max(0, ((r.cpuTimeMs - before) / intervalMs) * 100)),
    };
  });
}

function* sample(io: Io, opts: TopOpts, uid: number | null): SysGen<Sample> {
  const up = yield* io.sys.call('uptime', {});
  let mem: MemStat | null = null;
  try {
    mem = yield* io.sys.call('mem.stat', {});
  } catch (e) {
    mustErrno(e);
  }
  const rows = (yield* listProcs(io.sys)).filter(
    (r) => (uid === null || r.uid === uid) && (opts.pids.length === 0 || opts.pids.includes(r.pid)),
  );
  // ctx.now() is the executor's monotonic clock: as a time of day it showed the uptime shifted
  // by the time zone (05:03:13 at 09:55, UI-119). The header uses the wall clock, as uptime does.
  const mono = io.ctx.now();
  const now = yield* io.wallClock();
  return { now, mono, tz: yield* io.tzOffset(), up, rows, mem };
}

const QUIT = new Set(['SIGINT', 'SIGTERM', 'SIGHUP']);

/** The keys that end the interactive screen. */
export function quitsTop(input: string): boolean {
  return input.includes('q') || input.includes('Q');
}

/** A running frame timer: the `sleep` child whose exit means "draw the next frame". */
interface Ticker {
  readonly pid: number;
}

/** Starts a `sleep` child for one frame, or null when none can be started here. */
function* startTicker(io: Io, path: string, ms: number): SysGen<Ticker | null> {
  try {
    const { pid } = yield* io.sys.call('spawn', {
      path,
      argv: ['sleep', (ms / 1000).toFixed(3)],
      env: envRecord(io),
      cwd: io.ctx.cwd,
    });
    return { pid };
  } catch (e) {
    mustErrno(e);
    return null;
  }
}

/** Ends a ticker (it may already have exited) and reaps it. */
function* stopTicker(io: Io, t: Ticker): SysGen<void> {
  try {
    yield* io.sys.call('kill', { pid: t.pid, sig: 'SIGKILL' });
  } catch (e) {
    mustErrno(e);
  }
  try {
    yield* io.sys.call('wait', { pid: t.pid });
  } catch (e) {
    mustErrno(e);
  }
}

/**
 * Waits for the next frame on the interactive screen: 'frame' when the ticker fired or the window
 * changed size, 'quit' for `q`, end of input or a quit signal.
 */
function* nextFrame(io: Io, st: CommandState<TopOpts>): SysGen<'frame' | 'quit'> {
  for (;;) {
    // Signals that arrived while the frame was drawn are acted on before blocking again.
    const caught = st.caught.splice(0);
    if (caught.some((s) => QUIT.has(s))) return 'quit';
    if (caught.includes('SIGCHLD') || caught.includes('SIGWINCH')) return 'frame';
    let input: ArrayBuffer;
    try {
      input = yield* io.sys.call('read', { fd: 0, len: 64 });
    } catch (e) {
      // A caught signal (the ticker's SIGCHLD, a resize, a quit) interrupts the read.
      if (mustErrno(e) !== 'ECANCELED') throw e;
      continue;
    }
    if (input.byteLength === 0 || quitsTop(decodeText(input))) return 'quit';
  }
}

/** Drops the SIGCHLD of a ticker that was stopped, keeping every other caught signal. */
function forgetChild(st: CommandState<TopOpts>): void {
  const rest = st.caught.filter((s) => s !== 'SIGCHLD');
  st.caught.length = 0;
  st.caught.push(...rest);
}

/** The terminal size, read on every frame so a resize (SIGWINCH) takes effect at once. */
function* termSize(io: Io): SysGen<{ cols: number; rows: number }> {
  try {
    const attr = yield* io.sys.call('tty.getattr', { fd: 1 });
    return { cols: attr.cols, rows: attr.rows };
  } catch {
    return { cols: 80, rows: 24 };
  }
}

/** Sleeps one delay; true when a quit signal arrived. */
function* pause(io: Io, st: CommandState<TopOpts>, ms: number): SysGen<boolean> {
  try {
    yield* io.sys.call('sleep', { ms });
  } catch (e) {
    if (mustErrno(e) !== 'ECANCELED') throw e;
  }
  const quit = st.caught.some((s) => QUIT.has(s));
  st.caught.length = 0;
  return quit;
}

export default defineCommand<TopOpts>({
  name: 'top',
  catches: ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGWINCH', 'SIGCHLD'],
  parse(args) {
    const p = parseFor('top', args);
    if (p.operands.length > 0) throw new UsageError(`unknown argument '${p.operands[0] ?? ''}'`);
    const n = p.value('n');
    const iterations = n === undefined ? null : Number(n);
    if (iterations !== null && (!Number.isInteger(iterations) || iterations < 1))
      throw new UsageError(`bad iterations argument '${n ?? ''}'`);
    const d = Number(p.value('d') ?? '1');
    if (!Number.isFinite(d) || d < 0.5) throw new UsageError('delay must be at least 0.5 seconds');
    const sort = fieldName(p.value('o') ?? 'pcpu');
    if (sort === undefined) throw new UsageError(`unknown field '${p.value('o') ?? ''}'`);
    const pids = p
      .values('p')
      .flatMap((v) => v.split(','))
      .map(Number);
    if (pids.some((x) => !Number.isInteger(x) || x < 1)) throw new UsageError('bad pid list');
    return {
      batch: p.has('b'),
      iterations,
      delayMs: Math.round(d * 1000),
      user: p.value('u') ?? null,
      pids,
      sort,
      json: p.has('json'),
    };
  },
  *run(io, opts, st) {
    let uid: number | null = null;
    if (opts.user !== null) {
      uid = findUid(yield* loadUsers(io.sys), opts.user) ?? null;
      if (uid === null) {
        yield* io.error(`no such user '${opts.user}'`);
        return 1;
      }
    }
    const screen = !opts.batch && !opts.json && (yield* io.isTty(1));
    const tty = yield* io.isTty(1);
    // The interactive keys need the keyboard and a `sleep` program to time the frames.
    const sleepPath = screen && (yield* io.isTty(0)) ? yield* lookupCommand(io, 'sleep') : null;
    let saved: { canonical: boolean; echo: boolean } | null = null;
    if (screen) yield* io.out('\x1b[?1049h\x1b[?25l');
    let prev: Map<number, number> | null = null;
    let prevAt = 0;
    try {
      for (let i = 0; opts.iterations === null || i < opts.iterations; i++) {
        const s = yield* sample(io, opts, uid);
        const rows = withIntervalCpu(s.rows, prev, s.mono - prevAt);
        prev = new Map(s.rows.map((r) => [r.pid, r.cpuTimeMs]));
        prevAt = s.mono;
        const current = { now: s.now, tz: s.tz, up: s.up, rows, mem: s.mem };
        if (opts.json) yield* io.line(JSON.stringify(current));
        else {
          const lines = frame(current, opts.sort).map((l) => escapeName(l, tty));
          if (screen) {
            const size = yield* termSize(io);
            const shown = lines
              .slice(0, size.rows - 1)
              .map((l) => [...l].slice(0, size.cols).join(''));
            yield* io.out(`\x1b[H\x1b[2J${shown.join('\r\n')}`);
          } else {
            if (i > 0) yield* io.line();
            yield* io.lines(lines);
          }
        }
        yield* io.flush();
        if (opts.iterations !== null && i + 1 >= opts.iterations) break;
        const ticker = sleepPath === null ? null : yield* startTicker(io, sleepPath, opts.delayMs);
        if (ticker === null) {
          if (yield* pause(io, st, opts.delayMs)) break;
          continue;
        }
        if (saved === null) {
          const attr = yield* io.sys.call('tty.getattr', { fd: 0 });
          saved = { canonical: attr.canonical, echo: attr.echo };
          yield* io.sys.call('tty.setattr', { fd: 0, canonical: false, echo: false });
        }
        const next = yield* nextFrame(io, st);
        yield* stopTicker(io, ticker);
        forgetChild(st);
        if (next === 'quit') break;
      }
    } catch (e) {
      yield* io.error(describe(e));
      return 1;
    } finally {
      if (saved !== null) {
        try {
          yield* io.sys.call('tty.setattr', {
            fd: 0,
            canonical: saved.canonical,
            echo: saved.echo,
          });
        } catch (e) {
          mustErrno(e);
        }
      }
      if (screen) {
        yield* io.out('\x1b[?25h\x1b[?1049l');
        yield* io.flush();
      }
    }
    return 0;
  },
});
