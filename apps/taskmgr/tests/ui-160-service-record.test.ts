/**
 * Verifier regression (Wave 3, verify-c): a daemon service shows up twice in `ps`, as the
 * kernel's service record "[ai.indexer]" (uid 0, no executor) and as the program "ai.indexer"
 * it runs (on an executor). Once UI-160 dropped the brackets, both rows read "ai.indexer ·
 * background" and the AI tab pointed at the record's pid instead of the working indexer.
 */
import { describe, expect, it } from 'vitest';

import { badgesOf, findProcess, isServiceRecord, toAiModel, toProcessRow } from '../model.ts';
import { proc, T0 } from './fake-sys.ts';

const record = (pid: number, name: string): ReturnType<typeof proc> =>
  proc({
    pid,
    argv: [`[${name}]`],
    class: 'system',
    uid: 0,
    user: 'root',
    priority: 32,
    state: 'BLOCKED',
    waitingOn: `svc:${name}`,
    executor: null,
  });

const program = (pid: number, name: string): ReturnType<typeof proc> =>
  proc({
    pid,
    argv: [name],
    class: 'system',
    uid: 1201,
    user: 'examiner2',
    priority: 32,
    nice: 10,
    state: 'BLOCKED',
    waitingOn: 'io',
    executor: 0,
  });

describe('UI-160 service records and their programs', () => {
  it('UI-160 the service record keeps its service badge, the program shows only background', () => {
    const rec = record(14, 'ai.indexer');
    const prog = program(15, 'ai.indexer');
    expect(isServiceRecord(rec)).toBe(true);
    expect(isServiceRecord(prog)).toBe(false);
    expect(badgesOf(rec)).toEqual(['service', 'background']);
    expect(badgesOf(prog)).toEqual(['background']);
    const a = toProcessRow(rec, undefined, T0);
    const b = toProcessRow(prog, undefined, T0);
    expect(a.name).toBe(b.name);
    expect(a.badges).not.toEqual(b.badges);
  });

  it('UI-160 init is never a service record, and a bare-name system service keeps its badge', () => {
    expect(isServiceRecord(proc({ pid: 1, argv: ['init'], class: 'system', priority: 0 }))).toBe(
      false,
    );
    expect(badgesOf(record(2, 'sched'))).toContain('service');
    expect(badgesOf({ ...record(2, 'sched'), priority: 0 })).toEqual(['service']);
  });

  it('UI-132 the indexer shown is the working program, not the kernel record', () => {
    const procs = [record(14, 'ai.indexer'), program(15, 'ai.indexer')];
    expect(findProcess(procs, 'ai.indexer')?.pid).toBe(15);
    // Order does not matter.
    expect(findProcess([...procs].reverse(), 'ai.indexer')?.pid).toBe(15);
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
    expect(ai.indexer).toMatchObject({ pid: 15 });
  });

  it('UI-132 with no program running the record is still found, and TERMINATED is skipped', () => {
    expect(findProcess([record(14, 'ai.indexer')], 'ai.indexer')?.pid).toBe(14);
    const gone = { ...program(15, 'ai.indexer'), state: 'TERMINATED' as const };
    expect(findProcess([gone, record(14, 'ai.indexer')], 'ai.indexer')?.pid).toBe(14);
    expect(findProcess([gone], 'ai.indexer')).toBeUndefined();
  });
});
