/**
 * TEST-ONLY virtual-clock kernel for the scheduler tests (processes-and-scheduling.md §8: "unit
 * (Node, loopback kernel with a virtual clock)").
 *
 * It wires the real scheduler pieces (Scheduler, TimerHeap, ExecutorPool, Watchdog, KillPath,
 * NonPreemptiveSections) to a simulated executor pool. Simulated programs follow the §3.7.3 slice
 * loop: a CPU-bound program yields every `stepMs` and ends its slice at the first yield point at or
 * after its quantum, or at the next yield point after PREEMPT is set; the kernel processes the end
 * frame `kernelDelayMs` later (both together stay below δ, precondition 1 of §3.12.2).
 * Every event, including slice ends and wake-ups, is a timer in the kernel's own TimerHeap.
 */
import { mulberry32 } from '@plotinium/dsa';
import type { PState } from '@plotinium/protocol';

import type { ControlBlock } from '../control-block.ts';
import {
  CTL,
  CTL_BYTES,
  execBeginSlice,
  execEndSlice,
  execYieldPoint,
  setPreempt,
  writeSliceSeq,
} from '../control-block.ts';
import type { KillHooks, KillRecord } from '../kill.ts';
import { KillPath } from '../kill.ts';
import { bandOf, computeBase, defaultSchedParams, DEFAULT_PRIORITY } from '../params.ts';
import type { SchedParams } from '../params.ts';
import { ExecutorPool } from '../placement.ts';
import { Scheduler } from '../scheduler.ts';
import { NonPreemptiveSections } from '../sections.ts';
import { TimerHeap } from '../timers.ts';
import type { TimerId } from '../timers.ts';
import type { HeapFactory, SchedHost, SchedulableProcess, TransitionReason } from '../types.ts';
import { isolationKey } from '../types.ts';
import type { WatchdogAction } from '../watchdog.ts';
import { SuspectTracker, Watchdog } from '../watchdog.ts';
import { ModelHeap } from './model-heap.ts';

export interface SimProc extends SchedulableProcess {
  readonly name: string;
  readonly uid: number;
}

/** What a process does in its next slice. */
export type SliceBehaviour =
  /** CPU-bound: runs until the quantum (or a pre-emption) at `stepMs` granularity. */
  | { readonly kind: 'cpu' }
  /** Runs `afterMs` (if below the quantum) then blocks for `sleepMs`, then wakes (`wake`). */
  | { readonly kind: 'block'; readonly afterMs: number; readonly sleepMs: number }
  /** Runs `afterMs` then exits 0. */
  | { readonly kind: 'exit'; readonly afterMs: number }
  /**
   * Ignores the quantum. `honoursKill: false` is `for(;;){}` (never reaches a yield point);
   * `honoursKill: true` still stops at the next yield point once PREEMPT = 2 is set.
   */
  | { readonly kind: 'runaway'; readonly honoursKill?: boolean };

export type Program = (p: SimProc, sliceIndex: number) => SliceBehaviour;

export const burn: Program = () => ({ kind: 'cpu' });

export interface SpawnOptions {
  readonly name?: string;
  readonly uid?: number;
  readonly cls?: 'user' | 'agent' | 'system';
  readonly priority?: number;
  readonly nice?: number;
  readonly exclusive?: boolean;
  readonly checkpointable?: boolean;
  readonly program?: Program;
}

export interface SimOptions {
  readonly hwc?: number;
  readonly params?: Partial<SchedParams>;
  readonly maxExecutors?: number;
  readonly stepMs?: number;
  readonly kernelDelayMs?: number;
  readonly desktopInteractive?: boolean;
  readonly crossOriginIsolated?: boolean;
  readonly createHeap?: HeapFactory;
  readonly initialSeq?: number;
  readonly seed?: number;
  /** Arm the watchdog timer (default true). */
  readonly watchdog?: boolean;
}

export interface TransitionRecord {
  readonly t: number;
  readonly pid: number;
  readonly from: PState | null;
  readonly to: PState;
  readonly reason: TransitionReason;
}

