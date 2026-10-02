/**
 * Watchdog, forced termination and collateral handling
 * (specs/03-kernel/processes-and-scheduling.md §3.15, §3.16 step 4; KPS-08; syscall-abi.md §3.2.1).
 *
 * A kernel timer runs `check` every WATCHDOG_PERIOD_MS (KPS-13). For each executor e running a
 * slice {pid, seq}:
 *   - With SAB: runaway ⇔ ctl[RUNNING_PID] = pid ∧ ctl[SLICE_SEQ] = seq ∧ now − sliceStartedAt >
 *     HARD_LIMIT_MS. If RUNNING_PID is already 0 the report is in flight and nothing is done.
 *     A runaway gets PREEMPT = 2; if no frame arrives within KILL_GRACE_MS the executor is
 *     terminated (`worker.terminate()`), the runaway exits 137 (reason `watchdog`), and every
 *     co-resident is restored from a clean checkpoint or exits 137 (reason `collateral`).
 *   - Without SAB (message fallback, §3.7.4): runaway ⇔ no frame for this slice after
 *     HARD_LIMIT_MS + KILL_GRACE_MS; go straight to termination.
 * The kill path (§3.16 step 4) uses the same grace timer for a RUNNING target (`requestKill`).
 *
 * Plotinium hardening (beyond §3.15.1, documented in integration notes): with SAB, a slice whose
 * block never shows its pid (RUNNING_PID stays 0 or foreign) and that sends no frame for
 * HARD_LIMIT + KILL_GRACE + 2·WATCHDOG_PERIOD is treated as lost and terminated. A report that is
 * genuinely in flight is processed long before that, so conforming runs never reach this path.
 *
 * The worst time a runaway holds a run token is H_kill = HARD_LIMIT + KILL_GRACE + WATCHDOG_PERIOD
 * (400 ms by default), which is the H_kill term of the PROC-04 bound.
 */
import type { ControlBlock } from './control-block.ts';
import {
  readHeartbeat,
  readMaxStepUs,
  readRunningPid,
  readSliceSeq,
  readSteps,
} from './control-block.ts';
import type { SchedParams } from './params.ts';

export type WatchdogParams = Pick<SchedParams, 'hardLimitMs' | 'killGraceMs' | 'watchdogPeriodMs'>;

/** A slice as the scheduler knows it (`slice[e]`). */
export interface RunningSlice {
  readonly e: number;
  readonly pid: number;
  readonly sliceSeq: number;
  readonly startedAt: number;
}

export type TerminateCause =
  /** Runaway that did not honour PREEMPT = 2 within KILL_GRACE_MS. */
  | 'watchdog'
  /** Kill path target that did not honour PREEMPT = 2 within KILL_GRACE_MS. */
  | 'kill-grace'
  /** Message fallback: no frame after HARD_LIMIT_MS + KILL_GRACE_MS. */
  | 'no-report'
  /** SAB hardening: the block never showed the slice and no frame came. */
  | 'lost-slice';

export type WatchdogAction =
  | {
      readonly kind: 'preempt-kill';
      readonly e: number;
      readonly pid: number;
      readonly sliceSeq: number;
      /** klog `watchdog {pid, sliceMs, steps, maxStepUs}` (§3.15.2). */
      readonly sliceMs: number;
      readonly steps: number;
      readonly maxStepUs: number;
      /** HEARTBEAT did not move since the previous check of this slice. */
      readonly heartbeatStale: boolean;
    }
  | {
      readonly kind: 'terminate';
      readonly e: number;
      readonly pid: number;
      readonly sliceSeq: number;
      readonly cause: TerminateCause;
      readonly sliceMs: number;
    };

interface KillRequest {
  readonly pid: number;
  readonly sliceSeq: number;
  readonly requestedAt: number;
  readonly origin: 'watchdog' | 'kill';
}

interface Beat {
  readonly sliceSeq: number;
  readonly beat: number;
}

export class Watchdog {
  private params: WatchdogParams;
  private readonly kills = new Map<number, KillRequest>();
  private readonly beats = new Map<number, Beat>();

  constructor(params: WatchdogParams) {
    this.params = params;
  }

  setParams(params: WatchdogParams): void {
    this.params = params;
  }

  /**
   * PREEMPT = 2 was set on executor e for this slice (by `check` or by the kill path); start the
   * KILL_GRACE_MS timer. A second request for the same slice keeps the earlier start.
   */
  requestKill(
    e: number,
    pid: number,
    sliceSeq: number,
    now: number,
    origin: 'watchdog' | 'kill',
  ): void {
    const prev = this.kills.get(e);
    if (prev?.pid === pid && prev.sliceSeq === sliceSeq) return;
    this.kills.set(e, { pid, sliceSeq, requestedAt: now, origin });
  }

  /** The pending PREEMPT = 2 on executor e, if any. */
  pendingKill(
    e: number,
  ):
    | { pid: number; sliceSeq: number; requestedAt: number; origin: 'watchdog' | 'kill' }
    | undefined {
    const k = this.kills.get(e);
    return k === undefined ? undefined : { ...k };
  }

