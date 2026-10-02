import { describe, expect, it } from 'vitest';

import {
  forbiddenInPrecache,
  isIdentityCheck,
  isNetworkOnly,
  isRuntimeCached,
  isSwRequest,
  NAVIGATION_DENYLIST,
  NEVER_PRECACHE_GLOBS,
} from '../src/sw/routes.ts';
import type { UpdateState } from '../src/sw/update.ts';
import { createUpdateController } from '../src/sw/update.ts';

describe('Service Worker routes (offline-and-sync §3.16)', () => {
  it('SYN-14 /api/* and /ws are network-only and never navigation-routed', () => {
    for (const p of ['/api', '/api/', '/api/auth/login', '/ws', '/ws?x=1'])
      expect(isNetworkOnly(p)).toBe(true);
    for (const p of ['/', '/apiary', '/assets/index.js', '/wsx'])
      expect(isNetworkOnly(p)).toBe(false);
    const denied = (p: string): boolean => NAVIGATION_DENYLIST.some((re) => re.test(p));
    expect(denied('/api/readyz')).toBe(true);
    expect(denied('/ws')).toBe(true);
    expect(denied('/models/x/config.json')).toBe(true);
    expect(denied('/ort/ort.wasm')).toBe(true);
    expect(denied('/version.json')).toBe(true);
    expect(denied('/')).toBe(false);
    expect(denied('/settings')).toBe(false);
  });

  it('SYN-14 /models and /ort are runtime-cached and never enter the precache', () => {
    expect(isRuntimeCached('/models/Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx')).toBe(
      true,
    );
    expect(isRuntimeCached('/ort/ort-wasm-simd-threaded.asyncify.wasm')).toBe(true);
    expect(isRuntimeCached('/assets/index.js')).toBe(false);
    for (const url of [
      'models/Xenova/x.onnx',
      '/ort/ort.mjs',
      'assets/transformers-abc.js',
      'assets/embed.worker-9f1.js',
      'assets/ort-web-123.js',
      'assets/kernel.worker-1.js.map',
      'api/readyz',
      'x.wasm',
    ])
      expect(forbiddenInPrecache(url)).toBe(true);
    for (const url of ['index.html', 'assets/index-abc.js', 'sw.js', 'version.json', 'favicon.svg'])
      expect(forbiddenInPrecache(url)).toBe(false);
    expect(NEVER_PRECACHE_GLOBS).toEqual(expect.arrayContaining(['models/**', 'ort/**']));
  });

  it('OFF-05 only a no-store /version.json fetch is the identity check', () => {
    expect(isIdentityCheck('/version.json', 'no-store')).toBe(true);
    expect(isIdentityCheck('/version.json', 'default')).toBe(false);
    expect(isIdentityCheck('/boot-manifest.json', 'no-store')).toBe(false);
  });

  it('OFF-05 the worker accepts exactly SKIP_WAITING and GET_VERSION', () => {
    expect(isSwRequest({ type: 'SKIP_WAITING' })).toBe(true);
    expect(isSwRequest({ type: 'GET_VERSION' })).toBe(true);
    expect(isSwRequest({ type: 'CLAIM' })).toBe(false);
    expect(isSwRequest(null)).toBe(false);
    expect(isSwRequest('SKIP_WAITING')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The update controller against a scripted ServiceWorkerContainer.
// ---------------------------------------------------------------------------------------------

type Listener = (ev: Event) => void;

class FakeTarget {
  private readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(new Event(type));
  }
}

class FakeWorker extends FakeTarget {
  state: ServiceWorkerState;
  readonly posted: unknown[] = [];
  constructor(state: ServiceWorkerState) {
    super();
    this.state = state;
  }
  postMessage(msg: unknown, transfer?: Transferable[]): void {
    this.posted.push(msg);
    const port = transfer?.[0];
    if (port instanceof MessagePort && (msg as { type?: string }).type === 'GET_VERSION')
      port.postMessage({ version: '0.2.0', build: 'b2', date: '2026-09-26' });
  }
}

class FakeRegistration extends FakeTarget {
  active: FakeWorker | null = new FakeWorker('activated');
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  updates = 0;
  update(): Promise<void> {
    this.updates++;
    return Promise.resolve();
  }
}

class FakeContainer extends FakeTarget {
  readonly reg = new FakeRegistration();
  registered: { url: string; opts: RegistrationOptions | undefined }[] = [];
  get ready(): Promise<FakeRegistration> {
    return Promise.resolve(this.reg);
  }
  register(url: string, opts?: RegistrationOptions): Promise<FakeRegistration> {
    this.registered.push({ url, opts });
    return Promise.resolve(this.reg);
  }
}

function setup(enabled = true): {
  container: FakeContainer;
  replaced: string[];
  timers: { fn: () => void; ms: number }[];
  idle: (() => void)[];
  ctl: ReturnType<typeof createUpdateController>;
} {
  const container = new FakeContainer();
  const replaced: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const idle: (() => void)[] = [];
  const ctl = createUpdateController({
    container: container as unknown as ServiceWorkerContainer,
    replace: (u) => replaced.push(u),
    idle: (fn) => idle.push(fn),
    timers: {
      set: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
    },
    enabled,
  });
  return { container, replaced, timers, idle, ctl };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the Service Worker update controller (OFF-05)', () => {
  it('BOOT-09 registers /sw.js at scope / only after the idle callback, once, and reports offline-ready', async () => {
    const { container, idle, ctl } = setup();
    const states: UpdateState[] = [];
    ctl.subscribe((s) => states.push(s));
    const a = ctl.register();
    const b = ctl.register();
    expect(a).toBe(b);
    expect(container.registered).toHaveLength(0);
    idle.splice(0).forEach((fn) => {
      fn();
    });
    await a;
    expect(container.registered).toEqual([
      { url: '/sw.js', opts: { scope: '/', updateViaCache: 'none' } },
    ]);
    expect(ctl.state()).toMatchObject({ phase: 'active', offlineReady: true, waiting: null });
    expect(states[0]?.phase).toBe('registering');
    expect(container.reg.updates).toBeGreaterThanOrEqual(1);
  });

  it('OFF-05 a new build that finishes installing is reported as waiting with its version', async () => {
    const { container, idle, ctl } = setup();
    const p = ctl.register();
    idle.splice(0).forEach((fn) => {
      fn();
    });
    await p;
    const next = new FakeWorker('installing');
    container.reg.installing = next;
    container.reg.emit('updatefound');
    next.state = 'installed';
    container.reg.waiting = next;
    next.emit('statechange');
    await flush();
    await flush();
    expect(ctl.state().waiting).toEqual({ version: '0.2.0', build: 'b2', date: '2026-09-26' });
  });

  it('OFF-05 reboot posts SKIP_WAITING to the waiting worker and reloads on controllerchange', async () => {
    const { container, idle, replaced, timers, ctl } = setup();
    const p = ctl.register();
    idle.splice(0).forEach((fn) => {
      fn();
    });
    await p;
    const waiting = new FakeWorker('installed');
    container.reg.waiting = waiting;
    ctl.activateAndReload('/?boot=menu');
    expect(waiting.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(replaced).toEqual([]);
    container.emit('controllerchange');
    expect(replaced).toEqual(['/?boot=menu']);
    // The 5 s fallback is armed too, but the page never reloads twice.
    timers.find((t) => t.ms === 5_000)?.fn();
    ctl.activateAndReload('/');
    expect(replaced).toEqual(['/?boot=menu']);
  });

  it('OFF-05 reboot still reloads after 5 s when controllerchange never arrives', async () => {
    const { container, idle, replaced, timers, ctl } = setup();
    const p = ctl.register();
    idle.splice(0).forEach((fn) => {
      fn();
    });
    await p;
    container.reg.waiting = new FakeWorker('installed');
    ctl.activateAndReload('/');
    const fallback = timers.find((t) => t.ms === 5_000);
    expect(fallback).toBeDefined();
    fallback?.fn();
    expect(replaced).toEqual(['/']);
  });

  it('OFF-05 without a waiting worker reboot reloads at once; the dev server never registers', async () => {
    const { replaced, ctl } = setup();
    ctl.activateAndReload('/?boot=safe');
    expect(replaced).toEqual(['/?boot=safe']);
    const dev = setup(false);
    expect(dev.ctl.state().phase).toBe('off');
    await dev.ctl.register();
    expect(dev.idle).toHaveLength(0);
    expect(dev.container.registered).toHaveLength(0);
  });
});
