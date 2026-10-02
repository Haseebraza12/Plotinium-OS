/**
 * The process system: the kernel's glue between the process table (`core/proc`), the scheduler
 * (`core/sched`), the executor pool and its workers, the watchdog and kill path, the kernel timer
 * heap and the memory manager (`core/mm`) — processes-and-scheduling.md §3.6–§3.17, KPS-04..09,
 * KPS-13; memory-and-paging.md §3.7, §3.9, §3.13.
 *
 * Thread-agnostic. The host injects an `ExecutorTransport` (Worker ports in the browser, an
 * in-process runtime under Node) and drives the `TimerHeap` with ONE platform timer (KPS-13). It
 * implements, in the order of the sched agent's integration notes:
 *
 *   SchedHost     dispatch/resume frames with `pendingReply` and caught `pendingSigs`, PREEMPT
 *                 through the SAB control block (message fallback without SAB), and one klog record
 *                 plus `proc.state` event per transition through `Lifecycle.record`.
 *   Frames        identity check (`checkFrame`: stale ignored, mismatch audited, SUSPECT, second
 *                 mismatch terminates), yield / syscall (F fast path with `resume`, T/B/X/R block
 *                 then wake) / fault / exit / killed / error, watchdog.clear, overrun placement.
 *   Timers        aging tick, interactive pause, watchdog period, 1 s housekeeping (mm.tick, idle
 *                 hint, executor reaping, load averages) — all on the kernel timer heap.
 *   Admission     spawn: manifest → start-up closure (dsa/dag) → caps → PCB → memory reservation
 *                 → placement (pool) → executor start → `load` → NEW → READY.
 *   Kill path     `KillHooks` for proc (zombie, SIGCHLD, wait wake-ups, reparenting, reaping),
 *                 mm (free), the terminate hooks of vfs/lockd/wm, and the executor (`drop`).
 *   Signals       dispositions, stop (BLOCKED `sigcont`) / continue, caught delivery at the next
 *                 dispatch, ECANCELED for blocked B calls, job control per TTY.
 */
import type {
  AppManifest,
  Cap,
  CallSpec,
  Errno,
  ErrDetail,
  ProcClass,
  SignalName,
  SysRes,
  WaitArgs,
  WaitRet,
} from '@plotinium/protocol';
import {
  bitsToCaps,
  boundingSet,
  CALLS,
  capsToBits,
  fail,
  NEVER_FROM_MANIFEST,
  ok,
  signalNumber,
} from '@plotinium/protocol';

import { isKernelError, KernelError } from '../errors.ts';
import type { EventBus } from '../events/bus.ts';
import type { HookRegistry } from '../hooks/index.ts';
import type { PlatformInfo } from '../host.ts';
import type { Auditor } from '../ipc/audit.ts';
import type { Dispatcher } from '../ipc/dispatcher.ts';
import type { ExecPortRec } from '../ipc/ports.ts';
import { execPort } from '../ipc/ports.ts';
import type { Klog } from '../klog/klog.ts';
import type { MemoryManager } from '../mm/mm.ts';
import type { ProgramCatalog } from '../programs/catalog.ts';
import { manifestNameOf, manifestPath } from '../programs/catalog.ts';
import { ClosureCache } from '../programs/closure.ts';
import {
  CTL,
  CTL_FLAG,
  PREEMPT_NONE,
  setFlag,
  setPreempt as ctlSetPreempt,
  writeSliceSeq,
} from '../sched/control-block.ts';
import { KillPath } from '../sched/kill.ts';
import type { KillHooks } from '../sched/kill.ts';
import { defaultSchedParams, EXEC_IDLE_REAP_MS, IDLE_MS } from '../sched/params.ts';
import type { SchedParams } from '../sched/params.ts';
import { ExecutorPool } from '../sched/placement.ts';
import type { PlacementDecision } from '../sched/placement.ts';
import { defaultHeapFactory, Scheduler } from '../sched/scheduler.ts';
import type { SliceEndResult, SliceReport as SchedSliceReport } from '../sched/scheduler.ts';
import { NonPreemptiveSections } from '../sched/sections.ts';
import type { TimerHeap, TimerId } from '../sched/timers.ts';
import type { HeapFactory, SchedHost } from '../sched/types.ts';
import { currentRunTokens, EmbedActivity } from '../sched/tokens.ts';
import { SuspectTracker, Watchdog } from '../sched/watchdog.ts';
import type {
  ExecutorToKernel,
  ExecutorTransport,
  KernelToExecutor,
  LoadedReport,
  MemReport,
  SliceAcct,
  SliceReport,
} from './exec-frames.ts';
import { replyTransfer } from './exec-frames.ts';
import { JobControl } from './jobs.ts';
import type { Lifecycle } from './lifecycle.ts';
import type { ProcManager } from './manager.ts';
import type { ExitReason, PCB, ProcCred, WaitReason } from './pcb.ts';
import { INIT_PID } from './pid.ts';
import {
  actionFor,
  clearPendingStops,
  dispositionOf,
  setPending,
  takeDeliverable,
} from './signals.ts';
import { ChildWaits } from './waits.ts';

/** Service health for `svc:` requirements of the start-up closure. */
export type ServiceHealth = 'running' | 'degraded' | 'down';

/**
 * Optional seams other kernel subsystems install (`kernel.proc.hooks`), so that process code
 * never imports them: the VFS (manifest permission, fd inheritance, chdir), the service manager
 * and the window mirror.
 */
export interface ProcHooks {
  /** r + x on the manifest and x on its ancestors (syscall-abi.md §3.6); null when allowed. */
  checkExec?(caller: PCB, path: string): KernelError | null | Promise<KernelError | null>;
  /** Copy fds 0–2 (or `fds`) of the parent into the child (fd subsystem). May throw EBADF. */
  inheritFds?(
    parent: PCB,
    child: PCB,
    fds: Readonly<Partial<Record<0 | 1 | 2, number>>> | undefined,
  ): void;
  /** `chdir`: resolve a directory for `pcb` (VFS). */
  resolveDir?(
    pcb: PCB,
    path: string,
  ): { path: string; ino: string } | Promise<{ path: string; ino: string }>;
  /** Health of a service named by a `svc:` requirement (default: running). */
  serviceState?(name: string): ServiceHealth;
  /** Home directory and group names for `proc.cred` (users store). */
  userInfo?(uid: number): { home: string; groupNames?: readonly string[] } | undefined;
  /** The name of group `gid` (the VFS groups mirror, then the server's view of the account). */
  groupName?(gid: number): string | undefined;
  /** A process was spawned (window mirror, completion index, Task Manager feed). */
  spawned?(pcb: PCB): void;
}

export interface ProcessSystemDeps {
  readonly procs: ProcManager;
  readonly lifecycle: Lifecycle;
  readonly klog: Klog;
  readonly bus: EventBus;
  readonly dispatcher: Dispatcher;
  readonly audit: Auditor;
  readonly now: () => number;
  readonly platform: PlatformInfo;
  readonly timers: TimerHeap;
  readonly catalog: ProgramCatalog;
  readonly hooks: HookRegistry;
  readonly osSessionId: () => string;
  readonly transport?: ExecutorTransport | null;
  readonly params?: Partial<SchedParams>;
  readonly heapFactory?: HeapFactory;
  /** Default false: set by the host at the router's `desktop.interactive` (placement rule 5). */
  readonly desktopInteractive?: boolean;
}

/** A kernel-internal spawn (the `spawn` syscall and kernel services such as a Terminal's shell). */
export interface SpawnRequest {
  readonly parent: PCB;
  /** Manifest name (`/bin/<name>.json`). */
  readonly name: string;
  readonly argv: readonly string[];
  /** The full environment of the child (default: the parent's). */
  readonly env?: ReadonlyMap<string, string>;
  readonly cwd?: { readonly path: string; readonly ino?: string };
  /** Credentials (default: the parent's; kernel services pass the session user's). */
  readonly cred?: ProcCred;
  /** `'new'`: a new group led by the child; a number: that existing group (same session). */
  readonly pgid?: number | 'new';
  /** A new session led by the child (and a new group). */
  readonly setsid?: boolean;
  /** Controlling TTY (default: the parent's). */
  readonly tty?: number | null;
  readonly priority?: number;
  /** Absolute nice of the child. */
  readonly nice?: number;
  readonly dropCaps?: readonly Cap[];
  readonly fds?: Readonly<Partial<Record<0 | 1 | 2, number>>>;
  /**
   * A kernel-initiated system daemon (the AI indexer and predictor): a system-class program may
   * then run as the session user instead of root (rag-semantic-search.md §3.1, predictive-prefetch
   * §3.1). Only kernel-side callers set it; the `spawn` syscall never does.
   */
  readonly daemon?: boolean;
}