export interface SliceRecord {
  readonly pid: number;
  readonly e: number;
  readonly start: number;
  readonly end: number;
  readonly kind: string;
}

interface Running {
  readonly pid: number;
  readonly sliceSeq: number;
  readonly start: number;
  readonly quantumMs: number;
  readonly behaviour: SliceBehaviour;
  endKind: 'yield' | 'block' | 'exit' | 'killed';
  timer: TimerId | null;
}

export class SimKernel {
  now = 0;
  readonly procs = new Map<number, SimProc>();
  readonly timers: TimerHeap;
  readonly sched: Scheduler<SimProc>;
  readonly pool: ExecutorPool;
  readonly watchdog: Watchdog;
  readonly sections = new NonPreemptiveSections();
  readonly suspects = new SuspectTracker();
  readonly killPath: KillPath<SimProc>;
  readonly log: TransitionRecord[] = [];
  readonly sliceLog: SliceRecord[] = [];
  readonly killLog: KillRecord[] = [];
  readonly hookCalls: string[] = [];
  readonly preempts: { t: number; e: number; level: 1 | 2 }[] = [];
  readonly watchdogActions: WatchdogAction[] = [];
  /** Completed READY periods (READY → RUNNING) per pid. */
  readonly waits = new Map<number, number[]>();
  maxConcurrent = 0;
  isolationViolations = 0;
  readonly ctl: (ControlBlock | null)[] = [];
  readonly params: SchedParams;
  private readonly readySince = new Map<number, number>();
  private readonly running = new Map<number, Running>();
  /** Without SAB: PREEMPT levels queued as messages behind the running slice (§3.7.4). */
  private readonly messagePreempt = new Map<number, number>();
  private readonly programs = new Map<number, Program>();
  private readonly sliceIndex = new Map<number, number>();
  private readonly stepMs: number;
  private readonly kernelDelayMs: number;
  private readonly desktopInteractive: boolean;
  private nextPid = 100;
  readonly rand: () => number;
  /** Restorable predicate used when an executor is terminated (§3.15.3). */
  restorable: (pid: number) => boolean = () => false;

  constructor(opts: SimOptions = {}) {
    const base = defaultSchedParams(opts.hwc ?? 4);
    this.params = { ...base, ...opts.params };
    this.stepMs = opts.stepMs ?? 0.1;
    this.kernelDelayMs = opts.kernelDelayMs ?? 0.2;
    this.desktopInteractive = opts.desktopInteractive ?? true;
    this.rand = mulberry32(opts.seed ?? 42);
    const createHeap = opts.createHeap ?? (() => new ModelHeap());
    const maxExecutors = opts.maxExecutors ?? this.params.maxExecutors;
    this.timers = new TimerHeap(createHeap);
    this.pool = new ExecutorPool({
      maxExecutors,
      isRunnable: (pid) => {
        const s = this.procs.get(pid)?.state;
        return s === 'READY' || s === 'RUNNING';
      },
    });
    for (let e = 0; e < maxExecutors; e++) {
      this.ctl.push(
        opts.crossOriginIsolated === false
          ? null
          : new Int32Array(new SharedArrayBuffer(CTL_BYTES)),
      );
    }
    const host: SchedHost<SimProc> = {
      dispatch: (e, p, sliceSeq, quantumMs) => this.onDispatch(e, p, sliceSeq, quantumMs),
      setPreempt: (e, level) => this.onPreempt(e, level),
      transition: (p, from, to, reason, now) => this.onTransition(p, from, to, reason, now),
    };
    this.sched = new Scheduler<SimProc>({
      params: this.params,
      procs: this.procs,
      host,
      maxExecutors,
      createHeap,
      ...(opts.initialSeq === undefined ? {} : { initialSeq: opts.initialSeq }),
      nonPreemptible: (pid) => this.sections.isOpen(pid),
    });
    this.watchdog = new Watchdog(this.params);
    this.killPath = new KillPath<SimProc>({
      scheduler: this.sched,
      pool: this.pool,
      timers: this.timers,
      watchdog: this.watchdog,
      sections: this.sections,
      procs: this.procs,
      hooks: this.recordingHooks(),
    });
    this.pool.startFirst(0);
    this.sched.attachTimers(this.timers, 0);
    if (opts.watchdog !== false) {
      this.timers.arm(this.params.watchdogPeriodMs, (t) => this.watchdogTick(t), {
        label: 'watchdog',
        periodMs: this.params.watchdogPeriodMs,
      });
    }
  }

