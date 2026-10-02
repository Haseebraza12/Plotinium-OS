/**
 * UI-007: the `update` service takes Service Worker support from the router's POST capability
 * matrix (`boot.start caps.serviceWorker`), not from the kernel worker's own navigator (a dedicated
 * worker's navigator has no `serviceWorker` in Chrome). With support, the kernel asks the router to
 * register `/sw.js` after desktop-interactive and `update` runs once the router reports it.
 */
import { describe, expect, it } from 'vitest';

import { MemStore } from '../../core/fs/mem-store.ts';
import { DEV_IDENTITY } from '../../core/host.ts';
import { StaticProgramCatalog } from '../../core/programs/catalog.ts';
import { defaultHeapFactory } from '../../core/sched/scheduler.ts';
import { TimerHeap } from '../../core/sched/timers.ts';
import { BootSequence } from '../boot-sequence.ts';
import { ManualClock } from '../clock.ts';
import { InProcessExecutors } from '../inproc-executors.ts';
import { kernelTimersOf } from '../kernel-timers.ts';
import { LOOPBACK_PLATFORM } from '../loopback.ts';
import type { CapabilityMatrix, KernelToRouter } from '../router-protocol.ts';

const CAPS: CapabilityMatrix = {
  secureContext: true,
  crossOriginIsolated: true,
  sab: true,
  moduleWorkers: true,
  indexedDB: false,
  webLocks: true,
  cryptoSubtle: true,
  serviceWorker: true,
  serviceWorkerControlled: false,
  compressionStream: true,
  measureMemory: false,
  estimate: { usage: 0, quota: 1 },
};

interface Boot {
  readonly seq: BootSequence;
  readonly posts: KernelToRouter[];
  settle(rounds?: number): Promise<void>;
}

/** A composed boot whose worker-side platform says "no Service Worker" (as Chrome's does). */
function boot(): Boot {
  const clock = new ManualClock();
  const heap = new TimerHeap(defaultHeapFactory);
  const posts: KernelToRouter[] = [];
  const executors = new InProcessExecutors({ now: () => clock.now(), programs: () => undefined });
  const seq = new BootSequence({
    host: { clock, identity: DEV_IDENTITY, platform: LOOPBACK_PLATFORM },
    post: (m) => posts.push(m),
    timers: kernelTimersOf(heap, () => clock.now()),
    frame: (cb) => {
      queueMicrotask(cb);
    },
    ai: false,
    seed: 3,
    kernelOptions: {
      timers: heap,
      executors,
      programs: new StaticProgramCatalog([]),
      io: {
        platform: {
          channel: () => new MessageChannel(),
          subtle: crypto.subtle,
          online: false,
          serviceWorker: false,
        },
        store: new MemStore(),
        verifierIterations: 1_000,
      },
    },
  });
  const settle = async (rounds = 200): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      while (executors.deliverOne()) heap.runDue(clock.now());
      clock.advance(1);
      heap.runDue(clock.now());
    }
  };
  return { seq, posts, settle };
}

function last(posts: readonly KernelToRouter[], name: string): { state?: string; reason?: string } {
  let out: { state?: string; reason?: string } = {};
  for (const p of posts)
    if (p.t === 'svc.event' && p.name === name)
      out = { state: p.state, ...(p.reason === undefined ? {} : { reason: p.reason }) };
  return out;
}

async function toDesktop(b: Boot, caps: CapabilityMatrix): Promise<void> {
  b.seq.onRouterMessage({
    t: 'boot.start',
    t0: 0,
    profile: 'normal',
    verbose: false,
    flags: [],
    caps,
    preKernelLog: [],
  });
  const ch = new MessageChannel();
  b.seq.onRouterMessage({ t: 'compositor.attach', port: ch.port1 });
  await b.settle();
  b.seq.onRouterMessage({ t: 'login.guest', rid: 1 });
  await b.settle();
  b.seq.onRouterMessage({ t: 'desktop.interactive', at: 1 });
  await b.settle();
  ch.port1.close();
  ch.port2.close();
}

describe('UI-007 Service Worker support comes from the router POST', () => {
  it('UI-007 with caps.serviceWorker the kernel asks the router to register and update runs', async () => {
    const b = boot();
    await toDesktop(b, CAPS);
    expect(b.seq.kernel?.ioDeps?.platform?.serviceWorker).toBe(true);
    expect(b.posts.some((p) => p.t === 'swRegister')).toBe(true);
    b.seq.onRouterMessage({ t: 'sw', event: 'registered' });
    await b.settle(20);
    expect(last(b.posts, 'update').state).toBe('running');
  });

  it('UI-007 without caps.serviceWorker update is degraded with the no-Service-Worker reason', async () => {
    const b = boot();
    await toDesktop(b, { ...CAPS, serviceWorker: false });
    expect(b.posts.some((p) => p.t === 'swRegister')).toBe(false);
    expect(last(b.posts, 'update')).toEqual({
      state: 'degraded',
      reason: 'no Service Worker: offline boot unavailable',
    });
  });
});
