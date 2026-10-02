/**
 * UI-032: a boot on a slow network must not end in "sched failed: timeout 500 ms". `ctx.codeWait`
 * pauses a service's start budget while its own code downloads (ARC-08: the budget measures the
 * work, not the network), with its own finite cap so a download that never ends still fails.
 */
import { describe, expect, it } from 'vitest';

import type { ServiceImpl, ServiceManifest, ServiceName, StartResult } from '../src/index.ts';
import { BUILTIN_MANIFEST_FILES, CODE_WAIT_MAX_MS, ServiceManager } from '../src/index.ts';
import { builtin, FakeTimers, flush, instant, registryOf } from './helpers.ts';

const NAMES = builtin().map((m) => m.name);

interface Gate {
  open(): void;
  fail(e: Error): void;
  readonly done: Promise<void>;
}

function gate(): Gate {
  let open: () => void = () => undefined;
  let fail: (e: Error) => void = () => undefined;
  const done = new Promise<void>((res, rej) => {
    open = res;
    fail = rej;
  });
  return { open, fail, done };
}

/** `sched` as the kernel host starts it: wait for the code (codeWait), then a short hello. */
function schedLike(code: Gate, hello: Gate): ServiceImpl {
  return {
    start: async (ctx): Promise<StartResult> => {
      await ctx.codeWait(code.done);
      await hello.done;
      return { status: 'running' };
    },
    stop: () => Promise.resolve(),
  };
}

function manager(sched: ServiceImpl) {
  const timers = new FakeTimers();
  const mgr = new ServiceManager({
    profile: 'normal',
    files: BUILTIN_MANIFEST_FILES,
    source: 'builtin',
    registry: registryOf(NAMES, (n: ServiceName) => (n === 'sched' ? sched : instant())),
    timers,
    seed: 7,
    useDag: false,
    pidFor: (m: ServiceManifest) => 100 + NAMES.indexOf(m.name),
  });
  const built = mgr.build();
  if (!built.ok) throw new Error('build failed');
  mgr.start();
  return { mgr, timers };
}

describe('UI-032 the sched budget excludes the download of its code', () => {
  it('UI-032 a 3 s download followed by a quick hello starts sched (budget 500 ms)', async () => {
    const code = gate();
    const hello = gate();
    const { mgr, timers } = manager(schedLike(code, hello));
    await flush();
    expect(mgr.stateOf('sched')).toBe('starting');
    timers.advance(3_000);
    await flush();
    expect(mgr.stateOf('sched')).toBe('starting');
    code.open();
    await flush();
    timers.advance(100);
    hello.open();
    await flush();
    expect(mgr.stateOf('sched')).toBe('running');
  });

  it('UI-032 the budget still bounds the work after the download', async () => {
    const code = gate();
    const hello = gate();
    const { mgr, timers } = manager(schedLike(code, hello));
    await flush();
    timers.advance(200);
    code.open();
    await flush();
    // The wait began at once, so the whole 500 ms budget remains for the hello.
    timers.advance(499);
    await flush();
    expect(mgr.stateOf('sched')).toBe('starting');
    timers.advance(2);
    await flush();
    expect(mgr.stateOf('sched')).not.toBe('starting');
    expect(mgr.status().find((s) => s.name === 'sched')?.reason).toBe('timeout 500 ms');
  });

  it('UI-032 a download that never finishes fails at the code-wait cap', async () => {
    const code = gate();
    const hello = gate();
    const { mgr, timers } = manager(schedLike(code, hello));
    await flush();
    timers.advance(CODE_WAIT_MAX_MS - 1);
    await flush();
    expect(mgr.stateOf('sched')).toBe('starting');
    timers.advance(2);
    await flush();
    expect(mgr.status().find((s) => s.name === 'sched')?.reason).toBe(
      'timeout: code not loaded in 30 s',
    );
  });
});
