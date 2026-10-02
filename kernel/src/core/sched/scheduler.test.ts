/**
 * PROC-02 (ready heap, index map, changeKey), PROC-03 (round-robin, quanta, F-call resume,
 * pre-emption), KPS-11, KPS-12 and the frame identity rules, against the scheduler with the
 * test-only heap double and, gated on the dsa flag, the team's real BinaryHeap.
 */
import { BinaryHeap, IMPLEMENTED as HEAP_READY } from '@plotinium/dsa/heap';
import type { PState } from '@plotinium/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PCB } from '../proc/pcb.ts';
import {
  applySysctl,
  bandOf,
  computeBase,
  defaultSchedParams,
  readyKey,
  SEQ_MAX,
  splitReadyKey,
} from './params.ts';
import type { SchedParams } from './params.ts';
import { defaultHeapFactory, Scheduler } from './scheduler.ts';
import type { HeapFactory, SchedHost, SchedulableProcess, TransitionReason } from './types.ts';
import { isolationKey } from './types.ts';
import { ModelHeap } from './tests/model-heap.ts';
import { SimKernel } from './tests/sim.ts';

// A PCB of kernel/core/proc is accepted by the scheduler without an adapter (compile-time check).
const pcbIsSchedulable = (p: PCB): SchedulableProcess => p;
void pcbIsSchedulable;

interface Proc extends SchedulableProcess {
  name: string;
}

function mkProc(pid: number, priority = 20, worker = 0, nice = 0, isolation = '1000:user'): Proc {
  const base = computeBase(priority, nice, false);
  return {
    pid,
    name: `p${String(pid)}`,
    isolation,
    state: 'NEW',
    priority,
    nice,
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
    worker,
    exclusive: false,
    checkpointable: true,
  };
}

interface Rig {
  sched: Scheduler<Proc>;
  procs: Map<number, Proc>;
  heap: ModelHeap;
  dispatches: { e: number; pid: number; sliceSeq: number; quantumMs: number }[];
  preempts: { e: number; level: 1 | 2 }[];
  transitions: { pid: number; from: PState | null; to: PState; reason: TransitionReason }[];
  add(p: Proc): Proc;
}

function rig(
  over: Partial<SchedParams> = {},
  opts: { initialSeq?: number; maxExecutors?: number; createHeap?: HeapFactory } = {},
): Rig {
  const procs = new Map<number, Proc>();
  const dispatches: Rig['dispatches'] = [];
  const preempts: Rig['preempts'] = [];
  const transitions: Rig['transitions'] = [];
  let heap = new ModelHeap();
  const host: SchedHost<Proc> = {
    dispatch: (e, p, sliceSeq, quantumMs) =>
      dispatches.push({ e, pid: p.pid, sliceSeq, quantumMs }),
    setPreempt: (e, level) => preempts.push({ e, level }),
    transition: (p, from, to, reason) => transitions.push({ pid: p.pid, from, to, reason }),
  };
  const sched = new Scheduler<Proc>({
    params: { ...defaultSchedParams(4), ...over },
    procs,
    host,
    maxExecutors: opts.maxExecutors ?? 8,
    createHeap:
      opts.createHeap ??
      (() => {
        heap = new ModelHeap();
        return heap;
      }),
    ...(opts.initialSeq === undefined ? {} : { initialSeq: opts.initialSeq }),
  });
  return {
    sched,
    procs,
    get heap() {
      return heap;
    },
    dispatches,
    preempts,
    transitions,
    add: (p) => {
      procs.set(p.pid, p);
      return p;
    },
  };
}

