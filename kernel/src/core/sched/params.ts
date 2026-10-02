/**
 * Scheduler constants and parameter helpers (specs/03-kernel/processes-and-scheduling.md §3.1,
 * §3.9, §3.12, §3.13, §4.2).
 *
 * Every scheduling constant lives here (§3.1: "Every constant lives in kernel/core/sched/params.ts").
 * Values marked *Settings* in the spec are carried in `SchedParams` and changed only through
 * `applySysctl` (the `sysctl.set` keys of §4.5), never by mutating the constants.
 *
 * Pure: no platform objects, no clock. Callers pass `now` explicitly.
 */
import type { Band } from '@plotinium/protocol';

// ---------------------------------------------------------------------------------------------
// §3.1 constants
// ---------------------------------------------------------------------------------------------

/** §3.1 PID_MAX: valid pids are 1 … 32,767 (protocol `PID_MAX` is the largest valid pid). */
export const PID_LIMIT = 32_768;
/** §3.1: maximum PCBs, zombies included. */
export const PROC_MAX = 4_096;
/** §3.1: maximum PCBs per uid (uid 0 exempt). */
export const NPROC_PER_UID = 1_024;
/** §3.1: static priority of a user process unless its manifest says otherwise. */
export const DEFAULT_PRIORITY = 20;
/** §3.9.1: priorities 0 (highest) … 39 (lowest). */
export const PRIO_MIN = 0;
export const PRIO_MAX = 39;
/** §3.1: nice range; values outside are clamped (POSIX `setpriority`). */
export const NICE_LOW = -20;
export const NICE_HIGH = 19;
/** §3.1 / §3.9.3: base priority of a boosted process. */
export const FOCUS_PRIORITY = 5;

/** §3.1 QUANTUM_MS (*Settings*, each 2 … 50 ms). */
export const QUANTUM_MS: Readonly<Record<Band, number>> = Object.freeze({
  interactive: 5,
  normal: 10,
  background: 20,
});
export const QUANTUM_MIN_MS = 2;
export const QUANTUM_MAX_MS = 50;

/** §3.1 T_AGE_MS (*Settings*, 50 … 1,000 ms). */
export const T_AGE_MS = 100;
export const T_AGE_MIN_MS = 50;
export const T_AGE_MAX_MS = 1_000;

/** §3.1: a conforming program does at most 0.5 ms of work between yield points. */
export const STEP_MAX_US = 500;
/** §3.1 δ: declared upper bound on per-slice overhead. */
export const DELTA_MS = 1;
/** §3.1: a slice longer than quantum + 5 ms counts as an overrun. */
export const OVERRUN_SLACK_MS = 5;
/** §3.14 rule 2: the second overrun makes a process exclusive. */
export const OVERRUNS_BEFORE_EXCLUSIVE = 2;
/** §3.1: floor of HARD_LIMIT_MS = max(250, 10 × Q). */
export const HARD_LIMIT_FLOOR_MS = 250;
/** §3.1: time between PREEMPT = 2 and `worker.terminate()`. */
export const KILL_GRACE_MS = 100;
/** §3.1: watchdog check period (a kernel timer, KPS-13). */
export const WATCHDOG_PERIOD_MS = 50;

/** §3.1: isolation executors, including one unbound spare. */
export const MAX_EXECUTORS = 8;
/** §3.13: RUN_TOKENS = clamp(hwc − 2 − embed, 1, 6). */
export const RUN_TOKENS_MIN = 1;
export const RUN_TOKENS_MAX = 6;
/** §3.13: `embedActive` holds while ai.embed is resident and ran a job in the last 2 s. */
export const EMBED_ACTIVE_WINDOW_MS = 2_000;
/** §3.1: an executor with no residents is terminated after this. */
export const EXEC_IDLE_REAP_MS = 30_000;
/** §3.1 (WM-05): window close sends SIGTERM, then SIGKILL after this. */
export const CLOSE_GRACE_MS = 3_000;
/** §3.1 / §3.9.4 (KPS-11): background pause of at most 1,000 ms in any 2,000 ms. */
export const INTERACTIVE_PAUSE_MAX_MS = 1_000;
export const INTERACTIVE_WINDOW_MS = 2_000;
/** §3.9.4: the pause applies to processes whose current effPrio is at least this. */
export const BACKGROUND_EFFPRIO_MIN = 30;
/** §3.1: no input and no READY interactive/normal process for this long means idle (C12). */
export const IDLE_MS = 2_000;