  /** The slice on e ended (a frame arrived) or the executor was terminated. */
  clear(e: number): void {
    this.kills.delete(e);
    this.beats.delete(e);
  }

  /** One watchdog period. `ctlOf(e)` is the executor's control block, or null without SAB. */
  check(
    now: number,
    slices: Iterable<RunningSlice>,
    ctlOf: (e: number) => ControlBlock | null,
  ): WatchdogAction[] {
    const out: WatchdogAction[] = [];
    const { hardLimitMs, killGraceMs, watchdogPeriodMs } = this.params;
    for (const s of slices) {
      const sliceMs = now - s.startedAt;
      const pending = this.kills.get(s.e);
      if (pending !== undefined && (pending.pid !== s.pid || pending.sliceSeq !== s.sliceSeq)) {
        this.kills.delete(s.e); // left over from an earlier slice
      } else if (pending !== undefined) {
        if (now - pending.requestedAt >= killGraceMs) {
          out.push({
            kind: 'terminate',
            e: s.e,
            pid: s.pid,
            sliceSeq: s.sliceSeq,
            cause: pending.origin === 'watchdog' ? 'watchdog' : 'kill-grace',
            sliceMs,
          });
          this.clear(s.e);
        }
        continue;
      }
      const ctl = ctlOf(s.e);
      if (ctl === null) {
        if (sliceMs > hardLimitMs + killGraceMs) {
          out.push({
            kind: 'terminate',
            e: s.e,
            pid: s.pid,
            sliceSeq: s.sliceSeq,
            cause: 'no-report',
            sliceMs,
          });
          this.clear(s.e);
        }
        continue;
      }
      const beat = readHeartbeat(ctl);
      const prevBeat = this.beats.get(s.e);
      const heartbeatStale = prevBeat?.sliceSeq === s.sliceSeq && prevBeat.beat === beat;
      this.beats.set(s.e, { sliceSeq: s.sliceSeq, beat });
      const shown = readRunningPid(ctl) === s.pid && readSliceSeq(ctl) === (s.sliceSeq | 0);
      if (shown && sliceMs > hardLimitMs) {
        out.push({
          kind: 'preempt-kill',
          e: s.e,
          pid: s.pid,
          sliceSeq: s.sliceSeq,
          sliceMs,
          steps: readSteps(ctl),
          maxStepUs: readMaxStepUs(ctl),
          heartbeatStale,
        });
        this.requestKill(s.e, s.pid, s.sliceSeq, now, 'watchdog');
      } else if (!shown && sliceMs > hardLimitMs + killGraceMs + 2 * watchdogPeriodMs) {
        out.push({
          kind: 'terminate',
          e: s.e,
          pid: s.pid,
          sliceSeq: s.sliceSeq,
          cause: 'lost-slice',
          sliceMs,
        });
        this.clear(s.e);
      }
    }
    return out;
  }
}

/**
 * Identity mismatches per executor (syscall-abi.md §3.2.1): the first marks the executor SUSPECT,
 * the second terminates it through the watchdog path.
 */
export class SuspectTracker {
  private readonly counts = new Map<number, number>();

  mismatch(e: number): 'suspect' | 'terminate' {
    const n = (this.counts.get(e) ?? 0) + 1;
    this.counts.set(e, n);
    return n >= 2 ? 'terminate' : 'suspect';
  }

  isSuspect(e: number): boolean {
    return (this.counts.get(e) ?? 0) > 0;
  }

  /** A fresh worker at index e starts with a clean record. */
  reset(e: number): void {
    this.counts.delete(e);
  }
}

/** The four conditions of §3.15.3 for restoring a co-resident of a terminated executor. */
export interface RestoreFacts {
  readonly checkpointable: boolean;
  /** The latest verified checkpoint was taken after the process's last slice. */
  readonly checkpointAfterLastSlice: boolean;
  /** Every dirty data page has a valid swap copy of the current generation. */
  readonly dirtyPagesSwapped: boolean;
  /** No non-restartable call is in flight (§3.5.4). */
  readonly pendingCallRestartable: boolean;
}

export function isRestorable(f: RestoreFacts): boolean {
  return (
    f.checkpointable &&
    f.checkpointAfterLastSlice &&
    f.dirtyPagesSwapped &&
    f.pendingCallRestartable
  );
}

export interface CollateralPlan {
  /** READY/BLOCKED → SUSPENDED (reason `executor-lost`); paged in on demand elsewhere. */
  readonly restore: number[];
  /** → TERMINATED, exit 137, reason `collateral`. */
  readonly collateral: number[];
}

/** Split the co-residents of a terminated executor (the runaway itself is excluded). */
export function planCollateral(
  residents: readonly number[],
  runaway: number | null,
  restorable: (pid: number) => boolean,
): CollateralPlan {
  const restore: number[] = [];
  const collateral: number[] = [];
  for (const pid of residents) {
    if (pid === runaway) continue;
    (restorable(pid) ? restore : collateral).push(pid);
  }
  return { restore, collateral };
}