describe('PROC-02 ready heap and index map', () => {
  it('PROC-02 ready heap pops in (effPrio, seq) order against a sorted-array model (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 39 }), { minLength: 1, maxLength: 40 }),
        (bases) => {
          // One token held by a blocker; every other process on its own idle executor slot.
          const r = rig({ runTokens: 1 }, { maxExecutors: 64 });
          const blocker = r.add(mkProc(1, 0, 0));
          r.sched.makeReady(blocker, 'admit', 0);
          expect(blocker.state).toBe('RUNNING');
          const ps = bases.map((b, i) => r.add(mkProc(10 + i, b, 1 + i)));
          for (const p of ps) r.sched.makeReady(p, 'admit', 0);
          const expected = [...ps]
            .sort((a, b) => a.base - b.base || a.seq - b.seq)
            .map((p) => p.pid);
          expect(r.heap.sorted()).toEqual(expected);
          // Release the token repeatedly: each dispatched process blocks at once.
          r.dispatches.length = 0;
          r.sched.onSliceEnd(0, 'block', { cpuMs: 1 }, 1);
          blocker.state = 'BLOCKED';
          for (let i = 0; i < ps.length; i++) {
            const d = r.dispatches[i];
            expect(d).toBeDefined();
            if (d === undefined) break;
            r.sched.onSliceEnd(d.e, 'block', { cpuMs: 0.1 }, 1);
            r.procs.get(d.pid)!.state = 'BLOCKED';
          }
          expect(r.dispatches.map((d) => d.pid)).toEqual(expected);
          r.sched.checkInvariants();
        },
      ),
      { numRuns: 60, seed: 94 },
    );
  });

  it('PROC-02 the key effPrio * 2^32 + seq is exact and orders lexicographically by (effPrio, seq)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 39 }),
        fc.integer({ min: 0, max: SEQ_MAX }),
        fc.integer({ min: 0, max: 39 }),
        fc.integer({ min: 0, max: SEQ_MAX }),
        (e1, s1, e2, s2) => {
          const k1 = readyKey(e1, s1);
          const k2 = readyKey(e2, s2);
          expect(Number.isSafeInteger(k1)).toBe(true);
          expect(splitReadyKey(k1)).toEqual({ effPrio: e1, seq: s1 });
          const lex = e1 - e2 || s1 - s2;
          expect(Math.sign(k1 - k2)).toBe(Math.sign(lex));
        },
      ),
    );
  });

  it('PROC-02 renice of a READY process calls changeKey once and moves it to its new position', () => {
    const r = rig({ runTokens: 1 });
    const blocker = r.add(mkProc(1, 0, 0));
    r.sched.makeReady(blocker, 'admit', 0);
    const a = r.add(mkProc(2, 20, 1));
    const b = r.add(mkProc(3, 20, 2));
    const c = r.add(mkProc(4, 20, 3));
    for (const p of [a, b, c]) r.sched.makeReady(p, 'admit', 0);
    expect(r.heap.sorted()).toEqual([2, 3, 4]);
    const before = r.heap.calls.changePriority;
    r.sched.setPriority(c, { nice: -15 }, 10); // root renice: base 5
    expect(r.heap.calls.changePriority - before).toBe(1);
    expect(c.base).toBe(5);
    expect(c.band).toBe('interactive');
    expect(r.heap.sorted()).toEqual([4, 2, 3]);
    expect(r.heap.keyOf(4)).toBe(readyKey(5, c.seq));
    // A renice that leaves the effective priority unchanged costs no changeKey.
    r.sched.setPriority(a, { nice: 0 }, 10);
    expect(r.heap.calls.changePriority - before).toBe(1);
  });

  it('PROC-02 seq renumbering near 2^32 preserves dispatch order', () => {
    const r = rig({ runTokens: 1 }, { initialSeq: SEQ_MAX - 3 });
    const blocker = r.add(mkProc(1, 0, 0));
    r.sched.makeReady(blocker, 'admit', 0);
    const ps = [r.add(mkProc(2, 20, 1)), r.add(mkProc(3, 10, 2)), r.add(mkProc(4, 20, 3))];
    for (const p of ps) r.sched.makeReady(p, 'admit', 0);
    expect(r.sched.seqCounter).toBe(SEQ_MAX + 1);
    // The next arrival forces renumbering: 1 … n in key order, then continues from n + 1.
    const late = r.add(mkProc(5, 20, 4));
    r.sched.makeReady(late, 'admit', 0);
    expect(r.sched.stats().renumbers).toBe(1);
    expect(ps.map((p) => p.seq)).toEqual([2, 1, 3]);
    expect(late.seq).toBe(4);
    expect(r.heap.sorted()).toEqual([3, 2, 4, 5]);
    r.sched.checkInvariants();
  });

  it('PROC-02 the production heap factory builds the team BinaryHeap from dsa', () => {
    expect(defaultHeapFactory(16)).toBeInstanceOf(BinaryHeap);
  });
});

