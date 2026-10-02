import type { KEvent, Topic } from '@plotinium/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createKernelLink, readKernelMessage } from '../../src/shell/kernel-link.ts';
import type { PortLike } from '../../src/shell/env.ts';
import { frameSummary, FrameSampler } from '../../src/shell/frame-sampler.ts';
import { helpMenu, menusFor, windowActions, windowMenu } from '../../src/shell/menus.ts';
import type { MenuEntry } from '../../src/shell/ui.ts';
import { applyPrefs, DEFAULT_PREFS, resolvedTheme, withDefaults } from '../../src/shell/prefs.ts';
import {
  applyEvents,
  degradedServices,
  INITIAL_STATUS,
  netView,
  notificationsFrom,
  pushNotifications,
} from '../../src/shell/status.ts';

const MB = 1024 * 1024;
let seq = 0;
function ev<T extends Topic>(topic: T, data: KEvent<T>['data'], t = 1_000): KEvent {
  seq += 1;
  return { topic, seq, t, data } as KEvent;
}

const net = (
  state: 'online' | 'offline' | 'connecting' | 'resuming' | 'auth-required',
  queuedOps = 0,
) => ({
  state,
  queuedOps,
  lastAckAt: 500,
  degraded: [],
  leaseTtlMs: 20_000,
  serverBuild: null,
});

