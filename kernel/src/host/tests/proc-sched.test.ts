/**
 * Scheduling through the whole kernel on the process loopback host (processes-and-scheduling.md
 * §3.8–§3.14, §3.20): real `burn` processes spawned with the `spawn` system call, dispatched by the
 * scheduler on the dsa/heap ready queue over the executor pool, aged by the kernel timer heap.
 *
 * PROC-02 heap order and O(log n) re-keying (`setpriority`), PROC-03 round-robin with a
 * configurable quantum, PROC-04 the starvation bound asserted against the declared value, PROC-05
 * at most RUN_TOKENS slices at once and isolation keys never sharing an executor, PROC-09 256
 * sleeping processes, and `nice` / `setpriority` / `getpriority` permissions.
 *
 * Virtual time: the clock advances only while a program executes (0.25 ms per generator step), so
 * with RUN_TOKENS = 1 (hardwareConcurrency 3) virtual time is exactly the serial schedule the
 * declared bound (E = 1) describes.
 */
import { BinaryHeap } from '@plotinium/dsa/heap';
import type { ProcCred } from '../../core/proc/pcb.ts';
import { describe, expect, it } from 'vitest';

import {
  boundInputFromParams,
  declaredBoundMs,
  predictedStarvationWaitMs,
} from '../../core/sched/bound.ts';
import { defaultHeapFactory } from '../../core/sched/scheduler.ts';
import type { KlogProc } from '../../core/klog/records.ts';
import type { ProcLoopback } from '../proc-loopback.ts';
import { attempt, defineScript, exited, loopback, recordOf, runScript } from './proc-harness.ts';

const ROOT: ProcCred = Object.freeze({ uid: 0, gid: 0, groups: Object.freeze([]), ruid: 0 });
const BOB: ProcCred = Object.freeze({
  uid: 1002,
  gid: 1002,
  groups: Object.freeze([]),
  ruid: 1002,
});

/** Spawns argv[2] `burn` jobs at priority argv[3] and one at argv[4]; records the pids. */
defineScript('starve', function* (ctx, rec) {
  const n = Number(ctx.argv[2]);
  const high: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = yield* ctx.sys.spawn({
      path: '/bin/burn.json',
      argv: ['burn'],
      priority: Number(ctx.argv[3]),
    });
    high.push(c.pid);
  }
  const low = yield* ctx.sys.spawn({
    path: '/bin/burn.json',
    argv: ['burn'],
    priority: Number(ctx.argv[4]),
  });
  rec['high'] = high;
  rec['low'] = low.pid;
  yield* ctx.sleep(1_000_000_000);
  return 0;
});

defineScript('nice-self', function* (ctx, rec) {
  rec['before'] = yield* ctx.sys.getpriority({ pid: ctx.pid });
  rec['nice5'] = yield* ctx.sys.nice({ inc: 5 });
  rec['negative'] = yield* attempt(ctx.sys.nice({ inc: -1 }));
  rec['after'] = yield* ctx.sys.getpriority({ pid: ctx.pid });
  const bobPid = Number(ctx.argv[2]);
  rec['foreign'] = yield* attempt(ctx.sys.setpriority({ pid: bobPid, nice: 10 }));
  const child = yield* ctx.sys.spawn({ path: '/bin/script.json', argv: ['script', 'idle'] });
  rec['renice'] = yield* ctx.sys.setpriority({ pid: child.pid, nice: 12 });
  rec['raise'] = yield* attempt(ctx.sys.setpriority({ pid: child.pid, nice: 3 }));
  yield* ctx.sys.kill({ pid: child.pid, sig: 'SIGKILL' });
  yield* ctx.sys.wait({ pid: child.pid });
  return 0;
});

defineScript('idle', function* (ctx) {
  for (;;) yield* ctx.sleep(10_000);
});

defineScript('root-renice', function* (ctx, rec) {
  const target = Number(ctx.argv[2]);
  rec['lower'] = yield* ctx.sys.setpriority({ pid: target, nice: -5 });
  return 0;
});

