/**
 * What the desktop sees over the compositor port: connectivity and degraded services (OFF-04),
 * memory statistics, windows bound to (pid, wid) with their view ports and display channels, and
 * notifications (window-manager.md §3.3, §3.12, §3.17, §4.3; syscall-abi.md §4.4.4).
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { KEvent, NetStatus } from '@plotinium/protocol';
import { ABI_VERSION, abiDigest } from '@plotinium/protocol';

import type { Program } from '../../../runtime/sys.ts';
import type { World } from './world.ts';
import { bootToDesktop, fakeServer, settle } from './world.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.close();
});

function batches(w: World): KEvent[] {
  return w.compositor
    .filter((m): m is { t: 'events'; batch: KEvent[] } => (m as { t?: string }).t === 'events')
    .flatMap((m) => m.batch);
}

function lastNet(w: World): NetStatus | undefined {
  const e = batches(w)
    .filter((x): x is KEvent<'net.state'> => x.topic === 'net.state')
    .at(-1);
  return e?.data;
}

interface WinOut {
  wid?: number;
  focused?: boolean;
  nid?: number;
  err?: string;
}

function windowProgram(out: WinOut): Program<WinOut> {
  return {
    init: () => out,
    *run(ctx, st) {
      const win = yield* ctx.sys['window.create']({
        title: 'Probe\u0007 window',
        rect: { x: 10, y: 20, w: 400, h: 300 },
      });
      st.wid = win.wid;
      yield* ctx.sys['window.setTitle']({ wid: win.wid, title: 'Renamed' });
      st.focused = (yield* ctx.sys['window.focus']({ wid: win.wid })).focused;
      st.nid = (yield* ctx.sys['notify.post']({
        title: 'Hello',
        body: 'from a probe',
        level: 'info',
        wid: win.wid,
      })).nid;
      return 0;
    },
  };
}

describe('the desktop over the compositor port', () => {
  it('OFF-04 offline, net.state says offline and lists the degraded services; online again it recovers', async () => {
    const server = fakeServer();
    server.down = true;
    const w = await bootToDesktop({ server, online: false });
    worlds.push(w);
    await w.until(() => (lastNet(w)?.degraded ?? []).includes('auth'));
    expect(lastNet(w)).toMatchObject({ state: 'offline' });
    expect(lastNet(w)?.degraded).toEqual(expect.arrayContaining(['auth', 'sync']));
    server.down = false;
    w.io.router({ t: 'online' });
    await w.until(() => lastNet(w)?.state === 'online', 60_000);
    expect(lastNet(w)?.state).toBe('online');
  });

  it('OFF-04 the queued count follows the outbox while no sync engine drains it', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    const before = w.io.net.queuedOps;
    const writer: Program<null> = {
      init: () => null,
      *run(ctx) {
        yield* ctx.sys.writeFile({
          path: '/home/guest/q.txt',
          data: new TextEncoder().encode('q').buffer,
        });
        return 0;
      },
    };
    const p = w.lb.spawn(writer, { name: 'q', uid: 65_534, gid: 100 });
    await w.lb.run(p.pid);
    await settle();
    expect(w.io.net.queuedOps).toBe(before + 1);
    expect(w.io.net.status().queuedOps).toBe(before + 1);
  });

  it('MEM-01 the memory statistics reach the desktop as mem.pressure', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    await w.until(() => batches(w).some((e) => e.topic === 'mem.pressure'));
    const mem = batches(w).find((e): e is KEvent<'mem.pressure'> => e.topic === 'mem.pressure');
    expect(mem?.data.budget).toBeGreaterThan(0);
    expect(mem?.data.level).toBe('ok');
  });

  it('WM-01 window.create binds a window to the caller and asks the compositor for a frame with its two channels', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    const out: WinOut = {};
    const p = w.lb.spawn(windowProgram(out), { name: 'probe', uid: 65_534, gid: 100 });
    const r = await w.lb.run(p.pid);
    expect(r.code).toBe(0);
    await settle();
    const create = w.compositor.find((m) => (m as { t?: string }).t === 'create') as
      | {
          wid: number;
          pid: number;
          app: string;
          title: string;
          rect: unknown;
          ports: { view: unknown; display: unknown };
        }
      | undefined;
    expect(create).toMatchObject({
      wid: out.wid,
      pid: p.pid,
      app: 'probe',
      title: 'Probe window',
      rect: { x: 10, y: 20, w: 400, h: 300 },
    });
    expect(create?.ports.view).toBeInstanceOf(MessagePort);
    expect(create?.ports.display).toBeInstanceOf(MessagePort);
    expect(w.compositor).toContainEqual({ t: 'setTitle', wid: out.wid, title: 'Renamed' });
    // No recent user input: focus is refused and the window asks for attention (WMD-09).
    expect(out.focused).toBe(false);
    expect(w.compositor).toContainEqual({ t: 'attention', wid: out.wid, level: 'info' });
    expect(w.compositor.find((m) => (m as { t?: string }).t === 'notify')).toMatchObject({
      n: {
        level: 'info',
        title: 'Hello',
        body: 'from a probe',
        source: { app: 'probe', pid: p.pid },
      },
    });
    // PROC-07: the process exited, so its window closed.
    expect(w.compositor).toContainEqual(expect.objectContaining({ t: 'close', wid: out.wid }));
    expect(w.io.windows.count).toBe(0);
  });

  it('WM-01 a view port carries system calls for its own (pid, wid) only, and a close request goes through the kill path', async () => {
    const signals: [number, string][] = [];
    const w = await bootToDesktop({
      io: {
        proc: {
          signal: (pid, sig) => {
            signals.push([pid, sig]);
          },
        },
      },
    });
    worlds.push(w);
    const pcb = w.lb.kernel.procs.create({
      ppid: 1,
      kind: 'user',
      cls: 'user',
      name: 'viewer',
      argv: ['viewer'],
      cred: { uid: 65_534, gid: 100, groups: [], ruid: 65_534 },
      caps: ['window', 'fs.read'],
    });
    const made = w.io.windows.create(pcb, { title: 'Viewer' });
    await settle();
    const create = w.compositor.find(
      (m) =>
        (m as { t?: string; wid?: number }).t === 'create' &&
        (m as { wid?: number }).wid === made.wid,
    ) as { ports: { view: MessagePort } } | undefined;
    const view = create?.ports.view;
    expect(view).toBeInstanceOf(MessagePort);
    const replies: unknown[] = [];
    if (view === undefined) return;
    view.onmessage = (ev: MessageEvent) => {
      replies.push(ev.data);
    };
    view.postMessage({ t: 'hello', abi: ABI_VERSION, digest: abiDigest() });
    view.postMessage({ t: 'req', req: { id: 7, call: 'getpid', args: {} } });
    view.postMessage({
      t: 'req',
      req: { id: 8, call: 'window.close', args: { wid: made.wid + 100 } },
    });
    await w.until(() => replies.length >= 2, 1_000);
    expect(replies[0]).toMatchObject({
      t: 'res',
      res: { id: 7, ok: true, value: { pid: pcb.pid } },
    });
    expect(replies[1]).toMatchObject({ t: 'res', res: { id: 8, ok: false, errno: 'EPERM' } });
    w.shellPort.postMessage({ t: 'closeRequested', wid: made.wid, seq: 1 });
    await w.until(() => signals.length > 0, 1_000);
    expect(signals).toEqual([[pcb.pid, 'SIGTERM']]);
  });

  it('WM-04 the shell asks for an app with launch; the kernel spawns it for the console user', async () => {
    const launched: [string, readonly string[], number][] = [];
    const w = await bootToDesktop({
      io: {
        proc: {
          launch: (app, argv, user) => {
            launched.push([app, argv, user.uid]);
          },
        },
      },
    });
    worlds.push(w);
    w.shellPort.postMessage({ t: 'launch', app: 'files', argv: [] });
    await w.until(() => launched.length > 0, 1_000);
    expect(launched).toEqual([['files', [], 65_534]]);
  });

  it('WMD-17 a non-critical service that fails is announced with a notification', async () => {
    const w = await bootToDesktop();
    worlds.push(w);
    w.lb.kernel.bus.publish('svc.failed', { name: 'update', critical: false, error: 'boom' });
    await w.until(() => w.compositor.some((m) => (m as { t?: string }).t === 'notify'), 1_000);
    expect(w.compositor.find((m) => (m as { t?: string }).t === 'notify')).toMatchObject({
      n: { level: 'warning', title: 'update stopped', body: 'boom' },
    });
  });

  it('WM-04 the default spawner launches through the process system and tells the user when it cannot', async () => {
    const w = await bootToDesktop({
      programs: [
        { name: 'files', kind: 'app', entry: 'files', requires: [], caps: ['window', 'fs.read'] },
      ],
    });
    worlds.push(w);
    w.shellPort.postMessage({ t: 'launch', app: 'nosuch', argv: [] });
    await w.until(() => w.compositor.some((m) => (m as { t?: string }).t === 'notify'), 1_000);
    expect(w.compositor.find((m) => (m as { t?: string }).t === 'notify')).toMatchObject({
      n: { level: 'error', title: 'Could not open nosuch', body: 'No such app is installed.' },
    });
    // This test kernel has no executors: the spawn fails EAGAIN and the user is told.
    w.shellPort.postMessage({ t: 'launch', app: 'files', argv: [] });
    await w.until(
      () => w.compositor.filter((m) => (m as { t?: string }).t === 'notify').length >= 2,
      2_000,
    );
    const second = w.compositor.filter((m) => (m as { t?: string }).t === 'notify')[1];
    expect(second).toMatchObject({ n: { level: 'error', title: 'Could not open files' } });
  });
});