describe('menu-bar status from kernel events (OFF-04, WMD-11)', () => {
  it('OFF-04 maps every NetStatus state to the tray view', () => {
    expect(netView(net('online'), 0)).toEqual({ state: 'LIVE' });
    expect(netView(net('online', 3), 0)).toEqual({ state: 'SYNCING', ops: 3 });
    expect(netView(net('offline', 2), 0)).toEqual({ state: 'OFFLINE', queued: 2 });
    expect(netView(net('auth-required', 1), 0)).toEqual({ state: 'AUTH_REQUIRED', queued: 1 });
    expect(netView(net('connecting'), 100)).toEqual({ state: 'RECONNECTING', retryAt: 5_100 });
    expect(netView({ ...net('resuming'), retryAt: 9 } as ReturnType<typeof net>, 0)).toEqual({
      state: 'RECONNECTING',
      retryAt: 9,
    });
  });

  it('OFF-04 applies net, memory, AI, update and service events in one batch', () => {
    const s = applyEvents(INITIAL_STATUS, [
      ev('net.state', net('offline', 4)),
      ev('mem.pressure', { accounted: 142 * MB, budget: 256 * MB, level: 'ok' }),
      ev('ai.index.progress', { pending: 3, indexedFiles: 1, chunks: 9, state: 'indexing' }),
      ev('update.available', { version: '0.4.0', build: 'b2' }),
      ev('svc.degraded', {
        name: 'syncd',
        critical: false,
        error: 'server unreachable',
        retryInMs: 2_000,
      }),
    ]);
    expect(s.net).toEqual({ state: 'OFFLINE', queued: 4 });
    expect(s.queued).toBe(4);
    expect(s.leaseTtlMs).toBe(20_000);
    expect(s.lastSyncAt).toBe(500);
    expect(s.memory).toEqual({ usedMb: 142, budgetMb: 256 });
    expect(s.ai).toEqual({ state: 'indexing', progress: 0.25 });
    expect(s.update).toEqual({ version: '0.4.0', build: 'b2' });
    expect(s.services).toEqual([
      {
        name: 'syncd',
        state: 'degraded',
        attempts: 1,
        reason: 'server unreachable',
        nextRetryAt: 3_000,
      },
    ]);
    expect(degradedServices(s.services).map((x) => x.name)).toEqual(['syncd']);
    const healed = applyEvents(s, [ev('svc.started', { name: 'syncd', critical: false })]);
    expect(healed.services).toEqual([{ name: 'syncd', state: 'running', attempts: 0 }]);
    expect(degradedServices(healed.services)).toEqual([]);
    expect(
      applyEvents(healed, [ev('svc.stopped', { name: 'syncd', critical: false })]).services,
    ).toEqual([]);
  });

  it('OFF-04 tracks the AI model and the lease banner', () => {
    let s = applyEvents(INITIAL_STATUS, [
      ev('ai.model', { state: 'loading', loadedBytes: 5, totalBytes: 10 }),
    ]);
    expect(s.ai).toEqual({ state: 'indexing', progress: 0.5 });
    s = applyEvents(s, [ev('ai.model', { state: 'failed' })]);
    expect(s.ai?.state).toBe('error');
    s = applyEvents(s, [
      ev('ai.index.progress', { pending: 0, indexedFiles: 0, chunks: 0, state: 'degraded' }),
    ]);
    expect(s.ai?.state).toBe('error');
    s = applyEvents(s, [
      ev('ai.index.progress', { pending: 0, indexedFiles: 4, chunks: 8, state: 'idle' }),
    ]);
    expect(s.ai).toEqual({ state: 'idle' });
    const lock = {
      ino: '0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
      holder: 'bob',
      expiresAt: 9_000,
      fence: 3,
    };
    s = applyEvents(s, [ev('lock.queued', lock as KEvent<'lock.queued'>['data'])]);
    expect(s.lease).toMatchObject({ holder: 'bob', state: 'held', fence: 3 });
    s = applyEvents(s, [ev('lock.granted', lock as KEvent<'lock.granted'>['data'])]);
    expect(s.lease?.state).toBe('released');
    s = applyEvents(s, [ev('lock.lost', lock as KEvent<'lock.lost'>['data'])]);
    expect(s.lease?.state).toBe('expired');
  });

  it('OFF-04 returns the same state object for a batch the shell does not draw', () => {
    expect(applyEvents(INITIAL_STATUS, [ev('bus.overflow', { topic: 'x', dropped: 1 })])).toBe(
      INITIAL_STATUS,
    );
  });

  it('WM-07 turns notify, conflicts, lost locks, updates and degraded services into notifications', () => {
    const list = notificationsFrom([
      ev('notify', { nid: 7, title: 'Build done', body: '', level: 'warn', pid: 3 }),
      ev('update.available', { version: '0.4.0', build: 'b2' }),
      ev('svc.degraded', { name: 'lockd', critical: false }),
      ev('svc.degraded', { name: 'kernel', critical: true }),
    ]);
    expect(list.map((n) => n.id)).toEqual([
      'n7',
      'update-b2',
      expect.stringMatching(/^svc-lockd-/u),
    ]);
    expect(list[0]).toMatchObject({ level: 'warning', title: 'Build done' });
    expect(list[0]?.body).toBeUndefined();
    expect(list[1]?.actions?.map((a) => a.id)).toEqual(['restart-update', 'later']);
  });

  it('WM-07 keeps the newest notifications first, without duplicates, capped', () => {
    const n = (id: string) => ({ id, level: 'info' as const, title: id, at: 0 });
    const list = pushNotifications([n('a'), n('b')], [n('c'), n('a')], 3);
    expect(list.map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(pushNotifications([n('a')], [])).toEqual([n('a')]);
  });
});

describe('kernel link (window-manager.md §4.3)', () => {
  it('WM-01 reads create for the shell and still hands it to the compositor', () => {
    const onCreate = vi.fn();
    const shellOnly = readKernelMessage(
      { t: 'create', wid: 4, pid: 9, app: 'files', title: 'x', argv: ['a', 3], seq: 1 },
      { onCreate },
    );
    expect(shellOnly).toBe(false);
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        wid: 4,
        pid: 9,
        app: 'files',
        argv: ['a'],
        viewPort: null,
        restore: null,
      }),
    );
    expect(readKernelMessage({ t: 'create', wid: 'x' }, { onCreate })).toBe(false);
    expect(readKernelMessage(null, {})).toBe(false);
    expect(readKernelMessage({ t: 'focus', wid: 1, seq: 2 }, {})).toBe(false);
  });

  it('WM-01 keeps shell-only messages away from the compositor', () => {
    const hooks = { onEvents: vi.fn(), onNotify: vi.fn(), onOverlay: vi.fn(), onAttach: vi.fn() };
    expect(readKernelMessage({ t: 'events', batch: [] }, hooks)).toBe(true);
    expect(readKernelMessage({ t: 'notify', n: { title: 'x' } }, hooks)).toBe(true);
    expect(readKernelMessage({ t: 'suspend', wid: 2 }, hooks)).toBe(true);
    expect(readKernelMessage({ t: 'notResponding', wid: 2, since: 5 }, hooks)).toBe(true);
    expect(readKernelMessage({ t: 'notResponding', wid: 2, since: null }, hooks)).toBe(true);
    expect(readKernelMessage({ t: 'restoreFailed', wid: 2 }, hooks)).toBe(true);
    expect(readKernelMessage({ t: 'closeGuard', wid: 2, reason: 'Unsaved changes' }, hooks)).toBe(
      true,
    );
    expect(readKernelMessage({ t: 'closeGuard', wid: 2, reason: null }, hooks)).toBe(true);
    expect(readKernelMessage({ t: 'attach', wid: 2, display: null }, hooks)).toBe(true);
    expect(readKernelMessage({ t: 'restoring', wid: 2, doneBytes: 1, totalBytes: 4 }, hooks)).toBe(
      false,
    );
    expect(hooks.onEvents).toHaveBeenCalledWith([]);
    expect(hooks.onNotify).toHaveBeenCalledWith({ title: 'x' });
    expect(hooks.onOverlay.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      { kind: 'suspended' },
      { kind: 'not-responding', on: true },
      { kind: 'not-responding', on: false },
      { kind: 'restore-failed' },
      { kind: 'close-guard', reason: 'Unsaved changes' },
      { kind: 'close-guard', reason: null },
      { kind: 'restoring', doneBytes: 1, totalBytes: 4 },
    ]);
    expect(hooks.onAttach).not.toHaveBeenCalled();
  });

  it('WM-01 proxies the port: the compositor sees kernel messages, the shell posts intents', () => {
    const posted: unknown[] = [];
    const port: PortLike = { onmessage: null, postMessage: (m) => posted.push(m) };
    const link = createKernelLink(port, {});
    const seen = vi.fn();
    link.compositorPort.onmessage = seen;
    port.onmessage?.(new MessageEvent('message', { data: { t: 'focus', wid: 1, seq: 1 } }));
    port.onmessage?.(new MessageEvent('message', { data: { t: 'events', batch: [] } }));
    expect(seen).toHaveBeenCalledTimes(1);
    link.compositorPort.postMessage({ t: 'input', wid: 1 });
    link.post({ t: 'notify.action', id: 'k1', actionId: 'open' });
    expect(posted).toEqual([
      { t: 'input', wid: 1 },
      { t: 'notify.action', id: 'k1', actionId: 'open' },
    ]);
    link.dispose();
    expect(port.onmessage).toBeNull();
  });
});

