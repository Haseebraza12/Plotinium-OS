/**
 * The Terminal's process host: runs the shell and its commands as real program generators
 * (processes-and-scheduling.md §3.5 program model) on the view's thread, with the parts of the
 * kernel a terminal session needs implemented locally:
 *
 * - processes: `spawn`, `exit`, `wait`, `kill`, `getpid`, `setpgid`, `sig.action`, `getcwd`,
 *   `chdir`, `umask`, `nice`, `setpriority`, `getpriority`, `proc.list`, `proc.info`, `sleep`;
 * - descriptors: `pipe`, `dup`, `dup2`, `close`, `isatty`, `read` and `write` on TTYs and pipes;
 * - TTYs: the line discipline (../ldisc.ts), `tty.getattr`, `tty.setattr`, `tcsetpgrp`,
 *   `tcgetpgrp`, job-control signals from the keyboard (Ctrl-C SIGINT, Ctrl-Z SIGTSTP), SIGTTIN
 *   for background reads, SIGWINCH on resize, SIGHUP on hang-up (shell-and-terminal.md §3.2, §3.8);
 * - the confirmation takeover of `ai.agent.confirm` on the caller's controlling TTY (§3.11,
 *   AGT-03): the answer is read only from terminal keystrokes, never from the process's stdin.
 *
 * Every other call (files, identity, memory, AI, windows …) is DELEGATED to the kernel through the
 * view's system-call client, with relative paths made absolute against the caller's directory and
 * file descriptors translated to the kernel's. When the VFS has no `/bin` manifests yet, the host
 * serves a read-only overlay for its bundled programs (host/programs.ts).
 *
 * This is the stand-in for the kernel TTY and process syscalls until they are wired
 * (TODO(R1): kernel/core/tty, spawn/wait/pipe handlers). The Terminal then uses the kernel path
 * (tty.input / tty.resize / tty.output, see ../session.ts) and this module is only used in tests.
 */
import type {
  CompleteItem,
  DirEntry,
  OpenFile,
  PlanStep,
  ProcInfo,
  SigDisposition,
  SignalName,
  Stat,
  SubmitResult,
  TtyAttr,
  WaitStatus,
} from '@plotinium/protocol';
import { CALL_NAMES, FD_TABLE_SIZE, PID_MAX, SIGNALS, signalExitStatus } from '@plotinium/protocol';
import type { ProgramContext, Sys, SysGen } from '@plotinium/kernel/sys';
import { createSys, errnoOf, SysError, TICK } from '@plotinium/kernel/sys';
import type { Errno } from '@plotinium/protocol';

import { BUILTIN_NAMES } from '../../shell/builtins/names.ts';
import type { ConfirmKey, JobSignal, Modes } from '../ldisc.ts';
import type { ManLibrary } from './manpages.ts';
import { manFlags, manOverlayEntries, manOverlayStat, manOverlayText } from './manpages.ts';
import { absolute, normalise, tildify, withAbsolutePaths } from './paths.ts';
import { Pipe } from './pipe.ts';
import type { HostProgram, ProgramRegistry } from './programs.ts';
import { BIN_DIR, manifestText, overlayStat, programName } from './programs.ts';
import type { OutputListener } from './tty.ts';
import { Tty } from './tty.ts';

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

/** The kernel side: a promise system-call client (a view port's `sys.call`). */
export type Delegate = (call: string, args: unknown) => Promise<unknown>;

export interface HostClock {
  /** Monotonic milliseconds. */
  now(): number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  setTimer(ms: number, fn: () => void): () => void;
  /** Runs `fn` soon, after the current task (the host's scheduling turn). */
  defer(fn: () => void): void;
}

/** Who the terminal user is, when the kernel cannot say (`proc.cred` fallback). */
export interface HostIdentity {
  readonly uid: number;
  readonly gid: number;
  readonly user: string;
  readonly home: string;
}

/** A plan the host is asked to confirm (§3.11 step 4). */
export interface ConfirmPlan {
  readonly planId: string;
  readonly steps: readonly PlanStep[];
  readonly result: SubmitResult;
  readonly requester: ConfirmRequester;
}

export type ConfirmOutcome = 'declined' | 'timeout' | 'edit-unavailable';

/** The process asking for a confirmation. */
export interface ConfirmRequester {
  readonly pid: number;
  readonly comm: string;
}

export interface ConfirmRenderer {
  /** The confirmation block, CR LF line ends, ending with the `Proceed?` prompt. */
  block(plan: ConfirmPlan, cols: number): string;
  /** The line printed after a refusal. */
  outcome(kind: ConfirmOutcome): string;
}

export interface HostOptions {
  readonly programs: ProgramRegistry;
  readonly delegate?: Delegate;
  readonly clock?: HostClock;
  readonly identity?: HostIdentity;
  /** Script time per scheduling turn (default 8 ms), so the page keeps its frame budget. */
  readonly sliceMs?: number;
  readonly confirm?: ConfirmRenderer;
  /** §3.11 step 7: the confirm token's lifetime (default 120 s). */
  readonly confirmTimeoutMs?: number;
  /**
   * A kernel-confirmation takeover started or ended on a TTY (for the compositor strip and the
   * Terminal's status strip); `requester` is the process whose plan is being confirmed.
   */
  readonly onConfirmStrip?: (tty: number, active: boolean, requester: ConfirmRequester) => void;
  readonly log?: (message: string) => void;
  /**
   * Manual pages served read-only under /usr/share/man when the volume has none
   * (./manpages.ts, UI-053); none by default.
   */
  readonly manPages?: ManLibrary;
}

export interface TerminalOptions {
  readonly cols: number;
  readonly rows: number;
  /** Default `/bin/sh.json`. */
  readonly path?: string;
  /** Default `['-sh']`, a login shell (§3.3). */
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Default `$HOME` (the login shell changes there anyway). */
  readonly cwd?: string;
}

/** One terminal session: a TTY with a shell as its session leader. */
export interface TerminalLink {
  readonly tty: number;
  readonly pid: number;
  /** Keyboard input (`tty.input`); 'again' when the input queue is full. */
  input(data: string | Uint8Array): 'ok' | 'again';
  /** New grid size (`tty.winsize`): SIGWINCH to the foreground group. */
  resize(cols: number, rows: number): void;
  /** Receives output batches; call `ack` once the terminal has parsed one (SHL-03). */
  attach(listener: OutputListener | null): void;
  onExit(listener: (status: WaitStatus) => void): () => void;
  /** The session leader's working directory changed (the window title follows it, §3.3). */
  onCwd(listener: (cwd: string, display: string) => void): () => void;
  /** The shell's directory now, and as a title would show it (`~/notes`). */
  cwd(): { path: string; display: string };
  /** Hang-up: SIGHUP to the session, then SIGKILL to what is left after `graceMs`. */
  hangup(graceMs?: number): void;
  readonly modes: () => Readonly<Modes>;
}

// ---------------------------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------------------------

type Ofd =
  | { kind: 'tty'; tty: Tty; refs: number }
  | { kind: 'pipe-r'; pipe: Pipe; refs: number }
  | { kind: 'pipe-w'; pipe: Pipe; refs: number }
  | { kind: 'file'; dfd: number; path: string; flags: string; refs: number }
  | { kind: 'mem'; data: Uint8Array; pos: number; path: string; refs: number };

type Outcome =
  | { k: 'ok'; v: unknown }
  | { k: 'err'; e: SysError }
  | { k: 'block'; b: Block }
  | { k: 'async'; call: string; p: Promise<Outcome> }
  | { k: 'gone' };

interface Block {
  readonly on: string;
  readonly interruptible: boolean;
  /** Re-evaluates the call after a wake-up: an outcome, or null to keep waiting. */
  readonly retry?: () => Outcome | null;
  readonly cancel?: () => void;
}

type Resume = { ok: true; v: unknown } | { ok: false; e: unknown };

type Gen = Generator<unknown, number | undefined, unknown>;

interface Proc {
  readonly pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  readonly uid: number;
  readonly gid: number;
  readonly user: string;
  readonly home: string;
  readonly argv: readonly string[];
  readonly env: Map<string, string>;
  cwd: string;
  cwdIno: string | null;
  umask: number;
  nice: number;
  priority: number;
  readonly program: HostProgram;
  /** The program's name (`ls`, `ai.agent`): what `ps` calls COMMAND and the confirmation names. */
  readonly comm: string;
  st: unknown;
  gen: Gen | null;
  ctx: ProgramContext;
  readonly fds: Map<number, Ofd>;
  ctty: Tty | null;
  readonly disp: Map<SignalName, SigDisposition>;
  status: 'live' | 'zombie';
  stopped: SignalName | null;
  block: Block | null;
  resume: Resume | null;
  queued: boolean;
  report: WaitStatus | null;
  exit: WaitStatus | null;
  readonly startedAt: number;
  cpuMs: number;
  readonly children: Set<number>;
}

type Rec = Readonly<Record<string, unknown>>;

/** The job-control columns of a local process (see `info`). */
interface HostProcExtra {
  readonly sid: number;
  readonly tty: number | null;
  readonly fg: boolean;
  readonly leader: boolean;
  readonly stopped: boolean;
  readonly kind: 'user';
}

