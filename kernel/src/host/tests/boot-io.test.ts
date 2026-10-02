/**
 * The composed kernel host end to end on Node (boot-and-services.md §3.2–§3.3, §3.10): the
 * worker's `BootSequence` with the kernel options a composing host passes (the executor transport,
 * the program registry, ONE kernel timer heap, the I/O layer), driven only by router messages.
 *
 * It checks the wiring this host owns: `createKernel` links the I/O layer (`installIo`), whose real
 * services replace the placeholders; the LOGIN channel crosses the router port both ways
 * (`login.hello` → `login.state`, `login.guest` → `login.result` + `login.session`); the
 * compositor handshake and `desktop.interactive` finish the boot; a program from the injected
 * registry runs on an executor of the process system; and a power action ends in
 * `kernel.halted {restart}` after the services stopped.
 */
import type { AppManifestInput } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { MemStore } from '../../core/fs/mem-store.ts';
import { DEV_IDENTITY } from '../../core/host.ts';
import type { Program } from '../../runtime/sys.ts';
import { defaultHeapFactory } from '../../core/sched/scheduler.ts';
import { TimerHeap } from '../../core/sched/timers.ts';
import { StaticProgramCatalog } from '../../core/programs/catalog.ts';
import { BootSequence, restartUrl } from '../boot-sequence.ts';
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
  serviceWorker: false,
  serviceWorkerControlled: false,
  compressionStream: true,
  measureMemory: false,
  estimate: { usage: 0, quota: 1 },
};

const HELLO: AppManifestInput = {
  name: 'hello',
  kind: 'command',
  title: 'hello',
  entry: 'test/hello',
  requires: ['svc:vfs'],
  caps: ['proc', 'fs.read', 'fs.write'],
};

interface HelloState {
  wrote: boolean;
}

const hello: Program<HelloState> = {
  init: () => ({ wrote: false }),
  *run(ctx, st) {
    const home = ctx.env.get('HOME') ?? '/tmp';
    yield* ctx.sys.writeFile({
      path: `${home}/hello.txt`,
      data: new TextEncoder().encode('hi').buffer,
    });
    st.wrote = true;
    return 0;
  },
};

