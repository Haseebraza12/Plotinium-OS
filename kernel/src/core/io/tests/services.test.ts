/**
 * The rest of the I/O layer's services and calls: sync with a linked engine (OFF-01, OFF-04),
 * advisory locks (VFS §3.16, syscall-abi §4.4.7), the Service Worker update service (OFF-05), the
 * AI link (C12, ARC-06) and the administration calls (syscall-abi §4.4.11).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { NetStatus, RetOf } from '@plotinium/protocol';
import type { ServiceImpl } from '@plotinium/services';

import type { Program } from '../../../runtime/sys.ts';
import { errnoOf } from '../../../runtime/sys.ts';
import { KernelError } from '../../errors.ts';
import type { EngineFactory, SyncEngine, SyncEngineHost } from '../../net/engines.ts';
import type { World } from './world.ts';
import { bootToDesktop, fakeServer, settle } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

class FakeSyncEngine implements SyncEngine {
  connected = 0;
  kicks = 0;
  online = true;
  st: NetStatus | null = null;
  host: SyncEngineHost;
  constructor(host: SyncEngineHost) {
    this.host = host;
  }
  start(): Promise<void> {
    return Promise.resolve();
  }
  connect(): void {
    this.connected++;
  }
  kick(): void {
    this.kicks++;
  }
  setOnline(online: boolean): void {
    this.online = online;
  }
  onVisible(): void {
    // Nothing to resume in the fake.
  }
  status(): { status: NetStatus | null; label: string } {
    return { status: this.st, label: this.st?.state ?? 'connecting' };
  }
  idle(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  report(state: NetStatus['state'], queuedOps = 0): void {
    this.st = {
      state,
      queuedOps,
      lastAckAt: null,
      degraded: [],
      leaseTtlMs: 30_000,
      serverBuild: '0000000',
    };
    this.host.status(this.st, state);
  }
}

function engines(): { factory: EngineFactory; engine: () => FakeSyncEngine | null } {
  let made: FakeSyncEngine | null = null;
  return {
    factory: {
      sync: (_session, host) => {
        made = new FakeSyncEngine(host);
        return made;
      },
    },
    engine: () => made,
  };
}

interface Out {
  results: Record<string, unknown>;
  errors: Record<string, string>;
}

function prog(
  out: Out,
  body: (
    sys: Parameters<Program<Out>['run']>[0]['sys'],
    st: Out,
  ) => Generator<unknown, void, unknown>,
): Program<Out> {
  return {
    init: () => out,
    *run(ctx, st) {
      yield* body(ctx.sys, st) as Generator<never, void, unknown>;
      return 0;
    },
  };
}

function* attempt<T>(
  st: Out,
  key: string,
  g: Generator<unknown, T, unknown>,
): Generator<unknown, void, unknown> {
  try {
    st.results[key] = yield* g;
  } catch (e) {
    st.errors[key] = errnoOf(e) ?? String(e);
  }
}

describe('sync with a linked engine', () => {
  it('OFF-04 sync connects after desktop-interactive, turns live, degrades when the engine reports offline and recovers', async () => {
    const e = engines();
    const server = fakeServer();
    const w = await bootToDesktop({
      server,
      who: { user: 'alice', secret: 'alice-pass' },
      io: { engines: e.factory },
    });
    worlds.push(w);
    await w.until(() => e.engine() !== null && w.stateOf('sync') !== 'starting');
    const engine = e.engine();
    expect(engine?.connected).toBe(1);
    engine?.report('online');
    await w.until(() => w.stateOf('sync') === 'running');
    expect(w.stateOf('lockd')).toBe('degraded');
    engine?.report('offline', 3);
    await w.until(() => w.stateOf('sync') === 'degraded');
    expect(w.mgr.status().find((s) => s.name === 'sync')?.reason).toBe('offline · 3 queued');
    expect(w.io.net.status()).toMatchObject({ state: 'offline', queuedOps: 3 });
    w.io.router({ t: 'offline' });
    expect(engine?.online).toBe(false);
    engine?.report('online');
    await w.until(() => w.stateOf('sync') === 'running');
  });

  it('OFF-01 each synced commit kicks the engine', async () => {
    const e = engines();
    const server = fakeServer();
    const w = await bootToDesktop({
      server,
      who: { user: 'alice', secret: 'alice-pass' },
      io: { engines: e.factory },
    });
    worlds.push(w);
    await w.until(() => e.engine() !== null);
    const before = e.engine()?.kicks ?? 0;
    const out: Out = { results: {}, errors: {} };
    const p = w.lb.spawn(
      prog(out, function* (sys, st) {
        yield* attempt(
          st,
          'w',
          sys.writeFile({ path: '/home/alice/a.txt', data: new TextEncoder().encode('a').buffer }),
        );
      }),
      { name: 'w', uid: 1_100, gid: 100 },
    );
    await w.lb.run(p.pid);
    expect(out.errors).toEqual({});
    expect(e.engine()?.kicks).toBe(before + 1);
  });
});

describe('advisory locks', () => {
  it('VFS-12 S leases share, X excludes, a non-waiting request is EBUSY, release and exit free them', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    const enc = new TextEncoder();
    const out: Out = { results: {}, errors: {} };
    const a = w.lb.spawn(
      prog(out, function* (sys, st) {
        yield* sys.writeFile({ path: '/home/guest/l.txt', data: enc.encode('l').buffer });
        yield* attempt(
          st,
          's1',
          sys['lock.acquire']({ path: '/home/guest/l.txt', mode: 'S', wait: false }),
        );
        yield* attempt(
          st,
          's2',
          sys['lock.acquire']({ path: '/home/guest/l.txt', mode: 'S', wait: false }),
        );
        yield* attempt(
          st,
          'x',
          sys['lock.acquire']({ path: '/home/guest/l.txt', mode: 'X', wait: false }),
        );
        yield* attempt(st, 'status', sys['lock.status']({ path: '/home/guest/l.txt' }));
        const s1 = st.results['s1'] as RetOf<'lock.acquire'>;
        yield* attempt(st, 'release', sys['lock.release']({ leaseId: s1.leaseId }));
        yield* attempt(st, 'again', sys['lock.release']({ leaseId: s1.leaseId }));
        yield* attempt(
          st,
          'dir',
          sys['lock.acquire']({ path: '/home/guest', mode: 'S', wait: false }),
        );
      }),
      { name: 'locker', uid: 65_534, gid: 100 },
    );
    await w.lb.run(a.pid);
    expect(out.results['s1']).toMatchObject({ scope: 'local', fence: 1 });
    expect(out.results['s2']).toMatchObject({ scope: 'local', fence: 2 });
    expect(out.errors['x']).toBe('EBUSY');
    expect(out.results['status']).toMatchObject({
      holders: [{ mode: 'S' }, { mode: 'S' }],
      queued: 0,
    });
    expect(out.results['release']).toEqual({});
    expect(out.errors['again']).toBe('EINVAL');
    expect(out.errors['dir']).toBe('EISDIR');
    // PROC-07: the process exited, so its remaining S lease is gone and X is free again.
    const out2: Out = { results: {}, errors: {} };
    const b = w.lb.spawn(
      prog(out2, function* (sys, st) {
        yield* attempt(
          st,
          'x',
          sys['lock.acquire']({ path: '/home/guest/l.txt', mode: 'X', wait: false }),
        );
        yield* attempt(st, 'net', sys['net.status']({}));
        yield* attempt(st, 'flush', sys['sync.flush']({ timeoutMs: 1_000 }));
      }),
      { name: 'locker2', uid: 65_534, gid: 100 },
    );
    await w.lb.run(b.pid);
    expect(out2.results['x']).toMatchObject({ scope: 'local' });
    expect(out2.results['net']).toMatchObject({ leaseTtlMs: 30_000 });
    expect(out2.errors['flush']).toBe('EAGAIN');
  });
});

describe('the update service', () => {
  it('OFF-05 the Service Worker registers after the desktop, and a waiting worker is announced', async () => {
    const asked: number[] = [];
    const w = await bootToDesktop({
      io: {
        platform: {
          serviceWorker: true,
          channel: () => new MessageChannel(),
          subtle: crypto.subtle,
        },
        requestSwRegister: () => {
          asked.push(1);
        },
      },
    });
    worlds.push(w);
    await w.until(() => asked.length === 1);
    w.io.router({ t: 'sw', event: 'registered' });
    await w.until(() => w.stateOf('update') === 'running');
    w.io.router({ t: 'sw', event: 'waiting' });
    await w.until(() => w.compositor.some((m) => (m as { t?: string }).t === 'notify'));
    expect(w.compositor.find((m) => (m as { t?: string }).t === 'notify')).toMatchObject({
      n: { title: 'A new version is ready' },
    });
    w.io.router({ t: 'sw', event: 'error' });
    await w.until(() => w.stateOf('update') === 'degraded');
  });
});

describe('the AI link', () => {
  it('ARC-06 a linked AI service runs, and the agent batch gate asks the link', async () => {
    const started: string[] = [];
    const svc = (name: string): ServiceImpl => ({
      start: (ctx) => {
        started.push(name);
        ctx.log('info', `${name} up`);
        return Promise.resolve({ status: 'running' });
      },
      stop: () => Promise.resolve(),
    });
    const w = await bootToDesktop({
      io: {
        ai: () => ({
          services: { 'ai.runtime': svc('ai.runtime') },
          verifyPlanToken: () => new Error('bad token'),
        }),
      },
    });
    worlds.push(w);
    await w.until(() => w.stateOf('ai.runtime') === 'running');
    expect(started).toEqual(['ai.runtime']);
    const out: Out = { results: {}, errors: {} };
    const p = w.lb.spawn(
      prog(out, function* (sys, st) {
        yield* attempt(
          st,
          'batch',
          sys.batch({
            txnId: '01a0dddc-ee24-76e5-8190-01c1e8d3d620',
            ops: [{ op: 'mkdir', path: '/home/guest/x' }],
            expectedVersions: [],
            token: `01a0dddc-ee24-76e5-8190-01c1e8d3d619.9999999999999.${'t'.repeat(43)}`,
            planId: '01a0dddc-ee24-76e5-8190-01c1e8d3d619',
          }),
        );
      }),
      { name: 'agent', uid: 65_534, gid: 100, caps: ['fs.read', 'fs.write', 'batch.grant'] },
    );
    const pcb = w.lb.kernel.procs.get(p.pid);
    if (pcb !== undefined) pcb.cls = 'agent';
    await w.lb.run(p.pid);
    expect(out.errors['batch']).toBe('EPERM');
  });

  it('ARC-06 the AI-off build starts the AI services degraded with the reason', async () => {
    const w = await bootToDesktop({ io: { aiEnabled: false } });
    worlds.push(w);
    await w.until(() => w.stateOf('ai.runtime') === 'degraded');
    expect(w.mgr.status().find((s) => s.name === 'ai.runtime')?.reason).toBe(
      'AI is not part of this build (ai.runtime)',
    );
  });
});

describe('administration calls', () => {
  it('BOOT-12 svc.status, svc.restart, users.list; reboot saves, closes the boot record and halts; lock and logout reach the router', async () => {
    const halts: string[] = [];
    const server = fakeServer();
    const w = await bootToDesktop({
      server,
      who: { user: 'alice', secret: 'alice-pass' },
      io: {
        halt: (kind, next) => {
          halts.push(`${kind}:${next}`);
        },
      },
    });
    worlds.push(w);
    const out: Out = { results: {}, errors: {} };
    const p = w.lb.spawn(
      prog(out, function* (sys, st) {
        yield* attempt(st, 'status', sys['svc.status']({}));
        yield* attempt(st, 'restart', sys['svc.restart']({ name: 'storage' }));
        yield* attempt(st, 'nosvc', sys['svc.restart']({ name: 'nope' }));
        yield* attempt(st, 'users', sys['users.list']({}));
        yield* attempt(st, 'lock', sys['auth.lock']({}));
        yield* attempt(st, 'reboot', sys.reboot({ menu: true }));
        yield* attempt(st, 'prev', sys.bootlog({ boot: 'previous' }));
      }),
      { name: 'admin', uid: 1_100, gid: 100, caps: ['fs.read', 'sys.admin', 'auth.session'] },
    );
    await w.lb.run(p.pid);
    const status = out.results['status'] as RetOf<'svc.status'>;
    expect(status.services.find((s) => s.name === 'storage')).toMatchObject({
      state: 'running',
      critical: true,
    });
    expect(out.errors['restart']).toBe('EINVAL');
    expect(out.errors['nosvc']).toBe('ENOENT');
    expect((out.results['users'] as RetOf<'users.list'>).users.map((u) => u.name)).toEqual([
      'root',
      'alice',
    ]);
    expect(out.results['lock']).toEqual({});
    expect(w.posted.some((m) => m.t === 'login.lock')).toBe(true);
    expect(out.results['reboot']).toMatchObject({ scheduledAt: expect.any(Number) as number });
    expect(out.errors['prev']).toBe('ENOENT');
    await w.until(() => halts.length > 0, 2_000);
    expect(halts).toEqual(['reboot:menu']);
    const rec: { shutdown?: { kind: string; clean: boolean } }[] = [];
    await w.store.scan<{ shutdown?: { kind: string; clean: boolean } }>('bootlog', null, (r) =>
      rec.push(r),
    );
    expect(rec[0]?.shutdown).toMatchObject({ kind: 'reboot', clean: true });
    // A stranger may not power the machine off.
    const out2: Out = { results: {}, errors: {} };
    const q = w.lb.spawn(
      prog(out2, function* (sys, st) {
        yield* attempt(st, 'off', sys.shutdown({}));
        yield* attempt(st, 'logout', sys['auth.logout']({}));
      }),
      { name: 'stranger', uid: 4_242, gid: 100, caps: ['auth.session'] },
    );
    await w.lb.run(q.pid);
    expect(out2.errors).toEqual({ off: 'EPERM', logout: 'EPERM' });
    await settle();
    expect(KernelError).toBeDefined();
  });
});
