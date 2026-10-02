/**
 * The process lifecycle of Figure 9.1 (Spec §9.1, PROC-06; processes-and-scheduling.md §3.4).
 *
 * Every transition is exactly one klog record `{t, kind:'proc', pid, from, to, reason, …}` and one
 * `proc.state` event; spawning publishes `proc.spawn`, termination publishes `proc.exit`. A change
 * of `waitingOn` inside BLOCKED is an annotation record (`from === to`). Any edge that is not in
 * the table below is a kernel bug and is refused (INV-P9).
 */
import type { PState, SignalName, WaitStatus } from '@plotinium/protocol';
import { signalFromNumber } from '@plotinium/protocol';

import { KernelBug } from '../errors.ts';
import type { EventBus } from '../events/bus.ts';
import type { Klog } from '../klog/klog.ts';
import type { ExitReason, PCB, WaitReason } from './pcb.ts';

/**
 * §4.6 `TransitionReason` (the same union as core/sched/types.ts).
 * TODO(protocol): move to protocol/src/proc/records.ts and import it in both places.
 */
export type TransitionReason =
  | 'spawn'
  | 'admit'
  | 'spawn-failed'
  | 'dispatch'
  | 'quantum'
  | 'preempt'
  | 'requeue'
  | 'block'
  | 'wake'
  | 'cont'
  | 'page-out'
  | 'executor-lost'
  | 'page-in'
  | 'exit'
  | 'watchdog'
  | 'collateral'
  | 'crash'
  | 'reaped'
  | `signal:${number}`
  | 'annotate';

/**
 * Allowed edges: Figure 9.1 plus the documented Plotinium additions (§3.4 transition table).
 * READY → BLOCKED is the stop edge of §3.17.1 ("READY → removed from the heap, BLOCKED
 * `sigcont`"): a stop signal on a READY process, logged with reason `signal:<n>`.
 */
export const EDGES: Readonly<Record<PState, readonly PState[]>> = {
  NEW: ['READY', 'TERMINATED'],
  READY: ['RUNNING', 'SUSPENDED', 'TERMINATED', 'BLOCKED'],
  RUNNING: ['READY', 'BLOCKED', 'TERMINATED'],
  BLOCKED: ['READY', 'SUSPENDED', 'TERMINATED'],
  SUSPENDED: ['READY', 'TERMINATED'],
  TERMINATED: [],
};

export function isAllowedEdge(from: PState, to: PState): boolean {
  return EDGES[from].includes(to);
}

/** The ExitReason carried by `proc.exit` (the `crash` and `spawn-failed` reasons map to normal). */
type ProcExitReason = 'normal' | 'signal' | 'watchdog' | 'collateral' | 'abi-violation';

function exitEventReason(r: ExitReason): ProcExitReason {
  return r === 'crash' || r === 'spawn-failed' ? 'normal' : r;
}

/** `WaitStatus` of a terminated process (syscall-abi.md §4.2). */
export function waitStatusOf(pcb: PCB): WaitStatus {
  const code = pcb.exitCode ?? 0;
  if (
    pcb.exitReason === 'signal' ||
    pcb.exitReason === 'watchdog' ||
    pcb.exitReason === 'collateral'
  ) {
    const sig: SignalName = signalFromNumber(code - 128) ?? 'SIGKILL';
    return { kind: 'signaled', signal: sig, code: Math.min(255, Math.max(129, code)) };
  }
  return { kind: 'exited', code: Math.min(255, Math.max(0, code)) };
}

export interface LifecycleDeps {
  readonly klog: Klog;
  readonly bus: EventBus;
  readonly now: () => number;
}

export interface TransitionExtra {
  readonly waitingOn?: WaitReason;
  /** Pid of the process that caused it (kill), 0 for the kernel. */
  readonly by?: number;
  readonly exitCode?: number;
  readonly exitReason?: ExitReason;
  readonly detail?: string;
}

export class Lifecycle {
  private readonly deps: LifecycleDeps;

  constructor(deps: LifecycleDeps) {
    this.deps = deps;
  }

