import { describe, expect, it } from 'vitest';

import type {
  ServiceImpl,
  ServiceManifest,
  ServiceName,
  SvcEvent,
  SvcPanic,
} from '../src/index.ts';
import { BUILTIN_MANIFEST_FILES, criticalPath, ServiceManager } from '../src/index.ts';
import type { BootProfile } from '../src/types.ts';
import { builtin, controlled, FakeTimers, filesOf, flush, instant, registryOf } from './helpers.ts';

const NAMES = builtin().map((m) => m.name);

function manager(opts: {
  profile?: BootProfile;
  impls?: Partial<Record<ServiceName, ServiceImpl>>;
  files?: typeof BUILTIN_MANIFEST_FILES;
  timers?: FakeTimers;
}) {
  const timers = opts.timers ?? new FakeTimers();
  const events: SvcEvent[] = [];
  const panics: SvcPanic[] = [];
  const logs: string[] = [];
  let settled = 0;
  const registry = registryOf(NAMES, (n) => opts.impls?.[n] ?? instant());
  const mgr = new ServiceManager({
    profile: opts.profile ?? 'normal',
    files: opts.files ?? BUILTIN_MANIFEST_FILES,
    source: 'builtin',
    registry,
    timers,
    seed: 7,
    useDag: false,
    pidFor: (m: ServiceManifest) => 100 + NAMES.indexOf(m.name),
    onEvent: (e) => events.push(e),
    onPanic: (p) => panics.push(p),
    onLog: (l) => logs.push(`${l.sub}: ${l.level} ${l.msg}`),
    onSettled: () => {
      settled++;
    },
  });
  return { mgr, timers, events, panics, logs, settled: () => settled };
}

