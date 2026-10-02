import type { KEvent, MemStat, ProcInfo } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { FIELDS } from '../../coreutils/lib/procs.ts';
import { SLOW_EVERY, TaskManagerController, UNAVAILABLE_BACKOFF_MS } from '../controller.ts';
import { badgesOf, frameStats, processName, stateView, toProcessRow } from '../model.ts';
import { FakeSys, FakeTimers, flush, MB, proc, T0 } from './fake-sys.ts';

const ENV = { now: T0, tz: 0 };

function world(procs: ProcInfo[]): { sys: FakeSys; timers: FakeTimers; tm: TaskManagerController } {
  const sys = new FakeSys()
    .on('proc.list', () => ({ procs }))
    .on('proc.cred', () => ({
      uid: 1001,
      gid: 1001,
      groups: [1001],
      user: 'student',
      groupNames: ['student'],
      home: '/home/student',
      ruid: 1001,
    }))
    .on('notify.post', () => ({ nid: 1 }));
  const timers = new FakeTimers();
  const tm = new TaskManagerController({ sys, timers, aiAvailable: true });
  return { sys, timers, tm };
}

const PROCS: ProcInfo[] = [
  proc({
    pid: 1,
    argv: ['/sbin/init'],
    user: 'root',
    uid: 0,
    state: 'BLOCKED',
    waitingOn: 'wait',
    class: 'system',
    priority: 0,
  }),
  proc({
    pid: 301,
    argv: ['/bin/burn', '--cpu'],
    state: 'RUNNING',
    cpuPct: 98.04,
    residentBytes: 12.4 * MB,
    executor: 4,
  }),
  proc({
    pid: 212,
    argv: ['ai.agent'],
    state: 'BLOCKED',
    waitingOn: 'net:llm',
    cpuPct: 4.1,
    residentBytes: 96 * MB,
    executor: 2,
  }),
  proc({
    pid: 104,
    argv: ['/bin/files'],
    state: 'SUSPENDED',
    residentBytes: 0,
    swappedBytes: 38 * MB,
    executor: null,
  }),
  proc({
    pid: 150,
    argv: ['/bin/sleep', '100'],
    state: 'BLOCKED',
    waitingOn: 'sigcont',
    cpuPct: 0.25,
    residentBytes: 2 * MB,
  }),
  proc({
    pid: 220,
    argv: ['prefetch:terminal'],
    state: 'READY',
    nice: 19,
    speculative: true,
    residentBytes: 6 * MB,
  }),
];

