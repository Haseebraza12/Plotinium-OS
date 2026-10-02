/**
 * Test-only kernel for the demo programs. It runs real program generators (several processes,
 * round robin), answers their system calls through the real `@plotinium/kernel/sys` stubs, and
 * implements just enough of the ABI: output capture, `sleep` and `time.now` on a virtual clock,
 * `spawn`/`wait`/`kill` with signal dispositions (a caught signal cancels a blocking call with
 * ECANCELED, processes-and-scheduling.md §3.5.1 rule 6), and a memory manager with a budget, LRU
 * page-out and page-in for `ctx.mem` (FakeMem). Per-test handlers answer everything else.
 *
 * Virtual time: every `ctx.now()` call advances the clock by `cpuStepMs`, so CPU-bound loops end;
 * when every process is blocked the clock jumps to the earliest wake-up.
 */
import type { ArgsIn, CallName, RetOf, SignalName, WaitStatus } from '@plotinium/protocol';
import { SIGNALS, signalExitStatus } from '@plotinium/protocol';
import type { Program, ProgramContext, SysGen, SysRequest } from '@plotinium/kernel/sys';
import { createSys, SysError, TICK } from '@plotinium/kernel/sys';

import type { CtxMem, PageMode } from '../lib/pages.ts';

/** A handler's answer when the call must wait; it is asked again later (or at `until`). */
export interface Blocked {
  readonly blocked: true;
  readonly until: number | null;
}

export function block(until: number | null = null): Blocked {
  return { blocked: true, until };
}

function isBlocked(x: unknown): x is Blocked {
  return typeof x === 'object' && x !== null && 'blocked' in x && x.blocked === true;
}

export type Handler = (args: never, p: FakeProc, k: FakeKernel) => unknown;

type Resume = { readonly value: unknown } | { readonly error: SysError };
type Disposition = 'default' | 'ignore' | 'catch';

export interface FakeProc {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly argv: readonly string[];
  readonly program: Program<unknown>;
  st: unknown;
  ctx: ProgramContext;
  gen: SysGen<number | undefined> | null;
  state: 'run' | 'zombie' | 'reaped';
  status: WaitStatus | null;
  pending: SysRequest | null;
  pendingUntil: number | null;
  wakeAt: number | null;
  resume: Resume | null;
  caught: SignalName[];
  sigs: Map<SignalName, Disposition>;
  out: string;
  err: string;
  ticks: number;
  slices: number;
  /** Longest virtual time between two consecutive yields of this process (ms). */
  maxGapMs: number;
  lastYieldAt: number;
  priority: { priority?: number; nice?: number } | null;
}

export interface StartOptions {
  readonly env?: Record<string, string>;
  readonly tty?: boolean;
  readonly uid?: number;
  readonly ppid?: number;
  readonly pgid?: number;
  /** Give the process the `ctx.mem` page API of this kernel's FakeMem. */
  readonly ctxMem?: boolean;
}

export interface RunResult {
  readonly status: number;
  readonly out: string;
  readonly err: string;
  readonly proc: FakeProc;
}

const decoder = new TextDecoder();

// -----------------------------------------------------------------------------------------------
// Memory manager double
// -----------------------------------------------------------------------------------------------

interface FakePage {
  readonly id: number;
  readonly owner: number;
  readonly size: number;
  body: Uint8Array | null;
  swap: Uint8Array | null;
}

/**
 * Budgeted pages with LRU page-out (a copy goes to "swap", the resident buffer is scribbled over,
 * as a transferred buffer would be unusable) and page-in by copy. `committed` never exceeds the
 * budget: an allocation or a fault that cannot fit after evicting blocks.
 */
export class FakeMem {
  budget: number;
  committed = 0;
  maxCommitted = 0;
  faults = 0;
  pageOuts = 0;
  readonly faultsBy = new Map<number, number>();
  readonly pages = new Map<number, FakePage>();
  /** Resident page ids, least recently used first. */
  private readonly lru = new Map<number, true>();
  private nextId = 1;
  /** Called on every page-in with the bytes about to come back (tests may damage them). */
  onPageIn: ((page: FakePage, bytes: Uint8Array) => void) | null = null;

