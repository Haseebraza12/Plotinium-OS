/**
 * Task Manager model fixes of the polish wave (docs/design/bug-hunt/BUGS.md,
 * fix-apps-settings-a11y): UI-132, UI-138, UI-146, UI-160, UI-161, UI-162.
 */
import { describe, expect, it } from 'vitest';

import { descriptor } from '../index.ts';
import {
  displayName,
  EMPTY_MEMORY_HISTORY,
  findProcess,
  frameStats,
  stateReason,
  toAiModel,
  toMemoryModel,
  toProcessRow,
  toSummary,
} from '../model.ts';
import { proc, T0 } from './fake-sys.ts';

/** Kernel services as the kernel spawns them: argv[0] "[name]", parked on "svc:name". */
const service = (pid: number, name: string): ReturnType<typeof proc> =>
  proc({
    pid,
    argv: [`[${name}]`],
    class: 'system',
    uid: 0,
    user: 'root',
    state: 'BLOCKED',
    waitingOn: `svc:${name}`,
    executor: null,
  });

describe('UI-TaskManager model polish', () => {
  it('UI-160 kernel services show their bare name and an "idle" reason', () => {
    const sched = service(2, 'sched');
    expect(displayName(sched)).toBe('sched');
    expect(displayName(proc({ pid: 9, argv: ['/bin/burn'] }))).toBe('burn');
    expect(displayName(proc({ pid: 10, argv: ['[odd'] }))).toBe('[odd');
    expect(stateReason(sched)).toBe('idle');
    expect(stateReason(proc({ pid: 3, state: 'BLOCKED', waitingOn: 'page:4' }))).toBe('page-in');
    expect(stateReason(proc({ pid: 4, state: 'BLOCKED', waitingOn: 'ai:embed' }))).toBe(
      'awaiting ai',
    );
    const row = toProcessRow(sched, undefined, T0);
    expect(row).toMatchObject({ name: 'sched', reason: 'idle', badges: ['service'] });
  });

  it('UI-132 ai.indexer is found although its argv[0] is "[ai.indexer]"', () => {
    const procs = [service(2, 'sched'), { ...service(14, 'ai.indexer'), priority: 32 }];
    expect(findProcess(procs, 'ai.indexer')?.pid).toBe(14);
    const ai = toAiModel({
      aiAvailable: true,
      index: null,
      chunksPerSecond: 0,
      procs,
      net: null,
      audit: [],
      requireConfirm: true,
      now: T0,
    });
    expect(ai.indexer).toMatchObject({ pid: 14, priority: 32 });
  });

  it('UI-138 the summary counts running executors and names the pool ceiling', () => {
    const procs = [service(2, 'sched'), proc({ pid: 21, executor: 1 })];
    expect(toSummary(procs, 0, 0, 11)).toMatchObject({ executors: 1, executorsMax: 11 });
    // One core: no ceiling above the running count, nothing extra to say.
    expect(toSummary(procs, 0, 0, 1)).not.toHaveProperty('executorsMax');
  });

  it('UI-161 frame statistics say their bucket width (4 ms)', () => {
    const stats = frameStats([16.7, 16.6, 16.8, 70]);
    expect(stats.bucketMs).toBe(4);
    expect(stats.histogram[4]).toBe(3);
    expect(stats.histogram[12]).toBe(1);
    expect(stats.longFrames).toBe(1);
  });

  it('UI-146 Pin and Reclaim carry the reason they cannot work yet', () => {
    const memory = toMemoryModel({
      stat: null,
      procs: [proc({ pid: 21 })],
      statfs: null,
      net: null,
      history: EMPTY_MEMORY_HISTORY,
      overBudgetMs: 0,
      pageInLatencies: [],
      majorFaults: 0,
      pagesOut: 0,
      budgetBytes: 256 * 1024 * 1024,
      softLimitBytes: 64 * 1024 * 1024,
      thrashingGuard: false,
      hitRatioDelta: 0,
    });
    expect(memory.pinUnavailable).toMatch(/pin call/u);
    expect(memory.reclaimUnavailable).toMatch(/mem\.pageOut/u);
  });

  it('UI-162 the pause item names both states (menus are static descriptors)', () => {
    const items = descriptor.menus?.[0]?.items ?? [];
    const pause = items.find((i) => 'id' in i && i.id === 'view.pause');
    expect(pause !== undefined && 'label' in pause ? pause.label : '').toBe(
      'Pause or Resume Live Updates',
    );
  });
});
