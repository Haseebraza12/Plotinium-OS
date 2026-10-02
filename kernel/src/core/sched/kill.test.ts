/**
 * PROC-07: the kill path hooks, in order, and the scheduler-side leak check (INV-P7).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { exitCodeFor } from './kill.ts';
import { SimKernel } from './tests/sim.ts';
import type { SimProc } from './tests/sim.ts';

const STEPS_5_TO_11 = [
  'closeFds',
  'releaseLocks',
  'reparentChildren',
  'closeWindows',
  'freeMemory',
  'zombie',
  'log',
];

function stepsOf(sim: SimKernel, pid: number): string[] {
  return sim.hookCalls
    .filter((c) => c.split(':')[1]?.split('@')[0] === String(pid))
    .map((c) => c.split(':')[0] ?? '');
}

/** INV-P7 for the structures kernel/core/sched owns. */
function expectNoTrace(sim: SimKernel, p: SimProc): void {
  expect(sim.sched.isQueued(p.pid)).toBeNull();
  expect(sim.sched.runningOn(p.pid)).toBeNull();
  expect(sim.timers.timersOf(p.pid)).toEqual([]);
  expect(sim.pool.homeOf(p.pid)).toBeNull();
  for (const s of sim.pool.slots()) expect(s.residents.has(p.pid)).toBe(false);
  expect(p.worker).toBeNull();
  expect(sim.sched.tokens.held).toBe(sim.sched.runningCount);
  sim.sched.checkInvariants();
}