  constructor(budget: number) {
    this.budget = budget;
  }

  private touch(id: number): void {
    this.lru.delete(id);
    this.lru.set(id, true);
  }

  private evictOne(except: number): boolean {
    for (const id of this.lru.keys()) {
      if (id === except) continue;
      const page = this.pages.get(id);
      if (page?.body == null) continue;
      page.swap = page.body.slice();
      page.body.fill(0xee);
      page.body = null;
      this.lru.delete(id);
      this.committed -= page.size;
      this.pageOuts++;
      return true;
    }
    return false;
  }

  /** Reserves `size` bytes, evicting LRU pages; false when it cannot fit yet. */
  reserve(size: number, except = 0): boolean {
    while (this.committed + size > this.budget) {
      if (!this.evictOne(except)) return false;
    }
    this.committed += size;
    this.maxCommitted = Math.max(this.maxCommitted, this.committed);
    return true;
  }

  alloc(owner: number, size: number): number | Blocked {
    if (size > this.budget) throw new SysError('EINVAL', undefined, { reason: 'exceeds-budget' });
    if (!this.reserve(size)) return block();
    const id = this.nextId++;
    this.pages.set(id, { id, owner, size, body: new Uint8Array(size), swap: null });
    this.touch(id);
    return id;
  }

  fault(id: number): true | Blocked {
    const page = this.pages.get(id);
    if (page === undefined) throw new SysError('EINVAL');
    if (page.body !== null) return true;
    if (!this.reserve(page.size, id)) return block();
    const bytes = (page.swap ?? new Uint8Array(page.size)).slice();
    this.onPageIn?.(page, bytes);
    page.body = bytes;
    this.faults++;
    this.faultsBy.set(page.owner, (this.faultsBy.get(page.owner) ?? 0) + 1);
    this.touch(id);
    return true;
  }

  resident(id: number): Uint8Array | null {
    const page = this.pages.get(id);
    if (page?.body == null) return null;
    this.touch(id);
    return page.body;
  }

  free(id: number): void {
    const page = this.pages.get(id);
    if (page === undefined) return;
    if (page.body !== null) this.committed -= page.size;
    this.pages.delete(id);
    this.lru.delete(id);
  }

  bytesOf(owner: number): { resident: number; swapped: number } {
    let resident = 0;
    let swapped = 0;
    for (const p of this.pages.values()) {
      if (p.owner !== owner) continue;
      if (p.body === null) swapped += p.size;
      else resident += p.size;
    }
    return { resident, swapped };
  }

  /** Pages every resident page of `owner` out (a whole-process page-out). */
  pageOutAll(owner: number): void {
    for (const p of this.pages.values()) {
      if (p.owner !== owner || p.body === null) continue;
      p.swap = p.body.slice();
      p.body.fill(0xee);
      p.body = null;
      this.lru.delete(p.id);
      this.committed -= p.size;
      this.pageOuts++;
    }
  }

  /** The `ctx.mem` object a process sees: generators whose slow paths are system calls. */
  apiFor(): CtxMem {
    return ctxMemApi(this);
  }
}

function ctxMemApi(mem: FakeMem): CtxMem {
  return {
    *alloc(req: {
      kind: 'chunk' | 'logical';
      size: number;
      label?: string;
    }): SysGen<{ pageIds: readonly number[] }> {
      const reply = yield { call: 'ctxmem.alloc', args: req };
      return reply as { pageIds: readonly number[] };
    },
    *get(pageId: number, mode: PageMode): SysGen<Uint8Array> {
      // Another process may evict the page again before this one runs: fault until resident.
      for (;;) {
        const body = mem.resident(pageId);
        if (body !== null) return body;
        yield { call: 'ctxmem.fault', args: { pageId, mode } };
      }
    },
    *free(pageIds: readonly number[]): SysGen<unknown> {
      return yield { call: 'ctxmem.free', args: { pageIds } };
    },
  };
}

