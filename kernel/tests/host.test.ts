import { describe, expect, it } from 'vitest';

import { DAG_IMPLEMENTED } from '@plotinium/dsa';
import { ABI_VERSION, abiDigest } from '@plotinium/protocol';

import { DEV_IDENTITY, detectBrowser, normaliseCores } from '../src/core/host.ts';
import { BootSequence } from '../src/host/boot-sequence.ts';
import { ManualClock, platformClock } from '../src/host/clock.ts';
import { spawnExecutor } from '../src/host/executors.ts';
import { LOOPBACK_PLATFORM } from '../src/host/loopback.ts';
import { installViewShadows, startKernelLink } from '../src/host/main.ts';
import type { CapabilityMatrix, KernelToRouter, KlogLine } from '../src/host/router-protocol.ts';
import { HostTimers } from '../src/host/timers.ts';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const CAPS: CapabilityMatrix = {
  secureContext: true,
  crossOriginIsolated: false,
  sab: false,
  moduleWorkers: true,
  indexedDB: true,
  webLocks: true,
  cryptoSubtle: true,
  serviceWorker: true,
  serviceWorkerControlled: false,
  compressionStream: true,
  measureMemory: false,
  estimate: { usage: 0, quota: 1 },
};

/** A test-only platform timer: callbacks run when the test advances the manual clock. */
function manualPlatform(clock: ManualClock) {
  const pending = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  return {
    set: (fn: () => void, ms: number) => {
      pending.set(++id, { at: clock.now() + ms, fn });
      return id;
    },
    clear: (h: unknown) => {
      pending.delete(h as number);
    },
    advance(ms: number) {
      clock.advance(ms);
      for (const [k, v] of [...pending]) {
        if (v.at <= clock.now()) {
          pending.delete(k);
          v.fn();
        }
      }
    },
    get size() {
      return pending.size;
    },
  };
}

