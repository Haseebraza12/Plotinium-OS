/**
 * Integration: subsystem C (predictive pre-fetch) end to end — the kernel's telemetry tap on real
 * `wm.*` bus events, the `ai.predictor` PROGRAM learning through `ai.telemetry.read` and publishing
 * through `ai.predict.publish`, the `SchedulerHints` seam driving the pre-fetch policy, and the
 * `prefetch:<app>` PROGRAM (predictive-prefetch.md §3.1–§3.8).
 */
import { describe, expect, it } from 'vitest';

import type { MemoryFacts } from '../src/kernel/predict-service.ts';
import predictor, { POLL_MS, type PredictorState, predictNow } from '../src/programs/predictor.ts';
import prefetch from '../src/programs/prefetch.ts';
import {
  AI_DAEMONS,
  AI_MANIFESTS,
  PREFETCH_PRIORITY,
  prefetchArgv,
} from '../src/programs/index.ts';
import { ProgramRunner, TestOs, type Proc, makeError, settle } from './harness/kernel.ts';

const APPS = ['editor', 'files', 'settings', 'terminal'];
const ROUTINE = ['terminal', 'editor', 'files'];
const MIB = 1_048_576;

interface Rig {
  readonly os: TestOs;
  readonly spawned: Array<{ app: string; uid: number }>;
  finish: Array<(r: { wasted: boolean }) => void>;
  memory: MemoryFacts | undefined;
  fetches: string[];
}

function rig(): Rig {
  const r: Rig = {
    spawned: [],
    finish: [],
    memory: {
      budgetBytes: 512 * MIB,
      accountedBytes: 100 * MIB,
      reservedBytes: 0,
      reclaimRunning: false,
      thrashing: false,
    },
    fetches: [],
    os: undefined as unknown as TestOs,
  };
  const os = new TestOs({
    sessionUid: 1000,
    fetch: (url) => {
      r.fetches.push(url);
      return Promise.reject(new Error('offline'));
    },
    deps: {
      memory: () => r.memory,
      declaredBytes: () => 8 * MIB,
      spawnPrefetch: (app, uid) => {
        r.spawned.push({ app, uid });
        return new Promise((resolve) => r.finish.push(resolve));
      },
    },
  });
  for (const app of APPS)
    os.fs.write(
      `/bin/${app}.json`,
      JSON.stringify({ name: app, kind: 'app', requires: [] }),
      0,
      0,
      0o644,
    );
  os.fs.write(
    '/bin/ls.json',
    JSON.stringify({ name: 'ls', kind: 'command', requires: [] }),
    0,
    0,
    0o644,
  );
  (r as { os: TestOs }).os = os;
  return r;
}

let nextPid = 2_000;

/** A user launch: the app's first window, then (later) its last window closing. */
function launch(os: TestOs, uid: number, app: string): void {
  const pid = nextPid++;
  os.uids.set(pid, uid);
  os.clock.advance(60_000);
  os.bus.publish('wm.create', { wid: pid, pid, app });
  os.bus.publish('wm.focus', { wid: pid, pid, app });
  os.clock.advance(5_000);
  os.bus.publish('wm.close', { wid: pid, pid, app });
}

function routine(os: TestOs, launches: number): void {
  for (let i = 0; i < launches; i++) launch(os, 1000, ROUTINE[i % ROUTINE.length] ?? 'files');
}

async function runPredictor(r: Rig): Promise<ProgramRunner<PredictorState>> {
  const run = new ProgramRunner(
    r.os,
    predictor,
    ['ai.predictor'],
    r.os.pcb(1000, { pid: 700, name: 'ai.predictor', cls: 'system' }),
    {
      'mem.hint': () => ({}),
    },
  );
  await run.run({ until: () => run.last?.call === 'sleep' });
  return run;
}