/** §3.9.1 bands by `base`: interactive 0-9, normal 10-29, background 30-39. */
export const INTERACTIVE_BASE_MAX = 9;
export const NORMAL_BASE_MAX = 29;

/** §3.8: `seq` is a uint32; the ready key is effPrio · 2^32 + seq, exact below 2^53. */
export const SEQ_SPACE = 4_294_967_296;
export const SEQ_MAX = SEQ_SPACE - 1;

// ---------------------------------------------------------------------------------------------
// §4.2 parameters
// ---------------------------------------------------------------------------------------------

/** §4.2 SchedParams (kernel/core/sched/types.ts in the spec; kept next to the constants here). */
export interface SchedParams {
  readonly quantumMs: Readonly<Record<Band, number>>;
  readonly tAgeMs: number;
  readonly deltaMs: number;
  readonly hardLimitMs: number;
  readonly killGraceMs: number;
  readonly watchdogPeriodMs: number;
  readonly runTokens: number;
  readonly maxExecutors: number;
  readonly focusPriority: number;
}

/** Keys accepted by `sysctl.set` for the scheduler (§4.5, root and security-audited). */
export type SchedSysctlKey =
  'sched.quantum.interactive' | 'sched.quantum.normal' | 'sched.quantum.background' | 'sched.tAge';

export const SCHED_SYSCTL_KEYS: readonly SchedSysctlKey[] = [
  'sched.quantum.interactive',
  'sched.quantum.normal',
  'sched.quantum.background',
  'sched.tAge',
];

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** §3.13: ORT threads of ai.embed (`hwc ≥ 8 ? 2 : 1`). */
export function ortThreads(hwc: number): number {
  return normaliseHwc(hwc) >= 8 ? 2 : 1;
}

/** `navigator.hardwareConcurrency` may be missing or nonsense; treat that as one core. */
export function normaliseHwc(hwc: number): number {
  return Number.isFinite(hwc) && hwc >= 1 ? Math.floor(hwc) : 1;
}

/** §3.13 KPS-05: RUN_TOKENS = clamp(hwc − 2 − (embedActive ? ortThreads : 0), 1, 6). */
export function runTokensFor(hwc: number, embedActive: boolean): number {
  const h = normaliseHwc(hwc);
  return clamp(h - 2 - (embedActive ? ortThreads(h) : 0), RUN_TOKENS_MIN, RUN_TOKENS_MAX);
}

/** §3.1 Q = max(QUANTUM_MS): the longest quantum, used in the bound. */
export function maxQuantumMs(quantumMs: Readonly<Record<Band, number>>): number {
  return Math.max(quantumMs.interactive, quantumMs.normal, quantumMs.background);
}

/** §3.1 HARD_LIMIT_MS = max(250, 10 × Q). With the default quanta this is 250 ms. */
export function hardLimitFor(quantumMs: Readonly<Record<Band, number>>): number {
  return Math.max(HARD_LIMIT_FLOOR_MS, 10 * maxQuantumMs(quantumMs));
}

/** §3.1 H_KILL_MS = HARD_LIMIT_MS + KILL_GRACE_MS + WATCHDOG_PERIOD_MS (400 ms by default). */
export function hKillMs(
  p: Pick<SchedParams, 'hardLimitMs' | 'killGraceMs' | 'watchdogPeriodMs'>,
): number {
  return p.hardLimitMs + p.killGraceMs + p.watchdogPeriodMs;
}

/** Default parameters for a machine with `hwc` logical cores (lab PC: hwc = 4 → 2 tokens). */
export function defaultSchedParams(hwc = 4, embedActive = false): SchedParams {
  return {
    quantumMs: QUANTUM_MS,
    tAgeMs: T_AGE_MS,
    deltaMs: DELTA_MS,
    hardLimitMs: hardLimitFor(QUANTUM_MS),
    killGraceMs: KILL_GRACE_MS,
    watchdogPeriodMs: WATCHDOG_PERIOD_MS,
    runTokens: runTokensFor(hwc, embedActive),
    maxExecutors: MAX_EXECUTORS,
    focusPriority: FOCUS_PRIORITY,
  };
}