describe('host helpers', () => {
  it('PLT-ID-07 the browser is detected from UA-CH brands, then the UA string, else Unknown browser', () => {
    expect(
      detectBrowser(
        [
          { brand: 'Not.A/Brand', version: '99' },
          { brand: 'Google Chrome', version: '154' },
        ],
        undefined,
      ),
    ).toEqual({ brand: 'Chrome', major: 154 });
    expect(detectBrowser([{ brand: 'Microsoft Edge', version: 'x' }], undefined)).toEqual({
      brand: 'Edge',
      major: null,
    });
    expect(
      detectBrowser(undefined, 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36 Edg/150.0'),
    ).toEqual({ brand: 'Edge', major: 150 });
    expect(detectBrowser([], 'Mozilla/5.0 Chrome/148.0 Safari')).toEqual({
      brand: 'Chrome',
      major: 148,
    });
    expect(detectBrowser(undefined, 'Firefox')).toEqual({ brand: 'Unknown browser', major: null });
    expect([normaliseCores(undefined), normaliseCores(0), normaliseCores(8)]).toEqual([1, 1, 8]);
  });

  it('KPS-13 kernel clocks: the manual clock only moves forward and the platform clock reads performance and Date', () => {
    const c = new ManualClock({ epoch0: 1_000, t0: 5 });
    expect([c.now(), c.epochMs()]).toEqual([5, 1_005]);
    expect(() => c.advance(-1)).toThrow(RangeError);
    const p = platformClock({ now: () => 42 }, { now: () => 7_000 });
    expect([p.now(), p.epochMs()]).toEqual([42, 7_000]);
    expect(p.timeZone().tz.length).toBeGreaterThan(0);
  });

  it('KPS-13 host timers arm one platform timer for the earliest deadline and fire in deadline order', () => {
    const clock = new ManualClock();
    const platform = manualPlatform(clock);
    const timers = new HostTimers(clock, platform);
    const fired: string[] = [];
    timers.at(30, () => fired.push('c'));
    const b = timers.at(20, () => fired.push('b'));
    timers.at(20, () => fired.push('b2'), -1);
    timers.at(10, () => {
      fired.push('a');
      throw new Error('a failing callback does not stop the others');
    });
    expect(platform.size).toBe(1);
    expect(timers.cancel(b)).toBe(true);
    expect(timers.cancel(b)).toBe(false);
    platform.advance(25);
    expect(fired).toEqual(['a', 'b2']);
    platform.advance(10);
    expect(fired).toEqual(['a', 'b2', 'c']);
    expect(timers.pending).toBe(0);
    expect(platform.size).toBe(0);
    expect(timers.now()).toBe(35);
  });
});

describe('boot sequence (kernel init and service start)', () => {
  function boot() {
    const clock = new ManualClock({ epoch0: 1_000_000 });
    const platform = manualPlatform(clock);
    const posts: KernelToRouter[] = [];
    const frames: (() => void)[] = [];
    let spawned = 0;
    const seq = new BootSequence({
      host: { clock, identity: DEV_IDENTITY, platform: LOOPBACK_PLATFORM },
      post: (m) => posts.push(m),
      timers: new HostTimers(clock, platform),
      frame: (cb) => frames.push(cb),
      ai: true,
      seed: 1,
      spawnFirstExecutor: () => {
        spawned++;
        return Promise.resolve();
      },
    });
    const pre: KlogLine[] = [{ t: 0, sub: 'firmware', level: 'info', msg: 'Plotinium · POST ok' }];
    const start = () => {
      seq.onRouterMessage({
        t: 'boot.start',
        t0: 1_000_000,
        profile: 'normal',
        verbose: false,
        flags: [],
        caps: CAPS,
        preKernelLog: pre,
      });
    };
    return { seq, posts, frames, start, platform, spawned: () => spawned };
  }

  it('BOOT-03 boot.start creates the kernel, reports the target weights and starts services by completion', async () => {
    const b = boot();
    b.start();
    await flush();
    expect(b.posts.find((p) => p.t === 'kernel.ready')).toBeDefined();
    const target = b.posts.find((p) => p.t === 'boot.target');
    expect(target).toMatchObject({ t: 'boot.target', target: 'desktop' });
    expect(b.spawned()).toBe(1);
    // wm waits for the compositor, desktop for the interactive mark.
    expect(b.seq.services?.stateOf('wm')).toBe('starting');
    b.seq.onRouterMessage({ t: 'compositor.attach', port: new MessageChannel().port1 });
    await flush();
    expect(b.seq.services?.stateOf('desktop')).toBe('starting');
    expect(b.seq.compositorLink).not.toBeNull();
    b.seq.onRouterMessage({ t: 'desktop.interactive', at: 500 });
    await flush();
    expect(b.seq.services?.stateOf('desktop')).toBe('running');
    expect(b.seq.servicesIn('degraded').sort()).toEqual([
      'ai.predictor',
      'ai.runtime',
      'auth',
      'complete',
      'update',
    ]);
    // sync waits on the degraded auth; lockd and ai.agent (start-degraded) still need sync settled.
    expect(b.seq.servicesIn('blocked').sort()).toEqual(['ai.indexer', 'sync']);
    expect(b.posts.some((p) => p.t === 'swRegister')).toBe(true);
    // klog lines are batched per frame and start with the pre-kernel firmware line.
    while (b.frames.length > 0) b.frames.shift()?.();
    const lines = b.posts.flatMap((p) => (p.t === 'klog' ? p.lines : []));
    expect(lines[0]).toMatchObject({ sub: 'firmware', msg: 'Plotinium · POST ok', t: 0 });
    // The fallback warning appears exactly when dsa/dag is not implemented.
    expect(
      lines.some((l) => l.sub === 'svc' && l.level === 'warn' && l.msg.includes('dsa/dag')),
    ).toBe(!DAG_IMPLEMENTED);
    expect(
      lines.some((l) => l.sub === 'svc' && l.msg.includes('30 edges · acyclic · 7 levels')),
    ).toBe(true);
    expect(lines.some((l) => l.msg.includes('pre-emption: message fallback'))).toBe(true);
    const events = b.posts.filter((p) => p.t === 'svc.event');
    expect(events.length).toBeGreaterThan(18);
    // Every started service is a process: pid 1 for the kernel, a service PCB for each other one
    // that started (sync, ai.indexer, lockd and ai.agent never started here).
    const k = b.seq.kernel;
    expect(k?.procs.table.values().filter((p) => p.kind === 'service').length).toBe(18 - 1 - 4);
    b.seq.onRouterMessage({
      t: 'boot.start',
      t0: 0,
      profile: 'normal',
      verbose: false,
      flags: [],
      caps: CAPS,
      preKernelLog: [],
    });
    expect(b.posts.filter((p) => p.t === 'kernel.ready')).toHaveLength(1);
  });

  it('BOOT-08 a sched start that fails halts the boot with a critical panic and flushes the log first', async () => {
    const clock = new ManualClock();
    const posts: KernelToRouter[] = [];
    const seq = new BootSequence({
      host: { clock, identity: DEV_IDENTITY, platform: LOOPBACK_PLATFORM },
      post: (m) => posts.push(m),
      timers: new HostTimers(clock, manualPlatform(clock)),
      frame: () => undefined,
      ai: false,
      spawnFirstExecutor: () => Promise.reject(new Error('nested workers unavailable')),
    });
    seq.onRouterMessage({
      t: 'boot.start',
      t0: 0,
      profile: 'safe',
      verbose: true,
      flags: ['url:safe'],
      caps: { ...CAPS, crossOriginIsolated: true },
      preKernelLog: [],
    });
    await flush();
    const panic = posts.find((p) => p.t === 'panic');
    expect(panic).toMatchObject({
      kind: 'critical',
      text: 'sched failed: nested workers unavailable',
    });
    expect(posts.findIndex((p) => p.t === 'klog')).toBeLessThan(
      posts.findIndex((p) => p.t === 'panic'),
    );
    seq.onRouterMessage({ t: 'net.online' });
    seq.onRouterMessage({ t: 'persist', persisted: false });
    seq.onRouterMessage({ t: 'visibility', state: 'hidden' });
    expect(
      seq.kernel?.klog
        .read({ level: 'warn' })
        .some((r) => r.kind === 'line' && r.msg.includes('persistent storage denied')),
    ).toBe(true);
  });
});

describe('executor spawning', () => {
  class FakeWorker extends EventTarget {
    posted: unknown[] = [];
    terminated = false;
    postMessage(m: unknown): void {
      this.posted.push(m);
    }
    terminate(): void {
      this.terminated = true;
    }
    emit(data: unknown): void {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
  }

  it('ABI-10 an executor with a different ABI_VERSION or digest is refused at hello', async () => {
    const good = new FakeWorker();
    const p1 = spawnExecutor(1, true, () => good as unknown as Worker);
    good.emit({ t: 'noise' });
    good.emit({ t: 'hello', abi: ABI_VERSION, digest: abiDigest() });
    const h = await p1;
    expect(h.ctl).toBeInstanceOf(Int32Array);
    expect(good.posted[0]).toMatchObject({ t: 'init', index: 1, abi: ABI_VERSION });
    const bad = new FakeWorker();
    const p2 = spawnExecutor(2, false, () => bad as unknown as Worker);
    bad.emit({ t: 'hello', abi: ABI_VERSION, digest: '0'.repeat(64) });
    await expect(p2).rejects.toThrow(/ABI mismatch/);
    expect(bad.terminated).toBe(true);
    const gap = new FakeWorker();
    const p3 = spawnExecutor(3, false, () => gap as unknown as Worker);
    gap.emit({ t: 'sandbox', failed: ['fetch'] });
    await expect(p3).rejects.toThrow(/sandbox incomplete: fetch/);
    const broken = new FakeWorker();
    const p4 = spawnExecutor(4, false, () => broken as unknown as Worker);
    broken.dispatchEvent(Object.assign(new Event('error'), { message: 'syntax error' }));
    await expect(p4).rejects.toThrow(/syntax error/);
    await expect(
      spawnExecutor(5, false, () => {
        throw new Error('no workers');
      }),
    ).rejects.toThrow('no workers');
  });
});

describe('kernel-link router', () => {
  class FakeKernelWorker extends EventTarget {
    posted: { msg: unknown; transfer: Transferable[] }[] = [];
    postMessage(msg: unknown, transfer: Transferable[] = []): void {
      this.posted.push({ msg, transfer });
    }
    emit(data: unknown): void {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
  }
  const start = {
    t0: 0,
    profile: 'normal' as const,
    verbose: false,
    flags: [],
    caps: CAPS,
    preKernelLog: [],
  };

  it('BOOT-02 the router turns kernel events into monotone progress that reaches 1 at the last A service', async () => {
    const w = new FakeKernelWorker();
    const seen: number[] = [];
    const events: string[] = [];
    let takeover = '';
    let useHere: () => void = () => undefined;
    const link = startKernelLink({
      worker: w as unknown as Worker,
      start,
      assetsTotal: 100,
      hooks: {
        onProgress: (s) => seen.push(s.p),
        onTakeover: (state, steal) => {
          takeover = state;
          useHere = steal;
        },
        onService: (name, state) => events.push(`${name}:${state}`),
        onKlog: (lines) => events.push(`klog:${String(lines.length)}`),
        onReady: () => events.push('ready'),
        onPanic: (p) => events.push(`panic:${p.kind}`),
        onHalted: () => events.push('halted'),
        onSwRegister: () => events.push('sw'),
      },
    });
    w.emit({ t: 'takeover', state: 'held-elsewhere' });
    expect(takeover).toBe('held-elsewhere');
    useHere();
    expect(w.posted.at(-1)?.msg).toEqual({ t: 'takeover.steal' });
    w.emit({ t: 'loader.config', bootFlags: {}, recentBoots: [], volumeOk: false });
    await flush();
    expect(w.posted.at(-1)?.msg).toMatchObject({ t: 'boot.start', profile: 'normal' });
    link.asset('/kernel.js', 60, false);
    link.asset('/kernel.js', 100, true);
    const weights = {
      kernel: 3,
      sched: 1,
      storage: 4,
      wm: 2,
      mm: 2,
      vfs: 5,
      login: 2,
      session: 3,
      desktop: 3,
    };
    w.emit({ t: 'boot.target', target: 'desktop', weights });
    w.emit({ t: 'kernel.ready' });
    w.emit({ t: 'klog', lines: [{ t: 0, sub: 'k', level: 'info', msg: 'm' }] });
    w.emit({ t: 'svc.event', name: 'sync', state: 'starting', at: 1, label: 'sync: connecting' });
    for (const name of Object.keys(weights))
      w.emit({ t: 'svc.event', name, state: 'running', at: 2 });
    w.emit({ t: 'asset.done', url: '/exec.js', bytes: 0 });
    w.emit({ t: 'swRegister' });
    w.emit({ t: 'swSkipWaiting' });
    w.emit({ t: 'kernel.halted', restart: null });
    w.emit({ t: 'panic', kind: 'cycle', text: 'x', cycle: ['a', 'a'] });
    w.emit('garbage');
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
    expect(seen.at(-1)).toBe(1);
    expect(events).toEqual(
      expect.arrayContaining([
        'ready',
        'klog:1',
        'sync:starting',
        'desktop:running',
        'sw',
        'halted',
        'panic:cycle',
      ]),
    );
    const ch = new MessageChannel();
    link.attachCompositor(ch.port1);
    expect(w.posted.at(-1)).toMatchObject({
      msg: { t: 'compositor.attach' },
      transfer: [ch.port1],
    });
    link.post({ t: 'net.online' });
    link.dispose();
    link.post({ t: 'net.online' });
    expect(w.posted.filter((p) => (p.msg as { t: string }).t === 'net.online')).toHaveLength(1);
  });

  it('BOOT-08 a worker error before kernel.ready is a kernel panic, and decide() chooses the profile', async () => {
    const w = new FakeKernelWorker();
    const panics: string[] = [];
    startKernelLink({
      worker: w as unknown as Worker,
      start,
      assetsTotal: 0,
      hooks: { onPanic: (p) => panics.push(p.text), decide: () => ({ ...start, profile: 'safe' }) },
    });
    w.dispatchEvent(Object.assign(new Event('error'), { message: 'SyntaxError in kernel' }));
    w.emit({ t: 'loader.config', bootFlags: {}, recentBoots: [], volumeOk: true });
    await flush();
    expect(panics).toEqual(['SyntaxError in kernel']);
    expect(w.posted.at(-1)?.msg).toMatchObject({ t: 'boot.start', profile: 'safe' });
  });

  it('BOOT-06 a failing boot-menu decision falls back to Safe mode with the loader-fallback flag', async () => {
    const w = new FakeKernelWorker();
    startKernelLink({
      worker: w as unknown as Worker,
      start,
      assetsTotal: 0,
      hooks: { decide: () => Promise.reject(new Error('menu crashed')) },
    });
    w.emit({ t: 'loader.config', bootFlags: {}, recentBoots: [], volumeOk: true });
    await flush();
    expect(w.posted.at(-1)?.msg).toMatchObject({
      t: 'boot.start',
      profile: 'safe',
      flags: ['loader-fallback'],
    });
  });

  it('SVC-16 the ARC-07 shadows make indexedDB, caches, Worker and getDirectory throw after installation', () => {
    class StorageManager {
      getDirectory(): string {
        return 'opfs';
      }
    }
    const win: Record<string, unknown> = {
      indexedDB: {},
      caches: {},
      Worker: class {},
      StorageManager,
    };
    const done = installViewShadows(win);
    expect(done).toEqual(['indexedDB', 'caches', 'Worker', 'navigator.storage.getDirectory']);
    expect(() => win['indexedDB']).toThrow('Plotinium: use the system-call interface');
    expect(() => new StorageManager().getDirectory()).toThrow(TypeError);
    // Idempotent: installing twice keeps the same shadows.
    expect(installViewShadows(win)).toEqual(done);
  });
});
