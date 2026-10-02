/**
 * memhog: the memory stress program of MEM-06 and Demo Day item 5 (memory-and-paging.md §3.17.5,
 * KMM-14).
 *
 * The parent spawns N children and reports; each child allocates its share in 256 KiB pages
 * through the page API (lib/pages.ts: `ctx.mem.alloc` or the `mem.alloc` fallback), so every byte
 * is reserved before it exists and a child simply waits (BLOCKED on `mem`) while reclaim makes
 * room: accounted memory never exceeds the budget (MEM-06). Page bodies follow a deterministic
 * pattern (lib/pattern.ts) and their checksums live in the child's small state, so every read
 * touch verifies that a page which was paged out came back byte-identical (MEM-03), and a restored
 * child re-verifies every page before it continues.
 */
import type { MemStat, SignalName, WaitStatus } from '@plotinium/protocol';
import type { ProgramContext, SysGen } from '@plotinium/kernel/sys';
import { errnoOf } from '@plotinium/kernel/sys';

import type { DemoState, Out } from '../lib/cli.ts';
import {
  binSize,
  defineDemo,
  epochNow,
  errText,
  intOption,
  nap,
  numberOption,
  parseFor,
  sizeOption,
  statusFor,
  takeSignal,
  thousands,
  UsageError,
} from '../lib/cli.ts';
import type { PageBackend } from '../lib/pages.ts';
import { backendFor, PAGE_CHUNK } from '../lib/pages.ts';
import type { PageKey } from '../lib/pattern.ts';
import { checksum, DEFAULT_SEED, fillPage, mulberryStep, pageSeed } from '../lib/pattern.ts';

/** The manifest the shell resolves `memhog` to; children are spawned from it. */
export const MEMHOG_MANIFEST = '/bin/memhog.json';
export const MAX_PROCS = 64;
/** 64 GiB: far above any budget; a share that can never fit is refused by the kernel instead. */
export const MAX_TOTAL = 68_719_476_736;
/** Exit status of a child that found a page whose bytes changed. */
export const EXIT_MISMATCH = 3;
/** How many times a refused spawn or allocation (EAGAIN) is retried, one second apart. */
export const EAGAIN_RETRIES = 30;

export type TouchOrder = 'random' | 'seq';

export interface MemhogOpts {
  readonly total: number;
  readonly procs: number;
  readonly touch: TouchOrder;
  readonly rate: number;
  readonly writeRatio: number;
  readonly compressible: boolean;
  readonly hold: number | null;
  readonly seed: number;
  readonly report: number;
  /** Set in children only: their index under the parent. */
  readonly child: number | null;
}

export interface ChildWork {
  readonly kind: 'child';
  readonly index: number;
  readonly bytes: number;
  readonly pages: number;
  phase: 'alloc' | 'touch' | 'free' | 'done';
  /** Page handles (page ids or segment ids), by page index. */
  handles: number[];
  /** Write generation of each page. */
  gens: number[];
  /** Checksum of each page's current generation. */
  sums: string[];
  touches: number;
  writes: number;
  verified: number;
  mismatches: number;
  /** mulberry32 state of the touch order. */
  rng: number;
  cursor: number;
  /** Epoch ms when touching stops (`--hold`), fixed when touching starts. */
  holdUntil: number | null;
  maxBlockedMs: number;
  eagain: number;
  freed: number;
  failed: boolean;
  stoppedBy: SignalName | null;
}

export interface ChildResult {
  readonly pid: number;
  readonly index: number;
  readonly status: number;
}

export interface ParentWork {
  readonly kind: 'parent';
  /** Child pids, by child index. */
  children: number[];
  finished: ChildResult[];
  eagain: number;
  spawnFailed: boolean;
  stoppedBy: SignalName | null;
  peakAllocated: number;
  faults: number | null;
  budget: number | null;
  maxBlockedMs: number | null;
  maxOverBudgetMs: number | null;
}

export type MemhogWork = ChildWork | ParentWork;

// -----------------------------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------------------------

