/**
 * KPS-05, KPS-06 and PROC-05: executor pool, isolation versus concurrency, placement rules.
 */
import { describe, expect, it } from 'vitest';

import { bandOf, computeBase, runTokensFor } from './params.ts';
import { ExecutorPool } from './placement.ts';
import type { PlacementRequest } from './placement.ts';
import type { SchedulableProcess } from './types.ts';
import { SimKernel } from './tests/sim.ts';

function proc(
  pid: number,
  isolation: string,
  over: Partial<SchedulableProcess> = {},
): SchedulableProcess {
  const base = computeBase(20, 0, false);
  return {
    pid,
    isolation,
    state: 'READY',
    priority: 20,
    nice: 0,
    base,
    effPrio: base,
    band: bandOf(base),
    boosted: false,
    preemptRequested: false,
    seq: 0,
    cpuTimeMs: 0,
    lastRunAt: 0,
    waitingSince: 0,
    sliceStartedAt: 0,
    slices: 0,
    overruns: 0,
    maxStepUs: 0,
    worker: null,
    exclusive: false,
    checkpointable: true,
    ...over,
  };
}

function world(maxExecutors = 8): { pool: ExecutorPool; procs: Map<number, SchedulableProcess> } {
  const procs = new Map<number, SchedulableProcess>();
  const pool = new ExecutorPool({
    maxExecutors,
    isRunnable: (pid) => {
      const s = procs.get(pid)?.state;
      return s === 'READY' || s === 'RUNNING';
    },
  });
  return { pool, procs };
}

function place(
  w: ReturnType<typeof world>,
  p: SchedulableProcess,
  now = 0,
  interactive = true,
): number | null {
  w.procs.set(p.pid, p);
  const d = w.pool.placeProcess(p, now, interactive);
  if (w.pool.needsSpare(interactive)) w.pool.spawnSpare(now);
  return d.kind === 'fail' ? null : p.worker;
}

describe('PROC-05 isolation versus concurrency with hardwareConcurrency forced to 4', () => {
  it('PROC-05 with hardwareConcurrency forced to 4 at most RUN_TOKENS slices run at once and isolation keys never share an executor', () => {
    const sim = new SimKernel({ hwc: 4, seed: 3 });
    expect(sim.params.runTokens).toBe(2);
    const keys = [
      { uid: 1000, cls: 'user' as const },
      { uid: 0, cls: 'user' as const },
      { uid: 1000, cls: 'agent' as const },
      { uid: 1000, cls: 'system' as const },
    ];
    for (let i = 0; i < 12; i++) {
      const k = keys[i % keys.length];
      if (k === undefined) continue;
      sim.spawn({
        uid: k.uid,
        cls: k.cls,
        priority: 5 + i,
        program: (_p, n) =>
          n % 3 === 0 ? { kind: 'block', afterMs: 2, sleepMs: 15 } : { kind: 'cpu' },
      });
    }
    sim.runUntil(3_000);
    expect(sim.maxConcurrent).toBeLessThanOrEqual(2);
    expect(sim.maxConcurrent).toBe(2);
    expect(sim.isolationViolations).toBe(0);
    for (const s of sim.pool.slots()) {
      const ks = new Set([...s.residents].map((pid) => sim.proc(pid).isolation));
      expect(ks.size).toBeLessThanOrEqual(1);
      if (ks.size === 1) expect([...ks][0]).toBe(s.isolation);
    }
    sim.sched.checkInvariants();
  });

  it("PROC-05 with hardwareConcurrency forced to 4 and ai.embed active, RUN_TOKENS is 1 and a root shell, alice's shell and ai.agent all get executors", () => {
    expect(runTokensFor(4, true)).toBe(1);
    const sim = new SimKernel({
      hwc: 4,
      params: { runTokens: runTokensFor(4, true) },
      desktopInteractive: false,
    });
    const alice = sim.spawn({ uid: 1000, cls: 'user', name: 'sh' });
    const root = sim.spawn({ uid: 0, cls: 'user', name: 'sh' });
    const agent = sim.spawn({ uid: 1000, cls: 'agent', name: 'ai.agent' });
    const homes = [alice.worker, root.worker, agent.worker];
    expect(homes.every((h) => h !== null)).toBe(true);
    expect(new Set(homes).size).toBe(3);
    sim.runUntil(500);
    expect(sim.maxConcurrent).toBe(1);
    for (const p of [alice, root, agent]) expect(sim.proc(p.pid).slices).toBeGreaterThan(0);
  });

  it('KPS-05 RUN_TOKENS = clamp(hwc − 2 − embed, 1, 6)', () => {
    expect(runTokensFor(4, false)).toBe(2);
    expect(runTokensFor(2, false)).toBe(1);
    expect(runTokensFor(16, false)).toBe(6);
    expect(runTokensFor(8, true)).toBe(4);
    expect(runTokensFor(Number.NaN, false)).toBe(1);
  });
});

