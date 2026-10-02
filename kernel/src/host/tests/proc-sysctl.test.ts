/**
 * Kernel parameters and the remaining memory calls through the system calls on the process
 * loopback host: `sysctl.get` / `sysctl.set` for the scheduler (PROC-03 configurable quanta,
 * PROC-04 T_age) and the memory manager (MEM-01 budget and soft limit, the swap tier), and
 * `mem.declare`, `mem.free {key}`, `mem.prefetch`, `mem.hint` and `mem.stat` (MEM-01), including
 * the answers before the memory manager is attached.
 */
import type { MemStat } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import {
  attempt,
  defineScript,
  exited,
  loopback,
  manifest,
  recordOf,
  runScript,
} from './proc-harness.ts';

const MiB = 1_048_576;

defineScript('tune', function* (ctx, rec) {
  rec['all'] = yield* ctx.sys['sysctl.get']({});
  rec['q'] = yield* ctx.sys['sysctl.set']({ key: 'sched.quantum.normal', value: 8 });
  rec['qGet'] = yield* ctx.sys['sysctl.get']({ key: 'sched.quantum.normal' });
  rec['qBad'] = yield* attempt(ctx.sys['sysctl.set']({ key: 'sched.quantum.normal', value: 999 }));
  rec['qType'] = yield* attempt(ctx.sys['sysctl.set']({ key: 'sched.tAge', value: 'fast' }));
  rec['tAge'] = yield* ctx.sys['sysctl.set']({ key: 'sched.tAge', value: 50 });
  rec['budget'] = yield* attempt(ctx.sys['sysctl.set']({ key: 'mm.budget', value: 128 * MiB }));
  rec['budgetBad'] = yield* attempt(ctx.sys['sysctl.set']({ key: 'mm.budget', value: 1 }));
  rec['soft'] = yield* attempt(ctx.sys['sysctl.set']({ key: 'mm.softLimit', value: 16 * MiB }));
  rec['tier'] = yield* attempt(ctx.sys['sysctl.set']({ key: 'mm.swap.tier', value: 'local' }));
  rec['tierBad'] = yield* attempt(ctx.sys['sysctl.set']({ key: 'mm.swap.tier', value: 'tape' }));
  rec['ui'] = yield* ctx.sys['sysctl.set']({ key: 'ui.theme', value: 'dark' });
  rec['uiGet'] = yield* ctx.sys['sysctl.get']({ key: 'ui.theme' });
  rec['unknown'] = yield* attempt(ctx.sys['sysctl.get']({ key: 'ui.nothing' }));
  rec['admin'] = yield* attempt(ctx.sys['sysctl.set']({ key: 'kernel.panic', value: 1 }));
  return 0;
});

defineScript('mem-calls', function* (ctx, rec) {
  rec['statBefore'] = yield* ctx.sys['mem.stat']({});
  rec['declare'] = yield* attempt(
    ctx.sys['mem.declare']({ key: 'cache', kind: 'arraybuffer', bytes: 64 * 1_024 }),
  );
  rec['redeclare'] = yield* attempt(
    ctx.sys['mem.declare']({ key: 'cache', kind: 'arraybuffer', bytes: 96 * 1_024 }),
  );
  rec['stat'] = yield* attempt(ctx.sys['mem.stat']({ pid: ctx.pid }));
  rec['freeKey'] = yield* attempt(ctx.sys['mem.free']({ key: 'cache' }));
  rec['freeSeg'] = yield* attempt(ctx.sys['mem.free']({ segId: 4_242 }));
  rec['prefetchApp'] = yield* attempt(ctx.sys['mem.prefetch']({ app: 'files' }));
  rec['prefetchSelf'] = yield* attempt(ctx.sys['mem.prefetch']({ pid: ctx.pid }));
  rec['prefetchNone'] = yield* attempt(ctx.sys['mem.prefetch']({ pid: 29_999 }));
  rec['hint'] = yield* attempt(ctx.sys['mem.hint']({ app: 'editor', ttlMs: 5_000 }));
  rec['statNone'] = yield* attempt(ctx.sys['mem.stat']({ pid: 29_999 }));
  return 0;
});

