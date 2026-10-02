/**
 * The login and session services over the router's login channel (boot-and-services.md §3.2
 * stages 5–6; security-model.md §3.7, §3.8; BOOT-14, OFF-03, WM-06).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { OfflineVerifierRec } from '../verifier.ts';
import type { SessionLayout } from '../../window/types.ts';
import { MemStore } from '../../fs/mem-store.ts';
import type { World } from './world.ts';
import { bootToDesktop, bootWorld, fakeServer, loginWaiting, settle } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

async function toLogin(w: World): Promise<void> {
  await w.until(() => loginWaiting(w));
}

describe('login over the router channel', () => {
  it('BOOT-14 the login screen gets its tiles, a wrong password fails and keeps waiting, the right one signs in online', async () => {
    const server = fakeServer();
    const w = await bootWorld({ server });
    worlds.push(w);
    await toLogin(w);
    const state = w.posted.find((p) => p.t === 'login.state');
    expect(state?.t === 'login.state' ? state.state.users.map((u) => u.id) : []).toEqual([
      'demo',
      'alice',
      'bob',
      'guest',
    ]);
    const bad = await w.login({ user: 'alice', secret: 'nope' });
    expect(bad).toMatchObject({ ok: false, error: 'Invalid username or password' });
    expect(w.stateOf('login')).toBe('starting');
    const ok = await w.login({ user: 'alice', secret: 'alice-pass' });
    expect(ok).toMatchObject({
      ok: true,
      session: { uid: 1100, user: 'alice', kind: 'user', mode: 'online' },
    });
    await w.until(() => w.stateOf('session') === 'running');
    // The home directory exists in the VFS mirror, owned by the user.
    const fs = w.io.fs();
    expect(fs?.tree.user(1100)).toMatchObject({ username: 'alice', gid: 100 });
    // The password is never logged.
    expect(
      w.lb.kernel.klog.read().some((r) => r.kind === 'line' && r.msg.includes('alice-pass')),
    ).toBe(false);
  });

  it('BOOT-14 a valid server session resumes without the login screen', async () => {
    const server = fakeServer();
    server.session = 'demo';
    const w = await bootWorld({ server });
    worlds.push(w);
    await w.until(() => w.stateOf('session') === 'running');
    expect(loginWaiting(w)).toBe(false);
    expect(w.posted.findLast((p) => p.t === 'login.session')).toMatchObject({
      session: { uid: 1000, user: 'demo', kind: 'demo', mode: 'cached' },
    });
  });

  it('BOOT-14 the Guest tile signs in a server guest', async () => {
    const server = fakeServer();
    const w = await bootToDesktop({ server });
    worlds.push(w);
    expect(w.posted.findLast((p) => p.t === 'login.session')).toMatchObject({
      session: { user: 'guest-ab12', kind: 'guest', mode: 'guest' },
    });
    expect(server.calls).toContain('POST /api/auth/guest');
  });

  it('OFF-03 after one online login the offline verifier signs the same user in with the server down, never with a wrong password', async () => {
    const store = new MemStore();
    const server = fakeServer();
    const a = await bootToDesktop({ store, server, who: { user: 'alice', secret: 'alice-pass' } });
    worlds.push(a);
    // The verifier is written after desktop-interactive (PBKDF2 is off the boot path).
    await a.until(() => {
      let n = 0;
      void store.scan('credentials', null, () => {
        n++;
      });
      return n > 0;
    }, 20_000);
    let rec: OfflineVerifierRec | undefined;
    await store.scan<OfflineVerifierRec>('credentials', null, (r) => {
      rec = r;
    });
    expect(rec).toMatchObject({ username: 'alice', uid: 1100, kdf: 'PBKDF2-SHA256' });
    expect(JSON.stringify(rec)).not.toContain('alice-pass');
    a.close();
    worlds.pop();

    server.down = true;
    const b = await bootWorld({ store, server, online: false });
    worlds.push(b);
    await toLogin(b);
    const tiles = b.posted.find((p) => p.t === 'login.state');
    const users = tiles?.t === 'login.state' ? tiles.state.users : [];
    expect(users.find((u) => u.id === 'alice')?.disabled).toBeUndefined();
    expect(users.find((u) => u.id === 'bob')).toMatchObject({
      disabled: true,
      disabledReason: 'Sign in online once to enable offline login',
    });
    expect(await b.login({ user: 'alice', secret: 'wrong' })).toMatchObject({
      ok: false,
      error: 'Invalid username or password',
    });
    const ok = await b.login({ user: 'alice', secret: 'alice-pass' });
    expect(ok).toMatchObject({ ok: true, session: { uid: 1100, mode: 'offline' } });
  });

  it('WM-06 the layout the compositor reports is saved and the next session reopens its apps with their rectangles', async () => {
    const store = new MemStore();
    const a = await bootToDesktop({ store });
    worlds.push(a);
    const session = a.posted.findLast((p) => p.t === 'login.session');
    const osSessionId = session?.t === 'login.session' ? session.osSessionId : '';
    const layout: SessionLayout = {
      v: 1,
      osSessionId,
      uid: 65_534,
      savedAt: 1,
      viewport: { w: 1440, h: 900, dpr: 2 },
      windows: [
        {
          app: 'files',
          argv: ['files'],
          title: 'Files',
          rect: { x: 40, y: 60, w: 800, h: 520 },
          restoreRect: null,
          state: 'normal',
          prevState: 'normal',
          snap: null,
          z: 1,
          focused: false,
          proc: null,
        },
        {
          app: 'terminal',
          argv: ['terminal'],
          title: 'Terminal',
          rect: { x: 0, y: 0, w: 1440, h: 860 },
          restoreRect: { x: 100, y: 100, w: 700, h: 450 },
          state: 'maximised',
          prevState: 'maximised',
          snap: null,
          z: 2,
          focused: true,
          proc: null,
        },
      ],
    };
    a.shellPort.postMessage({ t: 'layout', layout });
    await settle();
    a.timers.advance(600);
    await settle();
    await a.io.shutdown('reboot');
    a.close();
    worlds.pop();

    const launched: string[] = [];
    const b = await bootToDesktop({
      store,
      io: {
        proc: {
          launch: (app) => {
            launched.push(app);
          },
        },
      },
    });
    worlds.push(b);
    expect(launched).toEqual(['files', 'terminal']);
    const restored = b.lb.kernel.klog
      .read()
      .find((r) => r.kind === 'line' && r.msg.includes('windows restored'));
    expect(restored?.kind === 'line' ? restored.msg : '').toContain('2 windows restored');
  });

  it('WM-06 an unreadable layout is kept for recovery and a clean session starts with a notification', async () => {
    const store = new MemStore();
    const a = await bootToDesktop({ store });
    worlds.push(a);
    await store.tx(['os_sessions'], 'strict', (t) => {
      t.put('os_sessions', {
        osSessionId: 'broken',
        uid: 65_534,
        savedAt: 9_999_999_999_999,
        v: 7,
      });
    });
    a.close();
    worlds.pop();
    const b = await bootToDesktop({ store });
    worlds.push(b);
    const kept: unknown[] = [];
    await store.scan<{ recoveryOf?: string }>('os_sessions', null, (r) => {
      if (r.recoveryOf === 'broken') kept.push(r);
    });
    expect(kept).toHaveLength(1);
    await b.until(() => b.compositor.some((m) => (m as { t?: string }).t === 'notify'));
    expect(b.compositor.find((m) => (m as { t?: string }).t === 'notify')).toMatchObject({
      n: { level: 'warning', title: 'Your previous desktop could not be restored' },
    });
  });

  it('BOOT-12 logout saves the layout strictly, ends the server session and tells the router', async () => {
    const server = fakeServer();
    const w = await bootToDesktop({ server, who: { user: 'alice', secret: 'alice-pass' } });
    worlds.push(w);
    const before = w.store.durabilities.length;
    w.io.router({ t: 'login.logout' });
    await w.until(() => w.posted.some((p) => p.t === 'login.loggedOut'));
    expect(w.store.durabilities.slice(before)).toContain('strict');
    expect(server.calls).toContain('POST /api/auth/logout');
    expect(server.session).toBeNull();
  });
});