describe('Task Manager processes', () => {
  it('PROC-08 Task Manager rows show the same state, CPU share and memory as ps within one refresh', async () => {
    const { tm } = world(PROCS);
    await tm.refresh();
    const rows = tm.snapshot().processes;
    expect(rows).toHaveLength(PROCS.length);
    for (const p of PROCS) {
      const row = rows.find((r) => r.pid === p.pid);
      expect(row, `pid ${String(p.pid)}`).toBeDefined();
      if (row === undefined) continue;
      // ps COMMAND, %CPU and RSS columns (apps/coreutils/lib/procs.ts) against the row.
      expect(row.name).toBe(FIELDS['comm']?.text(p, ENV));
      expect(row.cpu.toFixed(1)).toBe(FIELDS['pcpu']?.text(p, ENV));
      expect(row.residentBytes).toBe(p.residentBytes);
      // ps STAT: STP for a job-control stop, else the kernel state.
      const stat = FIELDS['stat']?.text(p, ENV) ?? '';
      expect(row.state === 'STOPPED').toBe(stat.startsWith('STP'));
      if (row.state !== 'STOPPED') expect(row.state).toBe(p.state);
    }
    expect(tm.snapshot().summary.processes).toBe(PROCS.length);
    expect(tm.snapshot().loading).toBe(false);
  });

  it('PROC-08 rows carry the wait reason, badges and the protected flag', async () => {
    const { tm } = world(PROCS);
    await tm.refresh();
    const byPid = new Map(tm.snapshot().processes.map((r) => [r.pid, r]));
    expect(byPid.get(212)).toMatchObject({ state: 'BLOCKED', reason: 'awaiting llm' });
    expect(byPid.get(104)).toMatchObject({
      state: 'SUSPENDED',
      reason: 'paged out',
      swappedBytes: 38 * MB,
    });
    expect(byPid.get(104)?.executor).toBeUndefined();
    expect(byPid.get(1)).toMatchObject({ protected: true, badges: ['kernel'] });
    expect(byPid.get(220)?.badges).toContain('speculative');
    expect(byPid.get(301)?.executor).toBe(4);
  });

  it('PROC-08 End Process sends SIGTERM with kill and refreshes the list', async () => {
    const { sys, tm } = world(PROCS);
    sys.on('kill', () => ({ delivered: 1 }));
    await tm.refresh();
    const before = sys.count('proc.list');
    expect(await tm.signal(301, 'SIGTERM')).toBe(true);
    expect(sys.calls('kill')).toEqual([{ pid: 301, sig: 'SIGTERM' }]);
    expect(sys.count('proc.list')).toBe(before + 1);
    expect(tm.snapshot().notice).toEqual({ level: 'info', text: 'Sent SIGTERM to burn (pid 301)' });
    expect(tm.snapshot().pendingPid).toBeUndefined();
  });

  it('PROC-08 a refused kill is reported with the errno text, never swallowed', async () => {
    const { sys, tm } = world(PROCS);
    sys.fail('kill', 'EPERM');
    await tm.refresh();
    expect(await tm.signal(1, 'SIGKILL')).toBe(false);
    const notice = tm.snapshot().notice;
    expect(notice?.level).toBe('error');
    expect(notice?.text).toContain('init (pid 1)');
    expect(notice?.text).toContain('EPERM');
    expect(sys.calls('notify.post')).toHaveLength(1);
    expect(sys.calls('notify.post')[0]).toMatchObject({ level: 'error', title: 'Task Manager' });
  });

  it('PROC-08 Renice calls setpriority and a refused negative nice explains that only root may raise priority', async () => {
    const { sys, tm } = world(PROCS);
    sys.on('setpriority', (a) => ({
      priority: 20,
      nice: a.nice ?? 0,
      effPrio: 20 + (a.nice ?? 0),
    }));
    await tm.refresh();
    expect(await tm.renice(301, 10)).toBe(true);
    expect(sys.calls('setpriority')).toEqual([{ pid: 301, nice: 10 }]);
    expect(tm.snapshot().reniceError).toBeUndefined();

    sys.fail('setpriority', 'EPERM');
    expect(await tm.renice(301, -5)).toBe(false);
    expect(tm.snapshot().reniceError).toBe('Only root can raise priority (negative nice).');
    expect(tm.snapshot().isRoot).toBe(false);
  });

  it('PROC-08 a failing proc.list marks the view stale and keeps the last rows', async () => {
    const { sys, tm, timers } = world(PROCS);
    await tm.refresh();
    sys.fail('proc.list', 'EIO');
    timers.advance(3_000);
    await tm.refresh();
    expect(tm.snapshot().processes).toHaveLength(PROCS.length);
    expect(tm.snapshot().stale).toBe('Kernel not responding · last update 3 s ago');
  });

  it('PROC-08 polling refreshes every second, stops when paused and when stopped', async () => {
    const { sys, tm, timers } = world(PROCS);
    tm.start();
    await flush();
    expect(sys.count('proc.list')).toBe(1);
    timers.advance(1_000);
    await flush();
    expect(sys.count('proc.list')).toBe(2);
    tm.setPaused(true);
    timers.advance(3_000);
    await flush();
    expect(sys.count('proc.list')).toBe(2);
    tm.setPaused(false);
    await flush();
    expect(sys.count('proc.list')).toBe(3);
    tm.stop();
    timers.advance(5_000);
    await flush();
    expect(sys.count('proc.list')).toBe(3);
    expect(timers.pending).toBe(0);
  });

  it('PROC-08 a proc.* event brings the next refresh forward', async () => {
    const { sys, tm, timers } = world(PROCS);
    tm.start();
    await flush();
    const ev: KEvent<'proc.exit'> = {
      topic: 'proc.exit',
      seq: 1,
      t: T0,
      data: {
        pid: 301,
        status: { kind: 'signaled', signal: 'SIGTERM', code: 143 },
        reason: 'signal',
      },
    };
    tm.onEvents([ev]);
    timers.advance(300);
    await flush();
    expect(sys.count('proc.list')).toBe(2);
    tm.stop();
  });

  it('PROC-08 badges: kernel for init, service for system daemons, background replaces service', () => {
    expect(badgesOf(proc({ pid: 1, class: 'system', priority: 0 }))).toEqual(['kernel']);
    expect(badgesOf(proc({ pid: 12, class: 'system', priority: 4 }))).toEqual(['service']);
    expect(
      badgesOf(proc({ pid: 40, class: 'system', priority: 32, argv: ['ai.indexer'] })),
    ).toEqual(['background']);
    expect(
      badgesOf(proc({ pid: 220, argv: ['prefetch:terminal'], nice: 19, speculative: true })),
    ).toEqual(['speculative']);
    expect(badgesOf(proc({ pid: 302, priority: 20, nice: 5 }))).toEqual([]);
  });

  it('PROC-08 names follow basename(argv[0]) and job-control stops read as STOPPED', () => {
    expect(processName({ pid: 7, argv: ['/usr/bin/top', '-b'] })).toBe('top');
    expect(processName({ pid: 7, argv: [] })).toBe('pid 7');
    expect(stateView({ state: 'BLOCKED', waitingOn: 'sigcont' })).toBe('STOPPED');
    expect(stateView({ state: 'BLOCKED', waitingOn: 'io' })).toBe('BLOCKED');
    const row = toProcessRow(
      proc({ pid: 9, cpuPct: 250, faults: 30 }),
      { faults: 10, at: T0 - 2_000 },
      T0,
    );
    expect(row.cpu).toBe(100);
    expect(row.faults).toBe(10);
  });
});