  // -------------------------------------------------------------------------------------------

  /** Create, place and admit a process (NEW → READY). */
  spawn(o: SpawnOptions = {}): SimProc {
    const pid = this.nextPid++;
    const priority = o.priority ?? DEFAULT_PRIORITY;
    const nice = o.nice ?? 0;
    const uid = o.uid ?? 1000;
    const b = computeBase(priority, nice, false);
    const p: SimProc = {
      pid,
      name: o.name ?? `p${String(pid)}`,
      uid,
      isolation: isolationKey(uid, o.cls ?? 'user'),
      state: 'NEW',
      priority,
      nice,
      base: b,
      effPrio: b,
      band: bandOf(b),
      boosted: false,
      preemptRequested: false,
      seq: 0,
      cpuTimeMs: 0,
      lastRunAt: 0,
      waitingSince: 0,
      sliceStartedAt: 0,
      slices: 0,
      overruns: 0,
      maxStepUs: 0,
      worker: null,
      exclusive: o.exclusive ?? false,
      checkpointable: o.checkpointable ?? true,
    };
    this.procs.set(pid, p);
    this.programs.set(pid, o.program ?? burn);
    this.log.push({ t: this.now, pid, from: null, to: 'NEW', reason: 'spawn' });
    const decision = this.pool.placeProcess(p, this.now, this.desktopInteractive);
    if (decision.kind === 'fail') throw new Error(`placement failed: ${decision.reason}`);
    if (this.pool.needsSpare(this.desktopInteractive)) this.pool.spawnSpare(this.now);
    this.sched.makeReady(p, 'admit', this.now);
    return p;
  }

  /** Advance the virtual clock to `t`, firing every kernel timer on the way. */
  runUntil(t: number): void {
    for (;;) {
      const next = this.timers.nextDeadline();
      if (next === null || next > t) break;
      this.now = Math.max(this.now, next);
      this.timers.runDue(this.now);
    }
    this.now = Math.max(this.now, t);
    this.timers.runDue(this.now);
  }

  /** Every READY wait of `pid`, including the one still open at `now`. */
  waitsOf(pid: number): number[] {
    const done = this.waits.get(pid) ?? [];
    const open = this.readySince.get(pid);
    return open === undefined ? [...done] : [...done, this.now - open];
  }

  maxWait(pid: number): number {
    return Math.max(0, ...this.waitsOf(pid));
  }

  proc(pid: number): SimProc {
    const p = this.procs.get(pid);
    if (p === undefined) throw new Error(`no pid ${String(pid)}`);
    return p;
  }

  /** Dispatch order of READY → RUNNING transitions (pids). */
  dispatchOrder(): number[] {
    return this.log.filter((r) => r.to === 'RUNNING').map((r) => r.pid);
  }

  // -------------------------------------------------------------------------------------------
  // Simulated executors
  // -------------------------------------------------------------------------------------------

  private onDispatch(e: number, p: SimProc, sliceSeq: number, quantumMs: number): void {
    if (this.running.has(e)) throw new Error(`executor ${String(e)} already runs a slice`);
    const slot = this.pool.slot(e);
    if (slot.isolation !== p.isolation) this.isolationViolations++;
    for (const pid of slot.residents)
      if (this.procs.get(pid)?.isolation !== slot.isolation) this.isolationViolations++;
    const ctl = this.ctl[e] ?? null;
    if (ctl !== null) {
      writeSliceSeq(ctl, sliceSeq);
      execBeginSlice(ctl, p.pid);
    }
    const idx = (this.sliceIndex.get(p.pid) ?? 0) + 1;
    this.sliceIndex.set(p.pid, idx);
    const program = this.programs.get(p.pid) ?? burn;
    const behaviour = program(p, idx);
    const r: Running = {
      pid: p.pid,
      sliceSeq,
      start: this.now,
      quantumMs,
      behaviour,
      endKind: 'yield',
      timer: null,
    };
    this.running.set(e, r);
    this.maxConcurrent = Math.max(this.maxConcurrent, this.running.size);
    this.planEnd(e, r, this.now);
  }

