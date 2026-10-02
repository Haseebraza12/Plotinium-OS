/**
 * KPS-08: watchdog detection, forced termination, collateral handling, identity mismatches.
 */
import { describe, expect, it } from 'vitest';

import {
  CTL_BYTES,
  execBeginSlice,
  execEndSlice,
  execYieldPoint,
  writeSliceSeq,
} from './control-block.ts';
import { defaultSchedParams, hKillMs } from './params.ts';
import { isRestorable, planCollateral, SuspectTracker, Watchdog } from './watchdog.ts';
import type { RunningSlice } from './watchdog.ts';
import { SimKernel } from './tests/sim.ts';

const params = defaultSchedParams(4);

function ctlFor(pid: number, sliceSeq: number): Int32Array {
  const ctl = new Int32Array(new SharedArrayBuffer(CTL_BYTES));
  writeSliceSeq(ctl, sliceSeq);
  execBeginSlice(ctl, pid);
  return ctl;
}

describe('KPS-08 watchdog decisions', () => {
  it('KPS-08 with SAB a slice past HARD_LIMIT gets PREEMPT = 2, then worker.terminate() after KILL_GRACE', () => {
    const wd = new Watchdog(params);
    const ctl = ctlFor(7, 3);
    const slice: RunningSlice = { e: 1, pid: 7, sliceSeq: 3, startedAt: 0 };
    expect(params.hardLimitMs).toBe(250);
    expect(wd.check(200, [slice], () => ctl)).toEqual([]);
    expect(wd.check(250, [slice], () => ctl)).toEqual([]); // not yet past the limit
    const first = wd.check(300, [slice], () => ctl);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: 'preempt-kill',
      e: 1,
      pid: 7,
      sliceSeq: 3,
      sliceMs: 300,
    });
    expect(wd.pendingKill(1)).toMatchObject({ pid: 7, origin: 'watchdog', requestedAt: 300 });
    expect(wd.check(350, [slice], () => ctl)).toEqual([]); // inside the grace
    const second = wd.check(400, [slice], () => ctl);
    expect(second).toEqual([
      { kind: 'terminate', e: 1, pid: 7, sliceSeq: 3, cause: 'watchdog', sliceMs: 400 },
    ]);
    expect(wd.pendingKill(1)).toBeUndefined();
  });

  it('KPS-08 a stale heartbeat is reported with the preempt-kill record', () => {
    const wd = new Watchdog(params);
    const ctl = ctlFor(7, 3);
    const slice: RunningSlice = { e: 0, pid: 7, sliceSeq: 3, startedAt: 0 };
    wd.check(100, [slice], () => ctl);
    execYieldPoint(ctl, 5, 120);
    wd.check(150, [slice], () => ctl);
    const a = wd.check(300, [slice], () => ctl)[0];
    expect(a).toMatchObject({
      kind: 'preempt-kill',
      heartbeatStale: true,
      steps: 5,
      maxStepUs: 120,
    });
  });

  it('KPS-08 RUNNING_PID = 0 means the report is in flight and nothing is done', () => {
    const wd = new Watchdog(params);
    const ctl = ctlFor(7, 3);
    execEndSlice(ctl);
    const slice: RunningSlice = { e: 0, pid: 7, sliceSeq: 3, startedAt: 0 };
    expect(wd.check(300, [slice], () => ctl)).toEqual([]);
    expect(wd.check(400, [slice], () => ctl)).toEqual([]);
    // Hardening: a slice the block never shows and that never reports is terminated eventually.
    const late = wd.check(
      params.hardLimitMs + params.killGraceMs + 2 * params.watchdogPeriodMs + 1,
      [slice],
      () => ctl,
    );
    expect(late).toEqual([expect.objectContaining({ kind: 'terminate', cause: 'lost-slice' })]);
  });

  it('KPS-08 without SAB a slice with no frame after HARD_LIMIT + KILL_GRACE is terminated directly', () => {
    const wd = new Watchdog(params);
    const slice: RunningSlice = { e: 2, pid: 9, sliceSeq: 1, startedAt: 10 };
    expect(wd.check(10 + 350, [slice], () => null)).toEqual([]);
    expect(wd.check(10 + 351, [slice], () => null)).toEqual([
      { kind: 'terminate', e: 2, pid: 9, sliceSeq: 1, cause: 'no-report', sliceMs: 351 },
    ]);
  });

  it('KPS-08 a kill-path PREEMPT = 2 on a RUNNING target escalates to terminate after the grace', () => {
    const wd = new Watchdog(params);
    const ctl = ctlFor(5, 8);
    const slice: RunningSlice = { e: 0, pid: 5, sliceSeq: 8, startedAt: 0 };
    wd.requestKill(0, 5, 8, 20, 'kill');
    wd.requestKill(0, 5, 8, 60, 'kill'); // a second request keeps the first start
    expect(wd.check(119, [slice], () => ctl)).toEqual([]);
    expect(wd.check(120, [slice], () => ctl)).toEqual([
      expect.objectContaining({ kind: 'terminate', cause: 'kill-grace' }),
    ]);
    // A leftover request from an older slice is dropped.
    wd.requestKill(0, 5, 7, 0, 'kill');
    expect(wd.check(500, [{ ...slice, sliceSeq: 9, startedAt: 450 }], () => ctlFor(5, 9))).toEqual(
      [],
    );
    wd.setParams({ ...params, hardLimitMs: 10 });
    expect(
      wd.check(500, [{ ...slice, sliceSeq: 9, startedAt: 450 }], () => ctlFor(5, 9))[0]?.kind,
    ).toBe('preempt-kill');
  });

  it('KPS-08 H_kill = HARD_LIMIT + KILL_GRACE + WATCHDOG_PERIOD = 400 ms', () => {
    expect(hKillMs(params)).toBe(400);
  });
});