interface InFlight {
  readonly id: number;
  readonly call: string;
  /** False while an F call may still answer in the same task (the fast path). */
  blocked: boolean;
  sync: SysRes | null;
}

interface Waiting<T> {
  readonly resolve: (v: T) => void;
  readonly reject: (e: Error) => void;
}

/** Calls that are safe to re-issue after a page-out or a collateral restore (§3.5.4). */
const RESTARTABLE = new Set([
  'sleep',
  'wait',
  'lock.acquire',
  'mem.alloc',
  'mem.declare',
  'tty.read',
]);

const signalReason = (sig: SignalName): `signal:${number}` => `signal:${signalNumber(sig)}`;

function callSpecOf(call: string): CallSpec | undefined {
  return Object.hasOwn(CALLS, call) ? (CALLS as Record<string, CallSpec>)[call] : undefined;
}

/** `waitingOn` of a process blocked in `call` (§4.1 WaitReason). */
export function waitReasonOf(call: string, args: unknown): WaitReason {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (call) {
    case 'sleep':
      return 'sleep';
    case 'wait':
      return `wait:${typeof a['pid'] === 'number' ? a['pid'] : -1}`;
    case 'mem.alloc':
    case 'mem.declare':
      return 'mem';
    default:
      return `io:${call.slice(0, 64)}`;
  }
}

function acctOf(f: SliceAcct): SchedSliceReport {
  return { cpuMs: f.cpuMs, steps: f.steps, maxStepUs: f.maxStepUs };
}

function hasCap(pcb: PCB, cap: Cap): boolean {
  return bitsToCaps(pcb.caps).includes(cap);
}

export class ProcessSystem {
  readonly sched: Scheduler<PCB>;
  readonly pool: ExecutorPool;
  readonly watchdog: Watchdog;
  readonly sections = new NonPreemptiveSections();
  readonly suspects = new SuspectTracker();
  readonly killPath: KillPath<PCB>;
  readonly jobs: JobControl;
  readonly waits: ChildWaits;
  readonly timers: TimerHeap;
  /** Seams installed by other subsystems (see `ProcHooks`). */
  readonly hooks: ProcHooks = {};

  private readonly d: ProcessSystemDeps;
  private readonly closures: ClosureCache;
  private readonly transport: ExecutorTransport | null;
  private readonly ports: ExecPortRec[] = [];
  private readonly realms = new Map<number, Promise<void>>();
  private readonly inflight = new Map<number, InFlight>();
  private readonly cancels = new Map<number, (err: KernelError) => void>();
  private readonly loads = new Map<number, Waiting<LoadedReport>>();
  private readonly memReqs = new Map<number, Waiting<MemReport>>();
  private readonly exitRequests = new Map<number, number>();
  private readonly stopSig = new Map<number, SignalName>();
  private readonly frozen = new Map<number, TimerId>();
  private readonly goneHooks: ((pid: number) => void)[] = [];
  private memory: MemoryManager | null = null;
  /** ai.embed residency and recent jobs: RUN_TOKENS drops by its ORT threads while active. */
  private readonly embed = new EmbedActivity();
  private embedTimer: TimerId | null = null;
  private interactive: boolean;
  private nextReqId = 1;
  private loadAvg: [number, number, number] = [0, 0, 0];

  constructor(deps: ProcessSystemDeps) {
    this.d = deps;
    this.timers = deps.timers;
    this.transport = deps.transport ?? null;
    this.interactive = deps.desktopInteractive ?? false;
    this.closures = new ClosureCache(deps.catalog);
    const params: SchedParams = { ...defaultSchedParams(deps.platform.cores), ...deps.params };
    this.pool = new ExecutorPool({
      maxExecutors: params.maxExecutors,
      isRunnable: (pid) => {
        const s = deps.procs.get(pid)?.state;
        return s === 'READY' || s === 'RUNNING';
      },
    });
    this.sched = new Scheduler<PCB>({
      params,
      procs: deps.procs,
      host: this.schedHost(),
      createHeap: deps.heapFactory ?? defaultHeapFactory,
      nonPreemptible: (pid) => this.sections.isOpen(pid),
    });
    this.watchdog = new Watchdog(params);
    this.killPath = new KillPath<PCB>({
      scheduler: this.sched,
      pool: this.pool,
      timers: this.timers,
      watchdog: this.watchdog,
      sections: this.sections,
      procs: deps.procs,
      hooks: this.killHooks(),
    });
    this.jobs = new JobControl({
      members: (pgid) => deps.procs.groupMembers(pgid).filter((p) => p.state !== 'TERMINATED'),
      signalGroup: (pgid, sig) => this.signalGroup(pgid, sig, 0),
    });
    this.waits = new ChildWaits({
      get: (pid) => deps.procs.get(pid),
      reap: (child, by) => {
        this.waits.forget(child.pid);
        deps.procs.reap(child, by);
      },
    });
    for (let e = 0; e < params.maxExecutors; e++) {
      this.ports.push(execPort(e, (pid, res) => this.onReply(pid, res)));
    }
    this.transport?.connect(
      (e, f) => this.onFrame(e, f),
      (e, why) => this.onCrash(e, why),
    );
    const now = deps.now();
    this.sched.attachTimers(this.timers, now);
    this.timers.arm(now + params.watchdogPeriodMs, (t) => this.watchdogTick(t), {
      label: 'watchdog',
      periodMs: params.watchdogPeriodMs,
    });
    this.timers.arm(now + 1_000, (t) => this.housekeeping(t), {
      label: 'proc:tick',
      periodMs: 1_000,
    });
    this.timers.arm(now + 5_000, () => this.sampleLoad(), { label: 'proc:load', periodMs: 5_000 });
  }

  // -------------------------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------------------------

  get desktopInteractive(): boolean {
    return this.interactive;
  }

  /** The router's `desktop-interactive` mark: the pool may grow and keeps a warm spare (BOOT-10). */
  setDesktopInteractive(on: boolean): void {
    this.interactive = on;
    if (on) this.ensureSpare();
  }

  get mm(): MemoryManager | null {
    return this.memory;
  }

  /** The memory manager (the `mm` service attaches it once its swap device is open). */
  attachMemory(mm: MemoryManager): void {
    this.memory = mm;
  }

  /** Called once per process when it enters TERMINATED (per-process tables of other modules). */
  onProcessGone(fn: (pid: number) => void): void {
    this.goneHooks.push(fn);
  }

  /** Load averages (1, 5, 15 minutes) of runnable processes, for `uptime`. */
  get load(): readonly [number, number, number] {
    return this.loadAvg;
  }

  /** The executor control port record of index `e` (the dispatcher's identity source). */
  port(e: number): ExecPortRec {
    const p = this.ports[e];
    if (p === undefined) throw new RangeError(`no executor ${String(e)}`);
    return p;
  }

  // -------------------------------------------------------------------------------------------
  // Executors
  // -------------------------------------------------------------------------------------------

  /** Boot stage 3: executor #1 (index 0) starts unbound (`sched` service). */
  startFirstExecutor(): Promise<void> {
    this.pool.startFirst(this.d.now());
    return this.realm(0);
  }

