/**
 * The scheduler: ready heap, parked queues, run tokens, dispatch loop, aging, round-robin,
 * pre-emption decisions and the starvation guard
 * (specs/03-kernel/processes-and-scheduling.md §3.8-§3.12, §3.21; PROC-02, PROC-03, PROC-04,
 * KPS-05, KPS-11, KPS-12, KPS-13, KPS-15).
 *
 * Pure and thread-agnostic: it never touches a worker, a port or a clock. The kernel host calls
 * it with `now` and receives side effects through `SchedHost` (dispatch frames, PREEMPT, klog).
 *
 *   key(p)       = effPrio · 2^32 + seq                    (exact below 2^53)
 *   ready        = dsa/heap IndexedMinHeap of pids by key   (index map → changeKey O(log n))
 *   parked[e]    = READY residents of a busy executor e     (keys recomputed on read)
 *   slice[e]     = {pid, seq} or IDLE
 *   tokens       = run-token semaphore of RUN_TOKENS        (KPS-05)
 *
 * The loop is event-driven: it runs after a process enters READY, after every slice report, after
 * a blocking call completes, on a timer (aging, interactive pause) and when RUN_TOKENS changes. It
 * never polls.
 *
 * | Operation                        | Complexity |
 * |----------------------------------|------------|
 * | makeReady, dispatch, pre-empt    | O(log n)   |
 * | F-call resume decision           | O(1)       |
 * | endSlice (k parked residents)    | O(k log n) |
 * | guardKey                         | O(parked)  |
 * | agingTick (R READY processes)    | O(R log R) |
 * | setPriority / focus boost        | O(log n)   |
 */
import type { IndexedMinHeap } from '@plotinium/dsa/heap';
import { BinaryHeap } from '@plotinium/dsa/heap';

import { InteractiveHint } from './interactive.ts';
import {
  agedEffPrio,
  BACKGROUND_EFFPRIO_MIN,
  bandOf,
  clampNice,
  clampPriority,
  computeBase,
  IDLE_MS,
  OVERRUN_SLACK_MS,
  readyKey,
  SEQ_MAX,
} from './params.ts';
import type { SchedParams } from './params.ts';
import type { TimerHeap, TimerId } from './timers.ts';
import { RunTokens } from './tokens.ts';
import type {
  HeapFactory,
  ProcLookup,
  ReadyReason,
  SchedHost,
  SchedulableProcess,
} from './types.ts';
import type { RunningSlice } from './watchdog.ts';

/** Production heap: the team's dsa/heap (IMPLEMENTED = false until R1 flips it, C16). */
export const defaultHeapFactory: HeapFactory = (capacity) => new BinaryHeap(capacity);

/** Largest slice counter before it wraps to 1 (SLICE_SEQ is an Int32 slot). */
const SLICE_SEQ_MAX = 0x7fff_ffff;

export interface SchedulerOptions<P extends SchedulableProcess> {
  readonly params: SchedParams;
  readonly procs: ProcLookup<P>;
  readonly host: SchedHost<P>;
  /** Executor indices 0 … maxExecutors − 1 (default: params.maxExecutors). */
  readonly maxExecutors?: number;
  readonly createHeap?: HeapFactory;
  readonly heapCapacity?: number;
  readonly interactive?: InteractiveHint;
  /** First `seq` to hand out (tests force it near 2^32 to exercise renumbering). */
  readonly initialSeq?: number;
  /** Pids that must not be chosen as pre-emption victims (for example inside a kernel section). */
  readonly nonPreemptible?: (pid: number) => boolean;
}

/** Result of the identity check of a frame against `slice[e]` (ABI-02, INV-P6). */
export type FrameCheck = 'ok' | 'stale' | 'mismatch';

/** Accounting carried by yield, syscall and exit frames (§4.3). */
export interface SliceReport {
  readonly cpuMs: number;
  readonly steps?: number;
  readonly maxStepUs?: number;
}

/** How a slice ended: `yield` re-queues; the other kinds leave the next state to kernel/core/proc. */
export type SliceEndKind = 'yield' | 'block' | 'exit' | 'killed' | 'error';

