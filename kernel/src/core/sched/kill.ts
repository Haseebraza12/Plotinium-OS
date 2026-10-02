/**
 * The kill path (specs/03-kernel/processes-and-scheduling.md §3.16, PROC-07; §3.15.2-§3.15.3,
 * KPS-08; syscall-abi.md §3.9).
 *
 * SIGKILL, an uncaught terminating signal, the watchdog and collateral loss all run these steps in
 * order inside the kernel worker, for a process P:
 *
 *   1. Permission and audit        (hook; `kill` has already checked permission)
 *   2. State                       P → TERMINATED; removed from the ready heap, parked[*], the
 *                                  timer heap and the memory wait queue (hook)
 *   3. Pending call                B/R cancelled (hook); a T call or X phase 2 is a non-pre-emptive
 *                                  section that commits or aborts whole, its reply discarded
 *   4. Worker                      RUNNING: PREEMPT = 2 and the KILL_GRACE_MS timer (watchdog); a
 *                                  `killed` frame or the executor's termination finishes the kill.
 *                                  Resident but not running: `{t:'drop', pid}`. The run token and
 *                                  the residency slot are released ("frees its worker").
 *   5. Files                       close every fd (hook)
 *   6. Locks                       release leases (hook)
 *   7. Children                    re-parent to pid 1, SIGHUP/SIGCONT rules (hook)
 *   8. Windows                     close every window (hook, WM-05)
 *   9. Memory                      free pages, reservations, swap GC without page-in (hook)
 *  10. Zombie and wake-ups         zombie record, SIGCHLD, wake wait()ers, init reaps (hook)
 *  11. Log                         klog {kind:'proc', pid, from, to:'TERMINATED', reason, by,
 *                                  exitCode} (hook)
 *
 * The scheduler-owned structures (heap, parked, slices, tokens, timers, residency) are cleaned
 * here; everything else is a hook implemented by kernel/core/proc, vfs, lockd, wm and mm.
 * INV-P7: afterwards no heap entry, parked entry, timer, run token or residency refers to P.
 */
import type { ExecutorPool } from './placement.ts';
import type { Scheduler } from './scheduler.ts';
import type { NonPreemptiveSections } from './sections.ts';
import type { TimerHeap } from './timers.ts';
import type { ExitReason, SchedulableProcess, TransitionReason } from './types.ts';
import type { CollateralPlan, Watchdog } from './watchdog.ts';
import { planCollateral } from './watchdog.ts';

/** Why a process is being killed: a signal number, the watchdog, or loss of its executor. */
export type KillReason = `signal:${number}` | 'watchdog' | 'collateral';

/** SIGKILL = 9 (syscall-abi.md §4.8); watchdog and collateral exits are 128 + 9 = 137. */
const SIGKILL_EXIT = 137;
const SIGNAL_EXIT_BASE = 128;

export interface KillRecord {
  readonly pid: number;
  readonly from: SchedulableProcess['state'];
  readonly to: 'TERMINATED';
  readonly reason: TransitionReason;
  /** Caller pid; 0 means the kernel itself. */
  readonly by: number;
  readonly exitCode: number;
  readonly exitReason: ExitReason;
}

/** Steps owned outside kernel/core/sched, called in the order of §3.16. */
export interface KillHooks<P extends SchedulableProcess> {
  /** Step 1: security audit for cross-uid kills and agent records (permission already checked). */
  audit(p: P, reason: KillReason, by: number): void;
  /** Step 2 (rest): leave the memory wait queue and any other kernel wait list. */
  leaveWaitQueues(p: P): void;
  /** Step 3: cancel a pending B or R call (drop its id). Not called while a T/X section runs. */
  cancelPendingCall(p: P): void;
  /** Step 4: post `{t:'drop', pid}` to a live executor where P is resident but not running. */
  dropResident(e: number, p: P): void;
  /** Step 5. */
  closeFds(p: P): void;
  /** Step 6. */
  releaseLocks(p: P): void;
  /** Step 7. */
  reparentChildren(p: P): void;
  /** Step 8. */
  closeWindows(p: P): void;
  /** Step 9 (a SUSPENDED process is never paged in to be killed). */
  freeMemory(p: P): void;
  /** Step 10: zombie record `{pid, ppid, uid, exitCode, exitReason, …}`, SIGCHLD, wake waiters. */
  zombie(p: P, exitCode: number, exitReason: ExitReason): void;
  /** Step 11. */
  log(record: KillRecord, now: number): void;
  /**
   * Collateral restore (§3.15.3): READY/BLOCKED → SUSPENDED with reason `executor-lost`; the
   * process is paged in on demand on a fresh executor.
   */
  suspendLost(p: P, now: number): void;
}