// -----------------------------------------------------------------------------------------------
// Kernel
// -----------------------------------------------------------------------------------------------

export class FakeKernel {
  time = 1_000;
  readonly epoch0 = 1_790_000_000_000;
  /** Virtual ms each `ctx.now()` call costs. */
  cpuStepMs = 0.002;
  /** Ticks per slice before the next process runs. */
  quantum = 50;
  readonly procs = new Map<number, FakeProc>();
  readonly programs = new Map<string, Program<unknown>>();
  readonly handlers = new Map<string, Handler>();
  readonly calls: { pid: number; call: string; args: unknown }[] = [];
  readonly mem: FakeMem;
  /** Segment reservations of `mem.alloc` (the fallback path), by id. */
  readonly segments = new Map<number, { owner: number; bytes: number; key: string }>();
  out = '';
  err = '';
  private nextPid = 500;
  private nextSeg = 1;
  onExit: ((p: FakeProc) => void) | null = null;

  constructor(opts: { budget?: number } = {}) {
    this.mem = new FakeMem(opts.budget ?? 256 * 1_048_576);
  }

  get epochNow(): number {
    return this.epoch0 + this.time;
  }

  on<C extends CallName>(
    name: C,
    fn: (args: ArgsIn<C>, p: FakeProc, k: FakeKernel) => RetOf<C> | Blocked,
  ): this;
  on(name: string, fn: Handler): this;
  on(name: string, fn: Handler): this {
    this.handlers.set(name, fn);
    return this;
  }

  /** Makes `name` fail with `errno`. */
  fail(name: string, errno: SysError['errno'], reason?: string): this {
    return this.on(name, () => {
      throw new SysError(errno, undefined, reason === undefined ? undefined : { reason });
    });
  }

  callsOf(name: string, pid?: number): unknown[] {
    return this.calls
      .filter((c) => c.call === name && (pid === undefined || c.pid === pid))
      .map((c) => c.args);
  }

  // ---------------------------------------------------------------------------------------------
  // Processes
  // ---------------------------------------------------------------------------------------------

  private context(
    pid: number,
    ppid: number,
    pgid: number,
    argv: readonly string[],
    o: StartOptions,
    restored: ProgramContext['restored'],
  ): ProgramContext {
    const sys = createSys();
    const env = new Map(
      Object.entries({ HOME: '/home/alice', USER: 'alice', PATH: '/bin', ...o.env }),
    );
    // The fake's page bodies are Uint8Array views (lib/pages.ts accepts both shapes), so the
    // context is built against the demo's wider CtxMem and handed out as the kernel's type.
    const ctx: Omit<ProgramContext, 'mem'> & { mem?: CtxMem } = {
      pid,
      ppid,
      pgid,
      sid: 200,
      uid: o.uid ?? 1001,
      gid: 1001,
      argv,
      env,
      cwd: '/home/alice',
      tty: o.tty === true ? 1 : null,
      restored,
      sys,
      tick: TICK,
      now: () => {
        const t = this.time;
        this.time += this.cpuStepMs;
        return t;
      },
      *sleep(ms: number): SysGen<void> {
        yield* sys.sleep({ ms: Math.max(0, Math.round(ms)) });
      },
      sleepUntil: (tMs: number): SysGen<void> => ctx.sleep(tMs - this.time),
      ...(o.ctxMem === true ? { mem: this.mem.apiFor() } : {}),
    };
    return ctx as ProgramContext;
  }

  private readonly startOpts = new Map<number, StartOptions>();