describe('PROC-03 round-robin and quanta', () => {
  it('PROC-03 three equal-priority burn jobs run in round-robin order in the klog trace', () => {
    const sim = new SimKernel({ hwc: 3, watchdog: false }); // RUN_TOKENS = 1
    const jobs = [sim.spawn({ name: 'a' }), sim.spawn({ name: 'b' }), sim.spawn({ name: 'c' })];
    sim.runUntil(200);
    const order = sim.dispatchOrder();
    expect(order.length).toBeGreaterThanOrEqual(15);
    const ids = jobs.map((j) => j.pid);
    for (let i = 0; i + 3 <= order.length; i += 3) {
      expect(new Set(order.slice(i, i + 3))).toEqual(new Set(ids));
      if (i >= 3) expect(order.slice(i, i + 3)).toEqual(order.slice(0, 3));
    }
    // Every re-entry to READY after a slice is a `quantum` record with a fresh, larger seq.
    const requeues = sim.log.filter((r) => r.reason === 'quantum');
    expect(requeues.length).toBeGreaterThan(10);
  });

  it('PROC-03 setting the normal quantum to 4 ms changes observed slice lengths to at most 4 ms plus delta', () => {
    const sim = new SimKernel({ hwc: 3, watchdog: false });
    const res = applySysctl(sim.params, 'sched.quantum.normal', 4);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    sim.sched.setParams(res.params, 0);
    sim.spawn();
    sim.spawn();
    sim.runUntil(100);
    expect(sim.sliceLog.length).toBeGreaterThan(10);
    for (const s of sim.sliceLog)
      expect(s.end - s.start).toBeLessThanOrEqual(4 + res.params.deltaMs);
    expect(Math.max(...sim.sliceLog.map((s) => s.end - s.start))).toBeGreaterThan(3.9);
  });

  it('PROC-03 an F call does not reset the quantum: the resume carries the remaining time', () => {
    const r = rig();
    const p = r.add(mkProc(1, 20, 0)); // normal band, 10 ms
    r.sched.makeReady(p, 'admit', 100);
    const first = r.dispatches[0];
    expect(first?.quantumMs).toBe(10);
    const res = r.sched.onFastCall(0, { cpuMs: 3 }, 103);
    expect(res).toEqual({
      kind: 'resume',
      pid: 1,
      sliceSeq: (first?.sliceSeq ?? 0) + 1,
      quantumLeftMs: 7,
    });
    // The executor echoes the new slice counter; the old one is now stale.
    expect(r.sched.checkFrame(0, 1, (first?.sliceSeq ?? 0) + 1)).toBe('ok');
    expect(r.sched.checkFrame(0, 1, first?.sliceSeq ?? 0)).toBe('stale');
    expect(p.cpuTimeMs).toBe(3);
    // Past the quantum the reply waits in pendingReply and the process re-queues.
    const late = r.sched.onFastCall(0, { cpuMs: 7 }, 111);
    expect(late).toEqual({ kind: 'requeue', pid: 1, killPending: false });
    expect(r.transitions.at(-1)?.reason).toBe('dispatch'); // re-dispatched at once (idle machine)
    expect(r.transitions.at(-2)).toMatchObject({
      pid: 1,
      from: 'RUNNING',
      to: 'READY',
      reason: 'requeue',
    });
  });

  it('PROC-03 an F call with a better process waiting in the heap re-queues instead of resuming', () => {
    const r = rig({ runTokens: 1 });
    const bg = r.add(mkProc(1, 35, 0));
    r.sched.makeReady(bg, 'admit', 0);
    const fg = r.add(mkProc(2, 5, 1));
    r.sched.makeReady(fg, 'admit', 1);
    expect(bg.preemptRequested).toBe(true);
    expect(r.sched.onFastCall(0, { cpuMs: 1 }, 2).kind).toBe('requeue');
    expect(fg.state).toBe('RUNNING');
  });

  it('PROC-03 an interactive-band process pre-empts a running background slice at its next yield point', () => {
    const sim = new SimKernel({ hwc: 3, watchdog: false }); // one token
    const bg = sim.spawn({ priority: 35, name: 'indexer' });
    sim.runUntil(3.05); // mid-way through its 20 ms quantum
    expect(bg.state).toBe('RUNNING');
    const fg = sim.spawn({ priority: 2, name: 'editor' });
    expect(sim.preempts.at(-1)).toMatchObject({ level: 1 });
    sim.runUntil(3.5);
    expect(fg.state).toBe('RUNNING');
    const bgSlice = sim.sliceLog.find((s) => s.pid === bg.pid);
    // It stopped at the next 0.1 ms yield point, plus the kernel's report handling.
    expect((bgSlice?.end ?? 0) - 3.05).toBeLessThanOrEqual(0.1 + 0.2 + 1e-6);
    expect(sim.log.some((r) => r.pid === bg.pid && r.reason === 'preempt')).toBe(true);
  });

  it('PROC-03 sysctl validates quanta and T_age and recomputes the hard limit', () => {
    const p = defaultSchedParams(4);
    expect(applySysctl(p, 'sched.quantum.background', 1)).toMatchObject({
      ok: false,
      errno: 'EINVAL',
    });
    expect(applySysctl(p, 'sched.quantum.background', 51)).toMatchObject({ ok: false });
    expect(applySysctl(p, 'sched.quantum.interactive', 2.5)).toMatchObject({
      ok: false,
      reason: 'not-integer',
    });
    expect(applySysctl(p, 'sched.tAge', 49)).toMatchObject({ ok: false });
    const big = applySysctl(p, 'sched.quantum.background', 50);
    expect(big.ok && big.params.hardLimitMs).toBe(500);
    const tAge = applySysctl(p, 'sched.tAge', 250);
    expect(tAge.ok && tAge.params.tAgeMs).toBe(250);
    const inter = applySysctl(p, 'sched.quantum.interactive', 3);
    expect(inter.ok && inter.params.quantumMs.interactive).toBe(3);
  });
});

