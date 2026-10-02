/**
 * burn: the CPU-bound demonstration program (processes-and-scheduling.md §3.18.10, KPS-14).
 *
 * A checkpointable program whose state is `{remainingMs, iterations, cpuMs, maxStepUs}`. It
 * computes in steps of `--step-us` µs of CPU time and yields `ctx.tick` between steps, so the
 * executor can pre-empt it at its quantum (PROC-03), the aging bound can be measured against it
 * (PROC-04) and three of them never cost a frame (PROC-05). CPU time is the time spent inside its
 * own steps, measured with `ctx.now()` within one step, so it is independent of the executor's
 * clock base and survives a migration.
 *
 * `--threads T` (or `--exclusive`) makes it a parent that spawns T single-thread burns and waits.
 */
import type { ArgsIn, SignalName, WaitStatus } from '@plotinium/protocol';
import type { ProgramContext, SysGen } from '@plotinium/kernel/sys';
import { errnoOf } from '@plotinium/kernel/sys';

import type { DemoState, Out } from '../lib/cli.ts';
import {
  defineDemo,
  errText,
  intOption,
  parseFor,
  statusFor,
  takeSignal,
  UsageError,
} from '../lib/cli.ts';

/** The manifest the shell resolves `burn` to; threads are spawned from it. */
export const BURN_MANIFEST = '/bin/burn.json';
/** STEP_MAX_US: the most work a conforming program does between two yield points. */
export const STEP_MAX_US = 500;
export const DEFAULT_STEP_US = 100;
export const MAX_THREADS = 64;

export interface BurnOpts {
  /** CPU ms to burn, or null to run until killed. */
  readonly ms: number | null;
  readonly stepUs: number;
  readonly threads: number;
  readonly priority: number | null;
  readonly nice: number | null;
  readonly exclusive: boolean;
  /** Seconds between progress lines; 0 = none. */
  readonly progress: number;
  readonly json: boolean;
}

export interface ThreadResult {
  readonly pid: number;
  readonly status: number;
}

export interface BurnWork {
  /** CPU ms still to burn; null = unlimited. */
  remainingMs: number | null;
  iterations: number;
  cpuMs: number;
  maxStepUs: number;
  /** The compute kernel's accumulator, kept so the work has an observable result. */
  acc: number;
  prioritySet: boolean;
  /** Thread mode: spawned child pids, in spawn order. */
  threads: number[];
  finished: ThreadResult[];
  exclusiveRefused: boolean;
  spawnFailed: boolean;
  stoppedBy: SignalName | null;
}

export function parseBurn(args: readonly string[]): BurnOpts {
  const p = parseFor('burn', args);
  if (p.operands.length > 0) throw new UsageError(`burn: extra operand '${p.operands[0] ?? ''}'`);
  const opt = (key: string, flag: string, min: number, max: number): number | null => {
    const raw = p.value(key);
    return raw === undefined ? null : intOption('burn', flag, raw, min, max);
  };
  return {
    ms: opt('ms', '--ms', 1, 2_147_483_647),
    stepUs: opt('step-us', '--step-us', 1, 1_000_000) ?? DEFAULT_STEP_US,
    threads: opt('t', '--threads', 1, MAX_THREADS) ?? 1,
    priority: opt('priority', '--priority', 0, 39),
    nice: opt('n', '--nice', -20, 19),
    exclusive: p.has('exclusive'),
    progress: opt('p', '--progress', 0, 86_400) ?? 0,
    json: p.has('json'),
  };
}

export function startBurn(opts: BurnOpts): BurnWork {
  return {
    remainingMs: opts.ms,
    iterations: 0,
    cpuMs: 0,
    maxStepUs: 0,
    acc: 0x2545f491,
    prioritySet: false,
    threads: [],
    finished: [],
    exclusiveRefused: false,
    spawnFailed: false,
    stoppedBy: null,
  };
}

// -----------------------------------------------------------------------------------------------
// The compute kernel (plain function: one step between two yield points)
// -----------------------------------------------------------------------------------------------

export interface StepResult {
  readonly iterations: number;
  readonly elapsedMs: number;
  readonly acc: number;
}