export function parseMemhog(args: readonly string[]): MemhogOpts {
  const p = parseFor('memhog', args);
  if (p.operands.length > 0) throw new UsageError(`memhog: extra operand '${p.operands[0] ?? ''}'`);
  const rawTotal = p.value('total');
  if (rawTotal === undefined) throw new UsageError('memhog: missing --total SIZE');
  const total = sizeOption('memhog', '--total', rawTotal, 1, MAX_TOTAL);
  const int = (key: string, min: number, max: number, dflt: number): number => {
    const raw = p.value(key);
    return raw === undefined ? dflt : intOption('memhog', `--${key}`, raw, min, max);
  };
  const touch = p.value('touch') ?? 'random';
  if (touch !== 'random' && touch !== 'seq')
    throw new UsageError(`memhog: invalid --touch '${touch}' (random or seq)`);
  const procs = int('procs', 1, MAX_PROCS, 1);
  if (total < procs)
    throw new UsageError(`memhog: --total ${rawTotal} is less than one byte per process`);
  const rawRatio = p.value('write-ratio');
  const rawHold = p.value('hold');
  const rawChild = p.value('child');
  return {
    total,
    procs,
    touch,
    rate: int('rate', 0, 100_000, 50),
    writeRatio:
      rawRatio === undefined ? 0.25 : numberOption('memhog', '--write-ratio', rawRatio, 0, 1),
    compressible: p.has('compressible'),
    hold: rawHold === undefined ? null : intOption('memhog', '--hold', rawHold, 1, 86_400),
    seed: int('seed', 0, 0xffff_ffff, DEFAULT_SEED),
    report: int('report', 1, 3_600, 5),
    child:
      rawChild === undefined ? null : intOption('memhog', '--child', rawChild, 0, MAX_PROCS - 1),
  };
}

export function startMemhog(o: MemhogOpts): MemhogWork {
  if (o.child === null) {
    return {
      kind: 'parent',
      children: [],
      finished: [],
      eagain: 0,
      spawnFailed: false,
      stoppedBy: null,
      peakAllocated: 0,
      faults: null,
      budget: null,
      maxBlockedMs: null,
      maxOverBudgetMs: null,
    };
  }
  return {
    kind: 'child',
    index: o.child,
    bytes: o.total,
    pages: Math.ceil(o.total / PAGE_CHUNK),
    phase: 'alloc',
    handles: [],
    gens: [],
    sums: [],
    touches: 0,
    writes: 0,
    verified: 0,
    mismatches: 0,
    rng: pageSeed(o.seed, o.child, 0xffff, 0),
    cursor: 0,
    holdUntil: null,
    maxBlockedMs: 0,
    eagain: 0,
    freed: 0,
    failed: false,
    stoppedBy: null,
  };
}

/** Child `index`'s share of `total` (the first `total % procs` children get one byte more). */
export function shareOf(total: number, procs: number, index: number): number {
  return Math.floor(total / procs) + (index < total % procs ? 1 : 0);
}

export function childArgv(o: MemhogOpts, index: number): string[] {
  const argv = [
    'memhog',
    '--child',
    String(index),
    '--total',
    String(shareOf(o.total, o.procs, index)),
  ];
  argv.push(
    '--touch',
    o.touch,
    '--rate',
    String(o.rate),
    '--write-ratio',
    String(o.writeRatio),
    '--seed',
    String(o.seed),
  );
  if (o.compressible) argv.push('--compressible');
  if (o.hold !== null) argv.push('--hold', String(o.hold));
  return argv;
}

// -----------------------------------------------------------------------------------------------
// Child
// -----------------------------------------------------------------------------------------------

export function pageLen(w: ChildWork, page: number): number {
  return Math.min(PAGE_CHUNK, w.bytes - page * PAGE_CHUNK);
}

function keyOf(o: MemhogOpts, w: ChildWork, page: number, gen: number): PageKey {
  return { seed: o.seed, child: w.index, page, gen, compressible: o.compressible };
}

function random(w: ChildWork): number {
  const r = mulberryStep(w.rng);
  w.rng = r.state;
  return r.value;
}