const STAT: MemStat = {
  budget: 256 * MB,
  accounted: 231 * MB,
  reservedWaiting: 0,
  resident: 200 * MB,
  swappedLocal: 96 * MB,
  swappedRemote: 40 * MB,
  speculative: 12 * MB,
  embed: { bytes: 100 * MB, state: 'resident' },
  kernel: 18 * MB,
  faults: 1284,
  faultsPerSec: 12,
  hitRatio: 0.972,
  bytesIn: 88 * MB,
  bytesOut: 312 * MB,
  procs: [
    {
      pid: 301,
      accounted: 12 * MB,
      resident: 12 * MB,
      swapped: 0,
      faults: 3,
      hitRatio: 0.99,
      softLimit: 64 * MB,
    },
    {
      pid: 212,
      accounted: 136 * MB,
      resident: 96 * MB,
      swapped: 40 * MB,
      faults: 612,
      hitRatio: 0.81,
      softLimit: 64 * MB,
    },
  ],
};

describe('Task Manager memory', () => {
  it('MEM-07 the Memory tab shows page faults, hit ratio and bytes paged in and out from mem.stat', async () => {
    const { sys, tm } = world(PROCS);
    sys.on('mem.stat', () => STAT);
    await tm.refresh();
    const m = tm.snapshot().memory;
    expect(m.budgetBytes).toBe(256 * MB);
    expect(m.stats).toMatchObject({
      faults: 1284,
      faultsPerSecond: 12,
      hitRatio: 0.972,
      pagedInBytes: 88 * MB,
      pagedOutBytes: 312 * MB,
    });
    expect(m.swap[0]?.usedBytes).toBe(96 * MB);
    expect(m.swap[1]?.usedBytes).toBe(40 * MB);
    expect(m.segments.map((s) => s.kind)).toEqual(['kernel', 'apps', 'model', 'speculative']);
    expect(m.segments.find((s) => s.kind === 'apps')?.bytes).toBe((231 - 18 - 100 - 12) * MB);
    // Per process: faults, hit ratio, resident and swapped bytes (MEM-07), heaviest first; every
    // live process is listed, with mem.stat figures where the memory manager reports the pid.
    expect(m.processes.map((r) => r.pid)).toEqual([212, 104, 301, 220, 150, 1]);
    expect(m.totalProcesses).toBe(PROCS.length);
    expect(m.processes[0]).toMatchObject({
      name: 'ai.agent',
      faults: 612,
      residentBytes: 96 * MB,
      swappedLocalBytes: 40 * MB,
      note: 'hit 81.0%',
      overSoftLimit: true,
    });
    expect(m.staleSince).toBeUndefined();
    expect(tm.snapshot().performance.memory).toMatchObject({
      usedBytes: 231 * MB,
      totalBytes: 256 * MB,
    });
  });

  it('MEM-07 bytes-per-second samples and the page-in p95 come from successive refreshes and mem.fault events', async () => {
    const { sys, tm, timers } = world(PROCS);
    let bytesIn = 88 * MB;
    sys.on('mem.stat', () => ({ ...STAT, bytesIn }));
    await tm.refresh();
    bytesIn += 4 * MB;
    timers.advance(2_000);
    await tm.refresh();
    const m = tm.snapshot().memory;
    expect(m.stats.pagedInSamples.at(-1)).toBe(2);
    const faults = [5, 10, 200, 20].map((ms, i) => ({
      topic: 'mem.fault' as const,
      seq: i + 1,
      t: T0,
      data: {
        pid: 212,
        pageId: i,
        tier: i === 2 ? ('remote' as const) : ('local' as const),
        bytes: 65_536,
        ms,
      },
    }));
    tm.onEvents(faults);
    await tm.refresh();
    expect(tm.snapshot().memory.stats.pageInP95Ms).toBe(200);
    expect(tm.snapshot().memory.stats.majorFaults).toBe(1);
  });

  it('MEM-07 without mem.stat the Memory tab shows proc.list totals and says so', async () => {
    const { tm } = world(PROCS);
    await tm.refresh();
    const m = tm.snapshot().memory;
    expect(m.staleSince).toContain('ENOSYS');
    expect(m.budgetBytes).toBe(256 * MB);
    const agent = m.processes.find((r) => r.pid === 212);
    expect(agent).toMatchObject({ residentBytes: 96 * MB, note: 'hit 100.0%' });
    expect(m.processes.find((r) => r.pid === 104)?.tag).toBe('suspended');
  });

  it('MEM-01 the budget follows the mm.budget sysctl when mem.stat is unavailable', async () => {
    const { sys, tm } = world(PROCS);
    sys.on('sysctl.get', () => ({ values: { 'mm.budget': 512 * MB, 'sched.quantum.normal': 12 } }));
    await tm.refresh();
    expect(tm.snapshot().memory.budgetBytes).toBe(512 * MB);
    expect(tm.snapshot().scheduler.bands.find((b) => b.band === 'normal')?.quantumMs).toBe(12);
  });

  it('MEM-07 a refused call is not asked again within the back-off', async () => {
    const { sys, tm, timers } = world(PROCS);
    await tm.refresh();
    await tm.refresh();
    expect(sys.count('mem.stat')).toBe(1);
    timers.advance(UNAVAILABLE_BACKOFF_MS + 1);
    await tm.refresh();
    expect(sys.count('mem.stat')).toBe(2);
  });
});