export interface SliceEndResult {
  readonly pid: number;
  /** The slice was longer than quantum + OVERRUN_SLACK_MS (placement rule 2 may follow). */
  readonly overrun: boolean;
  readonly overruns: number;
  /** A `yield` put the process back in READY (reason `quantum` or `preempt`). */
  readonly requeued: boolean;
  /** The kill path had already marked the process TERMINATED: finish the kill (§3.16 step 4). */
  readonly killPending: boolean;
}

export type FastCallResult =
  /** Post `{t:'resume', pid, sliceSeq, reply, quantumLeftMs}`: the slice keeps its token. */
  | {
      readonly kind: 'resume';
      readonly pid: number;
      readonly sliceSeq: number;
      readonly quantumLeftMs: number;
    }
  /**
   * The reply waits in `pendingReply`; the process was re-queued (reason `requeue`). With
   * `killPending` the kill path had already marked it TERMINATED: discard the reply and finish
   * the kill instead.
   */
  | { readonly kind: 'requeue'; readonly pid: number; readonly killPending: boolean };

export interface PriorityChange {
  readonly priority?: number;
  readonly nice?: number;
  readonly boosted?: boolean;
}

/** Diagnostics counters (`sched`, tests). */
export interface SchedCounters {
  dispatches: number;
  preemptRequests: number;
  guardEngaged: number;
  renumbers: number;
  agingTicks: number;
}

interface Slice {
  readonly pid: number;
  seq: number;
  readonly startedAt: number;
}

export class Scheduler<P extends SchedulableProcess = SchedulableProcess> {
  private paramsValue: SchedParams;
  private readonly procs: ProcLookup<P>;
  private readonly host: SchedHost<P>;
  private readonly ready: IndexedMinHeap;
  /** Pids currently in `ready` (iteration for aging and renumbering; the heap has no iterator). */
  private readonly inHeap = new Set<number>();
  private readonly parked: number[][] = [];
  private readonly slices: (Slice | null)[] = [];
  private readonly sliceCounter: number[] = [];
  readonly tokens: RunTokens;
  readonly interactive: InteractiveHint;
  private readonly nonPreemptible: (pid: number) => boolean;
  readonly maxExecutors: number;
  private nextSeq: number;
  private scheduling = false;
  private again = false;
  private timers: TimerHeap | null = null;
  private agingTimer: TimerId | null = null;
  private interactiveTimer: TimerId | null = null;
  /** Last moment of user input or of READY/RUNNING interactive or normal work (§3.1 IDLE_MS). */
  private lastForegroundAt = 0;
  /** Diagnostics for `sched` and tests. */
  private readonly counters: SchedCounters = {
    dispatches: 0,
    preemptRequests: 0,
    guardEngaged: 0,
    renumbers: 0,
    agingTicks: 0,
  };