/** The next page to touch: uniform random, or round robin with `--touch seq`. */
export function nextPage(o: MemhogOpts, w: ChildWork): number {
  if (o.touch === 'seq') {
    const page = w.cursor % w.pages;
    w.cursor = (w.cursor + 1) % w.pages;
    return page;
  }
  return Math.min(w.pages - 1, Math.floor(random(w) * w.pages));
}

function tagOf(ctx: ProgramContext, w: ChildWork): string {
  return `child ${String(w.index)} (pid ${String(ctx.pid)})`;
}

export function childStatusLine(ctx: ProgramContext, w: ChildWork): string {
  return (
    `memhog: ${tagOf(ctx, w)}: ${binSize(w.bytes)} in ${String(w.sums.length)}/${String(w.pages)} pages, ` +
    `${thousands(w.touches)} touches (${thousands(w.writes)} writes), ${thousands(w.verified)} verified, ` +
    `${String(w.mismatches)} changed, max blocked ${String(w.maxBlockedMs)} ms`
  );
}

/** Reads page `i` and compares its checksum with the recorded one; re-creates a lost body first. */
function* verifyPage(
  ctx: ProgramContext,
  out: Out,
  pages: PageBackend,
  o: MemhogOpts,
  w: ChildWork,
  i: number,
): SysGen<boolean> {
  const handle = w.handles[i];
  const want = w.sums[i];
  if (handle === undefined || want === undefined) return true;
  const { body, fresh } = yield* pages.get(handle, pageLen(w, i), 'r');
  const got = fresh ? fillPage(body, keyOf(o, w, i, w.gens[i] ?? 0)) : checksum(body);
  w.verified++;
  if (got === want) return true;
  w.mismatches++;
  yield* out.error(
    `${tagOf(ctx, w)}: page ${String(i)} changed after page-in: checksum ${got}, expected ${want}`,
  );
  return false;
}

/** Rewrites page `i` with its next generation (dirties it). */
function* rewritePage(pages: PageBackend, o: MemhogOpts, w: ChildWork, i: number): SysGen<void> {
  const handle = w.handles[i];
  if (handle === undefined) return;
  const gen = (w.gens[i] ?? 0) + 1;
  const { body } = yield* pages.get(handle, pageLen(w, i), 'rw');
  w.sums[i] = fillPage(body, keyOf(o, w, i, gen));
  w.gens[i] = gen;
  w.writes++;
}

/** Handles one caught signal; returns true when the child must stop. */
function* childSignal(
  ctx: ProgramContext,
  out: Out,
  w: ChildWork,
  sig: SignalName,
): SysGen<boolean> {
  if (sig === 'SIGUSR1') {
    yield* out.line(childStatusLine(ctx, w));
    return false;
  }
  w.stoppedBy ??= sig;
  if (w.phase !== 'done') w.phase = 'free';
  return true;
}

