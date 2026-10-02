import { describe, expect, expectTypeOf, it } from 'vitest';

import type { IntHashTable } from '@plotinium/dsa';

import { EventBus } from '../src/core/events/bus.ts';
import { Klog } from '../src/core/klog/klog.ts';
import type { KlogProc } from '../src/core/klog/records.ts';
import { listProcs, toProcInfo } from '../src/core/proc/info.ts';
import { EDGES, isAllowedEdge, Lifecycle, waitStatusOf } from '../src/core/proc/lifecycle.ts';
import { ProcManager, ROOT_CRED } from '../src/core/proc/manager.ts';
import type { PCB } from '../src/core/proc/pcb.ts';
import { bandOf, baseOf, createPcb } from '../src/core/proc/pcb.ts';
import { PidAllocator, PID_MAX } from '../src/core/proc/pid.ts';
import {
  createProcessTable,
  MapProcessTable,
  PidTableProcessTable,
} from '../src/core/proc/table.ts';
import { StaticUserDirectory } from '../src/core/proc/users.ts';
import type { SchedulableProcess } from '../src/core/sched/types.ts';

const alice = { uid: 1001, gid: 1001, groups: [], ruid: 1001 };

function setup(limits?: { procMax?: number; nprocPerUid?: number }) {
  let t = 0;
  const klog = new Klog();
  const bus = new EventBus(() => 1_000 + t);
  const now = (): number => t;
  const lifecycle = new Lifecycle({ klog, bus, now });
  const procs = new ProcManager({
    table: new MapProcessTable(),
    lifecycle,
    now,
    ...(limits ? { limits } : {}),
  });
  const init = procs.createInit();
  return { klog, bus, lifecycle, procs, init, tick: (ms: number) => (t += ms) };
}

const edges = (klog: Klog, pid: number): string[] =>
  klog.read({ filter: (r) => r.kind === 'proc' && r.pid === pid }).map((r) => {
    const p = r as KlogProc;
    return `${p.from ?? '-'}>${p.to ?? '-'}`;
  });

describe('PCB', () => {
  it('PROC-01 a PCB carries the Spec §9.1 fields and satisfies the scheduler view structurally', () => {
    const pcb = createPcb({
      pid: 7,
      ppid: 1,
      kind: 'user',
      cls: 'user',
      name: 'sh',
      cred: alice,
      caps: ['proc'],
      now: 5,
    });
    expect(pcb).toMatchObject({
      pid: 7,
      ppid: 1,
      pgid: 7,
      sid: 7,
      state: 'NEW',
      priority: 20,
      nice: 0,
      base: 20,
      band: 'normal',
      isolation: '1001:user',
      createdAt: 5,
    });
    expect(pcb.caps).toBeInstanceOf(Uint32Array);
    expect(pcb.sessionLeader).toBe(true);
    expectTypeOf<PCB>().toMatchTypeOf<SchedulableProcess>();
  });

  it('PROC-03 base is clamp(priority + nice, 0, 39) and the band follows it', () => {
    expect([baseOf(20, -25), baseOf(20, 25), baseOf(22, 10)]).toEqual([0, 39, 32]);
    expect([bandOf(0), bandOf(9), bandOf(10), bandOf(29), bandOf(30)]).toEqual([
      'interactive',
      'interactive',
      'normal',
      'normal',
      'background',
    ]);
    const p = createPcb({
      pid: 2,
      ppid: 1,
      kind: 'user',
      cls: 'user',
      name: 'x',
      cred: alice,
      priority: 99,
      nice: -99,
      now: 0,
    });
    expect([p.priority, p.nice, p.base]).toEqual([39, -20, 19]);
  });
});

describe('process table', () => {
  it('PROC-01 the Map stand-in and the PidTable adapter behave the same', () => {
    const backing = new Map<number, PCB>();
    const double: IntHashTable<PCB> = {
      get: (k) => backing.get(k),
      set: (k, v) => {
        backing.set(k, v);
      },
      delete: (k) => backing.delete(k),
      has: (k) => backing.has(k),
      get size() {
        return backing.size;
      },
      capacity: 8,
      forEach: (cb) => {
        backing.forEach((v, k) => cb(v, k));
      },
      keys: () => backing.keys(),
      clear: () => {
        backing.clear();
      },
      probeStats: () => ({ maxProbe: 0, meanProbe: 0, loadFactor: 0 }),
      stats: () => ({ size: backing.size, capacity: 8, bytesAllocated: 0, bytesUsed: 0 }),
      checkInvariants: () => undefined,
    };
    for (const table of [
      new MapProcessTable(),
      new PidTableProcessTable(double),
      createProcessTable(),
    ]) {
      const pcb = createPcb({
        pid: 9,
        ppid: 1,
        kind: 'user',
        cls: 'user',
        name: 'x',
        cred: alice,
        now: 0,
      });
      table.set(9, pcb);
      expect(table.has(9)).toBe(true);
      expect(table.get(9)).toBe(pcb);
      expect(table.size).toBe(1);
      expect(table.values()).toEqual([pcb]);
      expect(table.delete(9)).toBe(true);
      expect(table.get(9)).toBeUndefined();
    }
  });
});