describe('the ai.predictor process (PRE-01, PRE-02, PRE-06)', () => {
  it('PRE-01 the model learns on the device from the telemetry ring and one prediction takes at most 5 ms', async () => {
    const r = rig();
    await r.os.startServices('ai.runtime');
    routine(r.os, 60);
    const run = await runPredictor(r);
    // It runs as its own low-priority process (PRI 32) and reads only its uid's ring.
    expect(run.proc.priority).toEqual({ priority: 22, nice: 10 });
    expect(AI_DAEMONS['ai.predictor'].argv).toEqual(['ai.predictor']);
    expect(run.state.apps).toEqual(APPS);
    expect(run.count('ai.telemetry.read')).toBeGreaterThanOrEqual(1);
    expect(run.count('ai.predict.publish')).toBe(1);

    const clock = { epochMs: r.os.clock.epochMs(), tzOffsetMin: 300 };
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) predictNow(run.state, clock);
    expect((performance.now() - t0) / 200).toBeLessThanOrEqual(5);
    expect(r.fetches).toEqual([]);
  });

  it('PRE-02 on a routine trace the learned Markov model predicts the next app, where frequency alone cannot', async () => {
    const r = rig();
    await r.os.startServices('ai.runtime');
    routine(r.os, 61); // … terminal, editor, files, terminal → next is editor
    await runPredictor(r);
    const got = (await r.os.call(r.os.pcb(1000), 'ai.predict', { k: 3 })) as {
      model: string;
      launches: number;
      predictions: Array<{ app: string; confidence: number }>;
    };
    expect(got.model).toBe('markov2');
    expect(got.launches).toBeGreaterThanOrEqual(50);
    expect(got.predictions[0]?.app).toBe('editor');
    // MFU ties the three routine apps; the model is confident about the one that comes next.
    expect(got.predictions[0]?.confidence ?? 0).toBeGreaterThan(
      got.predictions[1]?.confidence ?? 1,
    );
  });

  it('PRE-06 predictions are visible with their confidence: ai.predict, the ai.predict event for the same uid, and a residency hint', async () => {
    const r = rig();
    await r.os.startServices('ai.runtime');
    routine(r.os, 61);
    const run = await runPredictor(r);
    const events = r.os.bus.topics('ai.predict');
    expect(events.length).toBeGreaterThan(0);
    const last = events.at(-1);
    expect(last?.data).toMatchObject({ uid: 1000 });
    const hints = run.proc.calls.filter((c) => c.call === 'mem.hint');
    expect(hints[0]?.args).toMatchObject({ app: 'editor', ttlMs: 60_000 });
    expect(r.os.hooks.hooks.scheduler.residencyHint()).toMatchObject({ app: 'editor' });
    // Another user sees nothing of alice's predictions.
    const bob = (await r.os.call(r.os.pcb(1001), 'ai.predict', {})) as { predictions: unknown[] };
    expect(bob.predictions).toEqual([]);
    // Cold start: under 50 launches the model is MFU with no confident pre-fetch.
    const cold = rig();
    await cold.os.startServices('ai.runtime');
    routine(cold.os, 10);
    await runPredictor(cold);
    expect(
      ((await cold.os.call(cold.os.pcb(1000), 'ai.predict', {})) as { model: string }).model,
    ).toMatch(/^mfu/);
    expect(cold.spawned).toEqual([]);
    expect(POLL_MS).toBeGreaterThan(0);
  });
});

