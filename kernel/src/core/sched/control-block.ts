/**
 * The 32-byte SharedArrayBuffer control block of every executor
 * (specs/03-kernel/processes-and-scheduling.md §3.7.2, §4.3 `CTL`; KPS-04).
 *
 * `Int32Array(new SharedArrayBuffer(32))`, i.e. 8 slots. Only pre-emption and heartbeat flags go
 * through it; syscalls never do (syscall-abi.md §3.1 rule 1). Without cross-origin isolation there
 * is no SharedArrayBuffer and the kernel falls back to `{t:'preempt'}` messages (§3.7.4); callers
 * then hold `null` instead of a block.
 *
 * Kernel-side writers: PREEMPT (set), SLICE_SEQ, FLAGS. Executor-side writers: PREEMPT (clear at
 * slice start), RUNNING_PID, HEARTBEAT, STEPS, MAX_STEP_US. Every access is an `Atomics` operation.
 */

/** §4.3 CTL slot indices (index 7 is reserved and stays 0). */
export const CTL = Object.freeze({
  PREEMPT: 0,
  RUNNING_PID: 1,
  HEARTBEAT: 2,
  SLICE_SEQ: 3,
  STEPS: 4,
  MAX_STEP_US: 5,
  FLAGS: 6,
  RESERVED: 7,
} as const);

export const CTL_SLOTS = 8;
export const CTL_BYTES = CTL_SLOTS * Int32Array.BYTES_PER_ELEMENT;

/** PREEMPT values: 0 none, 1 yield at the next yield point, 2 kill at the next yield point. */
export const PREEMPT_NONE = 0;
export const PREEMPT_YIELD = 1;
export const PREEMPT_KILL = 2;
export type PreemptLevel = typeof PREEMPT_NONE | typeof PREEMPT_YIELD | typeof PREEMPT_KILL;

/** FLAGS bits (§3.7.2). */
export const CTL_FLAG = Object.freeze({
  DRAINING: 1 << 0,
  CHECKPOINT_WANTED: 1 << 1,
  SUSPECT: 1 << 2,
} as const);

/** MAX_STEP_US saturates at 2^31 − 1. */
export const MAX_STEP_US_SATURATED = 0x7fff_ffff;

/** A control block view. `null` means message fallback (no cross-origin isolation). */
export type ControlBlock = Int32Array;

/**
 * Allocate a control block when the realm is cross-origin isolated (the host passes
 * `globalThis.crossOriginIsolated`); otherwise return null (message fallback, §3.7.4).
 */
export function createControlBlock(crossOriginIsolated: boolean): ControlBlock | null {
  if (!crossOriginIsolated || typeof SharedArrayBuffer !== 'function') return null;
  return new Int32Array(new SharedArrayBuffer(CTL_BYTES));
}

/** Wrap a block received in `{t:'init', ctl}`; throws on a buffer of the wrong size. */
export function wrapControlBlock(buffer: SharedArrayBuffer | ArrayBuffer): ControlBlock {
  if (buffer.byteLength !== CTL_BYTES) {
    throw new RangeError(
      `control block must be ${String(CTL_BYTES)} bytes, got ${String(buffer.byteLength)}`,
    );
  }
  return new Int32Array(buffer);
}

export function isControlBlock(value: unknown): value is ControlBlock {
  return value instanceof Int32Array && value.length === CTL_SLOTS;
}

/** Pre-emption mode reported by `sched` and `sched.info` (§3.7.4). */
export function preemptionMode(ctl: ControlBlock | null): 'sab' | 'message' {
  return ctl === null ? 'message' : 'sab';
}

// ---------------------------------------------------------------------------------------------
// Kernel side
// ---------------------------------------------------------------------------------------------

/** Kernel: request a yield (1) or a kill (2) at the next yield point. A kill is never downgraded. */
export function setPreempt(
  ctl: ControlBlock,
  level: typeof PREEMPT_YIELD | typeof PREEMPT_KILL,
): void {
  if (level === PREEMPT_YIELD) {
    // Only raise 0 → 1; a pending kill (2) must not be downgraded by a later yield request.
    Atomics.compareExchange(ctl, CTL.PREEMPT, PREEMPT_NONE, PREEMPT_YIELD);
    return;
  }
  Atomics.store(ctl, CTL.PREEMPT, PREEMPT_KILL);
}