export type SysctlResult =
  | { readonly ok: true; readonly params: SchedParams }
  | { readonly ok: false; readonly errno: 'EINVAL'; readonly reason: string };

/**
 * Apply one `sysctl.set` key (§4.5). Quanta must be integers in 2 … 50 ms and T_age an integer in
 * 50 … 1,000 ms; anything else is EINVAL. HARD_LIMIT_MS is recomputed from the new Q so H_kill
 * stays consistent with the bound (§3.1). A change applies from the next dispatch (§3.9.2).
 */
export function applySysctl(params: SchedParams, key: SchedSysctlKey, value: number): SysctlResult {
  if (!Number.isInteger(value)) return { ok: false, errno: 'EINVAL', reason: 'not-integer' };
  if (key === 'sched.tAge') {
    if (value < T_AGE_MIN_MS || value > T_AGE_MAX_MS) {
      return { ok: false, errno: 'EINVAL', reason: 'out-of-range' };
    }
    return { ok: true, params: { ...params, tAgeMs: value } };
  }
  if (value < QUANTUM_MIN_MS || value > QUANTUM_MAX_MS) {
    return { ok: false, errno: 'EINVAL', reason: 'out-of-range' };
  }
  const band: Band =
    key === 'sched.quantum.interactive'
      ? 'interactive'
      : key === 'sched.quantum.normal'
        ? 'normal'
        : 'background';
  const quantumMs = Object.freeze({ ...params.quantumMs, [band]: value });
  return { ok: true, params: { ...params, quantumMs, hardLimitMs: hardLimitFor(quantumMs) } };
}

// ---------------------------------------------------------------------------------------------
// §3.9 priorities and bands
// ---------------------------------------------------------------------------------------------

export function clampNice(nice: number): number {
  return clamp(Math.trunc(nice), NICE_LOW, NICE_HIGH);
}

export function clampPriority(priority: number): number {
  return clamp(Math.trunc(priority), PRIO_MIN, PRIO_MAX);
}

/** §3.9.1 / §3.18.1 PRI column: clamp(priority + nice, 0, 39). */
export function staticPri(priority: number, nice: number): number {
  return clamp(priority + nice, PRIO_MIN, PRIO_MAX);
}

/**
 * §3.9.1 `base`: clamp(priority + nice, 0, 39), lowered to min(base, FOCUS_PRIORITY) while
 * boosted, provided nice ≤ 0 (§3.9.3: an explicitly niced job is never boosted).
 */
export function computeBase(
  priority: number,
  nice: number,
  boosted: boolean,
  focusPriority = FOCUS_PRIORITY,
): number {
  const b = staticPri(priority, nice);
  return boosted && nice <= 0 ? Math.min(b, focusPriority) : b;
}

/** §3.9.1 band / cls from `base`. */
export function bandOf(base: number): Band {
  if (base <= INTERACTIVE_BASE_MAX) return 'interactive';
  if (base <= NORMAL_BASE_MAX) return 'normal';
  return 'background';
}

/** §3.18.1 CLS column abbreviation of a band. */
export function bandAbbrev(band: Band): 'int' | 'nor' | 'bkg' {
  return band === 'interactive' ? 'int' : band === 'normal' ? 'nor' : 'bkg';
}

/**
 * §3.9.1 / §3.12.1 aging rule: effPrio = max(0, base − ⌊(now − waitingSince) / T_age⌋).
 * Computed from the wait instead of counted, so a missed tick never loses a step.
 */
export function agedEffPrio(
  base: number,
  waitingSince: number,
  now: number,
  tAgeMs: number,
): number {
  const waited = Math.max(0, now - waitingSince);
  return Math.max(0, base - Math.floor(waited / tAgeMs));
}

/** §3.8: the ready key, exact below 2^53 for effPrio ≤ 39 and seq < 2^32. */
export function readyKey(effPrio: number, seq: number): number {
  return effPrio * SEQ_SPACE + seq;
}

/** Inverse of `readyKey` (diagnostics and tests). */
export function splitReadyKey(key: number): { effPrio: number; seq: number } {
  const effPrio = Math.floor(key / SEQ_SPACE);
  return { effPrio, seq: key - effPrio * SEQ_SPACE };
}