  constructor(opts: SchedulerOptions<P>) {
    this.paramsValue = opts.params;
    this.procs = opts.procs;
    this.host = opts.host;
    this.maxExecutors = opts.maxExecutors ?? opts.params.maxExecutors;
    const createHeap = opts.createHeap ?? defaultHeapFactory;
    this.ready = createHeap(opts.heapCapacity ?? 256);
    this.tokens = new RunTokens(opts.params.runTokens);
    this.interactive = opts.interactive ?? new InteractiveHint();
    this.nonPreemptible = opts.nonPreemptible ?? (() => false);
    this.nextSeq = opts.initialSeq ?? 1;
    if (!Number.isInteger(this.nextSeq) || this.nextSeq < 0)
      throw new RangeError('initialSeq must be a uint32');
    for (let e = 0; e < this.maxExecutors; e++) {
      this.parked.push([]);
      this.slices.push(null);
      this.sliceCounter.push(0);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Parameters, tokens and timers
  // -------------------------------------------------------------------------------------------

  get params(): SchedParams {
    return this.paramsValue;
  }

  /**
   * New parameters (sysctl or a RUN_TOKENS change). Quanta apply from the next dispatch; a lower
   * RUN_TOKENS pre-empts nothing (§3.13); a new T_age re-arms the aging tick.
   */
  setParams(params: SchedParams, now: number): void {
    const tAgeChanged = params.tAgeMs !== this.paramsValue.tAgeMs;
    this.paramsValue = params;
    this.tokens.setCapacity(params.runTokens);
    if (tAgeChanged && this.timers !== null) this.armAging(this.timers, now);
    this.schedule(now);
  }

  /** RUN_TOKENS changed (hwc known, ai.embed became active or idle). */
  setRunTokens(runTokens: number, now: number): void {
    this.setParams({ ...this.paramsValue, runTokens }, now);
  }

  /**
   * Arm the scheduler's kernel timers (KPS-13): the aging tick every T_age and the interactive
   * pause boundaries. The host arms one platform timer for `timers.nextDeadline()`.
   */
  attachTimers(timers: TimerHeap, now: number): void {
    this.timers = timers;
    this.armAging(timers, now);
    this.armInteractive(now);
  }

  private armAging(timers: TimerHeap, now: number): void {
    if (this.agingTimer !== null) timers.cancel(this.agingTimer);
    const period = this.paramsValue.tAgeMs;
    this.agingTimer = timers.arm(now + period, (t) => this.agingTick(t), {
      label: 'sched:aging',
      periodMs: period,
      priority: 1,
    });
  }

  private armInteractive(now: number): void {
    const timers = this.timers;
    if (timers === null) return;
    if (this.interactiveTimer !== null) timers.cancel(this.interactiveTimer);
    this.interactiveTimer = null;
    const at = this.interactive.nextChangeAt(now);
    if (at === null) return;
    this.interactiveTimer = timers.arm(
      at,
      (t) => {
        this.interactiveTimer = null;
        this.schedule(t);
        this.armInteractive(t);
      },
      { label: 'sched:interactive', priority: 2 },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Entering READY and the dispatch loop
  // -------------------------------------------------------------------------------------------

  /**
   * The ONLY way into READY (§3.10 makeReady): fresh seq (round-robin, PROC-03), waitingSince =
   * now, effPrio = base, push on the ready heap, log the transition, schedule.
   */
  makeReady(p: P, reason: ReadyReason, now: number): void {
    const from = p.state;
    if (from === 'READY') throw new Error(`pid ${String(p.pid)} is already READY`);
    if (from === 'TERMINATED') throw new Error(`pid ${String(p.pid)} is TERMINATED`);
    if (this.runningOn(p.pid) !== null) throw new Error(`pid ${String(p.pid)} still holds a slice`);
    const e = p.worker;
    if (e === null || e < 0 || e >= this.maxExecutors) {
      throw new Error(`pid ${String(p.pid)} has no executor (placement must precede READY)`);
    }
    this.refreshBase(p);
    p.state = 'READY';
    p.seq = this.takeSeq();
    p.waitingSince = now;
    p.effPrio = p.base;
    this.ready.push(p.pid, readyKey(p.effPrio, p.seq));
    this.inHeap.add(p.pid);
    this.host.transition(p, from, 'READY', reason, now);
    this.schedule(now);
  }

  /** §3.10 schedule(): grant free tokens in key order, then decide pre-emptions. Re-entrant safe. */
  schedule(now: number): void {
    if (this.scheduling) {
      this.again = true;
      return;
    }
    this.scheduling = true;
    try {
      do {
        this.again = false;
        this.scheduleOnce(now);
      } while (this.again);
    } finally {
      this.scheduling = false;
    }
  }

  private scheduleOnce(now: number): void {
    const paused = this.interactive.isPaused(now);
    let guard = this.guardKey();
    while (this.tokens.free > 0 && this.ready.size > 0) {
      const pid = this.ready.peek();
      const k = this.ready.peekKey();
      /* v8 ignore next -- size > 0 */
      if (pid === undefined || k === undefined) break;
      if (k > guard) {
        this.counters.guardEngaged++;
        break; // KPS-15: free tokens wait for the starving parked process
      }
      const p = this.proc(pid);
      if (paused && p.effPrio >= BACKGROUND_EFFPRIO_MIN) break; // everything left is background (KPS-11)
      const e = this.homeOf(p);
      this.ready.pop();
      this.inHeap.delete(pid);
      if (this.slices[e] != null) {
        // Home executor busy: park, keeping key and seq.
        this.parkedOf(e).push(pid);
        if (p.effPrio === 0 && k < guard) guard = k;
        continue;
      }
      this.dispatch(p, e, now);
    }

    // KPS-15: speed up the executor of the starving parked process.
    if (guard < Number.POSITIVE_INFINITY) {
      const m = this.guardProcess();
      if (m !== undefined) {
        const e = this.homeOf(m);
        const s = this.slices[e];
        if (s != null) {
          const v = this.proc(s.pid);
          if (v.effPrio > 0) this.requestPreempt(e, v);
        }
      }
    }

    // KPS-11: while paused, running background slices are asked to yield.
    if (paused) {
      for (let e = 0; e < this.maxExecutors; e++) {
        const s = this.slices[e];
        if (s == null) continue;
        const v = this.proc(s.pid);
        if (v.effPrio >= BACKGROUND_EFFPRIO_MIN) this.requestPreempt(e, v);
      }
    }

    // Pre-emption request: the heap top is better than the worst running pre-emptible slice.
    if (this.tokens.free === 0 && this.ready.size > 0) {
      const topPid = this.ready.peek();
      const topKey = this.ready.peekKey();
      /* v8 ignore next -- size > 0 */
      if (topPid === undefined || topKey === undefined) return;
      const top = this.proc(topPid);
      if (topKey > guard || (paused && top.effPrio >= BACKGROUND_EFFPRIO_MIN)) return;
      const victim = this.worstRunning();
      if (victim !== null && victim.p.effPrio > top.effPrio)
        this.requestPreempt(victim.e, victim.p);
    }
  }

  /** §3.10 dispatch(p, e): take a token, bump the slice counter, post the dispatch frame. */
  private dispatch(p: P, e: number, now: number): void {
    /* v8 ignore next -- the loop checks tokens.free first */
    if (!this.tokens.tryAcquire()) throw new Error('no run token');
    const prev = this.sliceCounter[e] ?? 0;
    const sliceSeq = prev >= SLICE_SEQ_MAX ? 1 : prev + 1;
    this.sliceCounter[e] = sliceSeq;
    this.slices[e] = { pid: p.pid, seq: sliceSeq, startedAt: now };
    p.state = 'RUNNING';
    p.effPrio = p.base;
    p.preemptRequested = false;
    p.sliceStartedAt = now;
    p.lastRunAt = now;
    p.slices += 1;
    this.counters.dispatches++;
    this.host.dispatch(e, p, sliceSeq, this.quantumOf(p));
    this.host.transition(p, 'READY', 'RUNNING', 'dispatch', now);
  }

  /**
   * PREEMPT = 2 on executor e (kill path step 4, watchdog runaway): the running slice is marked
   * pre-emption-requested, so neither the starvation guard nor the victim choice sends it a
   * redundant level-1 request while it dies. Returns the pid of the slice, or null if e is idle.
   */
  preemptKill(e: number): number | null {
    const s = this.slices[e];
    if (s == null) return null;
    this.proc(s.pid).preemptRequested = true;
    this.host.setPreempt(e, 2);
    return s.pid;
  }

  /** PREEMPT = 1 on e for its running slice v, once per slice. */
  private requestPreempt(e: number, v: P): void {
    if (v.preemptRequested || this.nonPreemptible(v.pid)) return;
    v.preemptRequested = true;
    this.counters.preemptRequests++;
    this.host.setPreempt(e, 1);
  }

  /** argmax over running slices of key(pcb), excluding non-pre-emptible ones (§3.10). */
  private worstRunning(): { e: number; p: P } | null {
    let best: { e: number; p: P } | null = null;
    let bestKey = Number.NEGATIVE_INFINITY;
    for (let e = 0; e < this.maxExecutors; e++) {
      const s = this.slices[e];
      if (s == null || this.nonPreemptible(s.pid)) continue;
      const p = this.proc(s.pid);
      const k = readyKey(p.effPrio, p.seq);
      if (k > bestKey) {
        bestKey = k;
        best = { e, p };
      }
    }
    return best !== null && !best.p.preemptRequested ? best : null;
  }

  /** KPS-15: min key over parked processes with effPrio = 0, or +∞. O(parked). */
  guardKey(): number {
    const m = this.guardProcess();
    return m === undefined ? Number.POSITIVE_INFINITY : readyKey(m.effPrio, m.seq);
  }

  private guardProcess(): P | undefined {
    let best: P | undefined;
    let bestKey = Number.POSITIVE_INFINITY;
    for (const list of this.parked) {
      for (const pid of list) {
        const q = this.proc(pid);
        if (q.effPrio !== 0) continue;
        const k = readyKey(q.effPrio, q.seq);
        if (k < bestKey) {
          bestKey = k;
          best = q;
        }
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------------------------
  // Frames from executors
  // -------------------------------------------------------------------------------------------

  /**
   * Identity check of a frame from executor e (syscall-abi.md §3.2.1, INV-P6): `ok` for the
   * current slice; `stale` for an older slice of the same pid (a report that raced a resume or a
   * pre-empt: ignore it); `mismatch` otherwise (ESRCH, security audit, SUSPECT).
   */
  checkFrame(e: number, pid: number, sliceSeq: number): FrameCheck {
    const s = this.slices[e];
    if (s == null || s.pid !== pid) return 'mismatch';
    if (s.seq === sliceSeq) return 'ok';
    return sliceSeq < s.seq && sliceSeq > 0 ? 'stale' : 'mismatch';
  }

  /**
   * The slice on e ended with a yield, a blocking (T, B, X, R) syscall, an exit, a `killed` or an
   * `error` frame (§3.10 onFrame). Accounts CPU time and overruns, frees the executor and the
   * token (parked residents become dispatchable), and re-queues a yield with a fresh seq
   * (round-robin, PROC-03). For the other kinds kernel/core/proc performs the next transition.
   */
  onSliceEnd(e: number, kind: SliceEndKind, report: SliceReport, now: number): SliceEndResult {
    const s = this.slices[e];
    if (s == null) throw new Error(`executor ${String(e)} has no running slice`);
    const p = this.proc(s.pid);
    const overrun = this.account(p, report, now, true);
    const killPending = p.state === 'TERMINATED';
    this.noteForeground(p, now);
    this.endSlice(e, now);
    let requeued = false;
    if (!killPending && kind === 'yield') {
      this.makeReady(p, p.preemptRequested ? 'preempt' : 'quantum', now);
      requeued = true;
    }
    return { pid: p.pid, overrun, overruns: p.overruns, requeued, killPending };
  }

  /**
   * An F call was answered in the same task (§3.10, syscall-abi.md §3.4). If quantum is left, no
   * pre-emption is pending and nothing better waits in the heap, the slice keeps its token and
   * resumes with a new slice counter and the REMAINING quantum (the quantum is wall time from
   * dispatch, so it is not reset). Otherwise the process is re-queued (reason `requeue`) and the
   * caller stores the reply in `pendingReply`.
   */
  onFastCall(e: number, report: SliceReport, now: number): FastCallResult {
    const s = this.slices[e];
    if (s == null) throw new Error(`executor ${String(e)} has no running slice`);
    const p = this.proc(s.pid);
    const left = this.quantumOf(p) - (now - p.sliceStartedAt);
    const topPid = this.ready.peek();
    const better = topPid !== undefined && this.proc(topPid).effPrio < p.effPrio;
    if (left > 0 && !p.preemptRequested && !better && p.state === 'RUNNING') {
      this.account(p, report, now, false);
      const sliceSeq = s.seq >= SLICE_SEQ_MAX ? 1 : s.seq + 1;
      s.seq = sliceSeq;
      this.sliceCounter[e] = sliceSeq;
      return { kind: 'resume', pid: p.pid, sliceSeq, quantumLeftMs: left };
    }
    this.account(p, report, now, true);
    this.endSlice(e, now);
    const killPending = p.state === 'TERMINATED';
    if (!killPending) this.makeReady(p, 'requeue', now);
    return { kind: 'requeue', pid: p.pid, killPending };
  }

  private account(p: P, report: SliceReport, now: number, sliceEnds: boolean): boolean {
    if (Number.isFinite(report.cpuMs) && report.cpuMs > 0) p.cpuTimeMs += report.cpuMs;
    if (report.maxStepUs !== undefined && report.maxStepUs > p.maxStepUs)
      p.maxStepUs = report.maxStepUs;
    if (!sliceEnds) return false;
    const overrun = now - p.sliceStartedAt > this.quantumOf(p) + OVERRUN_SLACK_MS;
    if (overrun) p.overruns++;
    return overrun;
  }

  /** §3.10 endSlice(e): e is idle again; its parked residents become dispatchable. */
  private endSlice(e: number, now: number): void {
    this.releaseSlice(e);
    this.schedule(now);
  }

  private releaseSlice(e: number): void {
    if (this.slices[e] == null) return;
    this.slices[e] = null;
    this.tokens.release();
    const list = this.parkedOf(e);
    for (const pid of list) {
      const q = this.proc(pid);
      this.ready.push(pid, readyKey(q.effPrio, q.seq)); // keys and seqs unchanged
      this.inHeap.add(pid);
    }
    list.length = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Aging, priorities, focus, input, the interactive hint
  // -------------------------------------------------------------------------------------------

  /**
   * §3.10 agingTick (every T_age, from the kernel timer heap): effPrio = max(0, base −
   * ⌊(now − waitingSince)/T_age⌋) for every READY process, heap and parked (INV-P5); changeKey
   * for heap members; then schedule.
   */
  agingTick(now: number): void {
    this.counters.agingTicks++;
    const tAge = this.paramsValue.tAgeMs;
    for (const pid of this.inHeap) {
      const p = this.proc(pid);
      const e2 = agedEffPrio(p.base, p.waitingSince, now, tAge);
      if (e2 !== p.effPrio) {
        p.effPrio = e2;
        this.ready.changePriority(pid, readyKey(e2, p.seq));
      }
    }
    for (const list of this.parked) {
      for (const pid of list) {
        const p = this.proc(pid);
        p.effPrio = agedEffPrio(p.base, p.waitingSince, now, tAge);
      }
    }
    this.schedule(now);
  }

  /**
   * `setpriority`, `renice`, `nice` and the focus boost (§3.9.3, KPS-12): recompute base and band,
   * and move a READY process in the heap with ONE changeKey (O(log n), PROC-02). A RUNNING
   * process's effPrio follows its base; the change can trigger a pre-emption.
   */
  setPriority(p: P, change: PriorityChange, now: number): void {
    if (change.priority !== undefined) p.priority = clampPriority(change.priority);
    if (change.nice !== undefined) p.nice = clampNice(change.nice);
    if (change.boosted !== undefined) p.boosted = change.boosted;
    this.refreshBase(p);
    if (p.state === 'READY') {
      const e2 = agedEffPrio(p.base, p.waitingSince, now, this.paramsValue.tAgeMs);
      if (e2 !== p.effPrio) {
        p.effPrio = e2;
        if (this.inHeap.has(p.pid)) this.ready.changePriority(p.pid, readyKey(e2, p.seq));
      }
    } else if (p.state === 'RUNNING') {
      p.effPrio = p.base;
    }
    this.schedule(now);
  }

  /**
   * §3.21: user input to a window of `pid`. If another process's slice runs on that process's
   * executor, ask it to yield so the keystroke waits at most one step. Returns true if PREEMPT
   * was set.
   */
  onInput(pid: number, now: number): boolean {
    this.noteInput(now);
    const p = this.procs.get(pid);
    if (p?.worker == null) return false;
    const s = this.slices[p.worker];
    if (s == null || s.pid === pid) return false;
    const v = this.proc(s.pid);
    const before = v.preemptRequested;
    this.requestPreempt(p.worker, v);
    this.schedule(now);
    return !before && v.preemptRequested;
  }

  /** `interactive {active}` from the compositor (KPS-11). */
  setInteractive(active: boolean, now: number): void {
    this.interactive.set(active, now);
    this.schedule(now);
    this.armInteractive(now);
  }

  /** User input (any window or TTY) resets the idle clock (§3.1 IDLE_MS, C12). */
  noteInput(now: number): void {
    if (now > this.lastForegroundAt) this.lastForegroundAt = now;
  }

  /**
   * §3.1 IDLE_MS (C12, PRE-04): milliseconds with no user input and no READY or RUNNING process in
   * the interactive or normal band. The kernel's idle timer passes this to
   * `SchedulerHints.onIdle(idleMs)` once it reaches IDLE_MS; pre-fetch jobs start only then.
   * O(READY + parked + E).
   */
  idleMs(now: number): number {
    if (this.hasForegroundWork()) {
      this.noteInput(now);
      return 0;
    }
    return Math.max(0, now - this.lastForegroundAt);
  }

  isIdle(now: number, idleThresholdMs = IDLE_MS): boolean {
    return this.idleMs(now) >= idleThresholdMs;
  }

  private hasForegroundWork(): boolean {
    const fg = (pid: number): boolean => this.proc(pid).band !== 'background';
    for (const pid of this.inHeap) if (fg(pid)) return true;
    for (const list of this.parked) for (const pid of list) if (fg(pid)) return true;
    for (const s of this.slices) if (s != null && fg(s.pid)) return true;
    return false;
  }

  private noteForeground(p: P, now: number): void {
    if (p.band !== 'background') this.noteInput(now);
  }

  // -------------------------------------------------------------------------------------------
  // Leaving the scheduler (kill path, page-out, executor loss)
  // -------------------------------------------------------------------------------------------

  /**
   * Remove a READY process from the ready heap or its parked queue (kill path step 2, page-out,
   * stop signals, collateral). A RUNNING process cannot be removed: its slice must end first.
   */
  remove(pid: number, now: number): 'heap' | 'parked' | 'running' | 'none' {
    const p = this.procs.get(pid);
    if (p !== undefined && this.isQueued(pid) !== null) this.noteForeground(p, now);
    if (this.inHeap.has(pid)) {
      this.ready.remove(pid);
      this.inHeap.delete(pid);
      this.schedule(now);
      return 'heap';
    }
    for (const list of this.parked) {
      const i = list.indexOf(pid);
      if (i >= 0) {
        list.splice(i, 1);
        this.schedule(now);
        return 'parked';
      }
    }
    return this.runningOn(pid) !== null ? 'running' : 'none';
  }

  /**
   * Executor e was terminated (watchdog, crash, identity mismatch): its slice and token are
   * released without a frame, and its residents leave the heap and the parked queue. The caller
   * restores or terminates them (§3.15.3).
   */
  executorLost(e: number, residents: Iterable<number>, now: number): { runningPid: number | null } {
    const s = this.slices[e];
    const runningPid = s?.pid ?? null;
    const list = this.parkedOf(e);
    list.length = 0; // residents leave; they are not pushed back
    if (s != null) {
      this.slices[e] = null;
      this.tokens.release();
    }
    for (const pid of residents) {
      if (this.inHeap.has(pid)) {
        this.ready.remove(pid);
        this.inHeap.delete(pid);
      }
    }
    this.schedule(now);
    return { runningPid };
  }

  // -------------------------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------------------------

  /** Executor index running `pid`, or null. O(E). */
  runningOn(pid: number): number | null {
    for (let e = 0; e < this.maxExecutors; e++) if (this.slices[e]?.pid === pid) return e;
    return null;
  }

  sliceOf(e: number): RunningSlice | null {
    const s = this.slices[e];
    return s == null ? null : { e, pid: s.pid, sliceSeq: s.seq, startedAt: s.startedAt };
  }

  /** Every running slice (the watchdog iterates these). */
  runningSlices(): RunningSlice[] {
    const out: RunningSlice[] = [];
    for (let e = 0; e < this.maxExecutors; e++) {
      const s = this.sliceOf(e);
      if (s !== null) out.push(s);
    }
    return out;
  }

  /** READY processes parked behind executor e's running slice. */
  parkedOn(e: number): readonly number[] {
    return this.parkedOf(e);
  }

  isQueued(pid: number): 'heap' | 'parked' | null {
    if (this.inHeap.has(pid)) return 'heap';
    for (const list of this.parked) if (list.includes(pid)) return 'parked';
    return null;
  }

  get readyCount(): number {
    return this.ready.size;
  }

  get parkedCount(): number {
    let n = 0;
    for (const list of this.parked) n += list.length;
    return n;
  }

  get runningCount(): number {
    let n = 0;
    for (const s of this.slices) if (s != null) n++;
    return n;
  }

  /** The next seq `makeReady` will hand out (tests and `sched`). */
  get seqCounter(): number {
    return this.nextSeq;
  }

  stats(): Readonly<SchedCounters> {
    return { ...this.counters };
  }

  /** Quantum for p's band (§3.9.2); a sysctl change applies from the next dispatch. */
  quantumOf(p: SchedulableProcess): number {
    return this.paramsValue.quantumMs[p.band];
  }

  /**
   * INV-P1 (scheduler part), INV-P2, INV-P3 (one slice per executor) and heap membership. Throws
   * with the invariant id on the first violation.
   */
  checkInvariants(): void {
    const seen = new Map<number, string>();
    const note = (pid: number, where: string): void => {
      const prev = seen.get(pid);
      if (prev !== undefined)
        throw new Error(`INV-P1 pid ${String(pid)} is in ${prev} and ${where}`);
      seen.set(pid, where);
    };
    if (this.inHeap.size !== this.ready.size)
      throw new Error('INV-P1 heap membership set out of sync');
    for (const pid of this.inHeap) {
      if (!this.ready.has(pid)) throw new Error(`INV-P1 pid ${String(pid)} missing from the heap`);
      if (this.proc(pid).state !== 'READY')
        throw new Error(`INV-P1 heap pid ${String(pid)} is not READY`);
      note(pid, 'heap');
    }
    let running = 0;
    for (let e = 0; e < this.maxExecutors; e++) {
      const s = this.slices[e];
      const list = this.parkedOf(e);
      if (list.length > 0 && s == null)
        throw new Error(`KPS-15 executor ${String(e)} has parked processes but is idle`);
      for (const pid of list) {
        const q = this.proc(pid);
        if (q.state !== 'READY') throw new Error(`INV-P1 parked pid ${String(pid)} is not READY`);
        if (q.worker !== e)
          throw new Error(`INV-P1 parked pid ${String(pid)} is not resident on ${String(e)}`);
        note(pid, `parked[${String(e)}]`);
      }
      if (s != null) {
        running++;
        const st = this.proc(s.pid).state;
        if (st !== 'RUNNING' && st !== 'TERMINATED')
          throw new Error(`INV-P1 slice pid ${String(s.pid)} is ${st}`);
        note(s.pid, `slice[${String(e)}]`);
      }
    }
    if (this.tokens.held !== running)
      throw new Error('INV-P2 held tokens differ from running slices');
    if (running > Math.max(this.tokens.capacity, this.tokens.held))
      throw new Error('INV-P2 too many running slices');
  }

  // -------------------------------------------------------------------------------------------

  private refreshBase(p: P): void {
    p.base = computeBase(p.priority, p.nice, p.boosted, this.paramsValue.focusPriority);
    p.band = bandOf(p.base);
  }

  /**
   * uint32 seq; when the counter would pass 2^32 − 1, renumber every READY process (heap and
   * parked) in key order to 1 … n, rebuild the heap and continue from n + 1 (§3.8, INV-P4).
   */
  private takeSeq(): number {
    if (this.nextSeq > SEQ_MAX) this.renumber();
    return this.nextSeq++;
  }

  private renumber(): void {
    this.counters.renumbers++;
    const all: P[] = [];
    for (const pid of this.inHeap) all.push(this.proc(pid));
    for (const list of this.parked) for (const pid of list) all.push(this.proc(pid));
    all.sort((a, b) => readyKey(a.effPrio, a.seq) - readyKey(b.effPrio, b.seq));
    this.ready.clear();
    let seq = 1;
    for (const p of all) p.seq = seq++;
    for (const pid of this.inHeap) {
      const p = this.proc(pid);
      this.ready.push(pid, readyKey(p.effPrio, p.seq));
    }
    this.nextSeq = seq;
  }

  private parkedOf(e: number): number[] {
    const list = this.parked[e];
    if (list === undefined) throw new RangeError(`no executor ${String(e)}`);
    return list;
  }

  private homeOf(p: P): number {
    const e = p.worker;
    if (e === null || e < 0 || e >= this.maxExecutors) {
      throw new Error(`READY pid ${String(p.pid)} has no executor`);
    }
    return e;
  }

  private proc(pid: number): P {
    const p = this.procs.get(pid);
    if (p === undefined) throw new Error(`pid ${String(pid)} is not in the process table`);
    return p;
  }
}