/**
 * Computes for `ms` of time on `now` (at least one iteration). An iteration is 32 rounds of
 * xorshift32 on the accumulator, a few tens of nanoseconds.
 */
export function spin(now: () => number, ms: number, acc: number): StepResult {
  const t0 = now();
  const end = t0 + ms;
  let x = acc === 0 ? 0x2545f491 : acc;
  let n = 0;
  let t: number;
  do {
    for (let k = 0; k < 32; k++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
    }
    n++;
    t = now();
  } while (t < end);
  return { iterations: n, elapsedMs: t - t0, acc: x >>> 0 };
}

// -----------------------------------------------------------------------------------------------
// Output
// -----------------------------------------------------------------------------------------------

export function finalLine(w: BurnWork): string {
  const stopped = w.stoppedBy === null ? '' : ` (stopped by ${w.stoppedBy})`;
  return `burn: ${String(w.iterations)} iterations, ${String(Math.round(w.cpuMs))} ms CPU, max step ${String(w.maxStepUs)} us${stopped}`;
}

export function progressLine(o: BurnOpts, w: BurnWork): string {
  const cpu = Math.round(w.cpuMs);
  const of =
    o.ms === null
      ? `${String(cpu)} ms CPU`
      : `${String(cpu)} of ${String(o.ms)} ms CPU (${String(Math.min(100, Math.floor((w.cpuMs / o.ms) * 100)))}%)`;
  return `burn: ${of}, ${String(w.iterations)} iterations, max step ${String(w.maxStepUs)} us`;
}

function finalJson(w: BurnWork): string {
  return JSON.stringify({
    iterations: w.iterations,
    cpuMs: Math.round(w.cpuMs),
    maxStepUs: w.maxStepUs,
    stoppedBy: w.stoppedBy,
  });
}

function exitCode(s: WaitStatus): number | null {
  if (s.kind === 'exited' || s.kind === 'signaled') return s.code;
  return null;
}

/** argv of one thread: the same work, single-threaded. */
export function threadArgv(o: BurnOpts): string[] {
  const argv = ['burn', '-t', '1', '--step-us', String(o.stepUs)];
  if (o.ms !== null) argv.push('--ms', String(o.ms));
  if (o.priority !== null) argv.push('--priority', String(o.priority));
  if (o.nice !== null) argv.push('--nice', String(o.nice));
  if (o.progress > 0) argv.push('--progress', String(o.progress));
  if (o.json) argv.push('--json');
  return argv;
}

// -----------------------------------------------------------------------------------------------
// run
// -----------------------------------------------------------------------------------------------

function* burnLoop(
  ctx: ProgramContext,
  out: Out,
  o: BurnOpts,
  w: BurnWork,
  st: DemoState<BurnOpts, BurnWork>,
): SysGen<number> {
  if (!w.prioritySet && (o.priority !== null || o.nice !== null)) {
    try {
      yield* ctx.sys.setpriority({
        pid: 0,
        ...(o.priority === null ? {} : { priority: o.priority }),
        ...(o.nice === null ? {} : { nice: o.nice }),
      });
    } catch (e) {
      yield* out.error(`cannot set priority: ${errText(e)}`);
      return 1;
    }
    w.prioritySet = true;
  }

  const stepMs = o.stepUs / 1000;
  const progressMs = o.progress * 1000;
  // Executor time is not state: after a restore the progress timer starts again.
  let lastReport = ctx.now();
  for (;;) {
    const sig = takeSignal(st);
    if (sig === 'SIGUSR1') {
      yield* out.line(progressLine(o, w));
      continue;
    }
    if (sig !== null) {
      w.stoppedBy = sig;
      break;
    }
    if (w.remainingMs !== null && w.remainingMs <= 0) break;

    const budget = w.remainingMs === null ? stepMs : Math.min(stepMs, w.remainingMs);
    const r = spin(() => ctx.now(), budget, w.acc);
    w.iterations += r.iterations;
    w.cpuMs += r.elapsedMs;
    w.acc = r.acc;
    w.maxStepUs = Math.max(w.maxStepUs, Math.round(r.elapsedMs * 1000));
    if (w.remainingMs !== null) w.remainingMs = Math.max(0, w.remainingMs - r.elapsedMs);

    if (progressMs > 0 && ctx.now() - lastReport >= progressMs) {
      lastReport = ctx.now();
      yield* out.line(progressLine(o, w));
    }
    yield ctx.tick;
  }
  yield* out.line(o.json ? finalJson(w) : finalLine(w));
  return w.stoppedBy === null ? 0 : statusFor(w.stoppedBy);
}

