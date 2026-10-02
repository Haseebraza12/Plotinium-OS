/**
 * The declared PROC-04 bound (specs/03-kernel/processes-and-scheduling.md §3.12.4, §3.12.5,
 * §3.18.8; C13).
 *
 *   W(P) ≤ (p + 1) · T_age + ⌈(N − 1) / E⌉ · (Q + δ) + H_kill
 *
 * E = 1 for any placement (the declared bound); E = RUN_TOKENS (the minimum during W(P)) only when
 * every runnable process is the only runnable resident of its executor (the corollary). The
 * starvation tests assert exactly the value this module computes, and `sched bound` prints it with
 * `formatBound`, so the examiner can check the number live (P3 gate step 7).
 */
import { hKillMs, maxQuantumMs, PRIO_MAX, PRIO_MIN } from './params.ts';
import type { SchedParams } from './params.ts';

export interface BoundInput {
  /** P's base priority, 0 … 39. */
  readonly p: number;
  /** Maximum number of runnable user processes during W(P), P included (≥ 1). */
  readonly n: number;
  /** Parallelism: 1 for the declared bound, the measured RUN_TOKENS for the corollary. */
  readonly e: number;
  readonly tAgeMs: number;
  /** Q: the longest quantum. */
  readonly qMs: number;
  readonly deltaMs: number;
  readonly hKillMs: number;
}

export interface BoundTerms {
  /** (p + 1) · T_age: the aging phase (Lemma 1). */
  readonly agingMs: number;
  /** ⌈(N − 1)/E⌉: predecessor slices per token. */
  readonly rounds: number;
  /** ⌈(N − 1)/E⌉ · (Q + δ) (Lemma 3 / corollary). */
  readonly slicesMs: number;
  readonly hKillMs: number;
  readonly totalMs: number;
}

function checkInput(i: BoundInput): void {
  if (!Number.isInteger(i.p) || i.p < PRIO_MIN || i.p > PRIO_MAX)
    throw new RangeError('p must be an integer in 0..39');
  if (!Number.isInteger(i.n) || i.n < 1) throw new RangeError('N must be an integer ≥ 1');
  if (!Number.isInteger(i.e) || i.e < 1) throw new RangeError('E must be an integer ≥ 1');
  for (const [name, v] of [
    ['T_age', i.tAgeMs],
    ['Q', i.qMs],
    ['delta', i.deltaMs],
    ['H_kill', i.hKillMs],
  ] as const) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`${name} must be a finite number ≥ 0`);
  }
}

/** The terms of §3.12.4 for one input. */
export function boundTerms(i: BoundInput): BoundTerms {
  checkInput(i);
  const agingMs = (i.p + 1) * i.tAgeMs;
  const rounds = Math.ceil((i.n - 1) / i.e);
  const slicesMs = rounds * (i.qMs + i.deltaMs);
  return { agingMs, rounds, slicesMs, hKillMs: i.hKillMs, totalMs: agingMs + slicesMs + i.hKillMs };
}

/** W(P) ≤ (p + 1)·T_age + ⌈(N − 1)/E⌉·(Q + δ) + H_kill, in ms. */
export function declaredBoundMs(i: BoundInput): number {
  return boundTerms(i).totalMs;
}

/** Fill T_age, Q, δ and H_kill from live parameters (what `sched bound` uses). */
export function boundInputFromParams(params: SchedParams, p: number, n: number, e = 1): BoundInput {
  return {
    p,
    n,
    e,
    tAgeMs: params.tAgeMs,
    qMs: maxQuantumMs(params.quantumMs),
    deltaMs: params.deltaMs,
    hKillMs: hKillMs(params),
  };
}

/**
 * The text `sched bound --p P --n N [--exclusive]` prints (§3.18.8):
 *
 *   W <= (p+1)*T_age + ceil((N-1)/E)*(Q+delta) + H_kill
 *      = 40*100 + ceil(50/1)*(20+1) + 400 = 5450 ms   (E = 1: general placement)
 */
export function formatBound(i: BoundInput, exclusive = false): string {
  const t = boundTerms(i);
  const fmt = (x: number): string => String(Math.round(x * 1000) / 1000);
  const note = exclusive
    ? `(E = ${String(i.e)}: every runnable process on its own executor)`
    : `(E = ${String(i.e)}: general placement)`;
  return [
    'W <= (p+1)*T_age + ceil((N-1)/E)*(Q+delta) + H_kill',
    `   = ${String(i.p + 1)}*${fmt(i.tAgeMs)} + ceil(${String(i.n - 1)}/${String(i.e)})*(${fmt(i.qMs)}+${fmt(i.deltaMs)}) + ${fmt(i.hKillMs)} = ${fmt(t.totalMs)} ms   ${note}`,
  ].join('\n');
}

/**
 * The §3.12.5 analysis: after P reaches level 0 the set A of earlier arrivals is empty (every
 * higher-priority job has re-queued with a fresh seq), so P waits about p·T_age plus one tick
 * phase plus the remaining slice of its executor. Printed next to the bound; the gap is the margin.
 */
export function predictedStarvationWaitMs(i: BoundInput): { min: number; max: number } {
  checkInput(i);
  return { min: i.p * i.tAgeMs, max: (i.p + 1) * i.tAgeMs + i.qMs + i.deltaMs };
}