describe('KPS-11 and KPS-12 in the dispatcher', () => {
  it('KPS-11 the interactive hint pauses background dispatch for at most 1 s in any 2 s and never pauses an aged process', () => {
    const sim = new SimKernel({ hwc: 3, watchdog: false });
    // Base 39: it needs 1 s of waiting to age below 30, so it stays paused for the whole pause.
    const bg = sim.spawn({ priority: 39, name: 'indexer' });
    sim.runUntil(1);
    sim.sched.setInteractive(true, sim.now);
    sim.runUntil(1.5);
    expect(bg.state).toBe('READY'); // pre-empted and not re-dispatched while paused
    const runsDuring = (from: number, to: number): number =>
      sim.sliceLog.filter((s) => s.pid === bg.pid && s.start >= from && s.start < to).length;
    sim.runUntil(1_000);
    expect(runsDuring(1.5, 1_000)).toBe(0);
    sim.runUntil(2_001);
    expect(runsDuring(1_001.5, 2_000)).toBeGreaterThan(0); // background resumed after 1 s
    // The pause returns for the next second of the continuing gesture: ≈ 50 % duty cycle.
    sim.runUntil(4_000);
    expect(runsDuring(2_002, 3_000)).toBe(0);
    expect(sim.sched.interactive.pausedWithin(1_000, 3_000, 4_000)).toBeLessThanOrEqual(
      1_000 + 1e-6,
    );
    sim.sched.setInteractive(false, sim.now);
    // An aged process (effPrio < 30) is not paused even while the gesture continues.
    const sim2 = new SimKernel({ hwc: 3, watchdog: false });
    sim2.spawn({ priority: 0 });
    sim2.spawn({ priority: 0 });
    const old = sim2.spawn({ priority: 30 });
    sim2.runUntil(250); // waited 250 ms → effPrio 28
    expect(old.state).toBe('READY');
    expect(old.effPrio).toBeLessThan(30);
    sim2.sched.setInteractive(true, sim2.now);
    sim2.runUntil(4_000);
    expect(sim2.log.some((r) => r.pid === old.pid && r.to === 'RUNNING' && r.t > 250)).toBe(true);
  });

  it('KPS-12 the focused window process and the focused TTY foreground group run in the interactive band unless niced', () => {
    const r = rig();
    const editor = r.add(mkProc(1, 20, 0));
    r.sched.makeReady(editor, 'admit', 0);
    r.sched.setPriority(editor, { boosted: true }, 1);
    expect(editor.base).toBe(5);
    expect(editor.band).toBe('interactive');
    expect(r.dispatches.at(-1)?.quantumMs).toBe(10); // quanta change from the next dispatch
    r.sched.setPriority(editor, { boosted: false }, 2);
    expect(editor.band).toBe('normal');
    const niced = r.add(mkProc(2, 20, 1, 10));
    r.sched.makeReady(niced, 'admit', 3);
    r.sched.setPriority(niced, { boosted: true }, 4);
    expect(niced.base).toBe(30); // an explicitly niced job is never boosted
    expect(niced.band).toBe('background');
  });

  it('KPS-12 input to a window pre-empts another slice on its executor so a keystroke waits one step', () => {
    const r = rig();
    const bg = r.add(mkProc(1, 35, 0));
    const editor = r.add(mkProc(2, 20, 0));
    r.sched.makeReady(bg, 'admit', 0);
    r.sched.makeReady(editor, 'admit', 0);
    expect(r.sched.parkedOn(0)).toEqual([2]);
    expect(r.sched.onInput(2, 1)).toBe(true);
    expect(r.preempts).toContainEqual({ e: 0, level: 1 });
    expect(r.sched.onInput(2, 1)).toBe(false); // already requested
    expect(r.sched.onInput(1, 1)).toBe(false); // its own slice
    expect(r.sched.onInput(99, 1)).toBe(false); // unknown pid
  });
});