describe('pid allocation', () => {
  it('KPS-02 pid allocation skips live pids, unreaped zombies and live pgids and sids after wrapping at 32768', () => {
    const { procs, init } = setup();
    const a = procs.create({ ppid: init.pid, kind: 'user', cls: 'user', name: 'a', cred: alice });
    expect(a.pid).toBe(2);
    // Walk the allocator to the top of the pid space, then check the wrap skips pid 2.
    const alloc = new PidAllocator(procs.table);
    (alloc as unknown as { nextPid: number }).nextPid = PID_MAX;
    expect(alloc.alloc(1001)).toBe(PID_MAX);
    expect(alloc.alloc(1001)).toBe(3);
    // A pid that names a live group is not reused.
    const b = procs.create({
      ppid: init.pid,
      kind: 'user',
      cls: 'user',
      name: 'b',
      cred: alice,
      pgid: 5,
    });
    expect(b.pid).toBe(3);
    const c = procs.create({ ppid: init.pid, kind: 'user', cls: 'user', name: 'c', cred: alice });
    expect(c.pid).toBe(4);
    expect(
      procs.create({ ppid: init.pid, kind: 'user', cls: 'user', name: 'd', cred: alice }).pid,
    ).toBe(6);
  });

  it('PROC-09 spawning up to PROC_MAX processes then one more fails with EAGAIN and leaks nothing', () => {
    const { procs, init } = setup({ procMax: 5, nprocPerUid: 3 });
    for (let i = 0; i < 3; i++)
      procs.create({ ppid: init.pid, kind: 'user', cls: 'user', name: 'x', cred: alice });
    expect(() =>
      procs.create({ ppid: init.pid, kind: 'user', cls: 'user', name: 'x', cred: alice }),
    ).toThrow(/per-user/);
    procs.create({ ppid: init.pid, kind: 'user', cls: 'user', name: 'root-ok', cred: ROOT_CRED });
    expect(() =>
      procs.create({ ppid: init.pid, kind: 'user', cls: 'user', name: 'x', cred: ROOT_CRED }),
    ).toThrow(/table full/);
    expect(procs.table.size).toBe(5);
  });
});

