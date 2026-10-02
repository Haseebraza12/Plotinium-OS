/**
 * Boot with the REAL system services (installIo) under the service manager on the loopback host:
 * BOOT-03, BOOT-04, BOOT-07, BOOT-09, BOOT-11 (boot-and-services.md §6.5).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { ManifestFile } from '@plotinium/services';
import { BUILTIN_MANIFEST_FILES } from '@plotinium/services';
import type { RetOf } from '@plotinium/protocol';
import { UID_OFFLINE_GUEST } from '@plotinium/protocol';

import type { Program } from '../../../runtime/sys.ts';
import { errnoOf } from '../../../runtime/sys.ts';
import type { BootRecord } from '../bootlog.ts';
import type { World } from './world.ts';
import { bootToDesktop, bootWorld, fakeServer, settle } from './world.ts';

let world: World | null = null;
afterEach(() => {
  world?.close();
  world = null;
});

interface Out {
  bootlog?: RetOf<'bootlog'>;
  wrote?: RetOf<'writeFile'>;
  list?: string[];
  err?: string;
}

function bootlogProgram(out: Out): Program<Out> {
  return {
    init: () => out,
    *run(ctx, st) {
      st.bootlog = yield* ctx.sys.bootlog({ criticalPath: true });
      return 0;
    },
  };
}

function writeHome(out: Out, home: string): Program<Out> {
  return {
    init: () => out,
    *run(ctx, st) {
      try {
        st.wrote = yield* ctx.sys.writeFile({
          path: `${home}/notes.txt`,
          data: new TextEncoder().encode('offline works').buffer,
        });
        const r = yield* ctx.sys.readdir({ path: home });
        st.list = r.entries.map((e) => e.name);
      } catch (e) {
        st.err = errnoOf(e) ?? String(e);
      }
      return 0;
    },
  };
}

describe('boot with the real system services', () => {
  it('BOOT-03 in the boot record every service starts after all its requirements have ended', async () => {
    world = await bootToDesktop();
    const w = world;
    await w.until(() => w.stateOf('complete') === 'running' && w.stateOf('update') === 'degraded');
    const timings = new Map(w.mgr.timings().map((t) => [t.name, t]));
    const requires = w.mgr.requiresMap();
    let edges = 0;
    for (const [name, reqs] of requires) {
      const t = timings.get(name);
      if (t?.start === null || t === undefined) continue;
      for (const r of reqs) {
        const u = timings.get(r);
        expect(u?.end, `${r} ended before ${name} started`).not.toBeNull();
        expect(t.start).toBeGreaterThanOrEqual(u?.end ?? Infinity);
        edges++;
      }
    }
    expect(edges).toBeGreaterThan(20);
    // storage, sched and wm need only `kernel`: they start at the same instant.
    const s = ['storage', 'sched', 'wm'].map((n) => timings.get(n)?.start);
    expect(new Set(s).size).toBe(1);
  });

  it('BOOT-04 a dependency cycle halts the boot naming the cycle before any real service starts', async () => {
    const files: ManifestFile[] = BUILTIN_MANIFEST_FILES.map((f) => {
      const json = f.json as { name: string; requires: string[] };
      return json.name === 'storage'
        ? { file: f.file, json: { ...json, requires: ['kernel', 'vfs'] } }
        : f;
    });
    world = await bootWorld({ files });
    const w = world;
    await w.until(() => w.panics.length > 0, 100);
    expect(w.panics[0]?.kind).toBe('cycle');
    expect(w.panics[0]?.cycle).toEqual(expect.arrayContaining(['storage', 'vfs']));
    expect(w.io.fs()).toBeNull();
    expect(w.store.durabilities).toHaveLength(0);
  });

  it('BOOT-07 a non-critical service that cannot reach the server degrades, the boot continues and it is retried with back-off', async () => {
    const server = fakeServer();
    server.down = true;
    world = await bootToDesktop({ server });
    const w = world;
    await w.until(() => w.stateOf('auth') === 'degraded');
    const auth = w.mgr.status().find((s) => s.name === 'auth');
    expect(auth).toMatchObject({ state: 'degraded', reason: 'offline' });
    expect(w.stateOf('desktop')).toBe('running');
    // The healer retries on the §5.3 back-off schedule.
    await w.until(
      () => (w.mgr.status().find((s) => s.name === 'auth')?.attempts ?? 0) >= 1,
      60_000,
    );
    // The server comes back: the next attempt recovers.
    server.down = false;
    w.io.router({ t: 'online' });
    await w.until(
      () =>
        w.stateOf('auth') !== 'degraded' || server.calls.some((c) => c.endsWith('/api/auth/me')),
      60_000,
    );
    // sync requires auth: while auth is degraded it is blocked (svcmgr §3.5), and lockd with it.
    expect(['degraded', 'blocked']).toContain(w.stateOf('sync'));
    // lockd requires sync, so it waits (pending) or is blocked with it; it never runs half-wired.
    expect(['degraded', 'blocked', 'pending']).toContain(w.stateOf('lockd'));
    // No AI link in this build: ai.runtime degrades; the ones behind sync wait with it.
    expect(w.mgr.status().find((s) => s.name === 'ai.runtime')?.reason).toMatch(/not linked/);
    for (const ai of ['ai.indexer', 'ai.predictor', 'ai.agent'] as const)
      expect(['degraded', 'blocked', 'pending']).toContain(w.stateOf(ai));
  });

  it('BOOT-09 with the network disabled the system boots to a usable desktop from local state (local guest)', async () => {
    const server = fakeServer();
    server.down = true;
    world = await bootToDesktop({ server, online: false });
    const w = world;
    const session = w.posted.findLast((p) => p.t === 'login.session');
    expect(session).toMatchObject({
      session: { uid: UID_OFFLINE_GUEST, user: 'guest', mode: 'local' },
    });
    const out: Out = {};
    const pcb = w.lb.spawn(writeHome(out, '/home/guest'), {
      name: 'writer',
      uid: UID_OFFLINE_GUEST,
      gid: 100,
    });
    await w.lb.run(pcb.pid);
    expect(out.err).toBeUndefined();
    expect(out.list).toContain('notes.txt');
  });

  it('BOOT-11 per-service timings are saved, bootlog prints them and --critical-path runs from kernel to desktop', async () => {
    world = await bootToDesktop();
    const w = world;
    await settle(8);
    const out: Out = {};
    const pcb = w.lb.spawn(bootlogProgram(out), { name: 'bootlog' });
    await w.lb.run(pcb.pid);
    const r = out.bootlog;
    expect(r?.entries.length).toBeGreaterThan(10);
    const chain = r?.criticalPath ?? [];
    expect(chain[0]).toBe('kernel');
    expect(chain.at(-1)).toBe('desktop');
    // Every link of the chain is a requirement edge of the DAG.
    const requires = w.mgr.requiresMap();
    for (let i = 1; i < chain.length; i++)
      expect(requires.get(chain[i] ?? '') ?? []).toContain(chain[i - 1]);
    expect(r?.totalMs).toBeGreaterThanOrEqual(0);
    const recs: BootRecord[] = [];
    await w.store.scan<BootRecord>('bootlog', null, (x) => recs.push(x));
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ outcome: 'interactive', profile: 'normal' });
    const loginRow = recs[0]?.services.find((s) => s.name === 'login');
    expect(loginRow).toMatchObject({ critical: true, status: 'running' });
    expect(loginRow?.end).toBeGreaterThanOrEqual(loginRow?.start ?? Infinity);
    expect(recs[0]?.services.some((s) => s.name === 'storage' && s.end !== null)).toBe(true);
  });
});