  /** Schedule the slice-end frame from `from` on (the first yield point, block, exit). */
  private planEnd(e: number, r: Running, from: number): void {
    if (r.timer !== null) this.timers.cancel(r.timer);
    r.timer = null;
    const b = r.behaviour;
    const ctl = this.ctl[e] ?? null;
    const level = ctl === null ? (this.messagePreempt.get(e) ?? 0) : Atomics.load(ctl, CTL.PREEMPT);
    if (b.kind === 'runaway') {
      if (b.honoursKill !== true || level !== 2) return; // only the watchdog ends it
      const nextYield =
        r.start + (Math.floor((from - r.start) / this.stepMs + 1e-9) + 1) * this.stepMs;
      r.endKind = 'killed';
      r.timer = this.timers.arm(nextYield + this.kernelDelayMs, (t) => this.onSliceEnd(e, t), {
        label: `slice:${String(e)}`,
      });
      return;
    }
    const quantumEnd = r.start + Math.ceil(r.quantumMs / this.stepMs - 1e-9) * this.stepMs;
    let end = quantumEnd;
    r.endKind = 'yield';
    if ((b.kind === 'block' || b.kind === 'exit') && r.start + b.afterMs < quantumEnd) {
      end = r.start + b.afterMs;
      r.endKind = b.kind;
    }
    if (level > 0) {
      const elapsed = from - r.start;
      const nextYield = r.start + (Math.floor(elapsed / this.stepMs + 1e-9) + 1) * this.stepMs;
      if (nextYield < end || level === 2) {
        end = Math.min(end, nextYield);
        r.endKind = level === 2 ? 'killed' : 'yield';
      }
    }
    r.timer = this.timers.arm(end + this.kernelDelayMs, (t) => this.onSliceEnd(e, t), {
      label: `slice:${String(e)}`,
    });
  }

  private onPreempt(e: number, level: 1 | 2): void {
    this.preempts.push({ t: this.now, e, level });
    const ctl = this.ctl[e] ?? null;
    if (ctl !== null) setPreempt(ctl, level);
    else this.messagePreempt.set(e, Math.max(level, this.messagePreempt.get(e) ?? 0));
    const r = this.running.get(e);
    // Without SAB the pre-empt message waits behind the running slice (§3.7.4): no effect now.
    if (r !== undefined && ctl !== null) this.planEnd(e, r, this.now);
  }

  private onSliceEnd(e: number, t: number): void {
    const r = this.running.get(e);
    if (r === undefined) return;
    this.running.delete(e);
    this.messagePreempt.delete(e);
    const ctl = this.ctl[e] ?? null;
    const cpuMs = Math.max(0, t - this.kernelDelayMs - r.start);
    if (ctl !== null) {
      execYieldPoint(ctl, Math.round(cpuMs / this.stepMs), this.stepMs * 1000);
      execEndSlice(ctl);
    }
    if (this.sched.checkFrame(e, r.pid, r.sliceSeq) !== 'ok')
      throw new Error('frame identity mismatch in sim');
    this.sliceLog.push({ pid: r.pid, e, start: r.start, end: t, kind: r.endKind });
    this.watchdog.clear(e);
    const p = this.proc(r.pid);
    const kind = r.endKind;
    const res = this.sched.onSliceEnd(
      e,
      kind,
      { cpuMs, steps: Math.round(cpuMs / this.stepMs), maxStepUs: this.stepMs * 1000 },
      t,
    );
    if (res.killPending) {
      this.killPath.finish(p.pid, t);
      return;
    }
    if (kind === 'killed') {
      this.killPath.finishWatchdogKill(p, t);
      return;
    }
    if (res.overrun) {
      const action = this.pool.onOverrun(p, this.desktopInteractive);
      if (action.kind !== 'none') p.exclusive = true;
    }
    if (kind === 'block' && r.behaviour.kind === 'block') {
      this.setState(p, 'BLOCKED', 'block', t);
      const sleepMs = r.behaviour.sleepMs;
      this.timers.arm(
        t + sleepMs,
        (now) => {
          if (p.state === 'BLOCKED') this.sched.makeReady(p, 'wake', now);
        },
        { label: `sleep:${String(p.pid)}`, pid: p.pid },
      );
    } else if (kind === 'exit') {
      this.setState(p, 'TERMINATED', 'exit', t);
      this.pool.evict(p, t);
    }
  }