describe('PRE-04 idle detection', () => {
  it('PRE-04 idle means 2 s with no input and no READY or RUNNING interactive or normal process', () => {
    const sim = new SimKernel({ hwc: 3, watchdog: false });
    const bg = sim.spawn({ priority: 39, name: 'prefetch:editor' });
    const fg = sim.spawn({
      priority: 20,
      name: 'sh',
      program: () => ({ kind: 'block', afterMs: 1, sleepMs: 60_000 }),
    });
    sim.runUntil(10);
    expect(fg.state).toBe('BLOCKED');
    expect(bg.state).toBe('RUNNING'); // background work alone does not prevent idleness
    const fgEnd = sim.sliceLog.find((x) => x.pid === fg.pid)?.end ?? 0;
    expect(sim.sched.idleMs(sim.now)).toBeCloseTo(sim.now - fgEnd, 6);
    expect(sim.sched.isIdle(sim.now)).toBe(false);
    sim.runUntil(fgEnd + 2_000);
    expect(sim.sched.isIdle(sim.now)).toBe(true);
    // Input resets the clock; a READY normal-band process keeps the machine busy.
    sim.sched.noteInput(sim.now);
    expect(sim.sched.idleMs(sim.now)).toBe(0);
    sim.runUntil(sim.now + 2_500);
    expect(sim.sched.isIdle(sim.now)).toBe(true);
    const busy = sim.spawn({ priority: 20 });
    expect(busy.state).not.toBe('BLOCKED');
    expect(sim.sched.idleMs(sim.now)).toBe(0);
    sim.sched.noteInput(sim.now - 1); // an older input never moves the clock back
    sim.killPath.begin(busy, 'signal:9', 0, sim.now);
    sim.runUntil(sim.now + 1);
    expect(sim.sched.isIdle(sim.now)).toBe(false);
    expect(sim.sched.onInput(fg.pid, sim.now)).toBe(false);
    expect(sim.sched.idleMs(sim.now)).toBe(0);
  });
});