export interface KillPathDeps<P extends SchedulableProcess> {
  readonly scheduler: Scheduler<P>;
  readonly pool: ExecutorPool;
  readonly timers: TimerHeap;
  readonly watchdog: Watchdog;
  readonly sections: NonPreemptiveSections;
  readonly procs: { get(pid: number): P | undefined };
  readonly hooks: KillHooks<P>;
}

export type KillOutcome =
  /** Steps 1-11 done. */
  | 'done'
  /** RUNNING: PREEMPT = 2 sent; `finish` runs steps 4-11 when the slice ends or the grace expires. */
  | 'pending'
  /** Already TERMINATED (a zombie): no effect (Linux behaviour, §3.17.1). */
  | 'already';

interface Pending<P> {
  readonly p: P;
  readonly from: SchedulableProcess['state'];
  readonly reason: KillReason;
  readonly by: number;
}

export interface ExecutorTermination {
  readonly e: number;
  /** The isolation key of the terminated worker (the caller respawns a fresh one for it). */
  readonly isolation: string | null;
  readonly runaway: number | null;
  readonly plan: CollateralPlan;
}

export function exitCodeFor(reason: KillReason): number {
  if (reason === 'watchdog' || reason === 'collateral') return SIGKILL_EXIT;
  return SIGNAL_EXIT_BASE + Number(reason.slice('signal:'.length));
}

function exitReasonFor(reason: KillReason): ExitReason {
  return reason === 'watchdog' || reason === 'collateral' ? reason : 'signal';
}

export class KillPath<P extends SchedulableProcess> {
  private readonly d: KillPathDeps<P>;
  private readonly pending = new Map<number, Pending<P>>();

  constructor(deps: KillPathDeps<P>) {
    this.d = deps;
  }

  /** Whether a RUNNING kill is waiting for its slice to end. */
  isPending(pid: number): boolean {
    return this.pending.has(pid);
  }

  /** Run the kill path for P (steps 1-4, and 5-11 unless P is RUNNING). */
  begin(p: P, reason: KillReason, by: number, now: number): KillOutcome {
    if (p.state === 'TERMINATED') return this.pending.has(p.pid) ? 'pending' : 'already';
    const { scheduler, timers, sections, hooks } = this.d;
    const from = p.state;
    // 1. Permission and audit.
    hooks.audit(p, reason, by);
    // 2. State: TERMINATED; out of the ready heap, parked[*], the timer heap and wait queues.
    p.state = 'TERMINATED';
    scheduler.remove(p.pid, now);
    timers.cancelAllOf(p.pid);
    hooks.leaveWaitQueues(p);
    // 3. Pending call: a kernel section finishes whole and its reply is discarded.
    if (sections.onKill(p.pid) === 'none') hooks.cancelPendingCall(p);
    // 4. Worker.
    const e = scheduler.runningOn(p.pid);
    if (e !== null) {
      const slice = scheduler.sliceOf(e);
      scheduler.preemptKill(e);
      /* v8 ignore next -- runningOn() returned e, so the slice exists */
      if (slice !== null) this.d.watchdog.requestKill(e, p.pid, slice.sliceSeq, now, 'kill');
      this.pending.set(p.pid, { p, from, reason, by });
      return 'pending';
    }
    this.complete(p, from, reason, by, now);
    return 'done';
  }