describe('KPS-08 forced termination on the virtual clock', () => {
  it('KPS-08 watchdog: a for(;;) program exits 137 with reason watchdog within H_kill and the executor respawns', () => {
    const sim = new SimKernel({ hwc: 4, desktopInteractive: false });
    const runaway = sim.spawn({ name: 'spin', program: () => ({ kind: 'runaway' }) });
    const e = runaway.worker ?? -1;
    const gen = sim.pool.slot(e).generation;
    sim.runUntil(1_000);
    expect(runaway.state).toBe('TERMINATED');
    const rec = sim.killLog.find((r) => r.pid === runaway.pid);
    expect(rec).toMatchObject({
      exitCode: 137,
      exitReason: 'watchdog',
      reason: 'watchdog',
      from: 'RUNNING',
    });
    const slice = sim.sched.sliceOf(e);
    expect(slice).toBeNull();
    const term = sim.log.find((r) => r.pid === runaway.pid && r.to === 'TERMINATED');
    expect(term?.t).toBeLessThanOrEqual(hKillMs(sim.params));
    expect(sim.watchdogActions.map((a) => a.kind)).toEqual(['preempt-kill', 'terminate']);
    expect(sim.pool.slot(e)).toMatchObject({
      state: 'bound',
      generation: gen + 1,
      terminations: 1,
    });
    expect(sim.sched.tokens.held).toBe(0);
    sim.sched.checkInvariants();
  });

  it('KPS-08 collateral: a checkpointable co-resident with a clean checkpoint is restored; a non-checkpointable one exits 137 collateral', () => {
    const sim = new SimKernel({ hwc: 4, desktopInteractive: false });
    const spin = sim.spawn({ name: 'spin', program: () => ({ kind: 'runaway' }) });
    const clean = sim.spawn({
      name: 'editor',
      checkpointable: true,
      program: () => ({ kind: 'block', afterMs: 1, sleepMs: 60_000 }),
    });
    const dirty = sim.spawn({ name: 'ls', checkpointable: false });
    expect(new Set([spin.worker, clean.worker, dirty.worker]).size).toBe(1);
    sim.restorable = (pid) =>
      isRestorable({
        checkpointable: sim.proc(pid).checkpointable,
        checkpointAfterLastSlice: true,
        dirtyPagesSwapped: true,
        pendingCallRestartable: true,
      });
    sim.runUntil(1_000);
    expect(spin.state).toBe('TERMINATED');
    expect(clean.state).toBe('SUSPENDED');
    expect(sim.log.some((r) => r.pid === clean.pid && r.reason === 'executor-lost')).toBe(true);
    expect(dirty.state).toBe('TERMINATED');
    expect(sim.killLog.find((r) => r.pid === dirty.pid)).toMatchObject({
      exitCode: 137,
      exitReason: 'collateral',
    });
    expect(clean.worker).toBeNull();
    expect(sim.sched.isQueued(dirty.pid)).toBeNull();
    sim.sched.checkInvariants();
  });

  it('KPS-08 a runaway that honours PREEMPT = 2 within the grace is killed alone (no collateral)', () => {
    const sim = new SimKernel({ hwc: 4, desktopInteractive: false });
    const p = sim.spawn({ program: () => ({ kind: 'runaway', honoursKill: true }) });
    const other = sim.spawn({ checkpointable: false });
    const e = p.worker ?? 0;
    expect(other.worker).toBe(e);
    sim.runUntil(1_000);
    expect(sim.watchdogActions.map((a) => a.kind)).toEqual(['preempt-kill']);
    expect(p.state).toBe('TERMINATED');
    expect(sim.killLog.find((r) => r.pid === p.pid)).toMatchObject({
      exitCode: 137,
      exitReason: 'watchdog',
      from: 'RUNNING',
    });
    expect(other.state).not.toBe('TERMINATED');
    expect(sim.pool.slot(e).terminations).toBe(0);
    expect(sim.killPath.finishWatchdogKill(p, sim.now)).toBe('already');
    sim.sched.checkInvariants();
  });
});

