/**
 * Scheduler constants and helpers (§3.1, §3.9, §3.13): bands, quanta, base, run tokens, sections,
 * tokens and the bound calculator's input checks.
 */
import { describe, expect, it } from 'vitest';

import { boundTerms, declaredBoundMs, predictedStarvationWaitMs } from './bound.ts';
import type { BoundInput } from './bound.ts';
import {
  bandAbbrev,
  bandOf,
  clampNice,
  clampPriority,
  computeBase,
  defaultSchedParams,
  hardLimitFor,
  hKillMs,
  maxQuantumMs,
  ortThreads,
  QUANTUM_MS,
  SCHED_SYSCTL_KEYS,
  staticPri,
} from './params.ts';
import { KERNEL_TASK_BUDGET_MS, NonPreemptiveSections } from './sections.ts';
import { currentRunTokens, EmbedActivity, RunTokens } from './tokens.ts';

describe('PROC-03 bands and quanta', () => {
  it('PROC-03 bands follow base: interactive 0-9, normal 10-29, background 30-39, with 5/10/20 ms quanta', () => {
    expect([0, 9, 10, 29, 30, 39].map(bandOf)).toEqual([
      'interactive',
      'interactive',
      'normal',
      'normal',
      'background',
      'background',
    ]);
    expect(QUANTUM_MS).toEqual({ interactive: 5, normal: 10, background: 20 });
    expect(maxQuantumMs(QUANTUM_MS)).toBe(20);
    expect(bandAbbrev('interactive')).toBe('int');
    expect(bandAbbrev('normal')).toBe('nor');
    expect(bandAbbrev('background')).toBe('bkg');
  });

  it('PROC-08 PRI is clamp(priority + nice, 0, 39): the indexer (22, nice 10) shows PRI 32', () => {
    expect(staticPri(22, 10)).toBe(32);
    expect(staticPri(35, 19)).toBe(39);
    expect(staticPri(0, -20)).toBe(0);
    expect(clampNice(-40)).toBe(-20);
    expect(clampNice(25.7)).toBe(19);
    expect(clampPriority(-1)).toBe(0);
    expect(clampPriority(99)).toBe(39);
  });

  it('KPS-12 the focus boost lowers base to FOCUS_PRIORITY unless the process is niced', () => {
    expect(computeBase(20, 0, true)).toBe(5);
    expect(computeBase(3, 0, true)).toBe(3);
    expect(computeBase(20, -5, true)).toBe(5);
    expect(computeBase(20, 1, true)).toBe(21);
    expect(computeBase(20, 0, false)).toBe(20);
  });

  it('KPS-08 HARD_LIMIT = max(250, 10 × Q) and H_kill = HARD_LIMIT + KILL_GRACE + WATCHDOG_PERIOD', () => {
    const p = defaultSchedParams(4);
    expect(p.hardLimitMs).toBe(250);
    expect(hKillMs(p)).toBe(400);
    expect(hardLimitFor({ interactive: 5, normal: 10, background: 40 })).toBe(400);
    expect(SCHED_SYSCTL_KEYS).toContain('sched.tAge');
  });
});

describe('KPS-05 run tokens', () => {
  it('KPS-05 the semaphore never hands out more than RUN_TOKENS and never pre-empts on a drop', () => {
    const t = new RunTokens(2);
    expect(t.tryAcquire()).toBe(true);
    expect(t.tryAcquire()).toBe(true);
    expect(t.tryAcquire()).toBe(false);
    t.setCapacity(1);
    expect(t.held).toBe(2);
    expect(t.free).toBe(0);
    t.release();
    expect(t.free).toBe(0);
    t.release();
    expect(t.free).toBe(1);
    expect(() => t.release()).toThrow(/twice/);
    expect(() => new RunTokens(0)).toThrow(RangeError);
    expect(() => t.setCapacity(1.5)).toThrow(RangeError);
    expect(t.capacity).toBe(1);
  });

  it('KPS-05 embedActive holds while ai.embed is resident and ran a job in the last 2 s', () => {
    const e = new EmbedActivity();
    expect(e.isActive(0)).toBe(false);
    e.jobRan(100);
    expect(e.isActive(100)).toBe(false); // not resident
    e.setResident(true);
    expect(e.isActive(100)).toBe(true);
    expect(e.nextChangeAt(500)).toBe(2_100);
    expect(currentRunTokens(4, e, 500)).toBe(1);
    expect(currentRunTokens(8, e, 500)).toBe(4);
    expect(e.isActive(2_100)).toBe(false);
    expect(e.nextChangeAt(2_100)).toBeNull();
    expect(currentRunTokens(4, e, 2_100)).toBe(2);
    expect(ortThreads(8)).toBe(2);
    expect(ortThreads(4)).toBe(1);
  });
});