/** READY → RUNNING records, in order, as `[t, pid]`. */
function followDispatches(lb: ProcLoopback): { log: [number, number][]; stop: () => void } {
  const log: [number, number][] = [];
  const stop = lb.kernel.klog.follow((r) => {
    if (r.kind !== 'proc') return;
    const p = r as KlogProc;
    if (p.to === 'RUNNING') log.push([p.t, p.pid]);
  });
  return { log, stop };
}

/** The longest continuous READY period W(P) of `pid` (from makeReady to dispatch), from klog. */
function followWaits(
  lb: ProcLoopback,
  pid: () => number | null,
): { waits: number[]; stop: () => void } {
  const waits: number[] = [];
  let since: number | null = null;
  const stop = lb.kernel.klog.follow((r) => {
    if (r.kind !== 'proc' || r.pid !== pid()) return;
    const p = r as KlogProc;
    if (p.to === 'READY') since = p.t;
    else if (p.to === 'RUNNING' && since !== null) {
      waits.push(p.t - since);
      since = null;
    }
  });
  return { waits, stop };
}

describe('PROC-02 ready queue', () => {
  it('PROC-02 the ready queue is the team dsa/heap binary heap', () => {
    expect(defaultHeapFactory(8)).toBeInstanceOf(BinaryHeap);
    const lb = loopback();
    expect(lb.kernel.proc.sched.readyCount).toBe(0);
  });

  it('PROC-02 setpriority re-keys a READY process in the heap: a reniced job is dispatched before its equals', async () => {
    const lb = loopback({ cores: 3 });
    const jobs = [];
    for (let i = 0; i < 4; i++) jobs.push(await lb.spawn('burn'));
    await lb.runFor(30);
    const d = followDispatches(lb);
    const last = jobs[3];
    if (last === undefined) throw new Error('no job');
    // Lower the nice of one READY job (root, kernel authority): its key drops below the others.
    const waiting = jobs.find((j) => j.state === 'READY') ?? last;
    lb.kernel.proc.setPriority(waiting, { nice: -10 });
    await lb.runFor(60);
    d.stop();
    const firstAfter = d.log[0]?.[1];
    expect(firstAfter).toBe(waiting.pid);
    for (const j of jobs) lb.kernel.proc.signalPid(j.pid, 'SIGKILL');
    await lb.runFor(50);
    lb.checkInvariants();
  });
});

describe('PROC-03 round-robin', () => {
  it('PROC-03 equal priorities share the CPU round-robin, one quantum each, and the quantum is configurable', async () => {
    const lb = loopback({ cores: 3 });
    const jobs = [await lb.spawn('burn'), await lb.spawn('burn'), await lb.spawn('burn')];
    await lb.runFor(50);
    const d = followDispatches(lb);
    await lb.runFor(300);
    d.stop();
    const order = d.log.map(([, pid]) => pid).filter((pid) => jobs.some((j) => j.pid === pid));
    expect(order.length).toBeGreaterThanOrEqual(20);
    // Every window of three consecutive dispatches holds all three jobs: FIFO within a level.
    for (let i = 0; i + 3 <= order.length; i++) expect(new Set(order.slice(i, i + 3)).size).toBe(3);
    // Slices are one normal-band quantum (10 ms): 300 ms of virtual time gives about 30 slices.
    const q = lb.kernel.proc.sched.params.quantumMs.normal;
    expect(q).toBe(10);
    expect(order.length).toBeGreaterThanOrEqual(Math.floor(300 / (q + 1)) - 2);

    // Configurable: a 4 ms normal quantum (sysctl) more than doubles the slices per 300 ms.
    lb.kernel.sysctl.set('sched.quantum.normal', 4);
    expect(lb.kernel.sysctl.get('sched.quantum.normal')).toBe(4);
    const d2 = followDispatches(lb);
    await lb.runFor(300);
    d2.stop();
    expect(d2.log.length).toBeGreaterThan(order.length * 2);
    expect(() => lb.kernel.sysctl.set('sched.quantum.normal', 500)).toThrow();
    for (const j of jobs) lb.kernel.proc.signalPid(j.pid, 'SIGKILL');
    await lb.runFor(50);
    lb.checkInvariants();
  });
});