/** Kernel: write the slice counter at dispatch (the executor echoes it in its frames). */
export function writeSliceSeq(ctl: ControlBlock, sliceSeq: number): void {
  Atomics.store(ctl, CTL.SLICE_SEQ, sliceSeq | 0);
}

export function readPreempt(ctl: ControlBlock): PreemptLevel {
  const v = Atomics.load(ctl, CTL.PREEMPT);
  return v === PREEMPT_KILL ? PREEMPT_KILL : v === PREEMPT_YIELD ? PREEMPT_YIELD : PREEMPT_NONE;
}

export function readRunningPid(ctl: ControlBlock): number {
  return Atomics.load(ctl, CTL.RUNNING_PID);
}

export function readSliceSeq(ctl: ControlBlock): number {
  return Atomics.load(ctl, CTL.SLICE_SEQ);
}

export function readHeartbeat(ctl: ControlBlock): number {
  return Atomics.load(ctl, CTL.HEARTBEAT);
}

export function readSteps(ctl: ControlBlock): number {
  return Atomics.load(ctl, CTL.STEPS);
}

export function readMaxStepUs(ctl: ControlBlock): number {
  return Atomics.load(ctl, CTL.MAX_STEP_US);
}

export function setFlag(ctl: ControlBlock, flag: number): void {
  Atomics.or(ctl, CTL.FLAGS, flag);
}

export function clearFlag(ctl: ControlBlock, flag: number): void {
  Atomics.and(ctl, CTL.FLAGS, ~flag);
}

export function hasFlag(ctl: ControlBlock, flag: number): boolean {
  return (Atomics.load(ctl, CTL.FLAGS) & flag) !== 0;
}

/** A consistent-enough snapshot for the watchdog and `sched` (each slot is read atomically). */
export interface ControlSnapshot {
  readonly preempt: PreemptLevel;
  readonly runningPid: number;
  readonly heartbeat: number;
  readonly sliceSeq: number;
  readonly steps: number;
  readonly maxStepUs: number;
  readonly flags: number;
}

export function snapshotControl(ctl: ControlBlock): ControlSnapshot {
  return {
    preempt: readPreempt(ctl),
    runningPid: readRunningPid(ctl),
    heartbeat: readHeartbeat(ctl),
    sliceSeq: readSliceSeq(ctl),
    steps: readSteps(ctl),
    maxStepUs: readMaxStepUs(ctl),
    flags: Atomics.load(ctl, CTL.FLAGS),
  };
}

// ---------------------------------------------------------------------------------------------
// Executor side (used by kernel/runtime/slice.ts; pure helpers so both sides share one layout)
// ---------------------------------------------------------------------------------------------

/** Executor: slice start (§3.7.3): PREEMPT = 0, RUNNING_PID = pid, STEPS = 0, MAX_STEP_US = 0. */
export function execBeginSlice(ctl: ControlBlock, pid: number): void {
  Atomics.store(ctl, CTL.PREEMPT, PREEMPT_NONE);
  Atomics.store(ctl, CTL.RUNNING_PID, pid | 0);
  Atomics.store(ctl, CTL.STEPS, 0);
  Atomics.store(ctl, CTL.MAX_STEP_US, 0);
}

/**
 * Executor: at a yield point, bump HEARTBEAT, publish STEPS and MAX_STEP_US (saturating), and
 * return the PREEMPT level to honour.
 */
export function execYieldPoint(ctl: ControlBlock, steps: number, maxStepUs: number): PreemptLevel {
  Atomics.add(ctl, CTL.HEARTBEAT, 1);
  Atomics.store(ctl, CTL.STEPS, Math.min(steps, MAX_STEP_US_SATURATED) | 0);
  Atomics.store(
    ctl,
    CTL.MAX_STEP_US,
    Math.min(Math.max(0, Math.round(maxStepUs)), MAX_STEP_US_SATURATED) | 0,
  );
  return readPreempt(ctl);
}

/** Executor: inside `report()`, RUNNING_PID = 0 (idle). */
export function execEndSlice(ctl: ControlBlock): void {
  Atomics.store(ctl, CTL.RUNNING_PID, 0);
}