describe('lifecycle', () => {
  it('PROC-06 observed transitions are exactly the edges of Figure 9.1 plus the documented additions', () => {
    expect(EDGES.NEW).toEqual(['READY', 'TERMINATED']);
    expect(isAllowedEdge('RUNNING', 'SUSPENDED')).toBe(false);
    expect(isAllowedEdge('SUSPENDED', 'BLOCKED')).toBe(false);
    expect(isAllowedEdge('BLOCKED', 'SUSPENDED')).toBe(true);
    const { procs, lifecycle, init } = setup();
    const p = procs.create({ ppid: init.pid, kind: 'user', cls: 'user', name: 'x', cred: alice });
    expect(() => lifecycle.transition(p, 'RUNNING', 'dispatch')).toThrow(/illegal transition/);
    expect(() => lifecycle.annotate(p, 'sleep')).toThrow();
    expect(() => lifecycle.reaped(p, 1)).toThrow();
  });

  it('PROC-06 every process state transition emits proc.state and a klog record', () => {
    const { procs, lifecycle, init, klog, bus } = setup();
    const sub = bus.subscribe(['proc.*'], { cred: alice });
    const p = procs.create({ ppid: init.pid, kind: 'user', cls: 'user', name: 'x', cred: alice });
    lifecycle.transition(p, 'READY', 'admit');
    lifecycle.transition(p, 'RUNNING', 'dispatch');
    lifecycle.transition(p, 'BLOCKED', 'block', { waitingOn: 'sleep' });
    lifecycle.annotate(p, 'sigcont');
    lifecycle.transition(p, 'SUSPENDED', 'page-out');
    lifecycle.transition(p, 'READY', 'page-in');
    lifecycle.transition(p, 'RUNNING', 'dispatch');
    procs.terminate(p, 'exit', { code: 3, reason: 'normal' });
    expect(edges(klog, p.pid)).toEqual([
      '->NEW',
      'NEW>READY',
      'READY>RUNNING',
      'RUNNING>BLOCKED',
      'BLOCKED>BLOCKED',
      'BLOCKED>SUSPENDED',
      'SUSPENDED>READY',
      'READY>RUNNING',
      'RUNNING>TERMINATED',
      'TERMINATED>-',
    ]);
    const topics = sub.take().events.map((e) => e.topic);
    expect(topics.filter((t) => t === 'proc.state')).toHaveLength(7);
    expect(topics[0]).toBe('proc.spawn');
    expect(topics.at(-1)).toBe('proc.exit');
    expect(procs.get(p.pid)).toBeUndefined();
  });

  it('KPS-02 init is pid 1, sleeps waiting for children, and kill of pid 1 fails with EPERM even for root', () => {
    const { procs, init } = setup();
    expect(init).toMatchObject({
      pid: 1,
      ppid: 0,
      name: 'init',
      state: 'BLOCKED',
      waitingOn: 'wait:-1',
      kind: 'kthread',
    });
    expect(() => procs.terminate(init, 'signal:9', { code: 137, reason: 'signal', by: 0 })).toThrow(
      /init cannot be terminated/,
    );
    expect(() => procs.createInit()).toThrow();
  });

  it('PROC-07 kill re-parents children to init, init reaps zombies, and cleanups run once', () => {
    const { procs, init, lifecycle } = setup();
    const cleaned: number[] = [];
    const off = procs.onTerminate((p) => cleaned.push(p.pid));
    const parent = procs.create({
      ppid: init.pid,
      kind: 'user',
      cls: 'user',
      name: 'sh',
      cred: alice,
    });
    const child = procs.create({
      ppid: parent.pid,
      kind: 'user',
      cls: 'user',
      name: 'sleep',
      cred: alice,
    });
    const zombie = procs.create({
      ppid: parent.pid,
      kind: 'user',
      cls: 'user',
      name: 'done',
      cred: alice,
    });
    procs.terminate(zombie, 'exit', { code: 0, reason: 'normal' });
    expect(procs.get(zombie.pid)?.state).toBe('TERMINATED'); // parent is not init: kept as a zombie
    lifecycle.transition(parent, 'READY', 'admit');
    procs.terminate(parent, 'signal:9', { code: 137, reason: 'signal', by: 1 });
    expect(child.ppid).toBe(1);
    expect(init.children.has(child.pid)).toBe(true);
    expect(procs.get(zombie.pid)).toBeUndefined();
    expect(procs.get(parent.pid)).toBeUndefined();
    expect(cleaned).toEqual([zombie.pid, parent.pid]);
    procs.terminate(parent, 'exit', { code: 0, reason: 'normal' });
    expect(cleaned).toHaveLength(2);
    off();
    procs.terminate(child, 'exit', { code: 0, reason: 'normal' });
    expect(cleaned).toHaveLength(2);
  });

  it('ABI-09 a process ended by a signal reports status 128 + n', () => {
    const p = createPcb({
      pid: 3,
      ppid: 1,
      kind: 'user',
      cls: 'user',
      name: 'x',
      cred: alice,
      now: 0,
    });
    p.exitReason = 'signal';
    p.exitCode = 137;
    expect(waitStatusOf(p)).toEqual({ kind: 'signaled', signal: 'SIGKILL', code: 137 });
    p.exitCode = 143;
    expect(waitStatusOf(p)).toMatchObject({ signal: 'SIGTERM' });
    p.exitReason = 'normal';
    p.exitCode = 3;
    expect(waitStatusOf(p)).toEqual({ kind: 'exited', code: 3 });
  });

  it('KPS-01 kernel threads and services have a pid, run as root and show in brackets', () => {
    const { procs } = setup();
    const svc = procs.createKernelProcess('syncd', 'service', 20);
    expect(svc).toMatchObject({
      ppid: 1,
      kind: 'service',
      argv: ['[syncd]'],
      state: 'BLOCKED',
      waitingOn: 'svc:syncd',
    });
    expect(svc.cred.uid).toBe(0);
    expect(() =>
      procs.create({ ppid: 999, kind: 'user', cls: 'user', name: 'x', cred: alice }),
    ).toThrow(/parent/);
  });
});

describe('proc.list rows', () => {
  it('PROC-08 rows are world-visible, paginated by pid and reduce other uids argv to argv[0]', () => {
    const { procs, init } = setup();
    for (let i = 0; i < 4; i++)
      procs.create({
        ppid: init.pid,
        kind: 'user',
        cls: 'user',
        name: 'cat',
        argv: ['cat', `f${String(i)}`],
        cred: alice,
      });
    const users = new StaticUserDirectory([[1001, 'alice']]);
    const ctx = {
      viewer: { uid: 1002, gid: 1002, groups: [], ruid: 1002 },
      users,
      epochAtZero: 1_000,
      now: 10,
    };
    const page1 = listProcs(procs.table.values(), { limit: 2 }, ctx);
    expect(page1.procs.map((p) => p.pid)).toEqual([1, 2]);
    expect(page1.next).toBe('2');
    const page2 = listProcs(procs.table.values(), { cursor: page1.next ?? '', limit: 10 }, ctx);
    expect(page2.procs.map((p) => p.pid)).toEqual([3, 4, 5]);
    expect(page2.next).toBeUndefined();
    expect(page2.procs[0]?.argv).toEqual(['cat']);
    const own = toProcInfo(procs.get(3) as PCB, { ...ctx, viewer: alice });
    expect(own).toMatchObject({
      argv: ['cat', 'f1'],
      user: 'alice',
      startedAt: 1_000,
      hitRatio: 1,
      executor: null,
    });
    expect(listProcs(procs.table.values(), { uid: 0 }, ctx).procs.map((p) => p.pid)).toEqual([1]);
    expect(listProcs(procs.table.values(), { pgid: 1 }, ctx).procs).toHaveLength(5);
    expect(listProcs(procs.table.values(), { cursor: 'junk' }, ctx).procs).toHaveLength(5);
    expect(users.nameOf(4242)).toBe('u4242');
    users.set(4242, 'bob');
    expect(users.nameOf(4242)).toBe('bob');
  });
});