describe('PROC-04 starvation bound through the kernel', () => {
  it('PROC-04 50 priority-0 burn jobs and 1 priority-39 job spawned by spawn(): the maximum wait of the low job is at most the declared 5450 ms', async () => {
    const lb = loopback({ cores: 3 });
    expect(lb.kernel.proc.sched.params.runTokens).toBe(1);
    let low: number | null = null;
    const w = followWaits(lb, () => low);
    const parent = await lb.spawn('script', {
      argv: ['script', 'starve', '50', '0', '39'],
      cred: ROOT,
    });
    expect(await lb.until(() => typeof recordOf(parent.pid)['low'] === 'number', 60_000)).toBe(
      true,
    );
    low = recordOf(parent.pid)['low'] as number;
    const high = recordOf(parent.pid)['high'] as number[];
    const n = high.length + 1;
    expect(n).toBe(51);
    const p = lb.kernel.procs.get(low);
    expect(p?.base).toBe(39);
    expect(p?.band).toBe('background');
    // The low job entered READY before we started following it: count from its admission.
    await lb.runFor(20_000);
    w.stop();
    const params = lb.kernel.proc.sched.params;
    const bound = declaredBoundMs(boundInputFromParams(params, 39, n, 1));
    expect(bound).toBe(5450);
    const maxW = Math.max(...w.waits);
    const prediction = predictedStarvationWaitMs(boundInputFromParams(params, 39, n, 1));
    console.info(
      `PROC-04 (kernel) N=${String(n)} RUN_TOKENS=${String(params.runTokens)} dispatches(P)=${String(w.waits.length)} ` +
        `maxW=${maxW.toFixed(1)}ms predicted=${String(prediction.min)}..${String(prediction.max)}ms bound=${String(bound)}ms`,
    );
    // Never starved: the low job runs again and again, each wait within the declared bound.
    expect(w.waits.length).toBeGreaterThanOrEqual(3);
    expect(maxW).toBeLessThanOrEqual(bound);
    expect(maxW).toBeGreaterThanOrEqual(prediction.min);
    for (const pid of high) expect(lb.kernel.procs.get(pid)?.slices ?? 0).toBeGreaterThan(0);
    for (const pid of [...high, low, parent.pid]) lb.kernel.proc.signalPid(pid, 'SIGKILL');
    await lb.runFor(100);
    lb.checkInvariants();
  }, 120_000);
});

describe('PROC-05 run tokens and isolation', () => {
  it('PROC-05 with hardwareConcurrency 4 at most RUN_TOKENS = 2 slices run at once, and isolation keys never share an executor', async () => {
    const lb = loopback({ cores: 4 });
    const tokens = lb.kernel.proc.sched.params.runTokens;
    expect(tokens).toBe(2);
    const alice = [await lb.spawn('burn'), await lb.spawn('burn'), await lb.spawn('burn')];
    const bob = [await lb.spawn('burn', { cred: BOB }), await lb.spawn('burn', { cred: BOB })];
    let peak = 0;
    await lb.until(() => {
      peak = Math.max(peak, lb.kernel.proc.sched.runningCount);
      return false;
    }, 500);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(tokens);
    const aliceExec = new Set(alice.map((p) => p.worker));
    const bobExec = new Set(bob.map((p) => p.worker));
    for (const e of bobExec) expect(aliceExec.has(e)).toBe(false);
    for (const s of lb.kernel.proc.pool.slots()) {
      const keys = new Set([...s.residents].map((pid) => lb.kernel.procs.get(pid)?.isolation));
      expect(keys.size).toBeLessThanOrEqual(1);
    }
    for (const p of [...alice, ...bob]) lb.kernel.proc.signalPid(p.pid, 'SIGKILL');
    await lb.runFor(50);
    lb.checkInvariants();
  });
});