describe('KPS-08 realm crash', () => {
  it('KPS-08 an executor error event is handled as a termination without the grace period', () => {
    const sim = new SimKernel({ hwc: 4, desktopInteractive: false, watchdog: false });
    const a = sim.spawn({
      name: 'editor',
      program: () => ({ kind: 'block', afterMs: 1, sleepMs: 60_000 }),
    });
    const b = sim.spawn({
      name: 'cat',
      checkpointable: false,
      program: () => ({ kind: 'block', afterMs: 1, sleepMs: 60_000 }),
    });
    const c = sim.spawn({ name: 'burn' });
    const e = a.worker ?? -1;
    expect(new Set([a.worker, b.worker, c.worker])).toEqual(new Set([e]));
    sim.runUntil(3);
    expect(c.state).toBe('RUNNING');
    sim.restorable = (pid) => sim.proc(pid).checkpointable && pid !== c.pid;
    const res = sim.killPath.terminateExecutor(e, sim.now, (pid) => sim.restorable(pid), 'crash');
    expect(res).toMatchObject({ e, isolation: '1000:user', runaway: c.pid });
    expect(res.plan).toEqual({ restore: [a.pid], collateral: [b.pid] });
    // The running process was not a proven runaway: it lost its executor like the others.
    expect(sim.killLog.find((r) => r.pid === c.pid)).toMatchObject({
      exitReason: 'collateral',
      exitCode: 137,
    });
    expect(a.state).toBe('SUSPENDED');
    expect(b.state).toBe('TERMINATED');
    expect(sim.sched.tokens.held).toBe(0);
    expect(sim.timers.timersOf(b.pid)).toEqual([]);
    sim.sched.checkInvariants();
  });
});

describe('KPS-08 collateral planning and identity', () => {
  it('KPS-08 restorable iff checkpointable, checkpoint after last slice, swap copies and a restartable call', () => {
    const base = {
      checkpointable: true,
      checkpointAfterLastSlice: true,
      dirtyPagesSwapped: true,
      pendingCallRestartable: true,
    };
    expect(isRestorable(base)).toBe(true);
    for (const k of Object.keys(base) as (keyof typeof base)[])
      expect(isRestorable({ ...base, [k]: false })).toBe(false);
    expect(planCollateral([1, 2, 3, 4], 1, (pid) => pid % 2 === 0)).toEqual({
      restore: [2, 4],
      collateral: [3],
    });
  });

  it('SYS-01 a second identity mismatch from the same executor terminates it through the watchdog path', () => {
    const t = new SuspectTracker();
    expect(t.isSuspect(3)).toBe(false);
    expect(t.mismatch(3)).toBe('suspect');
    expect(t.isSuspect(3)).toBe(true);
    expect(t.mismatch(3)).toBe('terminate');
    t.reset(3);
    expect(t.mismatch(3)).toBe('suspect');
  });
});
