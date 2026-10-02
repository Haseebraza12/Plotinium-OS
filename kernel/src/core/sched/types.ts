/**
 * Scheduler-facing types (specs/03-kernel/processes-and-scheduling.md §4.1, §4.2, §4.6).
 *
 * The PCB and the process table belong to kernel/core/proc. The scheduler only needs the subset of
 * PCB fields below, with the SAME names and meanings as the PCB of §4.1, so a PCB satisfies
 * `SchedulableProcess` structurally and no adapter is needed.
 */
import type { IndexedMinHeap } from '@plotinium/dsa/heap';
import type { Band, PState, ProcClass } from '@plotinium/protocol';

import type { SchedParams } from './params.ts';

/**
 * TODO(protocol): §4.6 `TransitionReason` belongs in protocol/src/proc/records.ts; declared here
 * until protocol exports it. Only the reasons the scheduler itself emits are listed in
 * `SchedReason`; the full union is kept for the kill path and collateral handling.
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

/** Reasons for entering READY (§3.4 transition table); `makeReady` is the only way in. */
export type ReadyReason = 'admit' | 'quantum' | 'preempt' | 'requeue' | 'wake' | 'cont' | 'page-in';

/** TODO(protocol): §4.1 `ExitReason` (protocol has only the `proc.exit` picklist). */
export type ExitReason =
  'normal' | 'signal' | 'watchdog' | 'collateral' | 'crash' | 'spawn-failed' | 'abi-violation';

/**
 * The PCB fields the scheduler reads and writes (§4.1 "scheduling" group plus identity, state and
 * residency). Field names are the PCB's own; see integration_notes for the mapping.
 */
export interface SchedulableProcess {
  readonly pid: number;
  /** `${uid}:${cls}` (§4.1 `isolation`); executors are bound to one key for life. */
  readonly isolation: string;
  state: PState;
  priority: number;
  nice: number;
  base: number;
  effPrio: number;
  band: Band;
  boosted: boolean;
  preemptRequested: boolean;
  /** Arrival sequence (round-robin, §3.8); changes only in makeReady and renumbering (INV-P4). */
  seq: number;
  cpuTimeMs: number;
  lastRunAt: number;
  waitingSince: number;
  sliceStartedAt: number;
  slices: number;
  overruns: number;
  maxStepUs: number;
  /** Executor index where resident (home executor); null while SUSPENDED or not placed. */
  worker: number | null;
  exclusive: boolean;
  checkpointable: boolean;
}

/** Read access to the process table (the PCB `PidTable` of kernel/core/proc satisfies it). */
export interface ProcLookup<P extends SchedulableProcess = SchedulableProcess> {
  get(pid: number): P | undefined;
}

/** Builds the `dsa/heap` instances (ready heap, timer heap). Tests inject a model double. */
export type HeapFactory = (initialCapacity: number) => IndexedMinHeap;

/** Side effects the scheduler asks of the kernel host (executor ports, klog, events). */
export interface SchedHost<P extends SchedulableProcess = SchedulableProcess> {
  /**
   * Post `{t:'dispatch', pid, sliceSeq, quantumMs, reply?, pendingSigs?}` to executor `e`. The
   * host adds `reply` (p.pendingReply) and `pendingSigs` from the PCB and writes SLICE_SEQ.
   */
  dispatch(e: number, p: P, sliceSeq: number, quantumMs: number): void;
  /** PREEMPT = level on executor `e` (Atomics.store with SAB, `{t:'preempt'}` without). */
  setPreempt(e: number, level: 1 | 2): void;
  /** One klog record and one `proc.state` event per transition (PROC-06). */
  transition(p: P, from: PState | null, to: PState, reason: TransitionReason, now: number): void;
}

/** §4.2 ExecutorInfo (the `sched` command and `sched.info`). */
export interface ExecutorInfo {
  readonly index: number;
  readonly isolation: string;
  readonly residents: number;
  readonly runnable: number;
  readonly runningPid: number | null;
  readonly exclusive: boolean;
  readonly spawnedAt: number;
  readonly terminations: number;
}

/** §4.2 SchedInfo (reply of `sched.info`). */
export interface SchedInfo extends SchedParams {
  readonly hwc: number;
  readonly embedActive: boolean;
  readonly executors: readonly ExecutorInfo[];
  readonly preemption: 'sab' | 'message';
  readonly tokensFree: number;
  readonly readyCount: number;
  readonly parkedCount: number;
  readonly hKillMs: number;
}

/** Isolation key of §3.13 / syscall-abi.md §3.2.1. */
export function isolationKey(uid: number, cls: ProcClass): string {
  return `${String(uid)}:${cls}`;
}