  private realm(e: number): Promise<void> {
    const t = this.transport;
    if (t === null)
      return Promise.reject(
        new KernelError('EAGAIN', { reason: 'executors-exhausted' }, 'no executor transport'),
      );
    const existing = this.realms.get(e);
    if (existing !== undefined) return existing;
    const started = t.start(e).catch((err: unknown) => {
      this.realms.delete(e);
      this.pool.terminate(e);
      this.log(
        'warn',
        `executor ${String(e)} failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new KernelError(
        'EAGAIN',
        { reason: 'executors-exhausted' },
        'executor failed to start',
      );
    });
    this.realms.set(e, started);
    return started;
  }

  private killRealm(e: number): void {
    this.transport?.terminate(e);
    this.realms.delete(e);
  }

  private ensureSpare(): void {
    if (this.transport === null || !this.pool.needsSpare(this.interactive)) return;
    const i = this.pool.spawnSpare(this.d.now());
    if (i !== null) void this.realm(i).catch(() => undefined);
  }

  /** Perform the worker operation a placement decision names (§3.14). */
  private async realise(d: Exclude<PlacementDecision, { kind: 'fail' }>): Promise<void> {
    if (d.kind === 'recycle') this.killRealm(d.index);
    await this.realm(d.index);
    this.ensureSpare();
  }

  /**
   * Post a frame to executor `e`. A reply that cannot be cloned (DataCloneError) must not leave the
   * process RUNNING with no frame to run (the watchdog would kill it as a runaway): the same
   * dispatch or resume is posted again with an EIO reply for the call.
   */
  private post(e: number, frame: KernelToExecutor, transfer?: Transferable[]): void {
    try {
      this.transport?.post(e, frame, transfer);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.log('fail', `executor ${String(e)} ${frame.t}: ${why}`.slice(0, 512));
      if ((frame.t === 'dispatch' || frame.t === 'resume') && frame.res !== undefined) {
        const res = fail(frame.res.id, 'EIO', 'the reply could not be delivered to the process');
        this.transport?.post(e, { ...frame, res });
      }
    }
  }

  private setPreempt(e: number, level: 1 | 2): void {
    const ctl = this.transport?.ctl(e) ?? null;
    if (ctl !== null) ctlSetPreempt(ctl, level);
    else if (level === 2) this.post(e, { t: 'preempt', level });
  }

  // -------------------------------------------------------------------------------------------
  // SchedHost
  // -------------------------------------------------------------------------------------------

  private schedHost(): SchedHost<PCB> {
    return {
      dispatch: (e, p, sliceSeq, quantumMs) => {
        const res = p.pendingReply as SysRes | null;
        p.pendingReply = null;
        const ctl = this.transport?.ctl(e) ?? null;
        if (ctl !== null) {
          // A fresh slice starts with no pre-emption request (the executor no longer clears it,
          // so requests made while this frame is queued are not lost; runtime/executor.ts).
          Atomics.store(ctl, CTL.PREEMPT, PREEMPT_NONE);
          writeSliceSeq(ctl, sliceSeq);
        }
        this.post(
          e,
          {
            t: 'dispatch',
            pid: p.pid,
            sliceSeq,
            quantumMs,
            pendingSigs: takeDeliverable(p),
            cwd: p.cwdPath,
            ...(res === null ? {} : { res }),
          },
          replyTransfer(res),
        );
      },
      setPreempt: (e, level) => {
        this.setPreempt(e, level);
      },
      transition: (p, from, to, reason) => {
        this.d.lifecycle.record(p, from ?? 'NEW', to, reason);
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------------------------

  private onFrame(e: number, f: ExecutorToKernel): void {
    try {
      this.frame(e, f);
    } catch (err) {
      this.log(
        'fail',
        `executor ${String(e)} frame ${f.t}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }

  private frame(e: number, f: ExecutorToKernel): void {
    switch (f.t) {
      case 'loaded': {
        const w = this.loads.get(f.pid);
        this.loads.delete(f.pid);
        w?.resolve(f);
        return;
      }
      case 'checkpointed':
      case 'pagedOut':
      case 'pagedIn':
      case 'released': {
        const w = this.memReqs.get(f.reqId);
        this.memReqs.delete(f.reqId);
        w?.resolve(f);
        return;
      }
      case 'yield':
      case 'syscall':
      case 'fault':
      case 'exit':
      case 'killed':
      case 'error':
        this.sliceFrame(e, f);
        return;
    }
  }

  private sliceFrame(e: number, f: SliceReport): void {
    const check = this.sched.checkFrame(e, f.pid, f.sliceSeq);
    if (check === 'stale') return;
    if (check === 'mismatch') {
      this.identityMismatch(e, f);
      return;
    }
    const p = this.d.procs.get(f.pid);
    /* v8 ignore next -- checkFrame proved the slice belongs to a live table entry */
    if (p === undefined) return;
    this.watchdog.clear(e);
    const now = this.d.now();
    switch (f.t) {
      case 'syscall':
        this.onSyscall(e, p, f, now);
        return;
      case 'fault':
        this.onFault(e, p, f, now);
        return;
      case 'yield':
        this.memSlice(p, f);
        this.onYield(e, p, f, now);
        return;
      case 'exit': {
        const r = this.sched.onSliceEnd(e, 'exit', { cpuMs: f.cpuMs }, now);
        if (r.killPending) this.killPath.finish(p.pid, now);
        else this.retire(p, 'exit', f.code, 'normal');
        return;
      }
      case 'killed': {
        const r = this.sched.onSliceEnd(e, 'killed', { cpuMs: 0 }, now);
        if (r.killPending) this.killPath.finish(p.pid, now);
        else this.killPath.finishWatchdogKill(p, now);
        return;
      }
      case 'error': {
        const r = this.sched.onSliceEnd(e, 'error', { cpuMs: 0 }, now);
        this.log(
          'fail',
          `pid ${String(p.pid)} crashed: ${f.message}${f.stack ? ` · ${f.stack}` : ''}`.slice(
            0,
            3_000,
          ),
          p.pid,
        );
        if (r.killPending) this.killPath.finish(p.pid, now);
        else {
          this.post(e, { t: 'drop', pid: p.pid });
          this.retire(p, 'crash', 1, 'crash');
        }
        return;
      }
    }
  }

  /** ABI-02 / INV-P6: a frame that is not from the slice dispatched on this executor. */
  private identityMismatch(e: number, f: SliceReport): void {
    const s = this.sched.sliceOf(e);
    this.d.audit.securityEvent(
      s?.pid ?? 0,
      `identity-mismatch exec ${String(e)} claimed ${String(f.pid)}/${String(f.sliceSeq)}`,
    );
    const verdict = this.suspects.mismatch(e);
    const ctl = this.transport?.ctl(e) ?? null;
    if (ctl !== null) setFlag(ctl, CTL_FLAG.SUSPECT);
    if (verdict === 'terminate') this.terminateExecutor(e, 'identity-mismatch');
  }

  private memSlice(p: PCB, f: SliceAcct): void {
    const mm = this.memory;
    if (mm !== null && mm.has(p.pid)) mm.onSlice(p.pid, f.touched ?? [], f.dirtied ?? []);
  }

  private afterSliceEnd(p: PCB, r: SliceEndResult): void {
    if (!r.overrun || p.state === 'TERMINATED') return;
    const act = this.pool.onOverrun(p, this.interactive);
    if (act.kind === 'none') return;
    p.exclusive = true;
    this.log('warn', `pid ${String(p.pid)} overran its quantum twice: ${act.kind}`, p.pid);
  }

  private onYield(e: number, p: PCB, f: SliceAcct, now: number): void {
    if (p.stopped && p.state === 'RUNNING') {
      const r = this.sched.onSliceEnd(e, 'block', acctOf(f), now);
      this.afterSliceEnd(p, r);
      this.enterStopped(p);
      return;
    }
    const r = this.sched.onSliceEnd(e, 'yield', acctOf(f), now);
    if (r.killPending) this.killPath.finish(p.pid, now);
    else this.afterSliceEnd(p, r);
  }

  private onSyscall(
    e: number,
    p: PCB,
    f: Extract<SliceReport, { t: 'syscall' }>,
    now: number,
  ): void {
    this.memSlice(p, f);
    if (p.state === 'TERMINATED') {
      // Kill pending: the call is dropped with the process (§3.16 step 3).
      this.sched.onSliceEnd(e, 'block', acctOf(f), now);
      this.killPath.finish(p.pid, now);
      return;
    }
    const spec = callSpecOf(f.req.call);
    const fast = spec === undefined || spec.cls === 'F';
    const rec: InFlight = { id: f.req.id, call: f.req.call, blocked: !fast, sync: null };
    this.inflight.set(p.pid, rec);
    if (!fast) this.block(e, p, f, waitReasonOf(f.req.call, f.req.args), now);
    const port = this.port(e);
    port.slice = { pid: p.pid, sliceSeq: f.sliceSeq };
    this.d.dispatcher.execFrame(port, f);
    port.slice = null;
    if (!fast) return;

    const code = this.exitRequests.get(p.pid);
    if (code !== undefined) {
      this.exitRequests.delete(p.pid);
      this.inflight.delete(p.pid);
      const r = this.sched.onSliceEnd(e, 'exit', acctOf(f), now);
      if (r.killPending) {
        this.killPath.finish(p.pid, now);
        return;
      }
      this.post(e, { t: 'drop', pid: p.pid });
      this.retire(p, 'exit', code, 'normal');
      return;
    }
    const res = rec.sync;
    if (res === null) {
      // An asynchronous F handler: the caller waits like a blocking call.
      rec.blocked = true;
      if ((p.state as string) === 'TERMINATED') {
        this.sched.onSliceEnd(e, 'block', acctOf(f), now);
        this.killPath.finish(p.pid, now);
        return;
      }
      this.block(e, p, f, `io:${f.req.call.slice(0, 64)}`, now);
      return;
    }
    this.inflight.delete(p.pid);
    if ((p.state as string) === 'TERMINATED') {
      // The call killed its own caller (for example `kill 0`): finish the kill at once.
      this.sched.onSliceEnd(e, 'block', acctOf(f), now);
      this.killPath.finish(p.pid, now);
      return;
    }
    if (p.stopped) {
      p.pendingReply = res;
      const r = this.sched.onSliceEnd(e, 'block', acctOf(f), now);
      this.afterSliceEnd(p, r);
      this.enterStopped(p);
      return;
    }
    const r = this.sched.onFastCall(e, acctOf(f), now);
    if (r.kind === 'resume') {
      const ctl = this.transport?.ctl(e) ?? null;
      if (ctl !== null) writeSliceSeq(ctl, r.sliceSeq);
      this.post(
        e,
        {
          t: 'resume',
          pid: p.pid,
          sliceSeq: r.sliceSeq,
          quantumMs: r.quantumLeftMs,
          pendingSigs: takeDeliverable(p),
          cwd: p.cwdPath,
          res,
        },
        replyTransfer(res),
      );
    } else if (r.killPending) {
      this.killPath.finish(p.pid, now);
    } else {
      p.pendingReply = res;
    }
  }

  /** End the slice for a blocking call and enter BLOCKED on `waitingOn`. */
  private block(e: number, p: PCB, f: SliceAcct, waitingOn: WaitReason, now: number): void {
    const r = this.sched.onSliceEnd(e, 'block', acctOf(f), now);
    this.afterSliceEnd(p, r);
    this.d.lifecycle.transition(p, 'BLOCKED', 'block', { waitingOn });
    const call = this.inflight.get(p.pid)?.call ?? '';
    p.pendingCall = {
      id: this.inflight.get(p.pid)?.id ?? 0,
      call,
      restartable: RESTARTABLE.has(call),
    };
    const mm = this.memory;
    if (mm !== null && mm.has(p.pid)) mm.setNonRestartable(p.pid, true);
  }

  /** `ctx.mem.get` of a page that is not resident: the runtime-internal `mem.fault` (§3.13.1). */
  private onFault(e: number, p: PCB, f: Extract<SliceReport, { t: 'fault' }>, now: number): void {
    this.memSlice(p, f);
    if (p.state === 'TERMINATED') {
      this.sched.onSliceEnd(e, 'block', acctOf(f), now);
      this.killPath.finish(p.pid, now);
      return;
    }
    this.inflight.set(p.pid, { id: f.id, call: 'mem.fault', blocked: true, sync: null });
    this.block(e, p, f, `page:${f.pageId}`, now);
    const mm = this.memory;
    const reply = (res: SysRes): void => {
      this.onReply(p.pid, res);
    };
    if (mm === null || !mm.has(p.pid)) {
      reply(fail(f.id, 'EINVAL', 'no such page', { reason: 'unknown-segment' }));
      return;
    }
    mm.fault(p.pid, f.pageId).then(
      () => {
        let size = 0;
        try {
          size = mm.page(p.pid, f.pageId).size;
        } catch {
          // The page was freed meanwhile: an empty body.
        }
        reply(ok(f.id, { size }));
      },
      (err: unknown) => {
        const k = toKernelError(err);
        reply(fail(f.id, k.errno, k.message.slice(0, 256), k.detail));
      },
    );
  }

  /** A reply from the dispatcher (or a fault) for `pid`'s in-flight call. */
  private onReply(pid: number, res: SysRes): void {
    const rec = this.inflight.get(pid);
    if (rec?.id !== res.id) return;
    if (!rec.blocked) {
      rec.sync = res;
      return;
    }
    this.inflight.delete(pid);
    this.cancels.delete(pid);
    const p = this.d.procs.get(pid);
    if (p === undefined || p.state === 'TERMINATED') return;
    p.pendingReply = res;
    p.pendingCall = null;
    const mm = this.memory;
    if (mm !== null && mm.has(pid)) mm.setNonRestartable(pid, false);
    if (p.state === 'BLOCKED') this.wake(p);
    else if (p.state === 'SUSPENDED') p.wakePending = true;
  }

  /** A `waitingOn` change inside BLOCKED (annotation record, §3.4 rule 2). */
  annotate(p: PCB, waitingOn: WaitReason): void {
    if (p.state === 'BLOCKED') this.d.lifecycle.annotate(p, waitingOn);
  }

  /** BLOCKED → READY (`wake`), or stay BLOCKED on `sigcont` while stopped (§3.4 rule 2). */
  private wake(p: PCB): void {
    if (p.stopped) {
      if (p.waitingOn !== 'sigcont') this.d.lifecycle.annotate(p, 'sigcont');
      return;
    }
    this.sched.makeReady(p, 'wake', this.d.now());
  }

  // -------------------------------------------------------------------------------------------
  // Blocking calls: cancellation
  // -------------------------------------------------------------------------------------------

  /**
   * Run a B call body that a caught signal cancels (ECANCELED `signal`, syscall-abi.md §3.4) and
   * a kill drops. `start` arms whatever will settle the call and returns its cleanup.
   */
  cancellable<T>(
    pcb: PCB,
    start: (settle: { resolve: (v: T) => void; reject: (e: Error) => void }) => () => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false;
      let cleanup: () => void = () => undefined;
      const finish = (): boolean => {
        if (done) return false;
        done = true;
        if (this.cancels.get(pcb.pid) === cancel) this.cancels.delete(pcb.pid);
        return true;
      };
      const cancel = (err: KernelError): void => {
        if (!finish()) return;
        cleanup();
        reject(err);
      };
      this.cancels.set(pcb.pid, cancel);
      cleanup = start({
        resolve: (v) => {
          if (finish()) resolve(v);
        },
        reject: (e) => {
          if (finish()) reject(e);
        },
      });
    });
  }

  /** Complete the process's blocked call with `err` (a caught signal or its kill). */
  private cancelCall(p: PCB, err: KernelError): void {
    const c = this.cancels.get(p.pid);
    this.cancels.delete(p.pid);
    c?.(err);
    this.waits.cancel(p.pid, err);
  }

  /** `sleep {ms}` on the kernel timer heap (KPS-13). */
  sleep(pcb: PCB, ms: number): Promise<{ sleptMs: number }> {
    const t0 = this.d.now();
    return this.cancellable(pcb, ({ resolve }) => {
      const id = this.timers.arm(t0 + ms, (t) => resolve({ sleptMs: Math.max(0, t - t0) }), {
        label: `sleep:${String(pcb.pid)}`,
        pid: pcb.pid,
      });
      return () => this.timers.cancel(id);
    });
  }

  /** `wait` (§3.17.3): a child state change, `{pid: 0}` with `nohang`, or block. */
  wait(pcb: PCB, args: WaitArgs): WaitRet | Promise<WaitRet> {
    return this.waits.wait(pcb, args);
  }

  /** `exit {code}`: the frame handler ends the slice and runs the exit path (no reply). */
  requestExit(pcb: PCB, code: number): void {
    this.exitRequests.set(pcb.pid, code);
  }

  // -------------------------------------------------------------------------------------------
  // Spawn (§3.6, KPS-07)
  // -------------------------------------------------------------------------------------------

  /** The `spawn` syscall: permission and argument rules, then `spawnProcess`. */
  async spawnSyscall(
    caller: PCB,
    args: {
      readonly path: string;
      readonly argv: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
      readonly fds?: Readonly<Partial<Record<0 | 1 | 2, number>>>;
      readonly pgid?: number;
      readonly priority?: number;
      readonly nice?: number;
      readonly dropCaps?: readonly Cap[];
    },
  ): Promise<{ pid: number }> {
    const name = manifestNameOf(args.path);
    if (name === null)
      throw new KernelError(
        'ENOENT',
        undefined,
        `${args.path.slice(0, 200)}: not a program manifest`,
      );
    const root = caller.cred.uid === 0;
    if (args.priority !== undefined && args.priority < 20 && !root)
      throw new KernelError('EPERM', { reason: 'root-only' }, 'raising priority needs root');
    if (args.nice !== undefined && args.nice < 0 && !root)
      throw new KernelError('EPERM', { reason: 'root-only' }, 'a negative nice needs root');
    const denied = await this.hooks.checkExec?.(caller, args.path);
    if (denied) throw denied;
    const env = new Map(caller.env);
    if (args.env !== undefined) for (const [k, v] of Object.entries(args.env)) env.set(k, v);
    const pcb = await this.spawnProcess({
      parent: caller,
      name,
      argv: args.argv.length > 0 ? args.argv : [name],
      env,
      ...(args.cwd === undefined ? {} : { cwd: { path: args.cwd } }),
      ...(args.pgid === undefined ? {} : { pgid: args.pgid === 0 ? ('new' as const) : args.pgid }),
      ...(args.priority === undefined ? {} : { priority: args.priority }),
      nice: caller.nice + (args.nice ?? 0),
      ...(args.dropCaps === undefined ? {} : { dropCaps: args.dropCaps }),
      ...(args.fds === undefined ? {} : { fds: args.fds }),
    });
    return { pid: pcb.pid };
  }

  /**
   * Create, admit and load a process (§3.6 rules 2–6). Resolves once the child is READY (or was
   * killed while NEW); rejects with the spawn errno after the child went NEW → TERMINATED.
   */
  async spawnProcess(req: SpawnRequest): Promise<PCB> {
    const { procs } = this.d;
    const plan = this.closures.get(req.name);
    const m = plan.manifest;
    if (m.kind === 'lib' || m.entry === undefined)
      throw new KernelError('EINVAL', { reason: 'bad-manifest' }, `${m.name} is not a program`);
    for (const svc of plan.services) {
      const health = this.hooks.serviceState?.(svc.name) ?? 'running';
      if (health === 'down' && !svc.optional)
        throw new KernelError('EAGAIN', { reason: 'service-down' }, `service ${svc.name} is down`);
    }
    const parent = req.parent;
    const base = req.cred ?? parent.cred;
    const cls: ProcClass = m.class;
    if (cls === 'system' && base.uid !== 0 && !(req.daemon === true && parent.pid === INIT_PID))
      throw new KernelError('EPERM', { reason: 'root-only' }, 'system-class programs need root');
    // An agent spawned from a root shell runs with the real login uid (C12, syscall-abi §3.5).
    const cred: ProcCred =
      cls === 'agent' && base.uid === 0 && base.ruid !== 0
        ? { uid: base.ruid, gid: base.ruid, groups: [], ruid: base.ruid }
        : base;
    const caps = capsForSpawn(m, cred.uid, cls, req.dropCaps ?? []);
    if (typeof req.pgid === 'number') {
      const group = procs.groupMembers(req.pgid).filter((p) => p.state !== 'TERMINATED');
      if (group.length === 0 || group.some((p) => p.sid !== parent.sid))
        throw new KernelError(
          'EPERM',
          undefined,
          `process group ${String(req.pgid)} is not in this session`,
        );
    }
    const pcb = procs.create({
      ppid: parent.pid,
      kind: 'user',
      cls,
      name: m.name,
      argv: req.argv,
      cred,
      caps,
      ...(typeof req.pgid === 'number' ? { pgid: req.pgid } : {}),
      priority: req.priority ?? m.priority,
      nice: req.nice ?? parent.nice,
      ...(req.cwd === undefined ? {} : { cwdPath: req.cwd.path, cwdIno: req.cwd.ino ?? '' }),
      manifestPath: manifestPath(m.name),
      checkpointable: m.checkpointable,
      ...(req.env === undefined ? {} : { env: req.env }),
      ...(req.tty === undefined ? {} : { tty: req.tty }),
    });
    if (req.setsid === true) {
      pcb.sid = pcb.pid;
      pcb.pgid = pcb.pid;
      pcb.sessionLeader = true;
    } else if (req.pgid === 'new') {
      pcb.pgid = pcb.pid;
    }
    try {
      this.hooks.inheritFds?.(parent, pcb, req.fds);
      await this.admit(pcb, m, libEntries(plan.libs));
    } catch (err) {
      const k = toKernelError(err);
      if (pcb.state !== 'TERMINATED') this.retire(pcb, 'spawn-failed', 126, 'spawn-failed');
      throw k;
    }
    if (pcb.state === 'NEW') {
      this.sched.makeReady(pcb, 'admit', this.d.now());
      this.hooks.spawned?.(pcb);
    }
    return pcb;
  }

  /**
   * §3.6 rule 4: memory reservation, placement, executor, `load` (with the closure's libs first).
   * The child stays NEW.
   */
  private async admit(pcb: PCB, m: AppManifest, libs: readonly string[]): Promise<void> {
    const mm = this.memory;
    if (mm !== null) {
      mm.register(pcb.pid, {
        uid: pcb.cred.uid,
        app: m.name,
        label: (pcb.argv[0] ?? m.name).slice(0, 64),
        osSession: this.d.osSessionId(),
        checkpointable: m.checkpointable,
        window: m.kind === 'app',
      });
      await mm.admit(pcb.pid, { prio: pcb.effPrio });
      if (pcb.state !== 'NEW') return;
    }
    const decision = this.pool.placeProcess(pcb, this.d.now(), this.interactive);
    if (decision.kind === 'fail')
      throw new KernelError(
        'EAGAIN',
        { reason: 'executors-exhausted' },
        'no executor for this isolation key',
      );
    await this.realise(decision);
    if (pcb.state !== 'NEW') return;
    const e = pcb.worker;
    /* v8 ignore next -- placeProcess set the home executor */
    if (e === null) throw new KernelError('EAGAIN', { reason: 'executors-exhausted' });
    const r = await this.loadOn(e, pcb, m.entry ?? m.name, undefined, libs);
    if (pcb.state !== 'NEW') return; // killed while it was loading
    if (!r.ok) {
      const missing = /no program module|has no Program|Failed to fetch|Cannot find/i.test(r.error);
      this.log('warn', `spawn ${m.name}: ${r.error}`, pcb.pid);
      throw new KernelError(
        missing ? 'ENOENT' : 'EIO',
        undefined,
        `${m.name}: ${r.error}`.slice(0, 256),
      );
    }
  }

  private loadOn(
    e: number,
    pcb: PCB,
    entry: string,
    restore?: {
      header: ArrayBuffer;
      body: ArrayBuffer;
      sha256: string;
      from: 'page-in' | 'migration' | 'session';
    },
    libs: readonly string[] = [],
  ): Promise<LoadedReport> {
    return new Promise<LoadedReport>((resolve, reject) => {
      this.loads.set(pcb.pid, { resolve, reject });
      this.post(
        e,
        {
          t: 'load',
          pid: pcb.pid,
          entry,
          ...(libs.length === 0 ? {} : { libs }),
          ppid: pcb.ppid,
          pgid: pcb.pgid,
          sid: pcb.sid,
          uid: pcb.cred.uid,
          gid: pcb.cred.gid,
          argv: pcb.argv,
          env: [...pcb.env],
          cwd: pcb.cwdPath,
          tty: pcb.tty,
          ...(restore === undefined ? {} : { restore }),
        },
        restore === undefined ? [] : [restore.body],
      );
    });
  }

  // -------------------------------------------------------------------------------------------
  // Exit, crash, spawn failure (the non-signal path to TERMINATED)
  // -------------------------------------------------------------------------------------------

  /**
   * RUNNING → TERMINATED (`exit`, `crash`) or NEW → TERMINATED (`spawn-failed`): every resource is
   * freed exactly as on the kill path (steps 2 and 5–11), without a signal.
   */
  retire(
    p: PCB,
    reason: 'exit' | 'crash' | 'spawn-failed',
    code: number,
    exitReason: ExitReason,
  ): void {
    if (p.state === 'TERMINATED') return;
    const now = this.d.now();
    this.sched.remove(p.pid, now);
    this.timers.cancelAllOf(p.pid);
    this.cancelCall(p, new KernelError('ECANCELED', { reason: 'killed' }));
    this.inflight.delete(p.pid);
    this.exitRequests.delete(p.pid);
    this.unfreeze(p.pid);
    if (this.pool.homeOf(p.pid) !== null) this.pool.evict(p, now);
    this.d.lifecycle.transition(p, 'TERMINATED', reason, { exitCode: code, exitReason });
    this.cleanupTerminated(p);
  }

  /** Steps 5–10 shared by `retire` and the kill path's `log` hook. */
  private cleanupTerminated(p: PCB): void {
    const errs = this.d.procs.runTerminateHooks(p);
    for (const e of errs)
      this.log('fail', `terminate hook for pid ${String(p.pid)}: ${e.message}`, p.pid);
    if (p.sessionLeader) for (const tty of this.jobs.ttysOfSession(p.sid)) this.jobs.hangup(tty);
    for (const c of this.d.procs.childrenOf(p.pid)) this.waits.forget(c.pid);
    this.d.procs.reparentChildren(p);
    this.memory?.exit(p.pid);
    this.stopSig.delete(p.pid);
    for (const fn of this.goneHooks) fn(p.pid);
    this.loads.get(p.pid)?.resolve({ t: 'loaded', pid: p.pid, ok: false, error: 'killed' });
    this.loads.delete(p.pid);
    const parent = this.d.procs.get(p.ppid);
    if (parent !== undefined && parent.pid !== INIT_PID) {
      this.signal(parent, 'SIGCHLD', 0);
      this.waits.notify(parent.pid);
    }
    this.d.procs.reapIfOrphaned(p);
  }

  // -------------------------------------------------------------------------------------------
  // Kill path hooks (§3.16)
  // -------------------------------------------------------------------------------------------

  private killHooks(): KillHooks<PCB> {
    return {
      audit: (p, reason, by) => {
        if (reason === 'watchdog' || reason === 'collateral')
          this.log('warn', `pid ${String(p.pid)} killed (${reason})`, p.pid);
        else if (by !== 0 && by !== p.pid && this.d.procs.get(by)?.cred.uid !== p.cred.uid)
          this.d.audit.securityEvent(
            by,
            `kill ${reason} pid ${String(p.pid)} uid ${String(p.cred.uid)}`,
          );
      },
      leaveWaitQueues: (p) => {
        this.unfreeze(p.pid);
        this.exitRequests.delete(p.pid);
      },
      cancelPendingCall: (p) => {
        this.cancelCall(p, new KernelError('ECANCELED', { reason: 'killed' }));
        this.inflight.delete(p.pid);
        p.pendingCall = null;
        p.pendingReply = null;
      },
      dropResident: (e, p) => {
        this.post(e, { t: 'drop', pid: p.pid });
      },
      closeFds: () => undefined, // the terminate hooks (log step) close fds, leases and windows
      releaseLocks: () => undefined,
      reparentChildren: () => undefined,
      closeWindows: () => undefined,
      freeMemory: () => undefined,
      zombie: (p, exitCode, exitReason) => {
        p.exitCode = exitCode;
        p.exitReason = exitReason;
      },
      log: (rec) => {
        const p = this.d.procs.get(rec.pid);
        if (p === undefined) return;
        this.d.lifecycle.record(p, rec.from, 'TERMINATED', rec.reason, {
          exitCode: rec.exitCode,
          exitReason: rec.exitReason,
          by: rec.by,
        });
        this.cleanupTerminated(p);
      },
      suspendLost: (p) => {
        // Collateral restore needs a clean checkpoint; `restorable` answers false until idle
        // checkpoints land, so co-residents exit 137 `collateral` (§3.15.3).
        this.sched.remove(p.pid, this.d.now());
        this.d.lifecycle.transition(p, 'SUSPENDED', 'executor-lost');
      },
    };
  }

  /** §3.15.3 restore conditions; no idle checkpoints yet, so never (see `suspendLost`). */
  private restorable(_pid: number): boolean {
    return false;
  }

  /** `worker.terminate()` of executor e, collateral handling, and a fresh realm for the key. */
  terminateExecutor(e: number, cause: 'watchdog' | 'crash' | 'identity-mismatch'): void {
    const now = this.d.now();
    this.killRealm(e);
    const t = this.killPath.terminateExecutor(e, now, (pid) => this.restorable(pid), cause);
    this.log(
      'warn',
      `executor ${String(e)} terminated (${cause}); runaway ${String(t.runaway ?? '-')}, collateral ${String(t.plan.collateral.length)}`,
    );
    this.suspects.reset(e);
    if (t.isolation !== null) {
      this.pool.respawn(e, t.isolation, now);
      void this.realm(e).catch(() => undefined);
    }
  }

  private onCrash(e: number, why: string): void {
    this.log('fail', `executor ${String(e)} crashed: ${why}`);
    if (this.pool.slot(e).state !== 'absent') this.terminateExecutor(e, 'crash');
  }

  // -------------------------------------------------------------------------------------------
  // Signals and job control (§3.17)
  // -------------------------------------------------------------------------------------------

  /**
   * `kill {pid, sig}` (syscall-abi.md §3.9): targets, permission (own uid or `kill.other`; pid 1
   * and kernel threads never), then delivery. Returns the number of processes signalled.
   */
  kill(caller: PCB, pid: number, sig: SignalName | 0): { delivered: number } {
    const targets: PCB[] = [];
    if (pid > 0) {
      const t = this.d.procs.get(pid);
      if (t === undefined) throw new KernelError('ESRCH', undefined, `no process ${String(pid)}`);
      targets.push(t);
    } else {
      const pgid = pid === 0 ? caller.pgid : -pid;
      targets.push(...this.d.procs.groupMembers(pgid));
      if (targets.length === 0)
        throw new KernelError('ESRCH', undefined, `no process group ${String(pgid)}`);
    }
    const other = hasCap(caller, 'kill.other');
    const allowed: PCB[] = [];
    let why: 'init' | 'owner' = 'owner';
    for (const t of targets) {
      if (t.pid === INIT_PID || t.kind !== 'user') {
        why = 'init';
        continue;
      }
      if (t.cred.uid !== caller.cred.uid && !other) continue;
      allowed.push(t);
    }
    if (allowed.length === 0) {
      if (targets.some((t) => t.cred.uid !== caller.cred.uid))
        this.d.audit.securityEvent(caller.pid, `kill ${String(sig)} of pid ${String(pid)} refused`);
      throw new KernelError('EPERM', { reason: why }, 'not permitted to signal the target');
    }
    if (sig === 0) return { delivered: 0 };
    let delivered = 0;
    for (const t of allowed) {
      if (t.state === 'TERMINATED') continue;
      this.signal(t, sig, caller.pid);
      delivered++;
    }
    return { delivered };
  }

  /** Deliver `sig` to every live member of `pgid` (job control: kernel authority). */
  signalGroup(pgid: number, sig: SignalName, by: number): number {
    let n = 0;
    for (const t of this.d.procs.groupMembers(pgid)) {
      if (t.state === 'TERMINATED' || t.kind !== 'user') continue;
      this.signal(t, sig, by);
      n++;
    }
    return n;
  }

  /** Apply one signal to one process (§3.17.1). */
  signal(p: PCB, sig: SignalName, by: number): void {
    if (p.state === 'TERMINATED' || p.kind !== 'user') return;
    const now = this.d.now();
    switch (actionFor(p, sig)) {
      case 'kill':
        this.killPath.begin(p, signalReason(sig), by, now);
        return;
      case 'stop':
        this.stop(p, sig);
        return;
      case 'continue':
        this.cont(p);
        if (dispositionOf(p, 'SIGCONT') === 'catch') {
          setPending(p, 'SIGCONT');
          this.interrupt(p);
        }
        return;
      case 'catch':
        setPending(p, sig);
        this.interrupt(p);
        return;
      case 'ignore':
        return;
    }
  }

  /** A caught signal completes a pending B/R call with ECANCELED so the process runs its hook. */
  private interrupt(p: PCB): void {
    if (p.state !== 'BLOCKED' || p.stopped) return;
    if (this.inflight.get(p.pid)?.blocked !== true) return;
    this.cancelCall(
      p,
      new KernelError('ECANCELED', { reason: 'signal' }, 'interrupted by a signal'),
    );
  }

  private stop(p: PCB, sig: SignalName): void {
    if (p.stopped) return;
    p.stopped = true;
    this.stopSig.set(p.pid, sig);
    switch (p.state) {
      case 'READY':
        this.sched.remove(p.pid, this.d.now());
        this.d.lifecycle.transition(p, 'BLOCKED', signalReason(sig), { waitingOn: 'sigcont' });
        this.notifyStopped(p);
        return;
      case 'RUNNING': {
        const e = this.sched.runningOn(p.pid);
        if (e !== null) {
          p.preemptRequested = true;
          this.setPreempt(e, 1);
        }
        return; // the slice end enters BLOCKED `sigcont` (enterStopped)
      }
      case 'NEW':
      case 'BLOCKED':
      case 'SUSPENDED':
        // BLOCKED: `sigcont` once the awaited event completes; NEW / SUSPENDED: flag only.
        this.notifyStopped(p);
        return;
      case 'TERMINATED':
        return;
    }
  }

  /** RUNNING → BLOCKED `sigcont` at the end of a slice during which a stop arrived. */
  private enterStopped(p: PCB): void {
    const sig = this.stopSig.get(p.pid) ?? 'SIGSTOP';
    this.d.lifecycle.transition(p, 'BLOCKED', signalReason(sig), { waitingOn: 'sigcont' });
    this.notifyStopped(p);
  }

  private cont(p: PCB): void {
    if (!p.stopped) return;
    p.stopped = false;
    this.stopSig.delete(p.pid);
    clearPendingStops(p);
    const blockedCall = this.inflight.get(p.pid)?.blocked === true;
    if (p.state === 'BLOCKED' && p.waitingOn === 'sigcont' && !blockedCall)
      this.sched.makeReady(p, 'cont', this.d.now());
    this.waits.childContinued(p);
    this.sigchld(p);
  }

  private notifyStopped(p: PCB): void {
    this.waits.childStopped(p, { kind: 'stopped', signal: this.stopSig.get(p.pid) ?? 'SIGSTOP' });
    this.sigchld(p);
  }

  private sigchld(child: PCB): void {
    const parent = this.d.procs.get(child.ppid);
    if (parent !== undefined && parent.pid !== INIT_PID) this.signal(parent, 'SIGCHLD', 0);
  }

  // -------------------------------------------------------------------------------------------
  // Priorities, focus and input hints (§3.9, §3.21)
  // -------------------------------------------------------------------------------------------

  setPriority(p: PCB, change: { priority?: number; nice?: number; boosted?: boolean }): void {
    this.sched.setPriority(p, change, this.d.now());
  }

  /**
   * Focus moved to `pid`'s window (KPS-12 boost, MEM-02 focus pin), or to no process. Without
   * `extraPids`, the foreground group of `pid`'s controlling TTY (a focused Terminal's job) is
   * boosted and pinned with it.
   */
  focus(pid: number | null, extraPids?: readonly number[]): void {
    if (extraPids === undefined) {
      this.focusOwner(pid);
      return;
    }
    const now = this.d.now();
    for (const p of this.d.procs.table.values()) {
      if (p.boosted && p.pid !== pid && !extraPids.includes(p.pid) && p.state !== 'TERMINATED')
        this.sched.setPriority(p, { boosted: false }, now);
    }
    const focused = [...(pid === null ? [] : [pid]), ...extraPids];
    for (const f of focused) {
      const p = this.d.procs.get(f);
      if (p !== undefined && p.state !== 'TERMINATED' && !p.boosted)
        this.sched.setPriority(p, { boosted: true }, now);
    }
    this.memory?.setFocus(focused.filter((f) => this.memory?.has(f) === true));
  }

  onInput(pid: number): void {
    this.sched.onInput(pid, this.d.now());
  }

  /**
   * Focus moved to a window of `pid` (the desktop's ProcLink): boost it and, when it owns a
   * controlling TTY (a Terminal), the TTY's foreground group too (KPS-12, MEM-02 focus pin).
   */
  focusOwner(pid: number | null): void {
    const p = pid === null ? undefined : this.d.procs.get(pid);
    const fg = p?.tty === null || p?.tty === undefined ? [] : this.jobs.foregroundPids(p.tty);
    this.focus(
      pid,
      fg.filter((x) => x !== pid && this.d.procs.get(x)?.kind === 'user'),
    );
  }

  /**
   * Kernel-authority signal by pid (window close SIGTERM, Force quit SIGKILL, WM-05): no
   * permission check, never to init or a kernel thread. False when there is no such process.
   */
  signalPid(pid: number, sig: SignalName, by = 0): boolean {
    const p = this.d.procs.get(pid);
    if (p === undefined || p.state === 'TERMINATED' || p.kind !== 'user') return false;
    this.signal(p, sig, by);
    return true;
  }

  /**
   * Start an app or command for a user on behalf of the desktop (Dock, launcher, session
   * restore): a child of init, so it is reaped at exit. Resolves with the pid once READY.
   */
  async launch(
    name: string,
    argv: readonly string[],
    user: { readonly uid: number; readonly gid: number; readonly groups?: readonly number[] },
    opts: { readonly cwd?: string; readonly env?: ReadonlyMap<string, string> } = {},
  ): Promise<PCB> {
    const init = this.d.procs.get(INIT_PID);
    /* v8 ignore next -- init never exits */
    if (init === undefined) throw new KernelError('ESRCH', undefined, 'no init');
    return this.spawnProcess({
      parent: init,
      name,
      argv: argv.length > 0 ? argv : [name],
      cred: { uid: user.uid, gid: user.gid, groups: [...(user.groups ?? [])], ruid: user.uid },
      ...(opts.cwd === undefined ? {} : { cwd: { path: opts.cwd } }),
      ...(opts.env === undefined ? {} : { env: opts.env }),
      tty: null,
      setsid: true,
    });
  }

  setInteractive(active: boolean): void {
    this.sched.setInteractive(active, this.d.now());
  }

  /**
   * The ai.embed worker became resident or went away (§3.13, KPS-05). While it is resident and
   * has run a job in the last 2 s, RUN_TOKENS is `clamp(hwc − 2 − ortThreads, 1, 6)`: its ONNX
   * threads take cores from the executors. The AI link calls this and `embedJobRan`.
   */
  setEmbedResident(resident: boolean): void {
    this.embed.setResident(resident);
    this.refreshRunTokens();
  }

  /** ai.embed started or finished a job. */
  embedJobRan(): void {
    this.embed.jobRan(this.d.now());
    this.refreshRunTokens();
  }

  /** Recompute RUN_TOKENS; one timer re-checks it when the embed activity window closes. */
  private refreshRunTokens(): void {
    const now = this.d.now();
    const tokens = currentRunTokens(this.d.platform.cores, this.embed, now);
    if (tokens !== this.sched.params.runTokens) this.sched.setRunTokens(tokens, now);
    if (this.embedTimer !== null) this.timers.cancel(this.embedTimer);
    this.embedTimer = null;
    const next = this.embed.nextChangeAt(now);
    if (next !== null)
      this.embedTimer = this.timers.arm(
        next,
        () => {
          this.embedTimer = null;
          this.refreshRunTokens();
        },
        { label: 'embed-tokens' },
      );
  }

  // -------------------------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------------------------

  private watchdogTick(now: number): void {
    const actions = this.watchdog.check(
      now,
      this.sched.runningSlices(),
      (e) => this.transport?.ctl(e) ?? null,
    );
    for (const a of actions) {
      if (a.kind === 'preempt-kill') {
        this.sched.preemptKill(a.e);
        this.log(
          'warn',
          `watchdog pid ${String(a.pid)} slice ${String(Math.round(a.sliceMs))} ms steps ${String(a.steps)} maxStep ${String(a.maxStepUs)} µs`,
          a.pid,
        );
      } else {
        this.terminateExecutor(a.e, 'watchdog');
      }
    }
  }

  private housekeeping(now: number): void {
    this.memory?.tick();
    if (this.sched.isIdle(now, IDLE_MS))
      this.d.hooks.hooks.scheduler.onIdle(this.sched.idleMs(now));
    for (const e of this.pool.reapable(now, EXEC_IDLE_REAP_MS)) {
      if (e === 0) continue; // executor #1 stays warm
      this.killRealm(e);
      this.pool.terminate(e);
    }
  }

  private sampleLoad(): void {
    const n = this.sched.runningCount + this.sched.readyCount + this.sched.parkedCount;
    const f = [Math.exp(-5 / 60), Math.exp(-5 / 300), Math.exp(-5 / 900)] as const;
    this.loadAvg = [
      this.loadAvg[0] * f[0] + n * (1 - f[0]),
      this.loadAvg[1] * f[1] + n * (1 - f[1]),
      this.loadAvg[2] * f[2] + n * (1 - f[2]),
    ];
  }

  // -------------------------------------------------------------------------------------------
  // Memory glue (memory-and-paging.md §4.3): requests to executors and suspension
  // -------------------------------------------------------------------------------------------

  /** Send a page frame to `pid`'s home executor and await its answer. */
  memRequest(
    pid: number,
    frame: (reqId: number) => KernelToExecutor,
    transfer?: Transferable[],
  ): Promise<MemReport> {
    const e = this.pool.homeOf(pid);
    if (e === null)
      return Promise.reject(
        new KernelError('ESRCH', undefined, `pid ${String(pid)} is not resident`),
      );
    const reqId = this.nextReqId++;
    return new Promise<MemReport>((resolve, reject) => {
      this.memReqs.set(reqId, { resolve, reject });
      this.post(e, frame(reqId), transfer);
    });
  }

  /**
   * Take a READY process off the ready heap for a releasing checkpoint: READY → SUSPENDED
   * (`page-out`) at once. Anything else (RUNNING, BLOCKED with a call in flight, stopped, a reply
   * waiting) cannot be suspended now: EBUSY, and the pager tries another victim.
   */
  freeze(pid: number): void {
    const p = this.d.procs.get(pid);
    if (p === undefined) throw new KernelError('ESRCH');
    if (p.state !== 'READY' || p.stopped || p.pendingReply !== null || this.inflight.has(pid))
      throw new KernelError('EBUSY', undefined, 'the process cannot be suspended now');
    this.sched.remove(pid, this.d.now());
    this.d.lifecycle.transition(p, 'SUSPENDED', 'page-out');
    // Safety net: if the page-out never completes, the process runs again.
    const id = this.timers.arm(this.d.now() + 10_000, () => this.thaw(pid), {
      label: `freeze:${String(pid)}`,
    });
    this.frozen.set(pid, id);
  }

  /** A failed page-out: SUSPENDED → READY (`page-in`); the executor still holds the process. */
  thaw(pid: number): void {
    const id = this.frozen.get(pid);
    if (id === undefined) return;
    this.frozen.delete(pid);
    this.timers.cancel(id);
    const p = this.d.procs.get(pid);
    if (p?.state === 'SUSPENDED' && p.worker !== null)
      this.sched.makeReady(p, 'page-in', this.d.now());
  }

  private unfreeze(pid: number): void {
    const id = this.frozen.get(pid);
    if (id === undefined) return;
    this.frozen.delete(pid);
    this.timers.cancel(id);
  }

  /** mm `suspended`: the executor released the process (the state page is in swap). */
  onSuspended(pid: number): void {
    this.unfreeze(pid);
    const p = this.d.procs.get(pid);
    if (p === undefined || p.state === 'TERMINATED') return;
    const now = this.d.now();
    if (p.state === 'READY' || p.state === 'BLOCKED') {
      this.sched.remove(pid, now);
      this.d.lifecycle.transition(p, 'SUSPENDED', 'page-out');
    }
    if (this.pool.homeOf(pid) !== null) this.pool.evict(p, now);
    p.worker = null;
    // A runnable process comes back once memory allows (the page-in reservation waits).
    if (!p.stopped) this.pageInLater(pid, 1_000);
  }

  /** Page a suspended runnable process back in after `delayMs`, retrying with back-off. */
  private pageInLater(pid: number, delayMs: number): void {
    this.timers.arm(
      this.d.now() + delayMs,
      () => {
        const mm = this.memory;
        const p = this.d.procs.get(pid);
        if (mm === null || p?.state !== 'SUSPENDED' || p.stopped || !mm.has(pid)) return;
        void mm.pageIn(pid).catch((err: unknown) => {
          this.log(
            'warn',
            `page-in of pid ${String(pid)} failed: ${toKernelError(err).message}`,
            pid,
          );
          this.pageInLater(pid, Math.min(delayMs * 2, 8_000));
        });
      },
      { label: `page-in:${String(pid)}`, pid },
    );
  }

  /** mm `restore`: place the process again and load it from its verified state page. */
  async restore(
    pid: number,
    page: { header: ArrayBuffer; body: ArrayBuffer; sha256: string },
    from: 'page-in' | 'session',
  ): Promise<void> {
    const p = this.d.procs.get(pid);
    if (p === undefined || p.state === 'TERMINATED') throw new KernelError('ESRCH');
    const m = this.d.catalog.manifest(p.name);
    const decision = this.pool.placeProcess(p, this.d.now(), this.interactive);
    if (decision.kind === 'fail')
      throw new KernelError('EAGAIN', { reason: 'executors-exhausted' });
    await this.realise(decision);
    const e = p.worker;
    if (e === null) throw new KernelError('EAGAIN', { reason: 'executors-exhausted' });
    let libs: readonly string[] = [];
    try {
      libs = libEntries(this.closures.get(p.name).libs);
    } catch {
      // The manifest changed since the process started: restore the program alone.
    }
    const r = await this.loadOn(e, p, m?.entry ?? p.name, { ...page, from }, libs);
    if (!r.ok) throw new KernelError('EIO', { reason: 'storage' }, r.error.slice(0, 200));
  }

  /** mm `resumed`: SUSPENDED → READY (`page-in`). */
  onResumed(pid: number): void {
    const p = this.d.procs.get(pid);
    if (p?.state !== 'SUSPENDED') return;
    p.wakePending = false;
    if (p.worker !== null) this.sched.makeReady(p, 'page-in', this.d.now());
  }

  // -------------------------------------------------------------------------------------------

  private log(level: 'info' | 'warn' | 'fail', msg: string, pid?: number): void {
    this.d.klog.line(this.d.now(), 'proc', level, msg, pid);
  }

  /**
   * Leak check for tests (INV-P7): no structure refers to a pid that is not live. A kill of a
   * RUNNING process is exempt while it is pending (TERMINATED at once, its slice still ending,
   * §3.16 step 4); once `finish` ran it must hold no residency either.
   */
  checkInvariants(): void {
    this.sched.checkInvariants();
    const dead = (pid: number): boolean => {
      const s = this.d.procs.get(pid)?.state;
      return (s === undefined || s === 'TERMINATED') && !this.killPath.isPending(pid);
    };
    for (const pid of this.inflight.keys()) {
      if (dead(pid)) throw new Error(`INV-P7 in-flight call of dead pid ${String(pid)}`);
    }
    for (const s of this.pool.slots()) {
      for (const pid of s.residents) {
        if (dead(pid))
          throw new Error(`INV-P7 executor ${String(s.index)} holds dead pid ${String(pid)}`);
      }
    }
  }

  /** Counts of per-process kernel records (leak tests). */
  stats(): { inflight: number; cancels: number; loads: number; memReqs: number; waiters: number } {
    return {
      inflight: this.inflight.size,
      cancels: this.cancels.size,
      loads: this.loads.size,
      memReqs: this.memReqs.size,
      waiters: this.waits.blocked,
    };
  }
}

/** The module ids of a start-up closure's libs, dependencies first (KPS-07). */
function libEntries(libs: readonly AppManifest[]): string[] {
  return libs.map((l) => l.entry ?? l.name);
}

/** caps(child) = manifest.caps ∩ bounding(uid, class) ∖ dropCaps ∖ never-from-manifest (§5.3). */
export function capsForSpawn(
  m: AppManifest,
  uid: number,
  cls: ProcClass,
  drop: readonly Cap[],
): Cap[] {
  const bound = new Set(boundingSet(uid, cls, false));
  const out: Cap[] = [];
  for (const c of m.caps) {
    if (bound.has(c) && !drop.includes(c) && !NEVER_FROM_MANIFEST.includes(c) && !out.includes(c))
      out.push(c);
  }
  return bitsToCaps(capsToBits(out));
}

/** A KernelError for any thrown value (mm errors carry errno and reason). */
export function toKernelError(e: unknown): KernelError {
  if (isKernelError(e)) return e;
  if (e !== null && typeof e === 'object' && 'errno' in e && typeof e.errno === 'string') {
    const errno = e.errno as Errno;
    const reason = (e as { reason?: unknown }).reason;
    const detail: ErrDetail | undefined = typeof reason === 'string' ? { reason } : undefined;
    return new KernelError(errno, detail, e instanceof Error ? e.message : undefined);
  }
  return new KernelError('EIO', undefined, e instanceof Error ? e.message : String(e));
}
