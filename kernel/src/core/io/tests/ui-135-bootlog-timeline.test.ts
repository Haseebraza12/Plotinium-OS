/**
 * UI-135: `bootlog` keeps the boot timeline. Scheduler transitions and syscall traces are dmesg's,
 * not the boot log's; the current boot answers from the record frozen at desktop-interactive, so a
 * busy desktop cannot push the boot out; `--list` returns the stored boot records.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { RetOf } from '@plotinium/protocol';

import type { Program } from '../../../runtime/sys.ts';
import { onTimeline } from '../bootlog.ts';
import { BOOT_RECORD_REFRESH_MS } from '../index.ts';
import type { World } from './world.ts';
import { bootToDesktop, settle } from './world.ts';

let world: World | null = null;
afterEach(() => {
  world?.close();
  world = null;
});

interface Out {
  bootlog?: RetOf<'bootlog'>;
}

function bootlog(out: Out, list: boolean): Program<Out> {
  return {
    init: () => out,
    *run(ctx, st) {
      st.bootlog = yield* ctx.sys.bootlog(list ? { list: true } : {});
      return 0;
    },
  };
}

/** A process that makes `n` system calls: scheduler transitions and traces in klog. */
function busy(n: number): Program<Record<string, never>> {
  return {
    init: () => ({}),
    *run(ctx) {
      for (let i = 0; i < n; i++) yield* ctx.sys.stat({ path: '/' });
      return 0;
    },
  };
}

describe('UI-135 bootlog keeps the boot timeline', () => {
  it('UI-135 the timeline has subsystem lines and process start and exit, never traces or dispatches', () => {
    expect(onTimeline({ kind: 'line', t: 0, sub: 'vfs', level: 'info', msg: 'mounted' })).toBe(
      true,
    );
    expect(onTimeline({ kind: 'proc', t: 0, pid: 5, from: null, to: 'NEW', reason: 'spawn' })).toBe(
      true,
    );
    expect(
      onTimeline({ kind: 'proc', t: 0, pid: 5, from: 'RUNNING', to: 'TERMINATED', reason: 'exit' }),
    ).toBe(true);
    expect(
      onTimeline({ kind: 'proc', t: 0, pid: 5, from: 'READY', to: 'RUNNING', reason: 'dispatch' }),
    ).toBe(false);
    expect(
      onTimeline({ kind: 'trace', t: 0, pid: 5, uid: 0, call: 'sleep', errno: null, us: 1 }),
    ).toBe(false);
  });

  it('UI-135 after heavy activity the current boot still starts at the kernel and lists records', async () => {
    world = await bootToDesktop();
    const w = world;
    await settle(8);
    const first: Out = {};
    const p1 = w.lb.spawn(bootlog(first, false), { name: 'bootlog' });
    await w.lb.run(p1.pid);
    const before = first.bootlog?.entries ?? [];
    expect(before.length).toBeGreaterThan(5);

    // Let the late-services refresh pass, then keep the desktop busy: scheduler transitions,
    // traces and free-text lines logged long after the boot.
    const t0 = w.clock.now();
    await w.until(() => w.clock.now() > t0 + BOOT_RECORD_REFRESH_MS + 100);
    const pb = w.lb.spawn(busy(20), { name: 'busy' });
    await w.lb.run(pb.pid);
    // klog holds the scheduler transitions of that process; the timeline must not.
    const noisy = w.lb.kernel.klog
      .read()
      .filter((r) => r.kind === 'proc' && r.pid === pb.pid && !onTimeline(r));
    expect(noisy.length).toBeGreaterThan(0);
    w.lb.kernel.log('later', 'info', 'an hour later');

    const after: Out = {};
    const p2 = w.lb.spawn(bootlog(after, true), { name: 'bootlog' });
    await w.lb.run(p2.pid);
    const entries = after.bootlog?.entries ?? [];
    expect(entries[0]).toEqual(before[0]);
    expect(entries.some((e) => e.sub === 'trace')).toBe(false);
    expect(entries.some((e) => /READY → RUNNING/.test(e.msg))).toBe(false);
    expect(entries.some((e) => e.sub === 'later')).toBe(false);
    expect(after.bootlog?.boots).toEqual([
      expect.objectContaining({
        seq: 1,
        outcome: 'interactive',
        current: true,
        reachedLogin: true,
      }),
    ]);
  });
});