describe('PROC-08 nice, renice and priorities (syscalls)', () => {
  it("PROC-08 nice raises the nice value, a negative increment or another user's process is EPERM, renice lowers a child, only root may raise it back", async () => {
    const lb = loopback();
    const bobs = await lb.spawn('script', { argv: ['script', 'idle'], cred: BOB });
    const { rec, code } = await runScript(lb, 'nice-self', { args: [String(bobs.pid)] });
    expect(code).toBe(0);
    const before = rec['before'] as {
      priority: number;
      nice: number;
      effPrio: number;
      band: string;
    };
    expect(before.nice).toBe(0);
    expect(rec['nice5']).toMatchObject({ nice: 5 });
    expect(rec['negative']).toEqual({ errno: 'EPERM' });
    const after = rec['after'] as { nice: number; effPrio: number };
    expect(after.nice).toBe(5);
    expect(rec['foreign']).toEqual({ errno: 'EPERM' });
    expect(rec['renice']).toMatchObject({ nice: 12 });
    expect(rec['raise']).toEqual({ errno: 'EPERM' });

    const root = await lb.spawn('script', {
      argv: ['script', 'root-renice', String(bobs.pid)],
      cred: ROOT,
    });
    await lb.until(() => exited(root), 5_000);
    expect(recordOf(root.pid)['lower']).toMatchObject({ nice: -5 });
    expect(lb.kernel.procs.get(bobs.pid)?.nice).toBe(-5);
    lb.kernel.proc.signalPid(bobs.pid, 'SIGKILL');
    lb.checkInvariants();
  });
});

describe('PROC-09 scale', () => {
  it('PROC-09 the process table holds 256 concurrent sleeping processes and proc.list pages through them', async () => {
    const lb = loopback();
    const kids = [];
    for (let i = 0; i < 256; i++) kids.push(await lb.spawn('script', { argv: ['script', 'idle'] }));
    await lb.runFor(100);
    const live = [...lb.kernel.procs.table.values()].filter(
      (p) => p.kind === 'user' && p.state !== 'TERMINATED',
    );
    expect(live.length).toBeGreaterThanOrEqual(256);
    expect(kids.every((k) => k.state === 'BLOCKED' && k.waitingOn === 'sleep')).toBe(true);
    // Sleepers share executors (placement rule 7): far fewer workers than processes.
    expect(lb.executors.aliveCount).toBeLessThanOrEqual(lb.kernel.proc.pool.maxExecutors);
    const lister = await lb.spawn('script', { argv: ['script', 'list-all'] });
    await lb.until(() => exited(lister), 10_000);
    expect(recordOf(lister.pid)['count']).toBeGreaterThanOrEqual(256);
    for (const k of kids) lb.kernel.proc.signalPid(k.pid, 'SIGKILL');
    await lb.runFor(100);
    lb.checkInvariants();
  }, 60_000);
});

defineScript('list-all', function* (ctx, rec) {
  let count = 0;
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const r = yield* ctx.sys['proc.list']({
      ...(cursor === undefined ? {} : { cursor }),
      limit: 100,
    });
    count += r.procs.length;
    if (r.next === undefined) break;
    cursor = r.next;
  }
  rec['count'] = count;
  return 0;
});

describe('KPS-05 run tokens and ai.embed', () => {
  it('KPS-05 while ai.embed is resident and ran a job in the last 2 s, RUN_TOKENS drops by its ORT threads, then comes back', async () => {
    const lb = loopback({ cores: 8 });
    const sched = lb.kernel.proc.sched;
    expect(sched.params.runTokens).toBe(6);
    lb.kernel.proc.setEmbedResident(true);
    expect(sched.params.runTokens).toBe(6);
    lb.kernel.proc.embedJobRan();
    expect(sched.params.runTokens).toBe(4);
    expect(sched.tokens.capacity).toBe(4);
    await lb.runFor(1_000);
    lb.kernel.proc.embedJobRan();
    await lb.runFor(1_500);
    expect(sched.params.runTokens).toBe(4);
    await lb.runFor(1_000);
    expect(sched.params.runTokens).toBe(6);
    lb.kernel.proc.embedJobRan();
    lb.kernel.proc.setEmbedResident(false);
    expect(sched.params.runTokens).toBe(6);
    lb.checkInvariants();
  });
});