describe('PROC-02 frames and slices', () => {
  it('SYS-01 a frame from an idle executor or with a foreign pid is a mismatch; an older slice of the same pid is stale', () => {
    const r = rig();
    const p = r.add(mkProc(1, 20, 0));
    expect(r.sched.checkFrame(0, 1, 1)).toBe('mismatch'); // idle executor
    r.sched.makeReady(p, 'admit', 0);
    const d = r.dispatches[0];
    expect(r.sched.checkFrame(0, 1, d?.sliceSeq ?? 0)).toBe('ok');
    expect(r.sched.checkFrame(0, 2, d?.sliceSeq ?? 0)).toBe('mismatch');
    expect(r.sched.checkFrame(0, 1, (d?.sliceSeq ?? 0) + 5)).toBe('mismatch');
  });

  it('PROC-03 a yield after PREEMPT is logged as preempt and one after the quantum as quantum', () => {
    const r = rig({ runTokens: 1 });
    const a = r.add(mkProc(1, 20, 0));
    r.sched.makeReady(a, 'admit', 0);
    r.sched.onSliceEnd(0, 'yield', { cpuMs: 10 }, 10);
    expect(r.transitions.filter((t) => t.pid === 1).map((t) => t.reason)).toEqual([
      'admit',
      'dispatch',
      'quantum',
      'dispatch',
    ]);
    const b = r.add(mkProc(2, 1, 1));
    r.sched.makeReady(b, 'admit', 11);
    expect(a.preemptRequested).toBe(true);
    const res = r.sched.onSliceEnd(0, 'yield', { cpuMs: 1 }, 12);
    expect(res.requeued).toBe(true);
    expect(r.transitions.filter((t) => t.pid === 1).at(-1)?.reason).toBe('preempt');
    expect(b.state).toBe('RUNNING');
  });

  it('PROC-03 a slice longer than quantum + 5 ms counts as an overrun', () => {
    const r = rig();
    const p = r.add(mkProc(1, 20, 0));
    r.sched.makeReady(p, 'admit', 0);
    const res = r.sched.onSliceEnd(0, 'yield', { cpuMs: 16, maxStepUs: 9000 }, 16);
    expect(res.overrun).toBe(true);
    expect(p.overruns).toBe(1);
    expect(p.maxStepUs).toBe(9000);
    const ok = r.sched.onSliceEnd(0, 'yield', { cpuMs: 15 }, 16 + 15);
    expect(ok.overrun).toBe(false);
  });

  it('KPS-05 a lower RUN_TOKENS pre-empts nothing and tokens are not re-issued until slices end', () => {
    const r = rig({ runTokens: 2 });
    const a = r.add(mkProc(1, 20, 0));
    const b = r.add(mkProc(2, 20, 1));
    const c = r.add(mkProc(3, 20, 2));
    for (const p of [a, b, c]) r.sched.makeReady(p, 'admit', 0);
    expect(r.sched.runningCount).toBe(2);
    r.sched.setRunTokens(1, 1);
    expect(r.sched.runningCount).toBe(2);
    expect(r.sched.tokens.free).toBe(0);
    r.sched.checkInvariants();
    r.sched.onSliceEnd(0, 'block', { cpuMs: 1 }, 2);
    a.state = 'BLOCKED';
    expect(r.sched.runningCount).toBe(1);
    expect(c.state).toBe('READY'); // the freed token is not re-issued: 1 running = RUN_TOKENS
    r.sched.setRunTokens(2, 3);
    expect(c.state).toBe('RUNNING');
  });

  it('PROC-02 makeReady refuses a READY, TERMINATED, running or unplaced process', () => {
    const r = rig();
    const p = r.add(mkProc(1, 20, 0));
    r.sched.makeReady(p, 'admit', 0);
    expect(() => r.sched.makeReady(p, 'wake', 0)).toThrow(/still holds a slice/);
    const q = r.add(mkProc(2, 20, 0));
    r.sched.makeReady(q, 'admit', 0);
    expect(() => r.sched.makeReady(q, 'wake', 0)).toThrow(/already READY/);
    const z = r.add({ ...mkProc(3), state: 'TERMINATED' });
    expect(() => r.sched.makeReady(z, 'wake', 0)).toThrow(/TERMINATED/);
    const u = r.add({ ...mkProc(4), worker: null });
    expect(() => r.sched.makeReady(u, 'admit', 0)).toThrow(/no executor/);
    expect(() => r.sched.onSliceEnd(5, 'yield', { cpuMs: 0 }, 0)).toThrow(/no running slice/);
    expect(() => r.sched.onFastCall(5, { cpuMs: 0 }, 0)).toThrow(/no running slice/);
  });

  it('PROC-07 remove takes a READY process out of the heap or its parked queue, never a running one', () => {
    const r = rig();
    const a = r.add(mkProc(1, 20, 0));
    const b = r.add(mkProc(2, 20, 0));
    const c = r.add(mkProc(3, 20, 1));
    r.sched.makeReady(a, 'admit', 0);
    r.sched.makeReady(b, 'admit', 0);
    expect(r.sched.isQueued(2)).toBe('parked');
    expect(r.sched.remove(2, 1)).toBe('parked');
    expect(r.sched.remove(1, 1)).toBe('running');
    expect(r.sched.remove(99, 1)).toBe('none');
    r.sched.setRunTokens(1, 1);
    r.sched.makeReady(c, 'admit', 1);
    expect(r.sched.isQueued(3)).toBe('heap');
    expect(r.sched.remove(3, 2)).toBe('heap');
    expect(r.sched.isQueued(3)).toBeNull();
    expect(r.sched.readyCount).toBe(0);
    expect(r.sched.parkedCount).toBe(0);
  });

  it('PROC-07 preemptKill posts PREEMPT = 2 once and suppresses level-1 requests to the dying slice', () => {
    const r = rig({ runTokens: 1 });
    expect(r.sched.preemptKill(0)).toBeNull();
    const a = r.add(mkProc(1, 35, 0));
    r.sched.makeReady(a, 'admit', 0);
    expect(r.sched.preemptKill(0)).toBe(1);
    expect(r.preempts).toEqual([{ e: 0, level: 2 }]);
    const b = r.add(mkProc(2, 0, 1));
    r.sched.makeReady(b, 'admit', 1); // would normally pre-empt a (background) with level 1
    expect(r.preempts).toEqual([{ e: 0, level: 2 }]);
  });

  it('PROC-02 checkInvariants reports INV-P1 and INV-P2 violations', () => {
    const r = rig();
    const a = r.add(mkProc(1, 20, 0));
    r.sched.makeReady(a, 'admit', 0);
    r.sched.checkInvariants();
    a.state = 'BLOCKED';
    expect(() => r.sched.checkInvariants()).toThrow(/INV-P1/);
    a.state = 'RUNNING';
    r.sched.tokens.release();
    expect(() => r.sched.checkInvariants()).toThrow(/INV-P2/);
  });

  it('KPS-13 attachTimers drives aging from the timer heap and re-arms it when T_age changes', () => {
    const sim = new SimKernel({ hwc: 3, watchdog: false });
    sim.spawn({ priority: 0 });
    sim.spawn({ priority: 0 });
    const p = sim.spawn({ priority: 30 });
    sim.runUntil(100.01);
    expect(p.effPrio).toBe(29);
    const res = applySysctl(sim.params, 'sched.tAge', 50);
    if (!res.ok) throw new Error('sysctl');
    sim.sched.setParams(res.params, sim.now);
    sim.runUntil(150.02);
    expect(p.effPrio).toBe(27); // waited 150 ms at T_age 50
    expect(sim.sched.stats().agingTicks).toBeGreaterThanOrEqual(2);
  });
});

