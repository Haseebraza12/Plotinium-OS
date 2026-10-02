/**
 * PROC-04 aging and the declared bound (processes-and-scheduling.md §3.12, §8), on the virtual
 * clock with the real scheduler, timer heap, placement and watchdog.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  boundInputFromParams,
  declaredBoundMs,
  formatBound,
  predictedStarvationWaitMs,
} from './bound.ts';
import { agedEffPrio, maxQuantumMs } from './params.ts';
import type { SliceBehaviour } from './tests/sim.ts';
import { SimKernel } from './tests/sim.ts';

describe('PROC-04 starvation test (declared bound, E = 1)', () => {
  it('PROC-04 starvation: 50 priority-0 CPU jobs and 1 priority-39 job, the maximum wait is at most the declared 5450 ms', () => {
    const sim = new SimKernel({ hwc: 4, seed: 7 });
    const high = Array.from({ length: 50 }, (_, i) =>
      sim.spawn({ name: `burn${String(i)}`, priority: 0 }),
    );
    const low = sim.spawn({ name: 'burn-low', priority: 39 });
    const n = high.length + 1;
    expect(n).toBe(51);
    expect(sim.params.runTokens).toBe(2);

    sim.runUntil(60_000);

    const bound = declaredBoundMs(boundInputFromParams(sim.params, 39, n, 1));
    expect(bound).toBe(5450);
    const maxW = sim.maxWait(low.pid);
    const prediction = predictedStarvationWaitMs(boundInputFromParams(sim.params, 39, n, 1));
    // The test logs what §3.12.5 asks for: N, RUN_TOKENS, slice lengths, max W(P) and the margin.
    const L = maxQuantumMs(sim.params.quantumMs) + sim.params.deltaMs;
    const long = sim.sliceLog.filter((s) => s.end - s.start > L);
    console.info(
      `PROC-04 N=${String(n)} RUN_TOKENS=${String(sim.params.runTokens)} slices=${String(sim.sliceLog.length)} ` +
        `long=${String(long.length)} maxW=${maxW.toFixed(1)}ms predicted=${String(prediction.min)}..${String(prediction.max)}ms bound=${String(bound)}ms`,
    );
    expect(long.length).toBeLessThanOrEqual(1);
    expect(maxW).toBeGreaterThan(0);
    expect(maxW).toBeLessThanOrEqual(bound);
    // The low job is never starved: it is dispatched again and again during the minute.
    expect(sim.waitsOf(low.pid).length).toBeGreaterThanOrEqual(10);
    // §3.12.5 analysis: the measured maximum sits near 3.9-4.1 s.
    expect(maxW).toBeGreaterThanOrEqual(prediction.min);
    expect(maxW).toBeLessThanOrEqual(prediction.max + 100);
    for (const p of high) expect(sim.proc(p.pid).slices).toBeGreaterThan(0);
    sim.sched.checkInvariants();
    expect(sim.isolationViolations).toBe(0);
  });

  it('PROC-04 corollary: 5 priority-0 jobs and 1 priority-39 job, each on its own executor, wait at most 4000 + ceil(5/E) x 21 + 400 ms for the logged E', () => {
    const sim = new SimKernel({ hwc: 4, seed: 11 });
    for (let i = 0; i < 5; i++) sim.spawn({ priority: 0, exclusive: true });
    const low = sim.spawn({ priority: 39, exclusive: true });
    const executors = new Set([...sim.procs.values()].map((p) => p.worker));
    expect(executors.size).toBe(6);
    sim.runUntil(30_000);
    const e = sim.params.runTokens;
    const bound = declaredBoundMs(boundInputFromParams(sim.params, 39, 6, e));
    expect(e).toBe(2);
    expect(bound).toBe(4463);
    // Nothing is ever parked in this placement, so the starvation guard never engages.
    expect(sim.sched.stats().guardEngaged).toBe(0);
    expect(sim.maxWait(low.pid)).toBeLessThanOrEqual(bound);
  });

  it('PROC-04 sched bound prints the same value that the starvation test asserts', () => {
    const sim = new SimKernel({ hwc: 4 });
    const text = formatBound(boundInputFromParams(sim.params, 39, 51, 1));
    expect(text).toBe(
      'W <= (p+1)*T_age + ceil((N-1)/E)*(Q+delta) + H_kill\n' +
        '   = 40*100 + ceil(50/1)*(20+1) + 400 = 5450 ms   (E = 1: general placement)',
    );
    const corollary = formatBound(boundInputFromParams(sim.params, 39, 6, 2), true);
    expect(corollary).toContain('= 4463 ms');
    expect(corollary).toContain('every runnable process on its own executor');
  });
});

describe('PROC-04 aging (unit)', () => {
  it('PROC-04 aging lowers effPrio by one level per T_age of waiting, never below 0, and dispatch resets it to base', () => {
    expect(agedEffPrio(39, 0, 0, 100)).toBe(39);
    expect(agedEffPrio(39, 0, 99, 100)).toBe(39);
    expect(agedEffPrio(39, 0, 100, 100)).toBe(38);
    expect(agedEffPrio(39, 0, 3_900, 100)).toBe(0);
    expect(agedEffPrio(39, 0, 99_000, 100)).toBe(0);
    expect(agedEffPrio(5, 100, 50, 100)).toBe(5); // a clock that runs backwards never raises priority

    // In the scheduler: two priority-0 jobs share the only token; P (base 30) waits and ages.
    const sim = new SimKernel({ hwc: 3, watchdog: false }); // RUN_TOKENS = 1
    sim.spawn({ priority: 0 });
    sim.spawn({ priority: 0 });
    const p = sim.spawn({ priority: 30 });
    expect(p.state).toBe('READY');
    const seen: number[] = [];
    for (let t = 100; t <= 500; t += 100) {
      sim.runUntil(t + 0.05);
      expect(p.state).toBe('READY');
      seen.push(p.effPrio);
    }
    // One level per T_age of waiting (INV-P5), computed from the wait.
    expect(seen).toEqual([29, 28, 27, 26, 25]);
    // P reaches level 0 after 30 ticks at the latest and is then dispatched; dispatch resets
    // effPrio to base.
    let sawRunning = false;
    for (let t = 500; t <= 4_000 && !sawRunning; t += 0.5) {
      sim.runUntil(t);
      if (p.state === 'RUNNING') {
        sawRunning = true;
        expect(p.effPrio).toBe(p.base);
      } else {
        expect(p.effPrio).toBeGreaterThanOrEqual(0);
      }
    }
    expect(sawRunning).toBe(true);
    expect(sim.maxWait(p.pid)).toBeLessThanOrEqual(3_100 + 21);
  });

  it('PROC-04 a parked process keeps its seq and is dispatched before later arrivals on its executor', () => {
    // One executor, two tokens: the co-residents of the running slice are parked, not dispatched.
    const sim = new SimKernel({ hwc: 4, maxExecutors: 1, watchdog: false });
    const a = sim.spawn({ priority: 20 });
    const b = sim.spawn({ priority: 20 });
    expect(a.state).toBe('RUNNING');
    expect(b.state).toBe('READY');
    expect(sim.sched.parkedOn(0)).toEqual([b.pid]);
    const seqB = b.seq;
    sim.runUntil(5); // a is mid-slice; a later arrival joins
    const c = sim.spawn({ priority: 20 });
    expect(b.seq).toBe(seqB);
    expect(c.seq).toBeGreaterThan(seqB);
    sim.runUntil(40);
    const order = sim.dispatchOrder();
    expect(order.indexOf(b.pid)).toBeLessThan(order.indexOf(c.pid));
  });

  it('PROC-04 starvation guard: while a parked process has effPrio 0 no token is granted to a larger key and its executor is asked to yield', () => {
    // Executor 0: v (normal band) running, m (priority 0) parked behind it.
    // Executor 1: x (priority 5) READY with an idle executor and a free token, but a larger key.
    const sim = new SimKernel({
      hwc: 4,
      watchdog: false,
      desktopInteractive: false,
      maxExecutors: 2,
    });
    const v = sim.spawn({ priority: 20, name: 'v' });
    const m = sim.spawn({ priority: 0, name: 'm' });
    expect(v.worker).toBe(m.worker);
    expect(sim.sched.parkedOn(v.worker ?? -1)).toContain(m.pid);
    // The guard fired at once: m is parked at effPrio 0, so v's executor was asked to yield.
    expect(v.preemptRequested).toBe(true);
    // A process of a different key lands on another executor; its key is larger than m's.
    const x = sim.spawn({ priority: 5, uid: 2000, name: 'x' });
    expect(x.worker).not.toBe(v.worker);
    expect(sim.sched.guardKey()).toBeLessThan(Number.POSITIVE_INFINITY);
    expect(x.state).toBe('READY'); // a token is free, x's executor is idle, yet x waits
    expect(sim.sched.tokens.free).toBe(1);
    expect(sim.sched.stats().guardEngaged).toBeGreaterThan(0);
    // v yields at its next yield point; m runs first, then x.
    sim.runUntil(20);
    const order = sim.dispatchOrder();
    expect(order.indexOf(m.pid)).toBeLessThan(order.indexOf(x.pid));
    sim.sched.checkInvariants();
  });
});

describe('PROC-04 property', () => {
  it('PROC-04 simulated random workloads with affinity and the starvation guard never exceed the E = 1 bound (fast-check, virtual clock)', () => {
    const job = fc.record({
      priority: fc.integer({ min: 0, max: 39 }),
      uid: fc.constantFrom(1000, 1001),
      blockEvery: fc.integer({ min: 0, max: 4 }),
      sleepMs: fc.integer({ min: 1, max: 300 }),
      burstMs: fc.double({ min: 0.1, max: 30, noNaN: true }),
    });
    fc.assert(
      fc.property(
        fc.array(job, { minLength: 2, maxLength: 12 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 3, max: 8 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (jobs, maxExecutors, hwc, seed) => {
          const sim = new SimKernel({ hwc, maxExecutors, seed, watchdog: false });
          for (const j of jobs) {
            const program = (_p: unknown, slice: number): SliceBehaviour =>
              j.blockEvery > 0 && slice % j.blockEvery === 0
                ? { kind: 'block', afterMs: j.burstMs, sleepMs: j.sleepMs }
                : { kind: 'cpu' };
            // Different uids need their own executors: skip jobs that cannot be placed.
            try {
              sim.spawn({ priority: j.priority, uid: j.uid, program });
            } catch {
              return;
            }
          }
          sim.runUntil(8_000);
          sim.sched.checkInvariants();
          const n = sim.procs.size;
          for (const p of sim.procs.values()) {
            const bound = declaredBoundMs(boundInputFromParams(sim.params, p.base, n, 1));
            const w = sim.maxWait(p.pid);
            if (w > bound)
              throw new Error(
                `pid ${String(p.pid)} base ${String(p.base)} waited ${String(w)} > ${String(bound)}`,
              );
          }
          expect(sim.isolationViolations).toBe(0);
        },
      ),
      { numRuns: 40, seed: 20260925 },
    );
  });
});