  private setState(p: SimProc, to: PState, reason: TransitionReason, t: number): void {
    const from = p.state;
    p.state = to;
    this.onTransition(p, from, to, reason, t);
  }

  private onTransition(
    p: SimProc,
    from: PState | null,
    to: PState,
    reason: TransitionReason,
    now: number,
  ): void {
    this.log.push({ t: now, pid: p.pid, from, to, reason });
    if (to === 'READY') this.readySince.set(p.pid, now);
    if (from === 'READY' && to === 'RUNNING') {
      const since = this.readySince.get(p.pid);
      if (since !== undefined) {
        const list = this.waits.get(p.pid) ?? [];
        list.push(now - since);
        this.waits.set(p.pid, list);
      }
      this.readySince.delete(p.pid);
    } else if (from === 'READY') {
      this.readySince.delete(p.pid);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Watchdog and kill hooks
  // -------------------------------------------------------------------------------------------

  private watchdogTick(t: number): void {
    const actions = this.watchdog.check(t, this.sched.runningSlices(), (e) => this.ctl[e] ?? null);
    for (const a of actions) {
      this.watchdogActions.push(a);
      if (a.kind === 'preempt-kill') {
        this.sched.preemptKill(a.e);
      } else {
        const r = this.running.get(a.e);
        if (r?.timer != null) this.timers.cancel(r.timer);
        this.running.delete(a.e);
        this.messagePreempt.delete(a.e);
        const isolation = this.pool.slot(a.e).isolation;
        this.killPath.terminateExecutor(a.e, t, (pid) => this.restorable(pid));
        this.suspects.reset(a.e);
        if (isolation !== null) this.pool.respawn(a.e, isolation, t);
      }
    }
  }

  private recordingHooks(): KillHooks<SimProc> {
    const rec = (name: string) => (p: SimProc) => {
      this.hookCalls.push(`${name}:${String(p.pid)}`);
    };
    return {
      audit: (p, reason, by) => {
        this.hookCalls.push(`audit:${String(p.pid)}:${reason}:${String(by)}`);
      },
      leaveWaitQueues: rec('leaveWaitQueues'),
      cancelPendingCall: rec('cancelPendingCall'),
      dropResident: (e, p) => {
        this.hookCalls.push(`dropResident:${String(p.pid)}@${String(e)}`);
      },
      closeFds: rec('closeFds'),
      releaseLocks: rec('releaseLocks'),
      reparentChildren: rec('reparentChildren'),
      closeWindows: rec('closeWindows'),
      freeMemory: rec('freeMemory'),
      zombie: (p, code, reason) => {
        this.hookCalls.push(`zombie:${String(p.pid)}:${String(code)}:${reason}`);
      },
      log: (record, now) => {
        this.killLog.push(record);
        this.log.push({
          t: now,
          pid: record.pid,
          from: record.from,
          to: 'TERMINATED',
          reason: record.reason,
        });
        this.hookCalls.push(`log:${String(record.pid)}`);
      },
      suspendLost: (p, now) => {
        this.hookCalls.push(`suspendLost:${String(p.pid)}`);
        this.setState(p, 'SUSPENDED', 'executor-lost', now);
      },
    };
  }
}