  /**
   * The RUNNING target's slice ended (`killed` or any racing frame, after `onSliceEnd`), or its
   * executor was terminated after KILL_GRACE_MS: finish steps 4-11. False if nothing was pending.
   */
  finish(pid: number, now: number): boolean {
    const k = this.pending.get(pid);
    if (k === undefined) return false;
    this.pending.delete(pid);
    this.complete(k.p, k.from, k.reason, k.by, now);
    return true;
  }

  /**
   * A runaway honoured PREEMPT = 2 from the watchdog (`killed` frame, after `onSliceEnd`): the kill
   * path for the runaway only, no collateral (§3.15.2).
   */
  finishWatchdogKill(p: P, now: number): KillOutcome {
    if (this.pending.has(p.pid)) return this.finish(p.pid, now) ? 'done' : 'already';
    return this.begin(p, 'watchdog', 0, now);
  }

  /**
   * `worker.terminate()` of executor e. `cause` is `watchdog` when the running slice is a proven
   * runaway (watchdog grace or kill grace expired): it exits 137 with reason `watchdog` unless a
   * kill of it was already pending. For a realm crash (worker `error` event) or a second identity
   * mismatch the running process merely lost its executor like everyone else: 137 `collateral`.
   * Each co-resident is restored from a clean checkpoint (SUSPENDED, `executor-lost`) or exits
   * 137 (`collateral`) (§3.15.3). The caller then respawns a fresh executor for `isolation`.
   */
  terminateExecutor(
    e: number,
    now: number,
    restorable: (pid: number) => boolean,
    cause: 'watchdog' | 'crash' | 'identity-mismatch' = 'watchdog',
  ): ExecutorTermination {
    const { scheduler, pool, watchdog, hooks } = this.d;
    const slot = pool.slot(e);
    const isolation = slot.isolation;
    const residents = pool.terminate(e);
    const { runningPid } = scheduler.executorLost(e, residents, now);
    watchdog.clear(e);
    for (const pid of residents) {
      const p = this.d.procs.get(pid);
      if (p !== undefined) p.worker = null;
    }
    if (runningPid !== null) {
      const runaway = this.d.procs.get(runningPid);
      if (runaway !== undefined) {
        runaway.worker = null;
        if (!this.finish(runningPid, now))
          this.begin(runaway, cause === 'watchdog' ? 'watchdog' : 'collateral', 0, now);
      }
    }
    const plan = planCollateral(residents, runningPid, (pid) => {
      const p = this.d.procs.get(pid);
      return p !== undefined && p.state !== 'TERMINATED' && restorable(pid);
    });
    for (const pid of plan.restore) {
      const p = this.d.procs.get(pid);
      if (p !== undefined) hooks.suspendLost(p, now);
    }
    // Only a RUNNING process can have a pending kill, and that is the runaway handled above.
    for (const pid of plan.collateral) {
      const p = this.d.procs.get(pid);
      if (p !== undefined && p.state !== 'TERMINATED') this.begin(p, 'collateral', 0, now);
    }
    return { e, isolation, runaway: runningPid, plan };
  }

  private complete(
    p: P,
    from: SchedulableProcess['state'],
    reason: KillReason,
    by: number,
    now: number,
  ): void {
    const { pool, hooks } = this.d;
    // 4 (rest): drop the resident's generator and free its residency slot.
    const home = pool.homeOf(p.pid);
    if (home !== null) {
      hooks.dropResident(home, p);
      pool.evict(p, now);
    } else {
      p.worker = null;
    }
    hooks.closeFds(p); // 5
    hooks.releaseLocks(p); // 6
    hooks.reparentChildren(p); // 7
    hooks.closeWindows(p); // 8
    hooks.freeMemory(p); // 9
    const exitCode = exitCodeFor(reason);
    const exitReason = exitReasonFor(reason);
    hooks.zombie(p, exitCode, exitReason); // 10
    hooks.log({ pid: p.pid, from, to: 'TERMINATED', reason, by, exitCode, exitReason }, now); // 11
  }
}