  start(program: Program<unknown>, argv: readonly string[], o: StartOptions = {}): FakeProc {
    const pid = this.nextPid++;
    const ppid = o.ppid ?? 200;
    const pgid = o.pgid ?? pid;
    const ctx = this.context(pid, ppid, pgid, argv, o, 'no');
    const p: FakeProc = {
      pid,
      ppid,
      pgid,
      argv,
      program,
      st: program.init(argv),
      ctx,
      gen: null,
      state: 'run',
      status: null,
      pending: null,
      pendingUntil: null,
      wakeAt: null,
      resume: null,
      caught: [],
      sigs: new Map(),
      out: '',
      err: '',
      ticks: 0,
      slices: 0,
      maxGapMs: 0,
      lastYieldAt: this.time,
      priority: null,
    };
    this.procs.set(pid, p);
    this.startOpts.set(pid, o);
    return p;
  }

  /**
   * Simulates a page-out and page-in of the whole process at its last yield point: the state goes
   * through structured clone (as through the state codec), the generator is dropped, and the
   * program re-enters `run` with `ctx.restored = from`.
   */
  restore(p: FakeProc, from: 'page-in' | 'migration' | 'session' = 'page-in'): void {
    if (p.pending !== null)
      throw new Error('cannot restore a process blocked in a non-restartable call');
    p.st = structuredClone(p.st);
    p.gen = null;
    p.wakeAt = null;
    p.resume = null;
    p.ctx = this.context(p.pid, p.ppid, p.pgid, p.argv, this.startOpts.get(p.pid) ?? {}, from);
  }

  /** Runs `program` as a fresh process until it exits. */
  run(program: Program<unknown>, argv: readonly string[], o: StartOptions = {}): RunResult {
    const p = this.start(program, argv, o);
    this.runUntil(() => p.state !== 'run');
    return { status: this.statusOf(p), out: p.out, err: p.err, proc: p };
  }

  statusOf(p: FakeProc): number {
    const s = p.status;
    if (s === null) throw new Error(`process ${String(p.pid)} has not exited`);
    return s.kind === 'exited' || s.kind === 'signaled' ? s.code : -1;
  }

  private exit(p: FakeProc, status: WaitStatus): void {
    p.state = 'zombie';
    p.status = status;
    p.pending = null;
    p.wakeAt = null;
    p.gen = null;
    this.onExit?.(p);
  }

  /** Ends a process abruptly (a killed renderer): no signal hook, no cleanup by the program. */
  crash(p: FakeProc): void {
    this.exit(p, { kind: 'signaled', signal: 'SIGKILL', code: signalExitStatus('SIGKILL') });
  }