describe('PROC-07 non-pre-emptive sections', () => {
  it('PROC-07 a section runs to completion, pins its process and discards the reply after a kill', () => {
    const s = new NonPreemptiveSections();
    s.begin(7, 'io:txn-1', 10);
    expect(() => s.begin(7, 'io:txn-2', 10)).toThrow(/already/);
    expect(s.isOpen(7)).toBe(true);
    expect(s.canSuspend(7)).toBe(false);
    expect(s.info(7)).toEqual({ pid: 7, label: 'io:txn-1', startedAt: 10, killRequested: false });
    expect(s.onKill(8)).toBe('none');
    expect(s.onKill(7)).toBe('in-section');
    const end = s.end(7, 10 + KERNEL_TASK_BUDGET_MS + 1);
    expect(end).toEqual({ discardReply: true, durationMs: 5, overBudget: true });
    expect(s.canSuspend(7)).toBe(true);
    expect(s.info(7)).toBeUndefined();
    expect(() => s.end(7, 20)).toThrow(/no open/);
    s.begin(8, 'io:txn-3', 0);
    expect(s.end(8, 1)).toEqual({ discardReply: false, durationMs: 1, overBudget: false });
    expect(s.stats()).toEqual({ open: 0, completed: 2, overBudget: 1 });
  });
});

describe('PROC-04 bound calculator', () => {
  const base: BoundInput = { p: 39, n: 51, e: 1, tAgeMs: 100, qMs: 20, deltaMs: 1, hKillMs: 400 };

  it('PROC-04 the declared values of §3.12.5 and §3.12.6', () => {
    expect(declaredBoundMs(base)).toBe(5450);
    expect(boundTerms(base)).toEqual({
      agingMs: 4000,
      rounds: 50,
      slicesMs: 1050,
      hKillMs: 400,
      totalMs: 5450,
    });
    const cor = { ...base, n: 6 };
    expect([1, 2, 3, 4, 5, 6].map((e) => declaredBoundMs({ ...cor, e }))).toEqual([
      4505, 4463, 4442, 4442, 4421, 4421,
    ]);
    expect(declaredBoundMs({ ...base, tAgeMs: 50 })).toBe(3450);
    expect(declaredBoundMs({ ...base, tAgeMs: 250 })).toBe(11450);
    expect(declaredBoundMs({ ...cor, e: 2, tAgeMs: 50 })).toBe(2463);
    expect(declaredBoundMs({ ...cor, e: 2, tAgeMs: 250 })).toBe(10463);
    expect(declaredBoundMs({ ...base, n: 1 })).toBe(4400);
    expect(predictedStarvationWaitMs(base)).toEqual({ min: 3900, max: 4021 });
  });

  it('PROC-04 the calculator rejects inputs outside the theorem', () => {
    expect(() => declaredBoundMs({ ...base, p: 40 })).toThrow(RangeError);
    expect(() => declaredBoundMs({ ...base, p: 1.5 })).toThrow(RangeError);
    expect(() => declaredBoundMs({ ...base, n: 0 })).toThrow(RangeError);
    expect(() => declaredBoundMs({ ...base, e: 0 })).toThrow(RangeError);
    expect(() => declaredBoundMs({ ...base, tAgeMs: -1 })).toThrow(RangeError);
    expect(() => declaredBoundMs({ ...base, hKillMs: Number.NaN })).toThrow(RangeError);
  });
});