describe('PROC-03 and MEM-01 kernel parameters (sysctl)', () => {
  it('PROC-03 sysctl sets the scheduler quanta and T_age within range, MEM-01 the budget, soft limit and swap tier; bad values are EINVAL', async () => {
    const lb = loopback({ memory: true });
    const { rec, code } = await runScript(lb, 'tune');
    expect(code).toBe(0);
    const all = (rec['all'] as { values: Record<string, unknown> }).values;
    expect(all['sched.quantum.normal']).toBe(10);
    expect(all['mm.budget']).toBe(256 * MiB);
    expect(rec['q']).toEqual({ old: 10, value: 8 });
    expect(rec['qGet']).toEqual({ values: { 'sched.quantum.normal': 8 } });
    expect(lb.kernel.proc.sched.params.quantumMs.normal).toBe(8);
    expect(rec['qBad']).toEqual({ errno: 'EINVAL' });
    expect(rec['qType']).toEqual({ errno: 'EINVAL' });
    expect(rec['tAge']).toEqual({ old: 100, value: 50 });
    expect(lb.kernel.proc.sched.params.tAgeMs).toBe(50);
    expect(rec['budget']).toEqual({ old: 256 * MiB, value: 128 * MiB });
    expect(lb.mm?.budget).toBe(128 * MiB);
    expect(rec['budgetBad']).toEqual({ errno: 'EINVAL' });
    expect(rec['soft']).toMatchObject({ value: 16 * MiB });
    expect(rec['tier']).toEqual({ old: 'auto', value: 'local' });
    expect(rec['tierBad']).toEqual({ errno: 'EINVAL' });
    expect(rec['ui']).toEqual({ old: null, value: 'dark' });
    expect(rec['uiGet']).toEqual({ values: { 'ui.theme': 'dark' } });
    expect(rec['unknown']).toEqual({ errno: 'EINVAL' });
    // A key outside the session prefixes needs sys.admin.
    expect(rec['admin']).toEqual({ errno: 'EPERM' });
  });

  it('MEM-01 the memory keys answer EAGAIN until the memory manager runs; the scheduler keys always work', () => {
    const lb = loopback();
    expect(lb.kernel.sysctl.get('mm.budget')).toBe(0);
    expect(() => lb.kernel.sysctl.set('mm.budget', 128 * MiB)).toThrow();
    expect(() => lb.kernel.sysctl.set('mm.swap.tier', 'local')).toThrow();
    expect(lb.kernel.sysctl.set('sched.quantum.background', 30)).toEqual({ old: 20, value: 30 });
  });
});

describe('MEM-01 the declared-memory and hint calls', () => {
  it('MEM-01 mem.declare reserves (re-declaring charges the delta), mem.free {key} releases, unknown pids are ESRCH; prefetch and hint need their capabilities', async () => {
    const lb = loopback({ memory: true });
    const { rec, code } = await runScript(lb, 'mem-calls');
    expect(code).toBe(0);
    expect((rec['statBefore'] as MemStat).budget).toBe(256 * MiB);
    expect(rec['declare']).toEqual({ key: 'cache', bytes: 64 * 1_024 });
    expect(rec['redeclare']).toEqual({ key: 'cache', bytes: 96 * 1_024 });
    const stat = rec['stat'] as MemStat;
    expect(stat.procs?.[0]?.accounted ?? 0).toBeGreaterThanOrEqual(96 * 1_024);
    expect(rec['freeKey']).toEqual({ bytes: 96 * 1_024 });
    expect(rec['freeSeg']).toEqual({ errno: 'EINVAL' });
    // An ordinary user program holds neither mm.speculative nor mm.hint (syscall-abi.md §3.5).
    expect(rec['prefetchApp']).toEqual({ errno: 'EPERM' });
    expect(rec['hint']).toEqual({ errno: 'EPERM' });
    expect(rec['statNone']).toEqual({ errno: 'ESRCH' });
    lb.checkInvariants();
  });

  it('MEM-01 a system-class program with mm.speculative and mm.hint may pre-fetch and hint', async () => {
    const lb = loopback({
      memory: true,
      extra: [
        {
          manifest: manifest('sysscript', {
            class: 'system',
            entry: 'test/script',
            caps: ['proc', 'mem', 'mm.speculative', 'mm.hint'],
          }),
        },
      ],
    });
    const p = await lb.spawn('sysscript', {
      argv: ['script', 'mem-calls'],
      cred: { uid: 0, gid: 0, groups: [], ruid: 0 },
    });
    await lb.until(() => exited(p), 10_000);
    const rec = recordOf(p.pid);
    expect(rec['prefetchApp']).toEqual({ bytes: 0, pages: 0 });
    expect(rec['prefetchSelf']).toMatchObject({ pages: 0 });
    expect(rec['prefetchNone']).toEqual({ errno: 'ESRCH' });
    expect(rec['hint']).toEqual({});
    lb.checkInvariants();
  });

  it('MEM-01 before the memory manager is attached mem.stat reports the default budget and reservations are EAGAIN', async () => {
    const lb = loopback();
    const { rec } = await runScript(lb, 'mem-calls');
    const s = rec['statBefore'] as MemStat;
    expect(s.budget).toBe(256 * MiB);
    expect(s.accounted).toBe(0);
    expect(rec['declare']).toEqual({ errno: 'EAGAIN' });
    expect(rec['freeKey']).toEqual({ errno: 'EAGAIN' });
  });
});