function composedBoot(): {
  seq: BootSequence;
  posts: KernelToRouter[];
  executors: InProcessExecutors;
  settle: (rounds?: number) => Promise<void>;
  halted: () => number;
} {
  const clock = new ManualClock();
  const heap = new TimerHeap(defaultHeapFactory);
  const posts: KernelToRouter[] = [];
  const executors = new InProcessExecutors({
    now: () => clock.now(),
    programs: (entry) => (entry === 'test/hello' ? hello : undefined),
  });
  let halts = 0;
  const seq = new BootSequence({
    host: { clock, identity: DEV_IDENTITY, platform: LOOPBACK_PLATFORM },
    post: (m) => posts.push(m),
    timers: kernelTimersOf(heap, () => clock.now()),
    frame: (cb) => {
      queueMicrotask(cb);
    },
    ai: false,
    seed: 3,
    onHalt: () => {
      halts++;
    },
    kernelOptions: {
      timers: heap,
      executors,
      programs: new StaticProgramCatalog([HELLO]),
      io: {
        platform: { channel: () => new MessageChannel(), subtle: crypto.subtle, online: false },
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
  return { seq, posts, executors, settle, halted: () => halts };
}

function stateOf(posts: readonly KernelToRouter[], name: string): string | undefined {
  let st: string | undefined;
  for (const p of posts) if (p.t === 'svc.event' && p.name === name) st = p.state;
  return st;
}

describe('the composed kernel host (BootSequence + createKernel + installIo)', () => {
  it('BOOT-03 the real system services start, the login channel crosses the router port, and the boot reaches the desktop', async () => {
    const b = composedBoot();
    b.seq.onRouterMessage({
      t: 'boot.start',
      t0: 0,
      profile: 'normal',
      verbose: false,
      flags: [],
      caps: CAPS,
      preKernelLog: [],
    });
    // The boot driver hands the kernel its end of the compositor channel at stage 2.
    const ch = new MessageChannel();
    b.seq.onRouterMessage({ t: 'compositor.attach', port: ch.port1 });
    await b.settle();
    const kernel = b.seq.kernel;
    expect(kernel).not.toBeNull();
    // installIo ran inside createKernel: the I/O layer exists and its services replaced the
    // placeholders (no "placeholder service" warning in klog).
    expect(kernel?.io).not.toBeNull();
    const lines = kernel?.klog.read({ filter: (r) => r.kind === 'line' }) ?? [];
    expect(lines.some((r) => r.kind === 'line' && r.msg.includes('placeholder service'))).toBe(
      false,
    );
    for (const svc of ['kernel', 'sched', 'storage', 'vfs', 'mm'])
      expect(stateOf(b.posts, svc)).toBe('running');
    // The login service waits for the user: the router hears the login screen's state.
    expect(stateOf(b.posts, 'login')).toBe('starting');
    b.seq.onRouterMessage({ t: 'login.hello' });
    await b.settle(5);
    const st = b.posts.find((p) => p.t === 'login.state');
    expect(st).toBeDefined();
    if (st?.t === 'login.state') expect(st.state.users.some((u) => u.kind === 'guest')).toBe(true);

    b.seq.onRouterMessage({ t: 'login.guest', rid: 7 });
    await b.settle();
    const res = b.posts.find((p) => p.t === 'login.result');
    expect(res).toMatchObject({ t: 'login.result', rid: 7, ok: true });
    const session = b.posts.find((p) => p.t === 'login.session');
    expect(session).toMatchObject({ t: 'login.session', session: { kind: 'guest' } });
    expect(stateOf(b.posts, 'login')).toBe('running');

    b.seq.onRouterMessage({ t: 'desktop.interactive', at: 1 });
    await b.settle();
    expect(stateOf(b.posts, 'wm')).toBe('running');
    expect(stateOf(b.posts, 'desktop')).toBe('running');
    expect(kernel?.proc.desktopInteractive).toBe(true);

    // A program from the injected registry runs on an executor as the console user.
    if (kernel === null) throw new Error('no kernel');
    const s = session?.t === 'login.session' ? session.session : null;
    expect(s).not.toBeNull();
    const launched = kernel.proc.launch(
      'hello',
      ['hello'],
      { uid: s?.uid ?? 0, gid: s?.uid ?? 0 },
      {
        env: new Map([['HOME', s?.home ?? '/tmp']]),
        cwd: s?.home ?? '/',
      },
    );
    await b.settle();
    const p = await launched;
    expect(p.exitCode).toBe(0);
    expect(b.executors.starts.length).toBeGreaterThanOrEqual(1);
    const fs = kernel.io?.fs();
    expect(fs).not.toBeNull();
    ch.port1.close();
    ch.port2.close();
  });

  it('BOOT-12 a power action from the I/O layer stops the services and ends in kernel.halted with the next boot URL', async () => {
    expect(restartUrl('reboot', 'normal')).toBe('/');
    expect(restartUrl('reboot', 'safe')).toBe('/?boot=safe');
    expect(restartUrl('poweroff', 'normal')).toBeNull();
    const b = composedBoot();
    b.seq.onRouterMessage({
      t: 'boot.start',
      t0: 0,
      profile: 'normal',
      verbose: false,
      flags: [],
      caps: CAPS,
      preKernelLog: [],
    });
    await b.settle();
    const deps = b.seq.kernel?.ioDeps;
    expect(deps?.halt).toBeTypeOf('function');
    deps?.halt?.('reboot', 'menu');
    await b.settle();
    expect(b.posts.at(-1)).toEqual({ t: 'kernel.halted', restart: '/?boot=menu' });
    expect(b.halted()).toBe(1);
    // A second power action while halting is ignored.
    deps?.halt?.('poweroff', 'normal');
    await b.settle(5);
    expect(b.posts.filter((p) => p.t === 'kernel.halted')).toHaveLength(1);
  });

  it('BOOT-03 without the I/O layer a login submit is answered at once instead of hanging', () => {
    const clock = new ManualClock();
    const posts: KernelToRouter[] = [];
    const heap = new TimerHeap(defaultHeapFactory);
    const seq = new BootSequence({
      host: { clock, identity: DEV_IDENTITY, platform: LOOPBACK_PLATFORM },
      post: (m) => posts.push(m),
      timers: kernelTimersOf(heap, () => clock.now()),
      frame: (cb) => {
        queueMicrotask(cb);
      },
      ai: false,
      spawnFirstExecutor: () => Promise.resolve(),
      kernelOptions: { timers: heap },
    });
    seq.onRouterMessage({
      t: 'boot.start',
      t0: 0,
      profile: 'safe',
      verbose: false,
      flags: [],
      caps: CAPS,
      preKernelLog: [],
    });
    seq.onRouterMessage({ t: 'login.submit', rid: 3, user: 'demo', secret: 'x' });
    expect(posts.find((p) => p.t === 'login.result')).toMatchObject({ rid: 3, ok: false });
  });
  it('WM-01 a compositor port the router attaches before boot.start is bound once the kernel exists', async () => {
    const b = composedBoot();
    // The driver attaches the compositor at stage 2, which usually precedes boot.start.
    const ch = new MessageChannel();
    const seen: unknown[] = [];
    ch.port2.onmessage = (ev: MessageEvent) => {
      seen.push(ev.data);
    };
    b.seq.onRouterMessage({ t: 'compositor.attach', port: ch.port1 });
    b.seq.onRouterMessage({
      t: 'boot.start',
      t0: 0,
      profile: 'normal',
      verbose: false,
      flags: [],
      caps: CAPS,
      preKernelLog: [],
    });
    await b.settle(20);
    expect(b.seq.kernel?.io?.windows.attached).toBe(true);
    // The window table greets the shell with the session state on attach.
    expect(seen.some((m) => (m as { t?: unknown }).t === 'session')).toBe(true);
    ch.port1.close();
    ch.port2.close();
  });
});