describe('pre-fetch jobs (PRE-03, PRE-04, PRE-06)', () => {
  async function trained(): Promise<Rig> {
    const r = rig();
    await r.os.startServices('ai.runtime');
    routine(r.os, 61);
    await runPredictor(r);
    return r;
  }

  it('PRE-04 pre-fetching runs only when idle, only within free memory, one job at a time', async () => {
    const r = await trained();
    const hooks = r.os.hooks.hooks.scheduler;
    // The confident publish while the desktop was idle already started one job; while it is
    // alive no second job starts.
    expect(r.spawned).toEqual([{ app: 'editor', uid: 1000 }]);
    hooks.onIdle(10_000);
    expect(r.os.ai.predict.lastDecision).toMatchObject({ start: false, reason: 'busy' });
    r.finish.shift()?.({ wasted: false });
    await settle();
    r.spawned.length = 0;
    // The user is active: no job.
    r.os.ai.noteInput();
    hooks.onIdle(0);
    expect(r.spawned).toEqual([]);
    expect(r.os.ai.predict.lastDecision).toMatchObject({ reason: 'not idle' });
    // Idle for 2 s but memory is tight: no job.
    r.os.clock.advance(2_500);
    r.memory = {
      budgetBytes: 512 * MIB,
      accountedBytes: 500 * MIB,
      reservedBytes: 0,
      reclaimRunning: false,
      thrashing: false,
    };
    hooks.onIdle(2_500);
    expect(r.spawned).toEqual([]);
    expect(r.os.ai.predict.lastDecision).toMatchObject({ reason: 'memory' });
    // Unknown memory facts never start a job either.
    r.memory = undefined;
    hooks.onIdle(2_500);
    expect(r.spawned).toEqual([]);
    // Idle, free memory, confident prediction: exactly one job for the predicted app.
    r.memory = {
      budgetBytes: 512 * MIB,
      accountedBytes: 100 * MIB,
      reservedBytes: 0,
      reclaimRunning: false,
      thrashing: false,
    };
    hooks.onIdle(2_500);
    hooks.onIdle(3_000);
    expect(r.spawned).toEqual([{ app: 'editor', uid: 1000 }]);
    // The job runs at the lowest priority there is.
    expect(AI_MANIFESTS.find((m) => m.name === 'prefetch')).toMatchObject({
      priority: PREFETCH_PRIORITY,
      class: 'system',
    });
    expect(PREFETCH_PRIORITY).toBe(39);
    r.finish.shift()?.({ wasted: false });
    await settle();
  });

  it('PRE-03 a pre-fetch job warms the predicted app (code and last state) and its recent files as speculative pages', async () => {
    const r = await trained();
    const warmed: unknown[] = [];
    const argv = prefetchArgv('editor', ['01890000-0000-7000-8000-0000000000f1']);
    const run = new ProgramRunner(
      r.os,
      prefetch,
      argv,
      r.os.pcb(1000, { pid: 900, name: 'prefetch' }),
      {
        'mem.prefetch': (_p: Proc, args: unknown) => {
          warmed.push(args);
          return { bytes: 4 * MIB, pages: 64 };
        },
      },
    );
    expect(await run.run()).toBe(0);
    expect(warmed).toEqual([{ app: 'editor' }, { ino: '01890000-0000-7000-8000-0000000000f1' }]);
    expect(run.state).toMatchObject({ app: 'editor', bytes: 8 * MIB, pages: 128 });
    // It never writes: only mem.prefetch calls were made.
    expect(new Set(run.proc.calls.map((c) => c.call))).toEqual(new Set(['mem.prefetch']));
  });

  it('PRE-04 a pre-fetch job never blocks the foreground: when warming would need reclaim (EAGAIN) it exits at once', async () => {
    const r = await trained();
    const run = new ProgramRunner(
      r.os,
      prefetch,
      prefetchArgv('editor'),
      r.os.pcb(1000, { pid: 901 }),
      {
        'mem.prefetch': () => {
          throw makeError('EAGAIN', { reason: 'mem-pressure' });
        },
      },
    );
    expect(await run.run()).toBe(0);
    expect(run.proc.calls).toHaveLength(1);
  });

  it('PRE-06 pre-fetch processes appear in ps under prefetch:<app>', () => {
    expect(prefetchArgv('terminal', ['a', 'b'])).toEqual([
      'prefetch:terminal',
      '--ino=a',
      '--ino=b',
    ]);
    expect(
      prefetchArgv(
        'files',
        Array.from({ length: 12 }, (_, i) => String(i)),
      ),
    ).toHaveLength(9);
  });
});

describe('telemetry privacy (PRE-05)', () => {
  it('PRE-05 telemetry stays on the device: it can be read, exported and cleared by its user only, and opt-in does not sync', async () => {
    const r = rig();
    await r.os.startServices('ai.runtime');
    routine(r.os, 5);
    const alice = r.os.pcb(1000);
    const read = (await r.os.call(alice, 'ai.telemetry.read', {})) as {
      events: Array<{ app: string; kind: string }>;
    };
    expect(read.events.filter((e) => e.kind === 'launch').map((e) => e.app)).toEqual([
      'terminal',
      'editor',
      'files',
      'terminal',
      'editor',
    ]);
    // App ids and times only (I-C6): no window titles, paths or content.
    for (const e of read.events) expect(Object.keys(e).sort()).not.toContain('title');
    const exported = new TextDecoder().decode(
      new Uint8Array((await r.os.call(alice, 'ai.telemetry.export', {})) as ArrayBuffer),
    );
    expect(exported.trim().split('\n').length).toBe(read.events.length);
    // bob's ring is his own.
    const bob = (await r.os.call(r.os.pcb(1001), 'ai.telemetry.read', {})) as { events: unknown[] };
    expect(bob.events).toEqual([]);
    // Opt-in is recorded locally; nothing is sent anywhere.
    expect(await r.os.call(alice, 'ai.telemetry.optin', { on: true })).toEqual({
      on: true,
      synced: false,
    });
    expect(r.fetches).toEqual([]);
    const cleared = (await r.os.call(alice, 'ai.telemetry.clear', {})) as { cleared: number };
    expect(cleared.cleared).toBe(read.events.length);
    expect(
      ((await r.os.call(alice, 'ai.telemetry.read', {})) as { events: unknown[] }).events,
    ).toEqual([]);
  });
});