describe('KPS-06 placement rules', () => {
  it('KPS-06 an empty executor bound to one isolation key is never re-bound to another', () => {
    const w = world(2);
    w.pool.startFirst(0);
    const a = proc(1, '1000:user');
    expect(place(w, a)).toBe(0);
    expect(() => w.pool.bind(0, '2000:user')).toThrow(/never re-bound/);
    w.pool.bind(0, '1000:user'); // same key: no-op
    w.pool.evict(a, 5);
    expect(w.pool.slot(0).residents.size).toBe(0);
    expect(w.pool.slot(0).isolation).toBe('1000:user');
    // Another key gets the spare; once the pool is full an empty executor of another key is
    // recycled: terminated and replaced by a fresh worker, never re-bound.
    const b = proc(2, '2000:user');
    expect(place(w, b)).toBe(1);
    const gen = w.pool.slot(0).generation;
    const c = proc(3, '3000:user');
    const d = w.pool.decide({ pid: 3, isolation: '3000:user', exclusive: false }, true);
    expect(d).toEqual({ kind: 'recycle', index: 0, evicted: '1000:user' });
    expect(place(w, c)).toBe(0);
    expect(w.pool.slot(0).generation).toBe(gen + 1);
    expect(w.pool.slot(0).terminations).toBe(1);
    expect(w.pool.slot(0).isolation).toBe('3000:user');
    // Nothing empty left: EAGAIN executors-exhausted (syscall-abi.md §4.3.1).
    expect(w.pool.decide({ pid: 4, isolation: '4000:user', exclusive: false }, true)).toEqual({
      kind: 'fail',
      errno: 'EAGAIN',
      reason: 'executors-exhausted',
    });
    expect(place(w, proc(4, '4000:user'))).toBeNull();
  });

  it('KPS-06 least loaded, then fewest residents, then lowest index; grow only after desktop-interactive', () => {
    const w = world(4);
    w.pool.startFirst(0);
    const a = proc(1, 'k');
    expect(place(w, a, 0, false)).toBe(0);
    // Before desktop-interactive: no grow, the second process shares executor 0.
    const b = proc(2, 'k');
    expect(place(w, b, 0, false)).toBe(0);
    expect(w.pool.alive).toBe(1);
    // After: the chosen executor has a runnable resident, so a new one is started.
    const c = proc(3, 'k');
    expect(place(w, c, 1, true)).toBe(1);
    expect(w.pool.spareIndex).toBe(2);
    // Sleepers do not count as load (rule 7): executor 1 holds only a BLOCKED process.
    c.state = 'BLOCKED';
    const decision = w.pool.decide({ pid: 4, isolation: 'k', exclusive: false }, false);
    expect(decision).toEqual({ kind: 'existing', index: 1 });
    // A different key binds the spare, even before desktop-interactive.
    expect(w.pool.decide({ pid: 5, isolation: 'other', exclusive: false }, false)).toEqual({
      kind: 'bind-spare',
      index: 2,
    });
    expect(w.pool.info(() => null).map((x) => x.isolation)).toEqual(['k', 'k', 'spare']);
  });

  it('KPS-06 a new isolation key before desktop-interactive spawns an executor anyway', () => {
    const w = world(3);
    w.pool.startFirst(0);
    place(w, proc(1, 'a'), 0, false);
    expect(w.pool.decide({ pid: 2, isolation: 'b', exclusive: false }, false)).toEqual({
      kind: 'spawn',
      index: 1,
    });
    expect(place(w, proc(2, 'b'), 0, false)).toBe(1);
  });

  it('KPS-06 an exclusive process gets an empty executor and its executor accepts no other', () => {
    const w = world(4);
    w.pool.startFirst(0);
    const x = proc(1, 'k', { exclusive: true });
    expect(place(w, x)).toBe(0);
    expect(w.pool.slot(0).exclusive).toBe(true);
    const y = proc(2, 'k');
    expect(place(w, y)).toBe(1);
    const z = proc(3, 'k', { exclusive: true });
    expect(place(w, z)).not.toBe(1);
    expect(w.pool.slot(z.worker ?? 0).residents.size).toBe(1);
    // When the exclusive process leaves, the realm may take residents of its key again.
    w.pool.evict(x, 10);
    expect(w.pool.slot(0).exclusive).toBe(false);
    expect(w.pool.reapable(10 + 30_000)).toContain(0);
    expect(w.pool.reapable(10 + 29_999)).not.toContain(0);
  });

  it('KPS-06 a process that overruns twice is moved to an exclusive executor', () => {
    const w = world(4);
    w.pool.startFirst(0);
    const a = proc(1, 'k');
    const b = proc(2, 'k');
    place(w, a, 0, false);
    place(w, b, 0, false);
    expect(a.worker).toBe(b.worker);
    a.overruns = 1;
    expect(w.pool.onOverrun(a, true)).toEqual({ kind: 'none' });
    a.overruns = 2;
    const action = w.pool.onOverrun(a, true);
    expect(action.kind).toBe('migrate');
    if (action.kind !== 'migrate') return;
    a.exclusive = true;
    expect(w.pool.move(a, action.to, 1)).not.toBe(0);
    expect(w.pool.slot(a.worker ?? 0).exclusive).toBe(true);
    expect(w.pool.slot(0).residents.has(1)).toBe(false);
    // Alone already: the executor itself becomes exclusive.
    b.overruns = 2;
    expect(w.pool.onOverrun(b, true)).toEqual({ kind: 'isolated-in-place', index: 0 });
    expect(w.pool.onOverrun(b, true)).toEqual({ kind: 'none' });
  });

  it('KPS-06 a non-checkpointable overrunner stays and its executor stops accepting new residents', () => {
    const w = world(2);
    w.pool.startFirst(0);
    const a = proc(1, 'k', { checkpointable: false, overruns: 2 });
    const b = proc(2, 'k');
    place(w, a, 0, false);
    place(w, b, 0, false);
    expect(w.pool.onOverrun(a, true)).toEqual({ kind: 'closed', index: 0 });
    expect(w.pool.decide({ pid: 3, isolation: 'k', exclusive: false }, false)).toEqual({
      kind: 'spawn',
      index: 1,
    });
    expect(w.pool.info(() => 1)[0]).toMatchObject({ exclusive: true, runningPid: 1 });
  });

  it('KPS-06 the focused process goes to the least-loaded executor of its key', () => {
    const w = world(4);
    w.pool.startFirst(0);
    const editor = proc(1, 'k');
    const burn = proc(2, 'k');
    place(w, editor, 0, false);
    place(w, burn, 0, false);
    const sleeper = proc(3, 'other');
    place(w, sleeper, 0, false);
    // Grow is allowed after desktop-interactive: migrate to a fresh executor.
    const f = w.pool.focus(editor, true);
    expect(f.kind).toBe('migrate');
    // Before desktop-interactive and with no less-loaded executor of the key: stay.
    expect(w.pool.focus(editor, false)).toEqual({ kind: 'stay' });
    // A less-loaded existing executor of the key is preferred.
    const lone = proc(4, 'k', { state: 'BLOCKED' });
    w.procs.set(4, lone);
    w.pool.commit({ kind: 'spawn', index: 2 }, { pid: 4, isolation: 'k', exclusive: false }, 0);
    expect(w.pool.focus(editor, false)).toEqual({
      kind: 'migrate',
      from: 0,
      to: { kind: 'existing', index: 2 },
    });
    // Non-checkpointable, alone, or unplaced: stay.
    expect(w.pool.focus({ ...editor, checkpointable: false }, true)).toEqual({ kind: 'stay' });
    expect(w.pool.focus(sleeper, true)).toEqual({ kind: 'stay' });
    expect(w.pool.focus(proc(9, 'k'), true)).toEqual({ kind: 'stay' });
  });

  it('KPS-08 terminate and respawn give a fresh realm for the same key', () => {
    const w = world(2);
    w.pool.startFirst(0);
    const a = proc(1, 'k');
    const b = proc(2, 'k');
    place(w, a, 0, false);
    place(w, b, 0, false);
    const gen = w.pool.slot(0).generation;
    expect(w.pool.terminate(0).sort()).toEqual([1, 2]);
    expect(w.pool.homeOf(1)).toBeNull();
    expect(w.pool.slot(0).state).toBe('absent');
    expect(() => w.pool.bind(0, 'k')).toThrow(/no worker/);
    w.pool.respawn(0, 'k', 100);
    expect(() => w.pool.respawn(0, 'k', 100)).toThrow(/still alive/);
    expect(w.pool.slot(0)).toMatchObject({
      state: 'bound',
      isolation: 'k',
      generation: gen + 1,
      terminations: 1,
      spawnedAt: 100,
    });
  });

  it('KPS-06 commit refuses decisions that do not match the pool', () => {
    const w = world(2);
    w.pool.startFirst(0);
    const req: PlacementRequest = { pid: 1, isolation: 'k', exclusive: false };
    expect(() => w.pool.commit({ kind: 'existing', index: 0 }, req, 0)).toThrow(/not bound/);
    expect(() => w.pool.commit({ kind: 'spawn', index: 0 }, req, 0)).toThrow(/already alive/);
    expect(
      w.pool.commit({ kind: 'fail', errno: 'EAGAIN', reason: 'executors-exhausted' }, req, 0),
    ).toBeNull();
    w.pool.commit({ kind: 'bind-spare', index: 0 }, req, 0);
    expect(() =>
      w.pool.commit({ kind: 'recycle', index: 0, evicted: 'k' }, { ...req, pid: 2 }, 0),
    ).toThrow(/not empty/);
    expect(() => w.pool.slot(7)).toThrow(RangeError);
    expect(() => new ExecutorPool({ maxExecutors: 0, isRunnable: () => false })).toThrow(
      RangeError,
    );
    expect(w.pool.spawnSpare(0)).toBe(1);
    expect(w.pool.spawnSpare(0)).toBeNull();
    expect(w.pool.removeResident(99, 0)).toBeNull();
  });
});