function* childRun(
  ctx: ProgramContext,
  out: Out,
  o: MemhogOpts,
  w: ChildWork,
  st: DemoState<MemhogOpts, MemhogWork>,
): SysGen<number> {
  const pages = backendFor(ctx);
  const tag = tagOf(ctx, w);

  // A restored child checks every page it had written before it goes on (MEM-03).
  if (ctx.restored !== 'no' && w.sums.length > 0 && (w.phase === 'alloc' || w.phase === 'touch')) {
    let ok = 0;
    for (let i = 0; i < w.sums.length; i++) {
      if (yield* verifyPage(ctx, out, pages, o, w, i)) ok++;
      yield ctx.tick;
    }
    const how =
      pages.name === 'ctx.mem'
        ? 'verified byte-identical'
        : 're-created from their seeds and verified (no ctx.mem)';
    yield* out.line(
      `memhog: ${tag} restored after ${ctx.restored}: ${String(ok)}/${String(w.sums.length)} pages ${how}`,
    );
  }

  // 1. Allocate and fill, one page per step.
  while (w.phase === 'alloc') {
    const sig = takeSignal(st);
    if (sig !== null) {
      yield* childSignal(ctx, out, w, sig);
      continue;
    }
    const i = w.sums.length;
    if (i >= w.pages) {
      w.phase = 'touch';
      break;
    }
    const len = pageLen(w, i);
    if (w.handles.length === i) {
      const t0 = ctx.now();
      try {
        const handle = yield* pages.alloc(len, `memhog.${String(w.index)}.${String(i)}`);
        w.handles.push(handle);
        w.gens.push(0);
      } catch (e) {
        const errno = errnoOf(e);
        if (errno === 'ECANCELED') continue;
        if (errno === 'EAGAIN' && w.eagain < EAGAIN_RETRIES) {
          w.eagain++;
          if (w.eagain === 1)
            yield* out.error(`${tag}: allocation refused (${errText(e)}); retrying`);
          yield* nap(ctx, 1000);
          continue;
        }
        yield* out.error(`${tag}: cannot allocate ${binSize(len)}: ${errText(e)}`);
        w.failed = true;
        w.phase = 'free';
        break;
      }
      w.maxBlockedMs = Math.max(w.maxBlockedMs, Math.round(ctx.now() - t0));
    }
    const handle = w.handles[i] ?? 0;
    const { body } = yield* pages.get(handle, len, 'rw');
    w.sums.push(fillPage(body, keyOf(o, w, i, 0)));
    yield ctx.tick;
  }

  // 2. Touch at `--rate` pages per second until `--hold` ends or a signal arrives.
  if (w.phase === 'touch' && o.hold !== null && w.holdUntil === null) {
    w.holdUntil = (yield* epochNow(ctx)).epochMs + o.hold * 1000;
  }
  let paceStart = ctx.now();
  let paced = 0;
  let lastClock = ctx.now();
  while (w.phase === 'touch') {
    const sig = takeSignal(st);
    if (sig !== null) {
      yield* childSignal(ctx, out, w, sig);
      continue;
    }
    if (w.holdUntil !== null && ctx.now() - lastClock >= 1000) {
      lastClock = ctx.now();
      if ((yield* epochNow(ctx)).epochMs >= w.holdUntil) {
        w.phase = 'free';
        break;
      }
    }
    const i = nextPage(o, w);
    const write = o.writeRatio > 0 && random(w) < o.writeRatio;
    try {
      if (write) yield* rewritePage(pages, o, w, i);
      else yield* verifyPage(ctx, out, pages, o, w, i);
    } catch (e) {
      if (errnoOf(e) === 'ECANCELED') continue;
      if (errnoOf(e) === undefined) throw e;
      // A fault that failed (EIO: the page is lost, memory-and-paging.md §3.13.1).
      yield* out.error(`${tag}: page ${String(i)} could not be read back: ${errText(e)}`);
      w.mismatches++;
    }
    w.touches++;
    paced++;
    if (o.rate > 0) {
      let wait = paceStart + (paced * 1000) / o.rate - ctx.now();
      if (wait < -1000) {
        // More than a second behind (the child was blocked or paged out): do not burst to catch up.
        paceStart = ctx.now();
        paced = 0;
        wait = 0;
      }
      if (wait >= 1) yield* nap(ctx, Math.round(wait));
      else yield ctx.tick;
    } else {
      yield ctx.tick;
    }
  }

  // 3. Give the pages back.
  while (w.phase === 'free') {
    const handle = w.handles[w.freed];
    if (handle === undefined) {
      w.phase = 'done';
      break;
    }
    try {
      yield* pages.free(handle);
    } catch (e) {
      if (errnoOf(e) === undefined) throw e;
    }
    w.freed++;
  }

  if (w.mismatches > 0) return EXIT_MISMATCH;
  if (w.failed) return 1;
  return w.stoppedBy === null ? 0 : statusFor(w.stoppedBy);
}

// -----------------------------------------------------------------------------------------------
// Parent
// -----------------------------------------------------------------------------------------------

/** Kernel fields of memory-and-paging.md §4.1 `MemSummary` that protocol `MemStat` lacks yet. */
type MemStatX = MemStat & {
  readonly committed?: number;
  readonly oldestBlockedMs?: number;
  readonly maxOverBudgetMs?: number;
};

