/**
 * UI-057: the kernel answers the recovery console's `recovery.run` actions (SVC-06, BOOT-06,
 * boot-and-services.md §3.8) with klog lines named after the action, which the console
 * (web/src/boot/recovery-console.ts `answersRun`) shows and which end its wait.
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
import type { RecoveryDeps } from '../recovery.ts';
import { runRecovery } from '../recovery.ts';
import type { CapabilityMatrix, KernelToRouter, KlogLine } from '../router-protocol.ts';

const CAPS: CapabilityMatrix = {
  secureContext: true,
  crossOriginIsolated: true,
  sab: true,
  moduleWorkers: true,
  indexedDB: false,
  webLocks: true,
  cryptoSubtle: true,
  serviceWorker: false,
  serviceWorkerControlled: false,
  compressionStream: true,
  measureMemory: false,
  estimate: { usage: 0, quota: 1 },
};

interface Boot {
  readonly seq: BootSequence;
  readonly posts: KernelToRouter[];
  readonly store: MemStore;
  settle(rounds?: number): Promise<void>;
}

function boot(store = new MemStore()): Boot {
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
    seed: 5,
    kernelOptions: {
      timers: heap,
      executors,
      programs: new StaticProgramCatalog([]),
      io: {
        platform: { channel: () => new MessageChannel(), subtle: crypto.subtle, online: false },
        store,
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
  return { seq, posts, store, settle };
}

function start(b: Boot, profile: 'normal' | 'recovery'): void {
  b.seq.onRouterMessage({
    t: 'boot.start',
    t0: 0,
    profile,
    verbose: false,
    flags: [],
    caps: CAPS,
    preKernelLog: [],
  });
  const ch = new MessageChannel();
  b.seq.onRouterMessage({ t: 'compositor.attach', port: ch.port1 });
}

function linesOf(posts: readonly KernelToRouter[], sub: string): KlogLine[] {
  return posts.flatMap((p) => (p.t === 'klog' ? p.lines.filter((l) => l.sub === sub) : []));
}

describe('UI-057 recovery console actions reach the kernel and are answered', () => {
  it('UI-057 F runs fsck on the local store and prints the report', async () => {
    const b = boot();
    start(b, 'recovery');
    await b.settle();
    b.seq.onRouterMessage({ t: 'recovery.run', action: 'fsck' });
    await b.settle(40);
    const lines = linesOf(b.posts, 'fsck').map((l) => l.msg);
    expect(lines[0]).toMatch(/^fsck: checked \d+ inodes, \d+ entries, \d+ blobs/);
    expect(lines.at(-1)).toBe('fsck: clean');
  });

  it('UI-057 L lists the boot records, S keeps saved layouts, M and C answer truthfully', async () => {
    const b = boot();
    start(b, 'recovery');
    await b.settle();
    // A saved layout of an earlier session.
    await b.store.tx(
      ['os_sessions'],
      'strict',
      (t) => {
        t.put('os_sessions', { osSessionId: 's-1', uid: 1000, savedAt: 1, windows: [] });
      },
      { label: 'test layout' },
    );
    for (const action of ['bootlog', 'reset-session', 'restore-manifests', 'clear-cache'] as const)
      b.seq.onRouterMessage({ t: 'recovery.run', action });
    await b.settle(60);

    const bootlog = linesOf(b.posts, 'bootlog').map((l) => l.msg);
    expect(bootlog[0]).toMatch(/^bootlog: 1 boot records, newest first$/);
    expect(bootlog[1]).toMatch(/^bootlog: #1 .* · recovery · recovery · build /);

    expect(linesOf(b.posts, 'reset-session').map((l) => l.msg)).toEqual([
      expect.stringMatching(/^reset-session: 1 saved layout kept as \*\.recovery-/) as string,
    ]);
    const kept: Record<string, unknown>[] = [];
    await b.store.scan<Record<string, unknown>>('os_sessions', null, (r) => kept.push(r));
    expect(kept).toHaveLength(1);
    expect(kept[0]?.['recoveryOf']).toBe('s-1');
    expect(String(kept[0]?.['osSessionId'])).toMatch(/^s-1\.recovery-/);

    expect(linesOf(b.posts, 'restore-manifests')[0]?.msg).toMatch(
      /^restore-manifests: nothing to restore: this build boots from its \d+ built-in/,
    );
    // No IndexedDB in this host: the database cannot be deleted, and the console is told so.
    expect(linesOf(b.posts, 'clear-cache')[0]).toMatchObject({
      level: 'warn',
      msg: 'clear-cache: the local database cannot be deleted from here',
    });
  });
});

describe('UI-057 runRecovery', () => {
  function deps(store: MemStore, over: Partial<RecoveryDeps> = {}) {
    const log: { sub: string; level: string; msg: string }[] = [];
    const d: RecoveryDeps = {
      store: () => store,
      log: (sub, level, msg) => log.push({ sub, level, msg }),
      bootId: () => 'b-1',
      builtinManifests: 18,
      requires: () => null,
      reboot: () => undefined,
      now: () => 0,
      ...over,
    };
    return { d, log };
  }

  it('UI-057 clear-cache refuses while unsynced changes exist, and deletes and reboots otherwise', async () => {
    const store = new MemStore();
    await store.tx(['outbox'], 'strict', (t) => {
      t.put('outbox', { seq: 1, opId: 'o1', state: 'pending', osSessionId: 's', cseq: 1 });
    });
    const deleted: string[] = [];
    let reboots = 0;
    const a = deps(store, {
      deleteDatabase: (n) => {
        deleted.push(n);
        return Promise.resolve();
      },
      reboot: () => {
        reboots++;
      },
    });
    await runRecovery('clear-cache', a.d);
    expect(a.log.map((l) => l.msg)).toEqual([
      'clear-cache: refused: 1 unsynced change would be lost. Reboot normally (N) and sign in online so they sync first',
    ]);
    expect(deleted).toEqual([]);

    await store.tx(['outbox'], 'strict', (t) => {
      t.del('outbox', 1);
    });
    await runRecovery('clear-cache', a.d);
    expect(deleted).toEqual(['plotinium']);
    expect(reboots).toBe(1);
  });

  it('UI-057 an action that fails still answers, with a FAIL line', async () => {
    const store = new MemStore();
    const a = deps(store, {
      store: () => {
        throw new Error('store gone');
      },
    });
    await runRecovery('fsck', a.d);
    expect(a.log).toEqual([{ sub: 'fsck', level: 'fail', msg: 'fsck: failed: store gone' }]);
  });
});