  /** Record the birth of `pcb` (none → NEW) and publish `proc.spawn`. */
  spawned(pcb: PCB): void {
    pcb.state = 'NEW';
    this.deps.klog.append({
      kind: 'proc',
      t: this.deps.now(),
      pid: pcb.pid,
      uid: pcb.cred.uid,
      from: null,
      to: 'NEW',
      reason: 'spawn',
    });
    this.deps.bus.publish('proc.spawn', {
      pid: pcb.pid,
      ppid: pcb.ppid,
      pgid: pcb.pgid,
      uid: pcb.cred.uid,
      argv0: (pcb.argv[0] ?? pcb.name).slice(0, 256),
      priority: pcb.priority,
      class: pcb.cls,
    });
  }

  /** Move `pcb` along one edge of Figure 9.1; throws KernelBug for any other edge. */
  transition(pcb: PCB, to: PState, reason: TransitionReason, extra: TransitionExtra = {}): void {
    this.apply(pcb, pcb.state, to, reason, extra);
  }

  /**
   * Log a transition whose state change the scheduler or the kill path has already made
   * (`SchedHost.transition`, kill-path step 11): `from` is the state before, `pcb.state` may
   * already be `to`. The edge is checked exactly as in `transition`.
   */
  record(
    pcb: PCB,
    from: PState,
    to: PState,
    reason: TransitionReason,
    extra: TransitionExtra = {},
  ): void {
    this.apply(pcb, from, to, reason, extra);
  }

  private apply(
    pcb: PCB,
    from: PState,
    to: PState,
    reason: TransitionReason,
    extra: TransitionExtra,
  ): void {
    if (!isAllowedEdge(from, to)) {
      throw new KernelBug(`illegal transition pid ${String(pcb.pid)}: ${from} → ${to} (${reason})`);
    }
    const t = this.deps.now();
    pcb.state = to;
    if (to === 'BLOCKED') pcb.waitingOn = extra.waitingOn ?? pcb.waitingOn;
    else pcb.waitingOn = null;
    if (to === 'READY') pcb.waitingSince = t;
    if (to === 'TERMINATED') {
      pcb.exitCode = extra.exitCode ?? pcb.exitCode ?? 0;
      pcb.exitReason = extra.exitReason ?? pcb.exitReason ?? 'normal';
      pcb.exitedAt = t;
      pcb.worker = null;
    }
    this.deps.klog.append({
      kind: 'proc',
      t,
      pid: pcb.pid,
      uid: pcb.cred.uid,
      from,
      to,
      reason,
      ...(extra.waitingOn === undefined ? {} : { waitingOn: extra.waitingOn }),
      ...(extra.by === undefined ? {} : { by: extra.by }),
      ...(to === 'TERMINATED' ? { exitCode: pcb.exitCode ?? 0 } : {}),
      ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    });
    this.deps.bus.publish('proc.state', { pid: pcb.pid, from, to, reason: reason.slice(0, 64) });
    if (to === 'TERMINATED') {
      this.deps.bus.publish('proc.exit', {
        pid: pcb.pid,
        status: waitStatusOf(pcb),
        reason: exitEventReason(pcb.exitReason ?? 'normal'),
      });
    }
  }

  /** A `waitingOn` change inside BLOCKED: one annotation record, no event. */
  annotate(pcb: PCB, waitingOn: WaitReason): void {
    if (pcb.state !== 'BLOCKED')
      throw new KernelBug(`annotate pid ${String(pcb.pid)} in ${pcb.state}`);
    pcb.waitingOn = waitingOn;
    this.deps.klog.append({
      kind: 'proc',
      t: this.deps.now(),
      pid: pcb.pid,
      uid: pcb.cred.uid,
      from: 'BLOCKED',
      to: 'BLOCKED',
      reason: 'annotate',
      waitingOn,
    });
  }

  /** The zombie is removed from the table (TERMINATED → reaped). */
  reaped(pcb: PCB, by: number): void {
    if (pcb.state !== 'TERMINATED')
      throw new KernelBug(`reap pid ${String(pcb.pid)} in ${pcb.state}`);
    this.deps.klog.append({
      kind: 'proc',
      t: this.deps.now(),
      pid: pcb.pid,
      uid: pcb.cred.uid,
      from: 'TERMINATED',
      to: null,
      reason: 'reaped',
      by,
    });
  }
}