export interface Sample {
  readonly procs: number;
  readonly allocated: number;
  readonly faults: number;
  readonly faultsPerSec: number | null;
  readonly budget: number | null;
  readonly committed: number | null;
  readonly maxBlockedMs: number | null;
  readonly maxOverBudgetMs: number | null;
}

function orDash(n: number | null, f: (x: number) => string): string {
  return n === null ? '-' : f(n);
}

const ms = (n: number): string => `${String(Math.round(n))} ms`;

/** `memhog: 8 procs, 512.0M allocated, budget 256.0M, committed 254.9M, faults 1832 (41/s), …`. */
export function statusLine(s: Sample): string {
  const rate = s.faultsPerSec === null ? '' : ` (${String(Math.round(s.faultsPerSec))}/s)`;
  return (
    `memhog: ${String(s.procs)} procs, ${binSize(s.allocated)} allocated, budget ${orDash(s.budget, binSize)}, ` +
    `committed ${orDash(s.committed, binSize)}, faults ${String(s.faults)}${rate}, ` +
    `max blocked ${orDash(s.maxBlockedMs, ms)}, max over budget ${orDash(s.maxOverBudgetMs, ms)}`
  );
}

function live(w: ParentWork): number[] {
  return w.children.filter((pid) => !w.finished.some((f) => f.pid === pid));
}

function exitCode(s: WaitStatus): number | null {
  if (s.kind === 'exited' || s.kind === 'signaled') return s.code;
  return null;
}

function* signalChildren(ctx: ProgramContext, w: ParentWork, sig: SignalName): SysGen<void> {
  for (const pid of live(w)) {
    try {
      yield* ctx.sys.kill({ pid, sig });
    } catch (e) {
      if (errnoOf(e) === undefined) throw e;
    }
  }
}

/** No child is left to wait for: whatever is still listed has gone without a status. */
function markLost(w: ParentWork): void {
  for (const pid of live(w)) w.finished.push({ pid, index: w.children.indexOf(pid), status: 1 });
}

/** Collects every child that has exited, without blocking. */
function* reap(ctx: ProgramContext, w: ParentWork): SysGen<void> {
  for (;;) {
    let r: { pid: number; status?: WaitStatus };
    try {
      r = yield* ctx.sys.wait({ pid: -1, nohang: true });
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === 'ECANCELED') return;
      if (errno === 'ESRCH') {
        markLost(w);
        return;
      }
      throw e;
    }
    if (r.pid === 0) return;
    const code = r.status === undefined ? null : exitCode(r.status);
    const index = w.children.indexOf(r.pid);
    if (code !== null && index >= 0 && !w.finished.some((f) => f.pid === r.pid)) {
      w.finished.push({ pid: r.pid, index, status: code });
    }
  }
}