/** `spawn` with the `exclusive` field of processes-and-scheduling.md §4.5 (requested in the ABI). */
type SpawnArgsX = ArgsIn<'spawn'> & { exclusive?: boolean };

function* threadsLoop(
  ctx: ProgramContext,
  out: Out,
  o: BurnOpts,
  w: BurnWork,
  st: DemoState<BurnOpts, BurnWork>,
): SysGen<number> {
  while (w.threads.length < o.threads && !w.spawnFailed && w.stoppedBy === null) {
    const exclusive = o.exclusive && !w.exclusiveRefused;
    const args: SpawnArgsX = {
      path: BURN_MANIFEST,
      argv: threadArgv(o),
      ...(exclusive ? { exclusive: true } : {}),
    };
    try {
      const { pid } = yield* ctx.sys.spawn(args);
      w.threads.push(pid);
    } catch (e) {
      const errno = errnoOf(e);
      if (exclusive && (errno === 'EINVAL' || errno === 'EPERM')) {
        w.exclusiveRefused = true;
        yield* out.error(
          `warning: exclusive placement refused (${errText(e)}); threads share executors`,
        );
        continue;
      }
      yield* out.error(`cannot spawn thread: ${errText(e)}`);
      w.spawnFailed = true;
    }
  }
  if (w.spawnFailed) yield* signalThreads(ctx, w, 'SIGTERM');

  const done = (): boolean => w.finished.length >= w.threads.length;
  while (!done()) {
    const sig = takeSignal(st);
    if (sig !== null) {
      if (sig !== 'SIGUSR1' && w.stoppedBy === null) w.stoppedBy = sig;
      yield* signalThreads(ctx, w, sig);
      continue;
    }
    let r: { pid: number; status?: WaitStatus };
    try {
      r = yield* ctx.sys.wait({ pid: -1 });
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === 'ECANCELED') continue;
      if (errno === 'ESRCH') break;
      throw e;
    }
    const code = r.status === undefined ? null : exitCode(r.status);
    if (code !== null && w.threads.includes(r.pid) && !w.finished.some((f) => f.pid === r.pid)) {
      w.finished.push({ pid: r.pid, status: code });
    }
  }

  const codes = w.threads.map((pid) => w.finished.find((f) => f.pid === pid)?.status ?? -1);
  if (o.json) {
    yield* out.line(
      JSON.stringify({
        threads: w.threads.length,
        exclusive: o.exclusive && !w.exclusiveRefused,
        children: w.finished,
        stoppedBy: w.stoppedBy,
      }),
    );
  } else {
    const stopped = w.stoppedBy === null ? '' : ` (stopped by ${w.stoppedBy})`;
    yield* out.line(
      `burn: ${String(w.threads.length)} threads done, exit status ${codes.map(String).join(' ')}${stopped}`,
    );
  }
  if (w.stoppedBy !== null) return statusFor(w.stoppedBy);
  if (w.spawnFailed || codes.some((c) => c !== 0)) return 1;
  return 0;
}

function* signalThreads(ctx: ProgramContext, w: BurnWork, sig: SignalName): SysGen<void> {
  for (const pid of w.threads) {
    if (w.finished.some((f) => f.pid === pid)) continue;
    try {
      yield* ctx.sys.kill({ pid, sig });
    } catch (e) {
      if (errnoOf(e) === undefined) throw e;
    }
  }
}

const burn = defineDemo<BurnOpts, BurnWork>({
  name: 'burn',
  checkpointable: true,
  catches: ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR1'],
  parse: parseBurn,
  start: startBurn,
  *run(ctx, out, o, w, st) {
    if (o.threads > 1 || o.exclusive || w.threads.length > 0)
      return yield* threadsLoop(ctx, out, o, w, st);
    return yield* burnLoop(ctx, out, o, w, st);
  },
});

export default burn;