const labelOf = (e: MenuEntry | undefined): string | undefined =>
  e !== undefined && 'label' in e ? e.label : undefined;

describe('menus, preferences and the frame meter', () => {
  it('WM-07 gives the desktop File, Go, Window and Help menus with disabled window items', () => {
    const apps = [
      { id: 'files', title: 'Files', icon: 'files' as const, mountView: () => () => undefined },
      {
        id: 'hidden',
        title: 'Hidden',
        icon: 'atom' as const,
        launchable: false,
        mountView: () => () => undefined,
      },
    ];
    const menus = menusFor(undefined, apps);
    expect(menus.map((m) => m.id)).toEqual(['file', 'go', 'window', 'help']);
    expect(menus[1]?.items.map((i) => i.id)).toEqual(['app:files']);
    expect(windowMenu(true).items.every((i) => !('disabled' in i) || i.disabled === true)).toBe(
      true,
    );
  });

  it('WM-07 puts the app menus first and never duplicates the shell Window and Help menus', () => {
    const entry = {
      id: 'files',
      title: 'Files',
      icon: 'files' as const,
      menus: [
        { id: 'file', label: 'File', items: [] },
        { id: 'window', label: 'Window', items: [] },
      ],
      mountView: () => () => undefined,
    };
    expect(menusFor(entry, [entry]).map((m) => m.id)).toEqual(['file', 'window', 'help']);
    expect(labelOf(helpMenu('Files').items[0])).toBe('Files Help');
    const bare = { ...entry, menus: undefined };
    expect(menusFor(bare, [bare])[0]?.items.map((i) => i.id)).toContain('close-window');
    expect(labelOf(windowActions(true).find((i) => i.id === 'zoom'))).toBe('Restore');
    expect(labelOf(windowActions(false).find((i) => i.id === 'zoom'))).toBe('Zoom');
  });

  it('WM-07 applies the theme and reduced motion to the root dataset', () => {
    const root = { dataset: {} as DOMStringMap };
    applyPrefs(root, { ...DEFAULT_PREFS, theme: 'dark', reducedMotion: true });
    expect(root.dataset).toEqual({ theme: 'dark', motion: 'reduce' });
    applyPrefs(root, DEFAULT_PREFS);
    expect(root.dataset).toEqual({});
    expect(resolvedTheme('system', true)).toBe('dark');
    expect(resolvedTheme('system', false)).toBe('light');
    expect(resolvedTheme('light', true)).toBe('light');
    expect(withDefaults({ frameMeter: true })).toEqual({ ...DEFAULT_PREFS, frameMeter: true });
  });

  it('WM-03 quantises frame deltas to refresh intervals and reports p95 and drops', () => {
    const s = new FrameSampler();
    expect(s.stats()).toBeUndefined();
    for (let i = 0; i < 120; i++) s.sample(16.7);
    expect(s.refreshMs).toBeCloseTo(16.7);
    for (let i = 0; i < 20; i++) s.sample(33.4);
    s.sample(-1);
    s.sample(5_000);
    s.longFrame(true);
    s.longFrame(false);
    const st = s.stats();
    expect(st?.refreshHz).toBe(60);
    expect(st?.p95Ms).toBeCloseTo(33.4, 1);
    expect(st?.droppedShare).toBeCloseTo(20 / 140);
    expect(st).toMatchObject({ loafOurs: 1, loafOther: 1 });
    expect(s.samples(10)).toHaveLength(10);
    expect(frameSummary(st)).toBe('p95 33.4 ms · 60 Hz');
    expect(frameSummary(undefined)).toBeUndefined();
  });
});