function* sample(ctx: ProgramContext, w: ParentWork, sinceMs: number | null): SysGen<Sample> {
  let allocated = 0;
  let faults = 0;
  const pids = live(w);
  for (const pid of pids) {
    try {
      const p = yield* ctx.sys.call('proc.info', { pid });
      allocated += p.residentBytes + p.swappedBytes;
      faults += p.faults;
    } catch (e) {
      if (errnoOf(e) === undefined) throw e;
    }
  }
  let m: MemStatX | null = null;
  try {
    m = yield* ctx.sys.call('mem.stat', {});
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
  const faultsPerSec =
    w.faults === null || sinceMs === null || sinceMs <= 0
      ? null
      : (Math.max(0, faults - w.faults) * 1000) / sinceMs;
  w.faults = faults;
  w.peakAllocated = Math.max(w.peakAllocated, allocated);
  if (m !== null) {
    w.budget = m.budget;
    if (m.oldestBlockedMs !== undefined)
      w.maxBlockedMs = Math.max(w.maxBlockedMs ?? 0, m.oldestBlockedMs);
    if (m.maxOverBudgetMs !== undefined) w.maxOverBudgetMs = m.maxOverBudgetMs;
  }
  return {
    procs: pids.length,
    allocated,
    faults,
    faultsPerSec,
    budget: m === null ? null : m.budget,
    committed: m === null ? null : (m.committed ?? m.accounted + m.reservedWaiting),
    maxBlockedMs: w.maxBlockedMs,
    maxOverBudgetMs: w.maxOverBudgetMs,
  };
}

export function finalLine(o: MemhogOpts, w: ParentWork): string {
  const changed = w.finished.filter((f) => f.status === EXIT_MISMATCH).length;
  const stopped = w.stoppedBy === null ? '' : ` (stopped by ${w.stoppedBy})`;
  return (
    `memhog: done: ${String(w.children.length)} of ${String(o.procs)} procs, peak ${binSize(w.peakAllocated)} allocated, ` +
    `budget ${orDash(w.budget, binSize)}, faults ${orDash(w.faults, String)}, max blocked ${orDash(w.maxBlockedMs, ms)}, ` +
    `max over budget ${orDash(w.maxOverBudgetMs, ms)}; pages changed in ${String(changed)} procs${stopped}`
  );
}

function* parentRun(
  ctx: ProgramContext,
  out: Out,
  o: MemhogOpts,
  w: ParentWork,
  st: DemoState<MemhogOpts, MemhogWork>,
): SysGen<number> {
  // 1. Spawn the children.
  while (w.children.length < o.procs && !w.spawnFailed && w.stoppedBy === null) {
    const sig = takeSignal(st);
    if (sig !== null) {
      if (sig !== 'SIGUSR1') w.stoppedBy = sig;
      continue;
    }
    const index = w.children.length;
    try {
      const { pid } = yield* ctx.sys.spawn({ path: MEMHOG_MANIFEST, argv: childArgv(o, index) });
      w.children.push(pid);
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === 'ECANCELED') continue;
      if (errno === 'EAGAIN' && w.eagain < EAGAIN_RETRIES) {
        w.eagain++;
        if (w.eagain === 1)
          yield* out.error(`spawn of child ${String(index)} refused (${errText(e)}); retrying`);
        yield* nap(ctx, 1000);
        continue;
      }
      yield* out.error(`cannot spawn child ${String(index)}: ${errText(e)}`);
      w.spawnFailed = true;
    }
  }
  if (w.spawnFailed || w.stoppedBy !== null) yield* signalChildren(ctx, w, 'SIGTERM');

  // 2. Report every `--report` seconds until every child has exited.
  const every = o.report * 1000;
  let lastReport = ctx.now();
  let lastSample: number | null = null;
  while (live(w).length > 0) {
    const sig = takeSignal(st);
    if (sig === 'SIGUSR1') {
      const s = yield* sample(ctx, w, lastSample === null ? null : ctx.now() - lastSample);
      lastSample = ctx.now();
      yield* out.line(statusLine(s));
      continue;
    }
    if (sig !== null) {
      if (w.stoppedBy === null) {
        w.stoppedBy = sig;
        yield* signalChildren(ctx, w, 'SIGTERM');
      }
      continue;
    }
    yield* reap(ctx, w);
    if (live(w).length === 0) break;
    if (ctx.now() - lastReport >= every) {
      lastReport = ctx.now();
      const s = yield* sample(ctx, w, lastSample === null ? null : ctx.now() - lastSample);
      lastSample = ctx.now();
      yield* out.line(statusLine(s));
    }
    yield* nap(ctx, Math.max(1, Math.min(1000, every - (ctx.now() - lastReport))));
  }

  yield* out.line(finalLine(o, w));
  if (w.finished.some((f) => f.status === EXIT_MISMATCH)) return EXIT_MISMATCH;
  if (w.stoppedBy !== null) return statusFor(w.stoppedBy);
  if (w.spawnFailed || w.finished.some((f) => f.status !== 0)) return 1;
  return 0;
}

const memhog = defineDemo<MemhogOpts, MemhogWork>({
  name: 'memhog',
  checkpointable: true,
  catches: ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR1'],
  parse: parseMemhog,
  start: startMemhog,
  *run(ctx, out, o, w, st) {
    if (w.kind === 'child') return yield* childRun(ctx, out, o, w, st);
    return yield* parentRun(ctx, out, o, w, st);
  },
});

export default memhog;