const UNKNOWN_INO = '00000000-0000-7000-8000-000000000000';
const REGISTERED: ReadonlySet<string> = new Set(CALL_NAMES);
const FIRST_PID = 300;
const DEFAULT_PRIORITY = 20;

const enc = new TextEncoder();

function rec(args: unknown): Rec {
  return typeof args === 'object' && args !== null ? (args as Rec) : {};
}
function num(a: Rec, key: string): number | undefined {
  const v = a[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(a: Rec, key: string): string | undefined {
  const v = a[key];
  return typeof v === 'string' ? v : undefined;
}
function bool(a: Rec, key: string): boolean {
  return a[key] === true;
}
/** `x` as a list of strings, or null when it is not one. */
function stringList(x: unknown): string[] | null {
  if (!Array.isArray(x)) return null;
  const out: string[] = [];
  for (const item of x as unknown[]) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
function ok(v: unknown): Outcome {
  return { k: 'ok', v };
}
function err(errno: Errno, message?: string): Outcome {
  return { k: 'err', e: new SysError(errno, message) };
}
function isSysRequest(y: unknown): y is { call: string; args: unknown } {
  return typeof y === 'object' && y !== null && typeof (y as { call?: unknown }).call === 'string';
}
function clampCode(code: number | undefined): number {
  if (code === undefined || !Number.isInteger(code)) return 0;
  return Math.min(255, Math.max(0, code));
}
/** `x` permission on a directory with stat `s` for `who` (root always may). */
function mayEnterAs(who: { readonly uid: number; readonly gid: number }, s: Rec): boolean {
  if (who.uid === 0) return true;
  const mode = num(s, 'mode') ?? 0o755;
  if (num(s, 'uid') === who.uid) return (mode & 0o100) !== 0;
  if (num(s, 'gid') === who.gid) return (mode & 0o010) !== 0;
  return (mode & 0o001) !== 0;
}
function asSysError(e: unknown): SysError {
  const errno = errnoOf(e);
  if (errno !== undefined) return new SysError(errno, e instanceof Error ? e.message : undefined);
  return new SysError('EIO', e instanceof Error ? e.message : String(e));
}

/** The default clock: `performance.now`, timers, and a MessageChannel turn. */
export function browserClock(): HostClock {
  const channel = typeof MessageChannel === 'undefined' ? null : new MessageChannel();
  const queue: (() => void)[] = [];
  if (channel !== null) {
    channel.port1.onmessage = () => {
      const fn = queue.shift();
      fn?.();
    };
  }
  return {
    now: () => performance.now(),
    setTimer: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    defer: (fn) => {
      if (channel === null) {
        setTimeout(fn, 0);
        return;
      }
      queue.push(fn);
      channel.port2.postMessage(0);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------------------------

export class ProcessHost {
  private readonly programs: ProgramRegistry;
  private readonly delegateFn: Delegate | undefined;
  private readonly clock: HostClock;
  private readonly identity: HostIdentity | undefined;
  private readonly sliceMs: number;
  private readonly confirmRenderer: ConfirmRenderer;
  private readonly confirmTimeoutMs: number;
  private readonly opts: HostOptions;
  private readonly sys: Sys = createSys();
  private readonly procs = new Map<number, Proc>();
  private readonly ttys = new Map<number, Tty>();
  private readonly queues = new Map<string, Set<Proc>>();
  private readonly plans = new Map<string, { steps: readonly PlanStep[]; result: SubmitResult }>();
  private readonly unsupported = new Set<string>();
  private readonly exitListeners = new Map<number, Set<(s: WaitStatus) => void>>();
  private readonly cwdListeners = new Map<number, Set<(cwd: string, display: string) => void>>();
  private runq: Proc[] = [];
  private turnScheduled = false;
  private outputScheduled = false;
  private nextPid = FIRST_PID;
  private nextTty = 1;
  private nextPipe = 1;
  private cred: HostIdentity | null = null;
  private readonly boot: number;

  constructor(opts: HostOptions) {
    this.opts = opts;
    this.programs = opts.programs;
    this.delegateFn = opts.delegate;
    this.clock = opts.clock ?? browserClock();
    this.identity = opts.identity;
    this.sliceMs = opts.sliceMs ?? 8;
    this.confirmRenderer = opts.confirm ?? PLAIN_CONFIRM;
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? 120_000;
    this.boot = Date.now();
  }

  // -------------------------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------------------------

  /** Opens a TTY and starts a login shell on it as a new session (§3.3 step 1). */
  async openTerminal(o: TerminalOptions): Promise<TerminalLink> {
    const who = await this.whoami();
    const tty = new Tty(
      this.nextTty++,
      { cols: o.cols, rows: o.rows },
      {
        signal: (t, sig) => this.keyboardSignal(t, sig),
        readable: (t) => this.wake(`tty:${String(t.n)}:read`),
        space: (t) => this.wake(`tty:${String(t.n)}:space`),
        pending: () => this.scheduleOutput(),
      },
    );
    this.ttys.set(tty.n, tty);
    const path = o.path ?? `${BIN_DIR}/sh.json`;
    const comm = programName(path) ?? '';
    const program = this.programs.get(comm);
    if (program === undefined) throw new SysError('ENOENT', `${path}: no such program`);
    const ofd: Ofd = { kind: 'tty', tty, refs: 0 };
    tty.refs += 1;
    const env = new Map(Object.entries(o.env ?? {}));
    const p = this.create({
      program,
      comm,
      argv: o.argv ?? ['-sh'],
      env,
      cwd: o.cwd ?? who.home,
      ppid: 0,
      pgid: 0,
      sid: 0,
      uid: who.uid,
      gid: who.gid,
      user: who.user,
      home: who.home,
      ctty: tty,
      fds: [ofd, ofd, ofd],
      umask: 0o022,
      nice: 0,
    });
    tty.sid = p.pid;
    tty.fgPgid = p.pgid;
    this.enqueue(p);
    const link: TerminalLink = {
      tty: tty.n,
      pid: p.pid,
      input: (data) => {
        const r = tty.ldisc.input(data);
        this.scheduleOutput();
        return r;
      },
      resize: (cols, rows) => {
        if (!tty.resize(Math.max(2, Math.round(cols)), Math.max(1, Math.round(rows)))) return;
        this.signalGroup(tty.fgPgid, 'SIGWINCH');
      },
      attach: (listener) => tty.attach(listener),
      onExit: (listener) => this.listen(this.exitListeners, p.pid, listener),
      onCwd: (listener) => this.listen(this.cwdListeners, p.pid, listener),
      cwd: () => {
        const leader = this.procs.get(p.pid);
        const path2 = leader?.cwd ?? p.cwd;
        return { path: path2, display: tildify(path2, p.home) };
      },
      hangup: (graceMs = 1_000) => this.hangup(tty, graceMs),
      modes: () => tty.modes,
    };
    return link;
  }

  /** Live processes, for tests and the Task Manager. */
  processes(): readonly { pid: number; pgid: number; argv: readonly string[]; state: string }[] {
    return [...this.procs.values()].map((p) => ({
      pid: p.pid,
      pgid: p.pgid,
      argv: p.argv,
      state:
        p.status === 'zombie'
          ? 'zombie'
          : p.stopped !== null
            ? 'stopped'
            : p.block !== null
              ? `blocked:${p.block.on}`
              : 'ready',
    }));
  }

  // -------------------------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------------------------

  private runnable(p: Proc): boolean {
    return p.status === 'live' && p.stopped === null && p.block === null && p.gen !== null;
  }

  private enqueue(p: Proc): void {
    if (p.queued || !this.runnable(p)) return;
    p.queued = true;
    this.runq.push(p);
    this.scheduleTurn();
  }

  private scheduleTurn(): void {
    if (this.turnScheduled) return;
    this.turnScheduled = true;
    this.clock.defer(() => this.turn());
  }

  private scheduleOutput(): void {
    if (this.outputScheduled) return;
    this.outputScheduled = true;
    this.clock.defer(() => {
      this.outputScheduled = false;
      for (const tty of this.ttys.values()) tty.deliver();
    });
  }

  /** One scheduling turn: round robin until the run queue is empty or the slice is used up. */
  private turn(): void {
    this.turnScheduled = false;
    const deadline = this.clock.now() + this.sliceMs;
    while (this.runq.length > 0) {
      const p = this.runq.shift();
      if (p === undefined) break;
      p.queued = false;
      if (!this.runnable(p)) continue;
      this.runSlice(p, deadline);
      if (this.clock.now() >= deadline) break;
    }
    if (this.runq.length > 0) this.scheduleTurn();
    this.scheduleOutput();
  }

  private runSlice(p: Proc, deadline: number): void {
    const start = this.clock.now();
    let ticks = 0;
    try {
      while (this.runnable(p)) {
        const gen = p.gen;
        if (gen === null) return;
        const input = p.resume;
        p.resume = null;
        let r: IteratorResult<unknown, number | undefined>;
        try {
          r = input === null ? gen.next() : input.ok ? gen.next(input.v) : gen.throw(input.e);
        } catch (e) {
          this.crash(p, e);
          return;
        }
        if (r.done === true) {
          this.exitProc(p, { kind: 'exited', code: clampCode(r.value) });
          return;
        }
        const y = r.value;
        if (isSysRequest(y)) {
          const out = this.syscall(p, y.call, y.args);
          if (!this.apply(p, out)) return;
        } else if (y === TICK || typeof y === 'symbol') {
          ticks += 1;
        } else {
          p.resume = { ok: false, e: new SysError('EINVAL', 'a program yielded a non-request') };
        }
        if (this.clock.now() >= deadline || ticks > 4_096) {
          this.enqueue(p);
          return;
        }
      }
    } finally {
      p.cpuMs += this.clock.now() - start;
    }
  }

  /** Records a call's outcome; true when the process can keep running now. */
  private apply(p: Proc, out: Outcome): boolean {
    switch (out.k) {
      case 'ok':
        p.resume = { ok: true, v: out.v };
        break;
      case 'err':
        p.resume = { ok: false, e: out.e };
        break;
      case 'block':
        p.block = out.b;
        return false;
      case 'async': {
        const b: Block = { on: `call:${out.call}`, interruptible: false };
        p.block = b;
        out.p.then(
          (res) => this.settle(p, b, res),
          (e: unknown) => this.settle(p, b, { k: 'err', e: asSysError(e) }),
        );
        return false;
      }
      case 'gone':
        return false;
    }
    return this.runnable(p);
  }

  /** A block ended with `out` (a wake-up, a delegated reply, a timer). */
  private settle(p: Proc, b: Block, out: Outcome): void {
    if (p.block !== b || p.status !== 'live') return;
    p.block = null;
    b.cancel?.();
    if (this.apply(p, out)) this.enqueue(p);
  }

  private queue(key: string): Set<Proc> {
    let q = this.queues.get(key);
    if (q === undefined) {
      q = new Set();
      this.queues.set(key, q);
    }
    return q;
  }

  /** Blocks `p` on `key`; `retry` runs at each wake-up. */
  private blockOn(p: Proc, key: string, on: string, retry: () => Outcome | null): Outcome {
    const q = this.queue(key);
    q.add(p);
    return {
      k: 'block',
      b: { on, interruptible: true, retry, cancel: () => q.delete(p) },
    };
  }

  private wake(key: string): void {
    const q = this.queues.get(key);
    if (q === undefined || q.size === 0) return;
    for (const p of [...q]) this.retry(p);
  }

  private retry(p: Proc): void {
    const b = p.block;
    if (b?.retry === undefined || p.status !== 'live') return;
    const out = b.retry();
    if (out !== null) this.settle(p, b, out);
  }

  // -------------------------------------------------------------------------------------------
  // Processes
  // -------------------------------------------------------------------------------------------

  private allocPid(): number {
    for (let i = 0; i < PID_MAX; i++) {
      const pid = this.nextPid;
      this.nextPid = this.nextPid >= PID_MAX ? FIRST_PID : this.nextPid + 1;
      if (!this.procs.has(pid)) return pid;
    }
    throw new SysError('EAGAIN', 'no free process ids');
  }

  private create(c: {
    program: HostProgram;
    comm: string;
    argv: readonly string[];
    env: Map<string, string>;
    cwd: string;
    ppid: number;
    pgid: number;
    sid: number;
    uid: number;
    gid: number;
    user: string;
    home: string;
    ctty: Tty | null;
    fds: readonly (Ofd | undefined)[];
    umask: number;
    nice: number;
  }): Proc {
    const pid = this.allocPid();
    const fds = new Map<number, Ofd>();
    c.fds.forEach((ofd, n) => {
      if (ofd === undefined) return;
      ofd.refs += 1;
      fds.set(n, ofd);
    });
    const p: Proc = {
      pid,
      ppid: c.ppid,
      pgid: c.pgid === 0 ? pid : c.pgid,
      sid: c.sid === 0 ? pid : c.sid,
      uid: c.uid,
      gid: c.gid,
      user: c.user,
      home: c.home,
      argv: [...c.argv],
      env: c.env,
      cwd: c.cwd,
      cwdIno: null,
      umask: c.umask,
      nice: c.nice,
      priority: DEFAULT_PRIORITY,
      program: c.program,
      comm: c.comm,
      st: undefined,
      gen: null,
      ctx: undefined as unknown as ProgramContext,
      fds,
      ctty: c.ctty,
      disp: new Map(),
      status: 'live',
      stopped: null,
      block: null,
      resume: null,
      queued: false,
      report: null,
      exit: null,
      startedAt: Date.now(),
      cpuMs: 0,
      children: new Set(),
    };
    p.ctx = this.contextOf(p);
    this.procs.set(pid, p);
    const parent = this.procs.get(c.ppid);
    parent?.children.add(pid);
    const init = p.program.init.bind(p.program);
    const run = p.program.run.bind(p.program) as unknown as (
      ctx: ProgramContext,
      st: unknown,
    ) => Gen;
    try {
      p.st = init(p.argv);
      p.gen = run(p.ctx, p.st);
    } catch (e) {
      p.gen = failing(e);
    }
    return p;
  }

  private contextOf(p: Proc): ProgramContext {
    const sys = this.sys;
    const clock = this.clock;
    return {
      pid: p.pid,
      get ppid() {
        return p.ppid;
      },
      get pgid() {
        return p.pgid;
      },
      get sid() {
        return p.sid;
      },
      uid: p.uid,
      gid: p.gid,
      argv: p.argv,
      env: p.env,
      get cwd() {
        return p.cwd;
      },
      get tty() {
        return p.ctty?.n ?? null;
      },
      restored: 'no',
      sys,
      tick: TICK,
      now: () => clock.now(),
      *sleep(ms: number): SysGen<void> {
        yield* sys.sleep({ ms: Math.max(0, Math.round(ms)) });
      },
      *sleepUntil(t: number): SysGen<void> {
        yield* sys.sleep({ ms: Math.max(0, Math.round(t - clock.now())) });
      },
    };
  }

  private crash(p: Proc, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.opts.log?.(`${p.argv[0] ?? '?'} (pid ${String(p.pid)}) crashed: ${message}`);
    const out = p.fds.get(2);
    const text = enc.encode(`${p.argv[0] ?? 'program'}: crashed: ${message}\n`);
    if (out?.kind === 'tty') out.tty.ldisc.write(text);
    else if (out?.kind === 'pipe-w') out.pipe.write(text);
    this.exitProc(p, { kind: 'exited', code: 1 });
  }

  private exitProc(p: Proc, status: WaitStatus): void {
    if (p.status !== 'live') return;
    const b = p.block;
    p.block = null;
    b?.cancel?.();
    p.gen = null;
    p.resume = null;
    p.status = 'zombie';
    p.stopped = null;
    p.exit = status;
    p.report = status;
    for (const fd of [...p.fds.keys()]) this.closeFd(p, fd);
    for (const pid of [...p.children]) {
      const c = this.procs.get(pid);
      if (c === undefined) continue;
      c.ppid = 0;
      if (c.status === 'zombie') this.reap(c);
    }
    p.children.clear();
    const tty = p.ctty;
    if (tty !== null && p.pid === p.sid && !tty.closed) this.hangup(tty, 1_000);
    const parent = this.procs.get(p.ppid);
    if (parent !== undefined && parent.status === 'live') {
      this.wake('wait');
      this.deliver(parent, 'SIGCHLD');
    } else {
      this.reap(p);
    }
    const listeners = this.exitListeners.get(p.pid);
    this.exitListeners.delete(p.pid);
    this.cwdListeners.delete(p.pid);
    for (const l of listeners ?? []) l(status);
  }

  private reap(p: Proc): void {
    this.procs.delete(p.pid);
    this.procs.get(p.ppid)?.children.delete(p.pid);
  }

  private listen<T>(map: Map<number, Set<T>>, pid: number, listener: T): () => void {
    let set = map.get(pid);
    if (set === undefined) {
      set = new Set();
      map.set(pid, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  // -------------------------------------------------------------------------------------------
  // Signals (syscall-abi.md §3.9; processes-and-scheduling.md §3.17)
  // -------------------------------------------------------------------------------------------

  private groupMembers(pgid: number): Proc[] {
    return [...this.procs.values()].filter((p) => p.pgid === pgid && p.status === 'live');
  }

  /**
   * Whether process group `pgid` exists in session `sid`. An unreaped zombie still holds its
   * group (POSIX), so a pipeline whose first command already exited can still join its group.
   */
  private groupInSession(pgid: number, sid: number): boolean {
    for (const p of this.procs.values()) if (p.pgid === pgid && p.sid === sid) return true;
    return false;
  }

  private signalGroup(pgid: number, sig: SignalName): number {
    const members = this.groupMembers(pgid);
    for (const p of members) this.deliver(p, sig);
    return members.length;
  }

  private keyboardSignal(tty: Tty, sig: JobSignal): void {
    this.signalGroup(tty.fgPgid, sig);
  }

  /** Delivers one signal to one process. */
  private deliver(p: Proc, sig: SignalName): void {
    if (p.status !== 'live') return;
    if (sig === 'SIGKILL') {
      this.exitProc(p, { kind: 'signaled', signal: sig, code: signalExitStatus(sig) });
      return;
    }
    if (sig === 'SIGSTOP') {
      this.stop(p, sig);
      return;
    }
    const disp = p.disp.get(sig) ?? 'default';
    if (sig === 'SIGCONT') {
      this.cont(p);
      if (disp === 'catch') this.caught(p, sig);
      return;
    }
    if (disp === 'ignore') return;
    if (disp === 'catch') {
      this.caught(p, sig);
      return;
    }
    switch (SIGNALS[sig].defaultAction) {
      case 'terminate':
        this.exitProc(p, { kind: 'signaled', signal: sig, code: signalExitStatus(sig) });
        return;
      case 'stop':
        this.stop(p, sig);
        return;
      case 'ignore':
        return;
    }
  }

  /** A caught signal: run the program's hook, then interrupt a blocking call (ECANCELED). */
  private caught(p: Proc, sig: SignalName): void {
    const hook = p.program.signal?.bind(p.program) as
      ((ctx: ProgramContext, st: unknown, sig: SignalName) => void) | undefined;
    try {
      hook?.(p.ctx, p.st, sig);
    } catch (e) {
      this.opts.log?.(`signal hook of pid ${String(p.pid)} threw: ${String(e)}`);
    }
    const b = p.block;
    if (b?.interruptible === true) this.settle(p, b, err('ECANCELED'));
  }

  private stop(p: Proc, sig: SignalName): void {
    if (p.stopped !== null) return;
    p.stopped = sig;
    p.report = { kind: 'stopped', signal: sig };
    this.wake('wait');
  }

  private cont(p: Proc): void {
    if (p.stopped === null) return;
    p.stopped = null;
    p.report = { kind: 'continued' };
    this.wake('wait');
    if (p.block !== null) this.retry(p);
    this.enqueue(p);
  }

  private hangup(tty: Tty, graceMs: number): void {
    if (tty.closed) return;
    tty.closed = true;
    tty.ldisc.hangup();
    const members = [...this.procs.values()].filter(
      (p) => p.sid === tty.sid && p.status === 'live',
    );
    for (const p of members) {
      this.deliver(p, 'SIGHUP');
      if (p.stopped !== null) this.deliver(p, 'SIGCONT');
    }
    this.wake(`tty:${String(tty.n)}:read`);
    this.wake(`tty:${String(tty.n)}:space`);
    const cancel = this.clock.setTimer(graceMs, () => {
      for (const p of members) this.deliver(p, 'SIGKILL');
      this.ttys.delete(tty.n);
    });
    if (members.every((p) => p.status !== 'live')) {
      cancel();
      this.ttys.delete(tty.n);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Descriptors
  // -------------------------------------------------------------------------------------------

  private install(p: Proc, ofd: Ofd, from = 0): number {
    for (let fd = from; fd < FD_TABLE_SIZE; fd++) {
      if (!p.fds.has(fd)) {
        ofd.refs += 1;
        p.fds.set(fd, ofd);
        return fd;
      }
    }
    throw new SysError('EMFILE');
  }

  private closeFd(p: Proc, fd: number): boolean {
    const ofd = p.fds.get(fd);
    if (ofd === undefined) return false;
    p.fds.delete(fd);
    this.unref(ofd);
    return true;
  }

  private unref(ofd: Ofd): void {
    ofd.refs -= 1;
    if (ofd.refs > 0) return;
    switch (ofd.kind) {
      case 'tty':
        ofd.tty.refs -= 1;
        return;
      case 'pipe-r':
        ofd.pipe.readers -= 1;
        this.wake(`pipe:${String(ofd.pipe.id)}:write`);
        return;
      case 'pipe-w':
        ofd.pipe.writers -= 1;
        this.wake(`pipe:${String(ofd.pipe.id)}:read`);
        return;
      case 'file':
        void this.delegate('close', { fd: ofd.dfd }).catch(() => undefined);
        return;
      case 'mem':
        return;
    }
  }

  private fdOf(p: Proc, a: Rec): Ofd | null {
    const fd = num(a, 'fd');
    return fd === undefined ? null : (p.fds.get(fd) ?? null);
  }

  // -------------------------------------------------------------------------------------------
  // Delegation
  // -------------------------------------------------------------------------------------------

  private delegate(call: string, args: unknown): Promise<unknown> {
    const fn = this.delegateFn;
    if (fn === undefined || this.unsupported.has(call)) {
      return Promise.reject(new SysError('ENOSYS', `${call}: not available`));
    }
    return fn(call, args).catch((e: unknown) => {
      // A requested call outside the ABI registry (the `complete.*` family) that the kernel
      // refused once is answered locally from then on, so the shell's per-command history
      // update does not cost a round trip to the kernel each time.
      if (errnoOf(e) === 'ENOSYS' && !REGISTERED.has(call)) this.unsupported.add(call);
      throw e;
    });
  }

  /**
   * A delegated call as an outcome, with an optional fallback for chosen errnos. The fallback
   * may answer later (a page of the man overlay loads lazily); null keeps the kernel's error.
   */
  private remote(
    call: string,
    args: unknown,
    map?: (v: unknown) => Outcome | Promise<Outcome>,
    fallback?: (errno: Errno) => Outcome | Promise<Outcome | null> | null,
  ): Outcome {
    const p = this.delegate(call, args).then(
      (v) => (map === undefined ? ok(v) : map(v)),
      async (e: unknown) => {
        const se = asSysError(e);
        return (await fallback?.(se.errno)) ?? { k: 'err' as const, e: se };
      },
    );
    return { k: 'async', call, p };
  }

  /** The terminal user: the kernel's `proc.cred`, or the fallback identity. */
  async whoami(): Promise<HostIdentity> {
    if (this.cred !== null) return this.cred;
    try {
      const v = rec(await this.delegate('proc.cred', {}));
      const uid = num(v, 'uid');
      const gid = num(v, 'gid');
      const user = str(v, 'user');
      const home = str(v, 'home');
      if (uid !== undefined && gid !== undefined && user !== undefined && home !== undefined) {
        this.cred = { uid, gid, user, home: uid === 0 ? '/root' : home };
        return this.cred;
      }
    } catch {
      // the kernel cannot say: fall back to the identity the view was given
    }
    this.cred = this.identity ?? { uid: 1000, gid: 1000, user: 'demo', home: '/home/demo' };
    return this.cred;
  }

  /**
   * `path`, normalised, when it is a directory the terminal user may enter (`x`, as `cd` checks),
   * else null. A Terminal opened on a folder starts its shell there (UI-129).
   */
  async enterableDirectory(path: string): Promise<string | null> {
    if (!path.startsWith('/')) return null;
    const who = await this.whoami();
    const dir = normalise('/', path);
    try {
      const s = rec(await this.delegate('stat', { path: dir }));
      if (str(s, 'type') !== 'd') return null;
      return mayEnterAs(who, s) ? dir : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // System calls
  // -------------------------------------------------------------------------------------------

  private syscall(p: Proc, call: string, args: unknown): Outcome {
    const a = rec(args);
    try {
      switch (call) {
        case 'getpid':
          return ok({ pid: p.pid, ppid: p.ppid, pgid: p.pgid, sid: p.sid });
        case 'exit':
          this.exitProc(p, { kind: 'exited', code: clampCode(num(a, 'code')) });
          return { k: 'gone' };
        case 'spawn':
          return this.sysSpawn(p, a);
        case 'wait':
          return this.sysWait(p, a);
        case 'kill':
          return this.sysKill(p, a);
        case 'setpgid':
          return this.sysSetpgid(p, a);
        case 'sig.action':
          return this.sysSigAction(p, a);
        case 'getcwd':
          return this.sysGetcwd(p);
        case 'chdir':
          return this.sysChdir(p, a);
        case 'umask': {
          const old = p.umask;
          const mask = num(a, 'mask');
          if (mask !== undefined) p.umask = mask & 0o777;
          return ok({ old });
        }
        case 'nice':
          return this.sysNice(p, a);
        case 'setpriority':
          return this.sysSetpriority(p, a);
        case 'getpriority':
          return this.sysGetpriority(p, a);
        case 'proc.list':
          return this.sysProcList(p, a);
        case 'proc.info':
          return this.sysProcInfo(p, a);
        case 'proc.cred':
          return this.remote('proc.cred', {}, undefined, (errno) =>
            errno === 'ENOSYS' || errno === 'EPERM' ? ok(this.fallbackCred(p)) : null,
          );
        case 'sleep':
          return this.sysSleep(p, a);
        case 'time.now':
          return this.remote('time.now', {}, undefined, (errno) =>
            errno === 'ENOSYS' || errno === 'EPERM' ? ok(localTime(this.clock)) : null,
          );
        case 'pipe':
          return this.sysPipe(p, a);
        case 'dup':
          return this.sysDup(p, a);
        case 'dup2':
          return this.sysDup2(p, a);
        case 'close':
          return this.sysClose(p, a);
        case 'isatty': {
          const ofd = this.fdOf(p, a);
          if (ofd === null) return err('EBADF');
          return ok(ofd.kind === 'tty' ? { tty: true, n: ofd.tty.n } : { tty: false });
        }
        case 'read':
          return this.sysRead(p, a);
        case 'write':
          return this.sysWrite(p, a);
        case 'seek':
        case 'fstat':
          return this.fileCall(p, call, a);
        case 'open':
          return this.sysOpen(p, a);
        case 'stat':
        case 'lstat':
          return this.sysStat(p, call, a);
        case 'readdir':
          return this.sysReaddir(p, a);
        case 'tty.getattr':
          return this.sysTtyGetattr(p, a);
        case 'tty.setattr':
          return this.sysTtySetattr(p, a);
        case 'tcsetpgrp':
          return this.sysTcsetpgrp(p, a);
        case 'tcgetpgrp': {
          const ofd = this.fdOf(p, a);
          if (ofd === null) return err('EBADF');
          if (ofd.kind !== 'tty') return err('ENOTTY');
          return ok({ pgid: ofd.tty.fgPgid });
        }
        case 'tty.open':
        case 'tty.input':
        case 'tty.resize':
          return err('EPERM', 'the terminal host owns its TTYs');
        case 'ai.agent.submit':
          return this.sysAgentSubmit(p, a);
        case 'ai.agent.confirm':
          return this.sysAgentConfirm(p, a);
        case 'complete.query':
          return this.remote('complete.query', a, undefined, (errno) =>
            errno === 'ENOSYS' ? this.localComplete(p, a) : null,
          );
        case 'lsof':
          return this.remote('lsof', withAbsolutePaths(args, p.cwd), undefined, (errno) =>
            errno === 'ENOSYS' ? ok(this.localLsof(p, a)) : null,
          );
        default:
          return this.remote(call, withAbsolutePaths(args, p.cwd));
      }
    } catch (e) {
      if (e instanceof SysError) return { k: 'err', e };
      throw e;
    }
  }

  private fallbackCred(p: Proc): unknown {
    return {
      uid: p.uid,
      gid: p.gid,
      groups: [p.gid],
      user: p.user,
      groupNames: [p.user],
      home: p.home,
      ruid: p.uid,
    };
  }

  // ---- processes ----------------------------------------------------------------------------

  private sysSpawn(p: Proc, a: Rec): Outcome {
    const path = str(a, 'path');
    const argv = stringList(a['argv']);
    if (path === undefined || argv === null) return err('EINVAL');
    const comm = programName(absolute(p.cwd, path)) ?? '';
    const program = this.programs.get(comm);
    if (program === undefined) return err('ENOENT', `${path}: no such program`);
    let pgid = p.pgid;
    const want = num(a, 'pgid');
    if (want !== undefined && want !== 0) {
      if (!this.groupInSession(want, p.sid)) return err('EPERM');
      pgid = want;
    } else if (want === 0) pgid = 0;
    const fdArgs = rec(a['fds']);
    const fds: (Ofd | undefined)[] = [];
    for (const n of [0, 1, 2]) {
      const from = num(fdArgs, String(n));
      const src = from === undefined ? p.fds.get(n) : p.fds.get(from);
      if (from !== undefined && src === undefined) return err('EBADF');
      fds.push(src);
    }
    const envArg = a['env'];
    const env =
      typeof envArg === 'object' && envArg !== null
        ? new Map(
            Object.entries(envArg as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          )
        : new Map(p.env);
    const cwd = str(a, 'cwd');
    const child = this.create({
      program,
      comm,
      argv,
      env,
      cwd: cwd === undefined ? p.cwd : normalise(p.cwd, cwd),
      ppid: p.pid,
      pgid,
      sid: p.sid,
      uid: p.uid,
      gid: p.gid,
      user: p.user,
      home: p.home,
      ctty: p.ctty,
      fds,
      umask: p.umask,
      nice: Math.max(-20, Math.min(19, p.nice + (num(a, 'nice') ?? 0))),
    });
    const prio = num(a, 'priority');
    if (prio !== undefined) child.priority = prio;
    this.enqueue(child);
    return ok({ pid: child.pid });
  }

  private sysWait(p: Proc, a: Rec): Outcome {
    const target = num(a, 'pid') ?? -1;
    const nohang = bool(a, 'nohang');
    const untraced = bool(a, 'untraced');
    const continued = bool(a, 'continued');
    const matches = (c: Proc): boolean =>
      target > 0 ? c.pid === target : target === -1 ? true : c.pgid === -target;
    const check = (): Outcome | null => {
      const kids = [...p.children]
        .map((pid) => this.procs.get(pid))
        .filter((c): c is Proc => c !== undefined && matches(c));
      if (kids.length === 0) return err('ESRCH');
      for (const c of kids) {
        const r = c.report;
        if (r === null) continue;
        if (r.kind === 'exited' || r.kind === 'signaled') {
          this.reap(c);
          return ok({ pid: c.pid, status: r });
        }
        if ((r.kind === 'stopped' && untraced) || (r.kind === 'continued' && continued)) {
          c.report = null;
          return ok({ pid: c.pid, status: r });
        }
      }
      return nohang ? ok({ pid: 0 }) : null;
    };
    return check() ?? this.blockOn(p, 'wait', 'wait', check);
  }

  private sysKill(p: Proc, a: Rec): Outcome {
    const pid = num(a, 'pid');
    const sig = a['sig'];
    if (pid === undefined) return err('EINVAL');
    if (sig !== 0 && (typeof sig !== 'string' || !Object.hasOwn(SIGNALS, sig)))
      return err('EINVAL');
    const targets =
      pid > 0
        ? [this.procs.get(pid)].filter((t): t is Proc => t !== undefined && t.status === 'live')
        : this.groupMembers(pid === 0 ? p.pgid : -pid);
    if (targets.length === 0) {
      return this.delegateFn === undefined ? err('ESRCH') : this.remote('kill', { pid, sig });
    }
    const allowed = targets.filter((t) => p.uid === 0 || t.uid === p.uid);
    if (allowed.length === 0) return err('EPERM');
    if (sig === 0) return ok({ delivered: 0 });
    for (const t of allowed) this.deliver(t, sig as SignalName);
    if (p.status !== 'live') return { k: 'gone' };
    return ok({ delivered: allowed.length });
  }

  private sysSetpgid(p: Proc, a: Rec): Outcome {
    const pid = num(a, 'pid') ?? 0;
    const target = pid === 0 ? p : this.procs.get(pid);
    if (target === undefined || (target !== p && target.ppid !== p.pid)) return err('ESRCH');
    if (target.sid !== p.sid || target.pid === target.sid) return err('EPERM');
    const want = num(a, 'pgid') ?? 0;
    const pgid = want === 0 ? target.pid : want;
    if (pgid !== target.pid && !this.groupInSession(pgid, p.sid)) {
      return err('EPERM');
    }
    target.pgid = pgid;
    return ok({ pgid });
  }

  private sysSigAction(p: Proc, a: Rec): Outcome {
    const sig = str(a, 'sig');
    const action = str(a, 'action');
    if (sig === undefined || !Object.hasOwn(SIGNALS, sig)) return err('EINVAL');
    if (action !== 'default' && action !== 'ignore' && action !== 'catch') return err('EINVAL');
    const name = sig as SignalName;
    if ((name === 'SIGKILL' || name === 'SIGSTOP') && action !== 'default') return err('EINVAL');
    const old = p.disp.get(name) ?? 'default';
    p.disp.set(name, action);
    return ok({ old });
  }

  private sysGetcwd(p: Proc): Outcome {
    if (p.cwdIno !== null) return ok({ path: p.cwd, ino: p.cwdIno });
    const path = p.cwd;
    return this.remote(
      'stat',
      { path },
      (v) => {
        const ino = str(rec(v), 'ino') ?? UNKNOWN_INO;
        if (p.cwd === path) p.cwdIno = ino;
        return ok({ path, ino });
      },
      () => ok({ path, ino: UNKNOWN_INO }),
    );
  }

  private sysChdir(p: Proc, a: Rec): Outcome {
    const raw = str(a, 'path');
    if (raw === undefined || raw === '') return err('ENOENT');
    const path = normalise(p.cwd, raw);
    const done = (s: Rec): Outcome => {
      if (str(s, 'type') !== 'd') return err('ENOTDIR');
      if (!this.mayEnter(p, s)) return err('EACCES');
      p.cwd = path;
      p.cwdIno = str(s, 'ino') ?? UNKNOWN_INO;
      if (p.pid === p.sid) {
        for (const l of this.cwdListeners.get(p.pid) ?? []) l(path, tildify(path, p.home));
      }
      return ok({ path, ino: p.cwdIno });
    };
    return this.remote(
      'stat',
      { path },
      (v) => done(rec(v)),
      async (errno) => {
        if (errno !== 'ENOENT' && errno !== 'ENOSYS') return null;
        const overlay = await this.overlayStatOf(path);
        return overlay === null ? null : done(overlay);
      },
    );
  }

  /** `x` permission on a directory for the caller (root always may). */
  private mayEnter(p: Proc, s: Rec): boolean {
    return mayEnterAs(p, s);
  }

  private schedRet(t: Proc): unknown {
    return {
      priority: t.priority,
      nice: t.nice,
      effPrio: Math.max(0, Math.min(39, t.priority + t.nice)),
    };
  }

  private sysNice(p: Proc, a: Rec): Outcome {
    const inc = num(a, 'inc') ?? 0;
    if (inc < 0 && p.uid !== 0) return err('EPERM');
    p.nice = Math.max(-20, Math.min(19, p.nice + inc));
    return ok(this.schedRet(p));
  }

  private sysSetpriority(p: Proc, a: Rec): Outcome {
    const pid = num(a, 'pid') ?? 0;
    const group = bool(a, 'group');
    const targets = group
      ? this.groupMembers(pid === 0 ? p.pgid : pid)
      : [pid === 0 ? p : this.procs.get(pid)].filter((t): t is Proc => t !== undefined);
    if (targets.length === 0) return this.remote('setpriority', a);
    const nice = num(a, 'nice');
    const priority = num(a, 'priority');
    for (const t of targets) {
      if (p.uid !== 0 && t.uid !== p.uid) return err('EPERM');
      if (nice !== undefined && nice < t.nice && p.uid !== 0) return err('EPERM');
    }
    for (const t of targets) {
      if (nice !== undefined) t.nice = Math.max(-20, Math.min(19, nice));
      if (priority !== undefined) t.priority = Math.max(0, Math.min(39, priority));
    }
    return ok(this.schedRet(targets[0] ?? p));
  }

  private sysGetpriority(p: Proc, a: Rec): Outcome {
    const pid = num(a, 'pid') ?? p.pid;
    const t = this.procs.get(pid);
    if (t === undefined) return this.remote('getpriority', a);
    return ok({ ...(this.schedRet(t) as object), band: 'normal' });
  }

  /**
   * `proc.info` of a local process, plus the job-control columns `ps` reads when present (sid,
   * tty, foreground, session leader, stopped; coreutils lib/procs.ts `ProcExtra`, requested for
   * protocol `ProcInfo`).
   */
  private info(t: Proc, caller: Proc): ProcInfo & HostProcExtra {
    const state =
      t.status === 'zombie'
        ? 'TERMINATED'
        : t === caller
          ? 'RUNNING'
          : t.stopped !== null || t.block !== null
            ? 'BLOCKED'
            : 'READY';
    const waitingOn =
      t.stopped !== null ? 'sigcont' : t.block === null ? null : t.block.on.slice(0, 128);
    return {
      pid: t.pid,
      ppid: t.ppid,
      pgid: t.pgid,
      uid: t.uid,
      user: t.user,
      state,
      class: 'user',
      waitingOn,
      priority: t.priority,
      nice: t.nice,
      effPrio: Math.max(0, Math.min(39, t.priority + t.nice)),
      cpuPct: 0,
      cpuTimeMs: Math.round(t.cpuMs),
      residentBytes: 0,
      swappedBytes: 0,
      faults: 0,
      hitRatio: 1,
      speculative: false,
      argv: t.uid === caller.uid || caller.uid === 0 ? [...t.argv] : t.argv.slice(0, 1),
      executor: null,
      windows: [],
      startedAt: t.startedAt,
      sid: t.sid,
      tty: t.ctty?.n ?? null,
      fg: t.ctty !== null && t.ctty.fgPgid === t.pgid,
      leader: t.pid === t.sid,
      stopped: t.stopped !== null,
      kind: 'user',
    };
  }

  private sysProcList(p: Proc, a: Rec): Outcome {
    const uid = num(a, 'uid');
    const pgid = num(a, 'pgid');
    const local = [...this.procs.values()]
      .filter(
        (t) => (uid === undefined || t.uid === uid) && (pgid === undefined || t.pgid === pgid),
      )
      .map((t) => this.info(t, p));
    if (pgid !== undefined || a['cursor'] !== undefined) return ok({ procs: local });
    return this.remote(
      'proc.list',
      a,
      (v) => {
        const remote = rec(v)['procs'];
        const others = Array.isArray(remote)
          ? (remote as ProcInfo[]).filter((r) => !this.procs.has(r.pid))
          : [];
        return ok({ procs: [...others, ...local] });
      },
      () => ok({ procs: local }),
    );
  }

  private sysProcInfo(p: Proc, a: Rec): Outcome {
    const pid = num(a, 'pid') ?? p.pid;
    const t = this.procs.get(pid);
    if (t === undefined) return this.remote('proc.info', a);
    const fds = [...t.fds.entries()].map(([fd, ofd]) => ({
      fd,
      kind:
        ofd.kind === 'tty' ? 'tty' : ofd.kind === 'file' || ofd.kind === 'mem' ? 'file' : 'pipe',
      flags: ofd.kind === 'pipe-r' ? 'r' : ofd.kind === 'pipe-w' ? 'w' : 'rw',
    }));
    return ok({ ...this.info(t, p), fds });
  }

  private sysSleep(p: Proc, a: Rec): Outcome {
    const ms = Math.max(0, num(a, 'ms') ?? 0);
    const start = this.clock.now();
    let cancel: (() => void) | null = null;
    const b: Block = {
      on: 'sleep',
      interruptible: true,
      cancel: () => cancel?.(),
    };
    cancel = this.clock.setTimer(ms, () => {
      cancel = null;
      this.settle(p, b, ok({ sleptMs: this.clock.now() - start }));
    });
    return { k: 'block', b };
  }

  // ---- descriptors --------------------------------------------------------------------------

  private sysPipe(p: Proc, a: Rec): Outcome {
    const pipe = new Pipe(this.nextPipe++, num(a, 'capacity'));
    const r: Ofd = { kind: 'pipe-r', pipe, refs: 0 };
    const w: Ofd = { kind: 'pipe-w', pipe, refs: 0 };
    pipe.readers = 1;
    pipe.writers = 1;
    const rfd = this.install(p, r);
    const wfd = this.install(p, w);
    return ok({ r: rfd, w: wfd });
  }

  private sysDup(p: Proc, a: Rec): Outcome {
    const ofd = this.fdOf(p, a);
    if (ofd === null) return err('EBADF');
    return ok({ fd: this.install(p, ofd) });
  }

  private sysDup2(p: Proc, a: Rec): Outcome {
    const ofd = this.fdOf(p, a);
    const to = num(a, 'to');
    if (ofd === null || to === undefined || to < 0 || to >= FD_TABLE_SIZE) return err('EBADF');
    if (p.fds.get(to) === ofd) return ok({ fd: to });
    this.closeFd(p, to);
    ofd.refs += 1;
    p.fds.set(to, ofd);
    return ok({ fd: to });
  }

  private sysClose(p: Proc, a: Rec): Outcome {
    const fd = num(a, 'fd');
    if (fd === undefined || !this.closeFd(p, fd)) return err('EBADF');
    return ok({});
  }

  private sysRead(p: Proc, a: Rec): Outcome {
    const ofd = this.fdOf(p, a);
    const len = Math.max(1, num(a, 'len') ?? 4_096);
    if (ofd === null) return err('EBADF');
    switch (ofd.kind) {
      case 'tty':
        return this.ttyRead(p, ofd.tty, len);
      case 'pipe-r': {
        const pipe = ofd.pipe;
        const attempt = (): Outcome | null => {
          const data = pipe.read(len);
          if (data === null) return null;
          if (data.length > 0) this.wake(`pipe:${String(pipe.id)}:write`);
          return ok(toBuffer(data));
        };
        return attempt() ?? this.blockOn(p, `pipe:${String(pipe.id)}:read`, 'pipe:read', attempt);
      }
      case 'pipe-w':
        return err('EBADF');
      case 'mem': {
        const off = num(a, 'offset') ?? ofd.pos;
        const data = ofd.data.slice(off, off + len);
        if (num(a, 'offset') === undefined) ofd.pos = off + data.length;
        return ok(toBuffer(data));
      }
      case 'file':
        return this.remote('read', { ...a, fd: ofd.dfd });
    }
  }

  private ttyRead(p: Proc, tty: Tty, len: number): Outcome {
    const attempt = (): Outcome | null => {
      if (tty.closed || tty.ldisc.hungUp) return ok(new ArrayBuffer(0));
      if (p.ctty === tty && p.pgid !== tty.fgPgid) {
        // A background read (§3.2 process groups): SIGTTIN, retried once the job continues.
        const disp = p.disp.get('SIGTTIN') ?? 'default';
        if (disp === 'ignore') return err('EIO');
        this.signalGroup(p.pgid, 'SIGTTIN');
        if (p.status !== 'live') return { k: 'gone' };
        return disp === 'catch' ? err('ECANCELED') : null;
      }
      const data = tty.ldisc.read(len);
      return data === null ? null : ok(toBuffer(data));
    };
    return (
      attempt() ??
      this.blockOn(p, `tty:${String(tty.n)}:read`, `tty:read:${String(tty.n)}`, attempt)
    );
  }

  private sysWrite(p: Proc, a: Rec): Outcome {
    const ofd = this.fdOf(p, a);
    const data = a['data'];
    if (ofd === null) return err('EBADF');
    if (!(data instanceof ArrayBuffer)) return err('EINVAL');
    const bytes = new Uint8Array(data);
    switch (ofd.kind) {
      case 'tty': {
        const tty = ofd.tty;
        const attempt = (): Outcome | null => {
          if (tty.closed) return err('EIO');
          if (tty.full()) return null;
          tty.ldisc.write(bytes);
          return ok({ bytes: bytes.length });
        };
        return attempt() ?? this.blockOn(p, `tty:${String(tty.n)}:space`, 'tty:output', attempt);
      }
      case 'pipe-w': {
        const pipe = ofd.pipe;
        let off = 0;
        const attempt = (): Outcome | null => {
          const n = pipe.write(bytes.subarray(off));
          if (n === 'epipe') {
            this.deliver(p, 'SIGPIPE');
            return p.status === 'live' ? err('EPIPE') : { k: 'gone' };
          }
          off += n;
          if (n > 0) this.wake(`pipe:${String(pipe.id)}:read`);
          return off >= bytes.length ? ok({ bytes: bytes.length }) : null;
        };
        return attempt() ?? this.blockOn(p, `pipe:${String(pipe.id)}:write`, 'pipe:write', attempt);
      }
      case 'pipe-r':
      case 'mem':
        return err('EBADF');
      case 'file':
        return this.remote('write', { ...a, fd: ofd.dfd });
    }
  }

  private fileCall(p: Proc, call: string, a: Rec): Outcome {
    const ofd = this.fdOf(p, a);
    if (ofd === null) return err('EBADF');
    if (ofd.kind === 'file') return this.remote(call, { ...a, fd: ofd.dfd });
    if (ofd.kind === 'mem' && call === 'seek') {
      const base =
        str(a, 'whence') === 'end' ? ofd.data.length : str(a, 'whence') === 'cur' ? ofd.pos : 0;
      ofd.pos = Math.max(0, base + (num(a, 'offset') ?? 0));
      return ok({ offset: ofd.pos });
    }
    return err('EINVAL');
  }

  /** The read-only text an overlay serves at `path` (a `/bin` manifest or a man page), or null. */
  private async overlayText(path: string): Promise<string | null> {
    const name = programName(path);
    const bin = overlayStat(path, this.programs, Date.now());
    if (bin !== null && bin.type === 'f' && name !== null) return manifestText(name);
    const man = this.opts.manPages;
    return man === undefined ? null : manOverlayText(path, man);
  }

  /** The `stat` of an overlay path (`/bin`, `/usr/share/man`), or null. */
  private async overlayStatOf(path: string): Promise<Stat | null> {
    const now = Date.now();
    const bin = overlayStat(path, this.programs, now);
    if (bin !== null) return bin;
    const man = this.opts.manPages;
    return man === undefined ? null : manOverlayStat(path, man, now);
  }

  private sysOpen(p: Proc, a: Rec): Outcome {
    const raw = str(a, 'path');
    if (raw === undefined) return err('EINVAL');
    const path = absolute(p.cwd, raw);
    const flags = str(a, 'flags') ?? 'r';
    return this.remote(
      'open',
      { ...a, path },
      (v) => {
        const r = rec(v);
        const dfd = num(r, 'fd');
        if (dfd === undefined) return err('EIO');
        try {
          const fd = this.install(p, {
            kind: 'file',
            dfd,
            path: normalise('/', path),
            flags,
            refs: 0,
          });
          return ok({ ...r, fd });
        } catch (e) {
          void this.delegate('close', { fd: dfd }).catch(() => undefined);
          return { k: 'err', e: asSysError(e) };
        }
      },
      async (errno) => {
        if (errno !== 'ENOENT' && errno !== 'ENOSYS') return null;
        const at = normalise('/', path);
        const s = await this.overlayStatOf(at);
        if (s === null || s.type !== 'f') return null;
        if (flags !== 'r') return err('EACCES');
        const text = await this.overlayText(at);
        if (text === null) return null;
        const fd = this.install(p, {
          kind: 'mem',
          data: enc.encode(text),
          pos: 0,
          path: at,
          refs: 0,
        });
        return ok({ fd, ino: s.ino, type: 'f', version: 1, size: s.size });
      },
    );
  }

  private sysStat(p: Proc, call: string, a: Rec): Outcome {
    const raw = str(a, 'path');
    if (raw === undefined) return err('EINVAL');
    const path = absolute(p.cwd, raw);
    return this.remote(call, { ...a, path }, undefined, async (errno) => {
      if (errno !== 'ENOENT' && errno !== 'ENOSYS') return null;
      const s = await this.overlayStatOf(normalise('/', path));
      return s === null ? null : ok(s);
    });
  }

  private overlayEntries(plus: boolean): DirEntry[] {
    const now = Date.now();
    return this.programs.names().flatMap((name) => {
      const s = overlayStat(`${BIN_DIR}/${name}.json`, this.programs, now);
      if (s === null) return [];
      const entry: DirEntry = { name: `${name}.json`, ino: s.ino, type: 'f' };
      return plus ? [{ ...entry, stat: s }] : [entry];
    });
  }

  /** The entries an overlay adds to directory `dir` (`/bin`, the man directories), or null. */
  private async overlayDir(dir: string, plus: boolean): Promise<DirEntry[] | null> {
    if (dir === BIN_DIR) return this.overlayEntries(plus);
    const man = this.opts.manPages;
    if (man === undefined || (await manOverlayStat(dir, man, 0))?.type !== 'd') return null;
    return manOverlayEntries(dir, man, plus, Date.now());
  }

  private sysReaddir(p: Proc, a: Rec): Outcome {
    const raw = str(a, 'path');
    if (raw === undefined) return err('EINVAL');
    const path = absolute(p.cwd, raw);
    const dir = normalise('/', path);
    const plus = bool(a, 'plus');
    const overlaid =
      dir === BIN_DIR || (this.opts.manPages !== undefined && dir.startsWith('/usr/share/man'));
    if (!overlaid) return this.remote('readdir', { ...a, path });
    return this.remote(
      'readdir',
      { ...a, path },
      async (v) => {
        const r = rec(v);
        const entries = Array.isArray(r['entries']) ? (r['entries'] as DirEntry[]) : [];
        if (r['next'] !== undefined || a['cursor'] !== undefined) return ok(v);
        const extra = (await this.overlayDir(dir, plus)) ?? [];
        const have = new Set(entries.map((e) => e.name));
        const merged = [...entries, ...extra.filter((e) => !have.has(e.name))];
        merged.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
        return ok({ ...r, entries: merged });
      },
      async (errno) => {
        if (errno !== 'ENOENT' && errno !== 'ENOSYS') return null;
        const extra = await this.overlayDir(dir, plus);
        return extra === null ? null : ok({ entries: extra, dirVersion: 1 });
      },
    );
  }

  // ---- completion and lsof stand-ins ---------------------------------------------------------

  /** Every entry of a directory as the caller sees it, with the overlays merged in. */
  private async entriesOf(dir: string): Promise<DirEntry[]> {
    const out: DirEntry[] = [];
    let cursor: string | undefined;
    try {
      do {
        const page = rec(
          await this.delegate(
            'readdir',
            cursor === undefined ? { path: dir } : { path: dir, cursor },
          ),
        );
        if (Array.isArray(page['entries'])) out.push(...(page['entries'] as DirEntry[]));
        cursor = str(page, 'next');
      } while (cursor !== undefined);
    } catch (e) {
      const errno = errnoOf(e);
      if (errno !== 'ENOENT' && errno !== 'ENOSYS') throw e;
    }
    const have = new Set(out.map((e) => e.name));
    for (const e of (await this.overlayDir(dir, false)) ?? []) if (!have.has(e.name)) out.push(e);
    return out;
  }

  /**
   * `complete.query` answered here while the kernel does not route it (the `complete.*` calls
   * are requested, not registered, so the dispatcher says ENOSYS; UI-123): commands, paths and
   * flags from the same sources the `complete` service indexes (the builtins and `/bin`, the
   * directory as the caller may list it, the man pages' front matter). A linear filter, not the
   * service's trie, so SYS-03 is still measured on the service. History stays with the shell.
   */
  private async localComplete(p: Proc, a: Rec): Promise<Outcome> {
    const prefix = str(a, 'prefix') ?? '';
    const limit = Math.max(1, Math.min(100, num(a, 'limit') ?? 100));
    let items: CompleteItem[];
    try {
      switch (str(a, 'ns') ?? '') {
        case 'cmd': {
          const programs = (await this.entriesOf(BIN_DIR))
            .filter((e) => e.name.endsWith('.json'))
            .map((e) => e.name.slice(0, -5));
          items = [
            ...BUILTIN_NAMES.map((text) => ({ text, kind: 'builtin' as const })),
            ...programs.map((text) => ({ text, kind: 'program' as const })),
          ].filter((i) => i.text.startsWith(prefix));
          break;
        }
        case 'path': {
          const dir = normalise(p.cwd, str(a, 'dir') ?? p.cwd);
          const hidden = prefix.startsWith('.');
          items = (await this.entriesOf(dir))
            .filter((e) => e.name.startsWith(prefix) && (hidden || !e.name.startsWith('.')))
            .map((e) => ({ text: e.name, kind: e.type }));
          break;
        }
        case 'flag': {
          const cmd = str(a, 'cmd');
          const man = this.opts.manPages;
          if (cmd === undefined) return err('EINVAL', 'the flag namespace needs cmd');
          const flags = man === undefined ? [] : await manFlags(man, cmd);
          items = flags.flatMap((f) => {
            const desc = f.desc.length > 80 ? `${f.desc.slice(0, 79)}…` : f.desc;
            return [f.short, f.long]
              .filter((t): t is string => t !== null && t.startsWith(prefix))
              .map((text) => ({ text, kind: 'flag' as const, ...(desc === '' ? {} : { desc }) }));
          });
          break;
        }
        default:
          return err('ENOSYS', 'complete.query: the shell keeps its own history here');
      }
    } catch (e) {
      return { k: 'err', e: asSysError(e) };
    }
    const seen = new Set<string>();
    const unique = items
      .filter((i) => (seen.has(i.text) ? false : (seen.add(i.text), true)))
      .sort((x, y) => (x.text < y.text ? -1 : x.text > y.text ? 1 : 0));
    return ok({ items: unique.slice(0, limit), truncated: unique.length > limit, indexed: true });
  }

  /**
   * `lsof` for this Terminal's processes while the kernel has no handler (ENOSYS; UI-125): their
   * TTYs, pipes and the files they opened, for the caller's own processes (all of them for
   * root), filtered by `pid` and `path`. Leases are the kernel's and are not listed.
   */
  private localLsof(p: Proc, a: Rec): { open: OpenFile[]; leases: [] } {
    const pid = num(a, 'pid');
    const raw = str(a, 'path');
    const path = raw === undefined ? undefined : normalise(p.cwd, raw);
    const open: OpenFile[] = [];
    for (const t of this.procs.values()) {
      if (t.status !== 'live' || (p.uid !== 0 && t.uid !== p.uid)) continue;
      if (pid !== undefined && t.pid !== pid) continue;
      for (const [fd, ofd] of [...t.fds.entries()].sort((x, y) => x[0] - y[0])) {
        const [name, flags] =
          ofd.kind === 'tty'
            ? [`tty${String(ofd.tty.n)}`, 'rw']
            : ofd.kind === 'pipe-r'
              ? [`pipe:${String(ofd.pipe.id)}`, 'r']
              : ofd.kind === 'pipe-w'
                ? [`pipe:${String(ofd.pipe.id)}`, 'w']
                : ofd.kind === 'file'
                  ? [ofd.path, ofd.flags]
                  : [ofd.path, 'r'];
        if (path !== undefined && name !== path) continue;
        open.push({ pid: t.pid, uid: t.uid, fd, path: name, flags: flags.slice(0, 8) });
      }
    }
    return { open, leases: [] };
  }

  // ---- TTYs ---------------------------------------------------------------------------------

  private attrOf(tty: Tty): TtyAttr {
    const m = tty.modes;
    return {
      n: tty.n,
      canonical: m.canonical,
      echo: m.echo,
      isig: m.isig,
      altScreen: m.altScreen,
      cols: tty.cols,
      rows: tty.rows,
      fgPgid: tty.fgPgid,
      sid: tty.sid,
    };
  }

  private ttyOf(p: Proc, a: Rec): Tty | Outcome {
    const ofd = this.fdOf(p, a);
    if (ofd === null) return err('EBADF');
    if (ofd.kind !== 'tty') return err('ENOTTY');
    return ofd.tty;
  }

  private sysTtyGetattr(p: Proc, a: Rec): Outcome {
    const tty = this.ttyOf(p, a);
    return tty instanceof Tty ? ok(this.attrOf(tty)) : tty;
  }

  private sysTtySetattr(p: Proc, a: Rec): Outcome {
    const tty = this.ttyOf(p, a);
    if (!(tty instanceof Tty)) return tty;
    const change: Partial<Modes> = {};
    for (const key of ['canonical', 'echo', 'isig', 'altScreen'] as const) {
      const v = a[key];
      if (typeof v === 'boolean') change[key] = v;
    }
    if (!tty.ldisc.takingOver) tty.ldisc.setModes(change);
    return ok(this.attrOf(tty));
  }

  private sysTcsetpgrp(p: Proc, a: Rec): Outcome {
    const tty = this.ttyOf(p, a);
    if (!(tty instanceof Tty)) return tty;
    if (p.ctty !== tty) return err('ENOTTY');
    const pgid = num(a, 'pgid');
    if (pgid === undefined) return err('EINVAL');
    if (!this.groupInSession(pgid, tty.sid)) return err('EPERM');
    tty.fgPgid = pgid;
    this.wake(`tty:${String(tty.n)}:read`);
    return ok({});
  }

  // ---- the kernel-owned confirmation (§3.11, AGT-03) ----------------------------------------

  private sysAgentSubmit(p: Proc, a: Rec): Outcome {
    const steps = Array.isArray(a['steps']) ? (a['steps'] as PlanStep[]) : [];
    return this.remote('ai.agent.submit', withAbsolutePaths(a, p.cwd), (v) => {
      const result = v as SubmitResult;
      if (typeof result.planId === 'string') this.plans.set(result.planId, { steps, result });
      return ok(v);
    });
  }

  private sysAgentConfirm(p: Proc, a: Rec): Outcome {
    const planId = str(a, 'planId');
    if (planId === undefined) return err('EINVAL');
    const tty = p.ctty;
    // Step 1: no controlling TTY, no confirmation; nothing runs.
    if (tty === null || tty.closed) return err('ENOTTY', 'a destructive plan needs a terminal');
    const plan = this.plans.get(planId);
    if (plan === undefined) return this.remote('ai.agent.confirm', a);
    const q = this.queue(`tty:${String(tty.n)}:read`);
    let prompt: (() => void) | null = null;
    const block: Block = {
      on: 'tty:confirm',
      interruptible: false,
      retry: () => {
        if (prompt !== null) return null;
        if (tty.closed) return err('ENOTTY');
        // Step 2: a background agent is stopped with SIGTTIN until it is in the foreground.
        if (p.pgid !== tty.fgPgid) {
          this.signalGroup(p.pgid, 'SIGTTIN');
          return p.status === 'live' ? null : { k: 'gone' };
        }
        if (tty.ldisc.takingOver) return null;
        q.delete(p);
        const full: ConfirmPlan = {
          planId,
          steps: plan.steps,
          result: plan.result,
          requester: { pid: p.pid, comm: p.comm },
        };
        prompt = this.prompt(tty, full, (out) => this.settle(p, block, out));
        return null;
      },
      cancel: () => {
        q.delete(p);
        prompt?.();
      },
    };
    q.add(p);
    const first = block.retry?.() ?? null;
    if (first !== null) {
      q.delete(p);
      return first;
    }
    return { k: 'block', b: block };
  }

  /**
   * Shows the confirmation on `tty` and reads one key from its keyboard (§3.11 steps 3-8).
   * `done` gets the call's outcome; the returned function abandons the prompt.
   */
  private prompt(tty: Tty, plan: ConfirmPlan, done: (out: Outcome) => void): () => void {
    let finished = false;
    let cancelTimer: (() => void) | null = null;
    const end = (): void => {
      finished = true;
      cancelTimer?.();
      cancelTimer = null;
      tty.ldisc.endTakeover();
      this.opts.onConfirmStrip?.(tty.n, false, plan.requester);
    };
    const answer = (key: ConfirmKey | 'timeout'): void => {
      if (finished) return;
      end();
      const echo = key === 'yes' ? 'y' : key === 'edit' ? 'e' : key === 'no' ? 'n' : '';
      tty.ldisc.write(enc.encode(`${echo}\n`));
      if (key === 'yes') {
        // The kernel mints the plan token; the answer came from this TTY's keyboard only.
        done(this.remote('ai.agent.confirm', { planId: plan.planId }));
      } else {
        const kind: ConfirmOutcome =
          key === 'timeout' ? 'timeout' : key === 'edit' ? 'edit-unavailable' : 'declined';
        tty.ldisc.write(enc.encode(`${this.confirmRenderer.outcome(kind)}\n`));
        done(err('ECANCELED', 'the plan was not confirmed'));
      }
      this.scheduleOutput();
    };
    // Step 3: reads suspended, type-ahead discarded, raw without echo, the strip shown.
    tty.ldisc.beginTakeover(answer);
    this.opts.onConfirmStrip?.(tty.n, true, plan.requester);
    // Step 4: the block is written by the owner of the TTY, never by the agent.
    tty.ldisc.write(enc.encode(this.confirmRenderer.block(plan, tty.cols)));
    this.scheduleOutput();
    // Step 7: the confirm token's lifetime.
    cancelTimer = this.clock.setTimer(this.confirmTimeoutMs, () => answer('timeout'));
    return () => {
      if (!finished) end();
    };
  }
}

function* failing(e: unknown): Gen {
  yield* [];
  throw e;
}

function localTime(clock: HostClock): unknown {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    epochMs: Date.now(),
    monotonicMs: Math.max(0, clock.now()),
    tz: /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) ? tz : 'UTC',
    tzOffsetMin: -new Date().getTimezoneOffset(),
  };
}

/** A plain-text confirmation, used when no renderer is given (tests, the AI-off build). */
export const PLAIN_CONFIRM: ConfirmRenderer = {
  block: (plan) => {
    const lines = [
      `-- Kernel confirmation · ${plan.requester.comm} (pid ${String(plan.requester.pid)}) --`,
      `Plan · ${String(plan.steps.length)} step${plan.steps.length === 1 ? '' : 's'}`,
      ...plan.steps.map((s, i) => `${String(i + 1).padStart(3)}  ${s.op}`),
      `Needs confirmation because: ${plan.result.confirm.reasons.join(', ')}`,
      'Proceed? [y/N/e=edit] ',
    ];
    return lines.join('\r\n');
  },
  outcome: (kind) =>
    kind === 'timeout'
      ? '✗ confirmation timed out — nothing ran'
      : kind === 'edit-unavailable'
        ? '✗ editing a plan is not available here — nothing ran'
        : '✗ declined — nothing ran',
};