describe.runIf(HEAP_READY)(
  'PROC-02 with the team BinaryHeap (runs once dsa/heap is IMPLEMENTED)',
  () => {
    it('PROC-02 three equal-priority jobs round-robin with the real heap', () => {
      const sim = new SimKernel({ hwc: 3, watchdog: false, createHeap: (n) => new BinaryHeap(n) });
      const jobs = [sim.spawn(), sim.spawn(), sim.spawn()];
      sim.runUntil(100);
      const order = sim.dispatchOrder();
      expect(new Set(order.slice(0, 3))).toEqual(new Set(jobs.map((j) => j.pid)));
      expect(order.slice(3, 6)).toEqual(order.slice(0, 3));
    });

    it('PROC-04 starvation with the real heap stays within 5450 ms', () => {
      const sim = new SimKernel({ hwc: 4, createHeap: (n) => new BinaryHeap(n) });
      for (let i = 0; i < 50; i++) sim.spawn({ priority: 0 });
      const low = sim.spawn({ priority: 39 });
      sim.runUntil(20_000);
      expect(sim.maxWait(low.pid)).toBeLessThanOrEqual(5450);
    });
  },
);

describe('KPS-05 isolation keys', () => {
  it('KPS-05 the isolation key is uid:class', () => {
    expect(isolationKey(1000, 'user')).toBe('1000:user');
    expect(isolationKey(0, 'agent')).toBe('0:agent');
  });
});