  /** Delivers `sig` as the kernel would (processes-and-scheduling.md §3.9). */
  signal(p: FakeProc, sig: SignalName): void {
    if (p.state !== 'run') return;
    const disp = p.sigs.get(sig) ?? 'default';
    const info = SIGNALS[sig];
    if (info.catchable && disp === 'catch') {
      p.caught.push(sig);
      if (p.pending !== null || p.wakeAt !== null) {
        p.pending = null;
        p.pendingUntil = null;
        p.wakeAt = null;
        p.resume = { error: new SysError('ECANCELED', undefined, { reason: 'signal' }) };
      }
      return;
    }
    if (info.catchable && disp === 'ignore') return;
    if (info.defaultAction === 'terminate' || !info.catchable) {
      this.exit(p, { kind: 'signaled', signal: sig, code: signalExitStatus(sig) });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduler
  // ---------------------------------------------------------------------------------------------

  /** Round robin until `done()` holds; throws on a deadlock or after `maxRounds`. */
  runUntil(done: () => boolean, maxRounds = 2_000_000): void {
    for (let round = 0; round < maxRounds; round++) {
      if (done()) return;
      let progressed = false;
      for (const p of [...this.procs.values()]) {
        if (p.state !== 'run') continue;
        if (p.pending !== null) {
          const r = this.dispatch(p, p.pending);
          if (r === null) continue;
          p.pending = null;
          p.pendingUntil = null;
          p.resume = r;
        } else if (p.wakeAt !== null) {
          if (this.time < p.wakeAt) continue;
          p.resume = { value: { sleptMs: this.time - p.wakeAt } };
          p.wakeAt = null;
        }
        this.slice(p);
        progressed = true;
        if (done()) return;
      }
      if (!progressed) {
        const wakes = [...this.procs.values()]
          .filter((p) => p.state === 'run')
          .flatMap((p) => [p.wakeAt, p.pendingUntil])
          .filter((t): t is number => t !== null && t > this.time);
        if (wakes.length === 0) {
          if (done()) return;
          throw new Error(
            `deadlock: every process is blocked (${[...this.procs.values()]
              .filter((p) => p.state === 'run')
              .map((p) => `${String(p.pid)}:${p.pending?.call ?? 'sleep'}`)
              .join(', ')})`,
          );
        }
        this.time = Math.min(...wakes);
      }
    }
    throw new Error('runUntil: too many rounds');
  }

  private slice(p: FakeProc): void {
    p.slices++;
    p.lastYieldAt = this.time;
    for (let sig = p.caught.shift(); sig !== undefined; sig = p.caught.shift())
      p.program.signal?.(p.ctx, p.st, sig);
    p.gen ??= p.program.run(p.ctx, p.st);
    let input = p.resume;
    p.resume = null;
    for (let ticks = 0; ;) {
      const r =
        input === null
          ? p.gen.next()
          : 'error' in input
            ? p.gen.throw(input.error)
            : p.gen.next(input.value);
      input = null;
      p.maxGapMs = Math.max(p.maxGapMs, this.time - p.lastYieldAt);
      p.lastYieldAt = this.time;
      if (r.done === true) {
        this.exit(p, { kind: 'exited', code: r.value ?? 0 });
        return;
      }
      if (r.value === TICK) {
        p.ticks++;
        ticks++;
        if (ticks >= this.quantum) return;
        continue;
      }
      const req = r.value;
      this.calls.push({ pid: p.pid, call: req.call, args: req.args });
      if (req.call === 'sleep') {
        p.wakeAt = this.time + (req.args as { ms: number }).ms;
        return;
      }
      const res = this.dispatch(p, req);
      if (res === null) p.pending = req;
      else p.resume = res;
      return;
    }
  }

  /** null = blocked (asked again later). */
  private dispatch(p: FakeProc, req: SysRequest): Resume | null {
    try {
      const custom = this.handlers.get(req.call);
      const builtin = this.builtins[req.call];
      let value: unknown;
      if (custom !== undefined) value = custom(req.args as never, p, this);
      else if (builtin !== undefined) value = builtin(req.args as never, p);
      else throw new SysError('ENOSYS');
      if (isBlocked(value)) {
        p.pendingUntil = value.until;
        return null;
      }
      return { value };
    } catch (e) {
      if (e instanceof SysError) return { error: e };
      throw e;
    }
  }

  /** The built-in `spawn`: runs the program registered for `path` as a child of `p`. */
  spawnDefault(a: { path: string; argv: readonly string[] }, p: FakeProc): { pid: number } {
    const program = this.programs.get(a.path);
    if (program === undefined) throw new SysError('ENOENT');
    const child = this.start(program, a.argv, {
      ...this.startOpts.get(p.pid),
      ppid: p.pid,
      pgid: p.pgid,
    });
    return { pid: child.pid };
  }

  private waitFor(p: FakeProc, a: { pid: number; nohang?: boolean }): unknown {
    const kids = [...this.procs.values()].filter(
      (c) => c.ppid === p.pid && c.state !== 'reaped' && (a.pid === -1 || c.pid === a.pid),
    );
    if (kids.length === 0) throw new SysError('ESRCH', undefined, { reason: 'no-child' });
    const z = kids.find((c) => c.state === 'zombie');
    if (z !== undefined) {
      z.state = 'reaped';
      return { pid: z.pid, status: z.status };
    }
    return a.nohang === true ? { pid: 0 } : block();
  }

  private readonly builtins: Record<string, (args: never, p: FakeProc) => unknown> = {
    write: (a: { fd: number; data: ArrayBuffer }, p: FakeProc) => {
      const text = decoder.decode(new Uint8Array(a.data));
      if (a.fd === 2) {
        p.err += text;
        this.err += text;
      } else {
        p.out += text;
        this.out += text;
      }
      return { bytes: a.data.byteLength };
    },
    isatty: (a: { fd: number }, p: FakeProc) => ({ tty: p.ctx.tty !== null && a.fd <= 2 }),
    'sig.action': (a: { sig: SignalName; action: Disposition }, p: FakeProc) => {
      const old = p.sigs.get(a.sig) ?? 'default';
      p.sigs.set(a.sig, a.action);
      return { old };
    },
    'time.now': () => ({
      epochMs: this.epochNow,
      monotonicMs: this.time,
      tz: 'UTC',
      tzOffsetMin: 0,
    }),
    setpriority: (a: { priority?: number; nice?: number }, p: FakeProc) => {
      p.priority = { ...a };
      return { priority: a.priority ?? 20, nice: a.nice ?? 0, effPrio: a.priority ?? 20 };
    },
    spawn: (a: { path: string; argv: string[] }, p: FakeProc) => this.spawnDefault(a, p),
    wait: (a: { pid: number; nohang?: boolean }, p: FakeProc) => this.waitFor(p, a),
    kill: (a: { pid: number; sig: SignalName | 0 }) => {
      const targets = [...this.procs.values()].filter(
        (t) => t.state === 'run' && (a.pid > 0 ? t.pid === a.pid : t.pgid === -a.pid),
      );
      if (targets.length === 0) throw new SysError('ESRCH');
      if (a.sig !== 0) for (const t of targets) this.signal(t, a.sig);
      return { delivered: a.sig === 0 ? 0 : targets.length };
    },
    'proc.info': (a: { pid: number }) => {
      const t = this.procs.get(a.pid);
      if (t === undefined || t.state === 'reaped') throw new SysError('ESRCH');
      const mem = this.mem.bytesOf(a.pid);
      let segs = 0;
      for (const s of this.segments.values()) if (s.owner === a.pid) segs += s.bytes;
      return {
        pid: a.pid,
        residentBytes: mem.resident + segs,
        swappedBytes: mem.swapped,
        faults: this.mem.faultsBy.get(a.pid) ?? 0,
      };
    },
    'mem.stat': () => ({
      budget: this.mem.budget,
      accounted: this.mem.committed + this.segmentBytes(),
      reservedWaiting: 0,
    }),
    'mem.alloc': (a: { bytes: number; key?: string }, p: FakeProc) => {
      if (a.bytes > this.mem.budget)
        throw new SysError('EINVAL', undefined, { reason: 'exceeds-budget' });
      if (this.mem.committed + this.segmentBytes() + a.bytes > this.mem.budget) return block();
      const segId = this.nextSeg++;
      this.segments.set(segId, { owner: p.pid, bytes: a.bytes, key: a.key ?? '' });
      this.mem.maxCommitted = Math.max(
        this.mem.maxCommitted,
        this.mem.committed + this.segmentBytes(),
      );
      return { segId, bytes: a.bytes };
    },
    'mem.free': (a: { segId: number }) => {
      const s = this.segments.get(a.segId);
      if (s === undefined) throw new SysError('EINVAL', undefined, { reason: 'unknown-segment' });
      this.segments.delete(a.segId);
      return { bytes: s.bytes };
    },
    'ctxmem.alloc': (a: { size: number }, p: FakeProc) => {
      const id = this.mem.alloc(p.pid, a.size);
      return isBlocked(id) ? id : { pageIds: [id] };
    },
    'ctxmem.fault': (a: { pageId: number }) => {
      const r = this.mem.fault(a.pageId);
      return isBlocked(r) ? r : {};
    },
    'ctxmem.free': (a: { pageIds: number[] }) => {
      for (const id of a.pageIds) this.mem.free(id);
      return {};
    },
  };

  segmentBytes(): number {
    let n = 0;
    for (const s of this.segments.values()) n += s.bytes;
    return n;
  }
}