describe('PROC-07 kill path', () => {
  it('PROC-07 kill -9 of a READY process runs steps 1-11 in order and frees its executor slot', () => {
    const sim = new SimKernel({ hwc: 3, desktopInteractive: false, watchdog: false }); // one token
    const a = sim.spawn();
    const b = sim.spawn();
    expect(b.state).toBe('READY');
    expect(sim.killPath.begin(b, 'signal:9', a.pid, 1)).toBe('done');
    expect(stepsOf(sim, b.pid)).toEqual([
      'audit',
      'leaveWaitQueues',
      'cancelPendingCall',
      'dropResident',
      ...STEPS_5_TO_11,
    ]);
    expect(sim.hookCalls).toContain(`audit:${String(b.pid)}:signal:9:${String(a.pid)}`);
    expect(sim.killLog.at(-1)).toEqual({
      pid: b.pid,
      from: 'READY',
      to: 'TERMINATED',
      reason: 'signal:9',
      by: a.pid,
      exitCode: 137,
      exitReason: 'signal',
    });
    expectNoTrace(sim, b);
    // A zombie target: success, no effect.
    expect(sim.killPath.begin(b, 'signal:9', a.pid, 2)).toBe('already');
  });

  it('PROC-07 kill of a RUNNING process sets PREEMPT = 2 and finishes when the killed frame arrives', () => {
    const sim = new SimKernel({ hwc: 3, desktopInteractive: false, watchdog: false });
    const a = sim.spawn({ name: 'victim' });
    const b = sim.spawn({ name: 'next' });
    expect(a.state).toBe('RUNNING');
    sim.runUntil(2);
    expect(sim.killPath.begin(a, 'signal:15', 0, sim.now)).toBe('pending');
    expect(sim.killPath.isPending(a.pid)).toBe(true);
    expect(sim.preempts.at(-1)).toMatchObject({ level: 2 });
    expect(stepsOf(sim, a.pid)).toEqual(['audit', 'leaveWaitQueues', 'cancelPendingCall']);
    expect(sim.killPath.begin(a, 'signal:9', 0, sim.now)).toBe('pending');
    sim.runUntil(3); // the executor honours PREEMPT = 2 at its next yield point
    expect(sim.killPath.isPending(a.pid)).toBe(false);
    expect(stepsOf(sim, a.pid).slice(3)).toEqual(['dropResident', ...STEPS_5_TO_11]);
    expect(sim.killLog.find((r) => r.pid === a.pid)).toMatchObject({
      from: 'RUNNING',
      exitCode: 143,
    });
    expect(b.state).toBe('RUNNING'); // the token went to the next process
    expectNoTrace(sim, a);
  });

  it('PROC-07 a RUNNING target that ignores PREEMPT = 2 loses its executor after KILL_GRACE and co-residents are handled', () => {
    const sim = new SimKernel({ hwc: 3, desktopInteractive: false });
    const a = sim.spawn({ name: 'stuck', program: () => ({ kind: 'runaway' }) });
    const co = sim.spawn({
      name: 'co',
      checkpointable: false,
      program: () => ({ kind: 'block', afterMs: 1, sleepMs: 100_000 }),
    });
    expect(a.worker).toBe(co.worker);
    sim.runUntil(10);
    expect(sim.killPath.begin(a, 'signal:9', 0, sim.now)).toBe('pending');
    sim.runUntil(10 + 100 + 50);
    expect(a.state).toBe('TERMINATED');
    expect(sim.killLog.find((r) => r.pid === a.pid)).toMatchObject({
      reason: 'signal:9',
      exitCode: 137,
    });
    expect(sim.killLog.find((r) => r.pid === co.pid)).toMatchObject({
      reason: 'collateral',
      exitCode: 137,
    });
    expect(sim.watchdogActions.at(-1)).toMatchObject({ kind: 'terminate', cause: 'kill-grace' });
    expectNoTrace(sim, a);
    expectNoTrace(sim, co);
  });

  it('PROC-07 kill of a BLOCKED process cancels its timers; kill of a SUSPENDED one needs no executor', () => {
    const sim = new SimKernel({ hwc: 3, desktopInteractive: false, watchdog: false });
    const sleeper = sim.spawn({ program: () => ({ kind: 'block', afterMs: 1, sleepMs: 10_000 }) });
    sim.runUntil(5);
    expect(sleeper.state).toBe('BLOCKED');
    expect(sim.timers.timersOf(sleeper.pid)).toHaveLength(1);
    expect(sim.killPath.begin(sleeper, 'signal:2', 0, sim.now)).toBe('done');
    expect(sim.killLog.at(-1)).toMatchObject({ from: 'BLOCKED', exitCode: 130 });
    expectNoTrace(sim, sleeper);

    const paged = sim.spawn({ program: () => ({ kind: 'block', afterMs: 1, sleepMs: 10_000 }) });
    sim.runUntil(10);
    sim.pool.evict(paged, sim.now);
    paged.state = 'SUSPENDED';
    const before = sim.hookCalls.length;
    expect(sim.killPath.begin(paged, 'signal:9', 0, sim.now)).toBe('done');
    const calls = sim.hookCalls.slice(before).map((c) => c.split(':')[0]);
    expect(calls).not.toContain('dropResident'); // never paged in to be killed
    expect(calls).toContain('freeMemory');
    expectNoTrace(sim, paged);
  });

  it('PROC-07 kill during an X-call commit leaves the section to finish whole and discards its reply', () => {
    const sim = new SimKernel({ hwc: 3, desktopInteractive: false, watchdog: false });
    const p = sim.spawn({ program: () => ({ kind: 'block', afterMs: 1, sleepMs: 10_000 }) });
    sim.runUntil(5);
    sim.sections.begin(p.pid, 'io:txn-7', sim.now);
    expect(sim.sections.canSuspend(p.pid)).toBe(false);
    expect(sim.killPath.begin(p, 'signal:9', 0, sim.now)).toBe('done');
    expect(stepsOf(sim, p.pid)).not.toContain('cancelPendingCall');
    const end = sim.sections.end(p.pid, sim.now + 3);
    expect(end.discardReply).toBe(true);
  });

  it('PROC-07 killing random processes never leaks timers, run tokens, heap or parked entries or residency', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            prio: fc.integer({ min: 0, max: 39 }),
            blocky: fc.boolean(),
            uid: fc.constantFrom(1000, 1001),
          }),
          {
            minLength: 2,
            maxLength: 10,
          },
        ),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 1, max: 400 })), {
          minLength: 1,
          maxLength: 8,
        }),
        (jobs, kills) => {
          const sim = new SimKernel({ hwc: 4, maxExecutors: 4, watchdog: true });
          const ps = jobs.map((j) =>
            sim.spawn({
              priority: j.prio,
              uid: j.uid,
              program: j.blocky
                ? (_p, n) =>
                    n % 2 === 0 ? { kind: 'block', afterMs: 2, sleepMs: 30 } : { kind: 'cpu' }
                : undefined,
            }),
          );
          for (const [pick, dt] of kills) {
            sim.runUntil(sim.now + dt);
            const p = ps[pick % ps.length];
            if (p !== undefined) sim.killPath.begin(p, 'signal:9', 0, sim.now);
          }
          sim.runUntil(sim.now + 500); // pending kills finish at the next yield point
          for (const p of ps) if (p.state === 'TERMINATED') expectNoTrace(sim, p);
          sim.sched.checkInvariants();
        },
      ),
      { numRuns: 40, seed: 7 },
    );
  });

  it('PROC-07 exit status is 128 + n for signals and 137 for watchdog and collateral', () => {
    expect(exitCodeFor('signal:15')).toBe(143);
    expect(exitCodeFor('signal:2')).toBe(130);
    expect(exitCodeFor('watchdog')).toBe(137);
    expect(exitCodeFor('collateral')).toBe(137);
  });
});