describe('Task Manager predictions and scheduler', () => {
  it('PRE-06 the Task Manager shows current predictions with confidence and a reason', async () => {
    const { sys, tm } = world(PROCS);
    sys.on('ai.predict', () => ({
      predictions: [
        { app: 'terminal', confidence: 0.62, reason: 'after Files → Editor (markov-2, 14 obs)' },
        { app: 'files', confidence: 0.21, reason: 'after Editor (markov-1, 40 obs)' },
        { app: 'taskmgr', confidence: 0.09, reason: 'most used overall' },
        { app: 'calculator', confidence: 0.08, reason: 'unknown app' },
      ],
      model: 'markov2',
      launches: 612,
      updatedAt: T0,
    }));
    await tm.refresh();
    const p = tm.snapshot().predictions;
    expect(p.state).toBe('ready');
    expect(p.model).toBe('Markov-2 (Witten-Bell)');
    expect(p.rows).toEqual([
      { app: 'terminal', label: 'Terminal', confidence: 0.62, prefetched: true },
      { app: 'files', label: 'Files', confidence: 0.21 },
      { app: 'task-manager', label: 'Task Manager', confidence: 0.09 },
    ]);
    expect(p.reason).toBe('after Files → Editor (markov-2, 14 obs)');
    expect(p.threshold).toBe(0.4);
    expect(sys.calls('ai.predict')).toEqual([{ k: 3 }]);
  });

  it('PRE-06 cold start reports launches out of 50, and the AI-off build shows the predictor off', async () => {
    const { sys, tm } = world(PROCS);
    sys.on('ai.predict', () => ({ predictions: [], model: 'mfu', launches: 12, updatedAt: T0 }));
    await tm.refresh();
    expect(tm.snapshot().predictions).toMatchObject({
      state: 'cold',
      launches: 12,
      coldTarget: 50,
    });

    const off = new TaskManagerController({ sys, timers: new FakeTimers(), aiAvailable: false });
    const asked = sys.count('ai.predict');
    await off.refresh();
    expect(off.snapshot().predictions.state).toBe('off');
    expect(off.snapshot().ai.indexer.state).toBe('off');
    expect(sys.count('ai.predict')).toBe(asked);
  });

  it('PRE-06 predictions refresh on the slow cadence and at once on an ai.predict event', async () => {
    const { sys, tm } = world(PROCS);
    sys.on('ai.predict', () => ({ predictions: [], model: 'mfu', launches: 0, updatedAt: T0 }));
    for (let i = 0; i < SLOW_EVERY; i++) await tm.refresh();
    expect(sys.count('ai.predict')).toBe(1);
    await tm.refresh();
    expect(sys.count('ai.predict')).toBe(2);
    tm.onEvents([{ topic: 'ai.predict', seq: 1, t: T0, data: { uid: 1001, predictions: [] } }]);
    await tm.refresh();
    expect(sys.count('ai.predict')).toBe(3);
  });

  it('PROC-04 the Scheduler tab puts READY processes in their band with the waited time', async () => {
    const { tm, timers } = world(PROCS);
    await tm.refresh();
    timers.advance(1_500);
    await tm.refresh();
    const s = tm.snapshot().scheduler;
    const background = s.bands.find((b) => b.band === 'background');
    expect(background?.entries.map((e) => e.pid)).toEqual([220]);
    expect(background?.entries[0]?.waitedMs).toBe(1_500);
    expect(s.maxWaitMs).toBe(1_500);
    expect(s.running).toContainEqual({
      executor: 4,
      pid: 301,
      name: 'burn',
      band: 'normal',
      quantumMs: 10,
    });
    expect(s.bound).toEqual({ p: 39, n: 51, e: 1, qMs: 20, deltaMs: 1, hKillMs: 400 });
    // The declared PROC-04 bound with the default parameters (processes-and-scheduling.md §3.12.5).
    const b = s.bound;
    expect(
      (b.p + 1) * s.tAgeMs + Math.ceil((b.n - 1) / b.e) * (b.qMs + b.deltaMs) + b.hKillMs,
    ).toBe(5_450);
    expect(s.tAgeMs).toBe(100);
  });

  it('PROC-05 frame statistics give the p95 and a 4 ms histogram', () => {
    const f = frameStats([
      16, 16, 17, 16, 60, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 33,
    ]);
    expect(f.p95Ms).toBe(33);
    expect(f.longFrames).toBe(1);
    expect(f.histogram[4]).toBe(18);
  });
});