describe('service manager', () => {
  it('SVC-02 a clean boot starts all 18 services and settles, logging the fallback warning', async () => {
    const h = manager({});
    const built = h.mgr.build();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.values(built.weights).reduce((a, b) => a + b, 0)).toBe(25);
    h.mgr.start();
    await flush();
    expect(h.mgr.status().every((s) => s.state === 'running')).toBe(true);
    expect(h.settled()).toBe(1);
    expect(h.logs).toContain('svc: warn dsa/dag not implemented — using fallback order');
    expect(h.logs).toContain('svc: info 18 manifests (builtin) · 30 edges · acyclic · 7 levels');
    expect(h.mgr.status().find((s) => s.name === 'sync')?.pid).toBe(100 + NAMES.indexOf('sync'));
  });

  it('BOOT-03 in the record every service starts after all its requirements have ended', async () => {
    const h = manager({});
    h.mgr.build();
    h.mgr.start();
    await flush();
    const t = new Map(h.mgr.timings().map((x) => [x.name, x] as const));
    for (const m of builtin()) {
      for (const dep of m.requires)
        expect(t.get(m.name)?.start ?? -1).toBeGreaterThanOrEqual(t.get(dep)?.end ?? Infinity);
    }
  });

  it('BOOT-03 completion-driven start: a fast L2 service starts before a slow L1 sibling finishes', async () => {
    const wm = controlled();
    const h = manager({ impls: { wm } });
    h.mgr.build();
    h.mgr.start();
    await flush();
    // storage (L1) finished, so vfs (L2) runs although wm (L1) is still starting.
    expect(h.mgr.stateOf('vfs')).toBe('running');
    expect(h.mgr.stateOf('wm')).toBe('starting');
    expect(h.mgr.stateOf('login')).toBe('pending');
    wm.resolve();
    await flush();
    expect(h.mgr.stateOf('desktop')).toBe('running');
  });

  it('BOOT-07 a rejected non-critical start retries at 0.25–0.5, 0.5–1 and 1–2 s and resets after success', async () => {
    let fail = 3;
    const auth: ServiceImpl = {
      start: () =>
        fail-- > 0
          ? Promise.reject(new Error('backend unreachable'))
          : Promise.resolve({ status: 'running' }),
      stop: () => Promise.resolve(),
    };
    const h = manager({ impls: { auth } });
    h.mgr.build();
    h.mgr.start();
    await flush();
    const windows: [number, number][] = [
      [250, 500],
      [500, 1_000],
      [1_000, 2_000],
    ];
    for (const [lo, hi] of windows) {
      const st = h.mgr.status().find((s) => s.name === 'auth');
      expect(st?.state).toBe('retry-wait');
      const delay = (st?.nextRetryAt ?? 0) - h.timers.now();
      expect(delay).toBeGreaterThanOrEqual(lo);
      expect(delay).toBeLessThan(hi);
      h.timers.advance(delay);
      await flush();
    }
    const st = h.mgr.status().find((s) => s.name === 'auth');
    expect(st).toMatchObject({ state: 'running', attempts: 0 });
    expect(h.mgr.stateOf('desktop')).toBe('running');
  });

  it('BOOT-07 lockd starts degraded while sync is degraded and upgrades when sync recovers', async () => {
    const hold: { recover?: () => void } = {};
    const sync: ServiceImpl = {
      start: (ctx) => {
        hold.recover = () => {
          ctx.recovered();
        };
        return Promise.resolve({
          status: 'degraded',
          reason: 'offline, 3 queued',
          selfHeals: true,
        });
      },
      stop: () => Promise.resolve(),
    };
    const h = manager({ impls: { sync } });
    h.mgr.build();
    h.mgr.start();
    await flush();
    expect(h.mgr.status().find((s) => s.name === 'lockd')).toMatchObject({
      state: 'degraded',
      reason: 'requires sync',
    });
    // ai.agent is also start-degraded; nothing waits on a degraded sync with policy 'wait'.
    expect(h.mgr.stateOf('ai.agent')).toBe('degraded');
    hold.recover?.();
    await flush();
    expect(h.mgr.stateOf('sync')).toBe('running');
    expect(h.mgr.stateOf('lockd')).toBe('running');
  });

  it('BOOT-07 a failed non-critical service blocks its waiting dependents and the boot still settles', async () => {
    const sync: ServiceImpl = {
      start: () => Promise.reject(new Error('down')),
      stop: () => Promise.resolve(),
    };
    const h = manager({ impls: { sync } });
    h.mgr.build();
    h.mgr.start();
    await flush();
    expect(h.mgr.stateOf('sync')).toBe('retry-wait');
    expect(h.mgr.status().find((s) => s.name === 'lockd')).toMatchObject({
      state: 'blocked',
      reason: 'blocked by sync',
    });
    expect(h.mgr.stateOf('desktop')).toBe('running');
    expect(h.settled()).toBe(1);
    expect(
      h.events.some(
        (e) => e.name === 'sync' && e.state === 'retry-wait' && e.retryAt !== undefined,
      ),
    ).toBe(true);
  });

  it('BOOT-08 a critical start that never settles reaches the recovery screen within timeoutMs plus 100 ms', async () => {
    const storage = controlled();
    const h = manager({ impls: { storage } });
    h.mgr.build();
    h.mgr.start();
    await flush();
    h.timers.advance(3_000 + 100);
    await flush();
    expect(h.panics).toEqual([
      { kind: 'critical', text: 'storage failed: timeout 3000 ms', service: 'storage' },
    ]);
    expect(h.mgr.isHalted).toBe(true);
    // A late resolution is ignored.
    storage.resolve();
    await flush();
    expect(h.mgr.stateOf('storage')).toBe('failed');
    // Recovery-screen Retry re-runs the start (attempt n+1).
    expect(h.mgr.retry('storage')).toBe(true);
    storage.resolve();
    await flush();
    expect(h.mgr.stateOf('desktop')).toBe('running');
  });

  it('BOOT-08 a timeout scale stretches start budgets (dev server) and the panic names the scaled budget', async () => {
    const storage = controlled();
    const timers = new FakeTimers();
    const panics: SvcPanic[] = [];
    const mgr = new ServiceManager({
      profile: 'normal',
      files: BUILTIN_MANIFEST_FILES,
      source: 'builtin',
      registry: registryOf(NAMES, (n) => (n === 'storage' ? storage : instant())),
      timers,
      useDag: false,
      timeoutScale: 10,
      onPanic: (p) => panics.push(p),
    });
    mgr.build();
    mgr.start();
    await flush();
    timers.advance(3_100);
    await flush();
    expect(panics).toEqual([]);
    timers.advance(27_000);
    await flush();
    expect(panics[0]?.text).toBe('storage failed: timeout 30000 ms');
  });

  it('SVC-03 a service timeout is a timer-heap entry and cancelling on settle removes it', async () => {
    const vfs = controlled();
    const h = manager({ impls: { vfs } });
    h.mgr.build();
    h.mgr.start();
    await flush();
    expect(h.timers.armed).toBeGreaterThan(0);
    vfs.resolve();
    await flush();
    expect(h.timers.armed).toBe(0);
  });

  it('BOOT-10 user wait at login pauses the login timeout and is excluded from its own time', async () => {
    const hold: { finish?: () => void } = {};
    const login: ServiceImpl = {
      start: async (ctx) => {
        await ctx.userWait(
          new Promise<void>((r) => {
            hold.finish = r;
          }),
        );
        return { status: 'running' };
      },
      stop: () => Promise.resolve(),
    };
    const h = manager({ impls: { login } });
    h.mgr.build();
    h.mgr.start();
    await flush();
    h.timers.advance(30_000);
    await flush();
    expect(h.mgr.stateOf('login')).toBe('starting');
    hold.finish?.();
    await flush();
    expect(h.mgr.stateOf('desktop')).toBe('running');
    expect(h.mgr.timings().find((t) => t.name === 'login')?.userWaitMs).toBe(30_000);
  });

  it('SVC-05 safe mode skips the ai services and still reaches the desktop', async () => {
    const h = manager({ profile: 'safe' });
    h.mgr.build();
    h.mgr.start();
    await flush();
    const skipped = h.mgr
      .status()
      .filter((s) => s.state === 'skipped')
      .map((s) => s.name)
      .sort();
    expect(skipped).toEqual(['ai.agent', 'ai.indexer', 'ai.predictor', 'ai.runtime']);
    expect(h.mgr.stateOf('desktop')).toBe('running');
  });

  it('SVC-06 recovery mode starts exactly kernel, sched, storage, wm and vfs', async () => {
    const h = manager({ profile: 'recovery' });
    const built = h.mgr.build();
    expect(built.ok && built.target).toBe('recovery');
    h.mgr.start();
    await flush();
    const running = h.mgr
      .status()
      .filter((s) => s.state === 'running')
      .map((s) => s.name)
      .sort();
    expect(running).toEqual(['kernel', 'sched', 'storage', 'vfs', 'wm']);
    expect(h.settled()).toBe(1);
  });

  it('BOOT-04 a manifest cycle panics before any service starts', () => {
    const files = filesOf(
      builtin().map((m) => (m.name === 'auth' ? { ...m, requires: ['login', 'lockd'] } : m)),
    );
    const h = manager({ files });
    const r = h.mgr.build();
    expect(r.ok).toBe(false);
    expect(h.panics[0]?.kind).toBe('cycle');
    expect(h.panics[0]?.text).toMatch(/^dependency cycle detected among: .*auth.*lockd.*sync/);
    expect(h.events.filter((e) => e.state === 'starting')).toHaveLength(0);
  });

  it('SVC-01 an invalid manifest panics naming the file and the rule', () => {
    const files = filesOf(
      builtin().map((m) => (m.name === 'vfs' ? { ...m, requires: ['storge'] } : m)),
    );
    const h = manager({ files });
    expect(h.mgr.build()).toMatchObject({
      ok: false,
      panic: { kind: 'manifest', rule: 'V4', file: 'vfs.json' },
    });
  });

  it('BOOT-12 services stop in reverse topological order', async () => {
    const order: string[] = [];
    const h = manager({
      impls: Object.fromEntries(NAMES.map((n) => [n, instant({ status: 'running' }, order, n)])),
    });
    h.mgr.build();
    h.mgr.start();
    await flush();
    const stopping = h.mgr.stop('shutdown');
    await flush();
    await stopping;
    const pos = new Map(order.map((n, i) => [n, i] as const));
    for (const m of builtin())
      for (const dep of m.requires)
        expect(pos.get(dep)).toBeGreaterThan(pos.get(m.name) ?? Infinity);
    expect(order.at(-1)).toBe('kernel');
    expect(h.mgr.status().every((s) => s.state === 'stopped')).toBe(true);
  });

  it('BOOT-12 a stop that never finishes is forced after stopTimeoutMs', async () => {
    const hang: ServiceImpl = {
      start: () => Promise.resolve({ status: 'running' }),
      stop: () => new Promise<void>(() => undefined),
    };
    const h = manager({ impls: { update: hang } });
    h.mgr.build();
    h.mgr.start();
    await flush();
    const stopping = h.mgr.stop('restart');
    await flush();
    h.timers.advance(2_000);
    await flush();
    await stopping;
    expect(h.logs.some((l) => l.startsWith('update: warn stop timed out'))).toBe(true);
  });

  it('BOOT-11 critical path ends at desktop, follows real edges, and its durations sum to the boot time', async () => {
    const timers = new FakeTimers();
    const took: Record<string, number> = {
      storage: 60,
      vfs: 90,
      login: 130,
      session: 60,
      desktop: 330,
      wm: 20,
      mm: 10,
    };
    const timed = (name: string): ServiceImpl => ({
      start: async () => {
        await Promise.resolve();
        timers.t += took[name] ?? 1;
        return { status: 'running' };
      },
      stop: () => Promise.resolve(),
    });
    const h = manager({ timers, impls: Object.fromEntries(NAMES.map((n) => [n, timed(n)])) });
    h.mgr.build();
    h.mgr.start();
    await flush();
    const rows = criticalPath(h.mgr.timings(), h.mgr.requiresMap(), 'desktop');
    expect(rows.map((r) => r.name)).toEqual([
      'kernel',
      'storage',
      'vfs',
      'login',
      'session',
      'desktop',
    ]);
    const req = h.mgr.requiresMap();
    for (let i = 1; i < rows.length; i++)
      expect(req.get(rows[i]?.name ?? '')).toContain(rows[i - 1]?.name);
    const total = rows.reduce((n, r) => n + r.own, 0);
    expect(total).toBe((rows.at(-1)?.end ?? 0) - (rows[0]?.start ?? 0));
    expect(rows.find((r) => r.name === 'login')?.slack).toHaveProperty('wm');
  });

  it('OFF-04 net.online retries a network service at once with its back-off reset', async () => {
    let up = false;
    const sync: ServiceImpl = {
      start: () =>
        up ? Promise.resolve({ status: 'running' }) : Promise.reject(new Error('offline')),
      stop: () => Promise.resolve(),
    };
    const h = manager({ impls: { sync } });
    h.mgr.build();
    h.mgr.start();
    await flush();
    expect(h.mgr.stateOf('sync')).toBe('retry-wait');
    up = true;
    h.mgr.netOnline();
    await flush();
    expect(h.mgr.stateOf('sync')).toBe('running');
    expect(h.mgr.stateOf('lockd')).toBe('running');
  });
});
