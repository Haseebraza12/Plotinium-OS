// @vitest-environment happy-dom
/**
 * The desktop-shell polish wave, pure parts (docs/design/bug-hunt/BUGS.md, owner
 * fix-desktop-shell): status mapping, notification merging, menu key equivalents, Dock items,
 * preferences and the selector contract.
 */
import type { KEvent, NetStatus, Topic } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { dockItems, isSystemPanel, type DockWindow } from '../../src/shell/dock-logic.ts';
import type { AppEntry } from '../../src/shell/env.ts';
import { ACTION_LABELS, DEFAULT_BINDINGS, shortcutSections } from '../../src/shell/keys.ts';
import { isEditableTarget, menuShortcut, parseShortcut } from '../../src/shell/menu-keys.ts';
import { applyPrefs, DEFAULT_PREFS, withDefaults } from '../../src/shell/prefs.ts';
import {
  applyEvents,
  INITIAL_STATUS,
  mergeNotifications,
  notificationsFrom,
  notificationSource,
  serviceTitle,
  syncIssue,
  trayNet,
} from '../../src/shell/status.ts';
import { contractAppId, tagDock, tagWindow } from '../../src/shell/testids.ts';
import type { MenuBarMenu, ShellNotification } from '../../src/shell/ui.ts';

let seq = 0;
const ev = <T extends Topic>(topic: T, data: KEvent<T>['data'], t = 1_000): KEvent =>
  ({ topic, seq: ++seq, t, data }) as KEvent;

const online: NetStatus = {
  state: 'online',
  queuedOps: 0,
  lastAckAt: 500,
  degraded: [],
  leaseTtlMs: 15_000,
  serverBuild: 'b1',
};

describe('UI-071 the AI item', () => {
  it('UI-071 a model that finished loading is idle, not "AI 100%, indexing"', () => {
    let s = applyEvents(INITIAL_STATUS, [
      ev('ai.model', { state: 'loading', loadedBytes: 10, totalBytes: 10 }),
    ]);
    expect(s.ai).toEqual({ state: 'indexing', progress: 1 });
    s = applyEvents(s, [ev('ai.model', { state: 'ready' })]);
    expect(s.ai).toEqual({ state: 'idle' });
  });

  it('UI-071 files still pending keep the indexing progress through a model ready event', () => {
    let s = applyEvents(INITIAL_STATUS, [
      ev('ai.index.progress', { pending: 3, indexedFiles: 1, chunks: 4, state: 'indexing' }),
    ]);
    expect(s.ai).toEqual({ state: 'indexing', progress: 0.25 });
    s = applyEvents(s, [ev('ai.model', { state: 'ready' })]);
    expect(s.ai).toEqual({ state: 'indexing', progress: 0.25 });
    s = applyEvents(s, [
      ev('ai.index.progress', { pending: 0, indexedFiles: 4, chunks: 8, state: 'indexing' }),
    ]);
    expect(s.ai).toEqual({ state: 'idle' });
    s = applyEvents(s, [ev('ai.model', { state: 'ready' })]);
    expect(s.ai).toEqual({ state: 'idle' });
  });
});

describe('UI-025 the tray says sync is unavailable while the sync service is degraded', () => {
  it('UI-025 online with a degraded sync service is UNAVAILABLE with its reason', () => {
    const s = applyEvents(INITIAL_STATUS, [
      ev('net.state', online),
      ev('svc.degraded', { name: 'sync', critical: false, error: 'sync client not linked' }),
    ]);
    expect(syncIssue(s.services)).toBe('sync client not linked');
    expect(trayNet(s)).toEqual({
      state: 'UNAVAILABLE',
      queued: 0,
      reason: 'sync client not linked',
    });
    const syncing = { ...s, net: { state: 'SYNCING', ops: 5 } as const };
    expect(trayNet(syncing)).toEqual({
      state: 'UNAVAILABLE',
      queued: 5,
      reason: 'sync client not linked',
    });
    const offline = { ...s, net: { state: 'OFFLINE', queued: 2 } as const };
    expect(trayNet(offline)).toBe(offline.net);
  });

  it('UI-025 a healthy or unknown sync service leaves the net state as it is', () => {
    const s = applyEvents(INITIAL_STATUS, [
      ev('net.state', online),
      ev('svc.degraded', { name: 'lockd', critical: false, error: 'local advisory locks only' }),
    ]);
    expect(trayNet(s)).toBe(s.net);
    const healed = applyEvents(s, [
      ev('svc.degraded', { name: 'sync', critical: false }),
      ev('svc.started', { name: 'sync', critical: false }),
    ]);
    expect(trayNet(healed)).toEqual({ state: 'LIVE' });
    expect(syncIssue([{ name: 'syncd', state: 'blocked', attempts: 0, blockedBy: 'netd' }])).toBe(
      'blocked by netd',
    );
  });
});

describe('UI-080 and UI-151 notifications', () => {
  const note = (id: string, extra: Partial<ShellNotification> = {}): ShellNotification => ({
    id,
    level: 'error',
    title: 'Cannot pin pid 21',
    body: 'the kernel has no pin call yet.',
    app: 'task-manager',
    appName: 'Task Manager',
    at: 1,
    ...extra,
  });

  it('UI-080 identical notifications merge into one that counts them and keeps its id', () => {
    let list = mergeNotifications([], [note('a')]);
    list = mergeNotifications(list, [note('b', { at: 2 }), note('c', { at: 3 })]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'a', count: 3, at: 3 });
    list = mergeNotifications(list, [note('d', { title: 'Something else' })]);
    expect(list.map((n) => n.id)).toEqual(['d', 'a']);
    expect(mergeNotifications(list, [], 1)).toHaveLength(1);
    expect(notificationSource(note('x'))).toBe('task-manager');
    expect(notificationSource({ id: 'y', level: 'info', title: 't', at: 0 })).toBe('System');
  });

  it('UI-151 service notifications use readable names and keep the id in the body', () => {
    const [n] = notificationsFrom([
      ev('svc.degraded', { name: 'lockd', critical: false, error: 'local advisory locks only' }),
    ]);
    expect(n).toMatchObject({
      level: 'warning',
      title: 'File locking is degraded',
      body: 'local advisory locks only (lockd)',
      appName: 'System',
    });
    expect(serviceTitle('ai.agent')).toBe('The AI agent');
    expect(serviceTitle('custom.svc')).toBe('custom.svc');
  });
});

describe('UI-087 app-menu key equivalents', () => {
  const menus: MenuBarMenu[] = [
    {
      id: 'view',
      label: 'View',
      items: [
        { id: 'view.processes', label: 'Processes', shortcut: ['Ctrl', '1'] },
        { kind: 'separator', id: 's' },
        { id: 'view.refresh', label: 'Refresh Now', shortcut: ['Ctrl', 'R'] },
        { id: 'view.off', label: 'Off', shortcut: ['Ctrl', '9'], disabled: true },
        { id: 'delete', label: 'Delete', shortcut: ['Delete'] },
        { id: 'end', label: 'Force Quit', shortcut: ['Alt', 'Ctrl', 'Q'] },
      ],
    },
  ];
  const key = (code: string, mods: { alt?: boolean; ctrl?: boolean; shift?: boolean } = {}) => ({
    code,
    key: code,
    altKey: mods.alt === true,
    ctrlKey: mods.ctrl === true,
    shiftKey: mods.shift === true,
    metaKey: false,
  });

  it('UI-087 parses keycaps into exact chords', () => {
    expect(parseShortcut(['Ctrl', 'Shift', 'N'])).toEqual({
      code: 'KeyN',
      alt: false,
      shift: true,
      ctrl: true,
      meta: false,
    });
    expect(parseShortcut(['⌘', '↵'])).toMatchObject({ code: 'Enter', meta: true });
    expect(parseShortcut(['F3'])).toMatchObject({ code: 'F3' });
    expect(parseShortcut(['Ctrl', 'A', 'B'])).toBeNull();
    expect(parseShortcut(['Ctrl', '§'])).toBeNull();
  });

  it('UI-087 finds the item for a chord; bare keys and disabled items are never bound', () => {
    expect(menuShortcut(menus, key('Digit1', { ctrl: true }))).toEqual({
      menuId: 'view',
      itemId: 'view.processes',
    });
    expect(menuShortcut(menus, key('KeyR', { ctrl: true }))?.itemId).toBe('view.refresh');
    expect(menuShortcut(menus, key('KeyQ', { ctrl: true, alt: true }))?.itemId).toBe('end');
    expect(menuShortcut(menus, key('KeyR', { ctrl: true, shift: true }))).toBeNull();
    expect(menuShortcut(menus, key('Digit9', { ctrl: true }))).toBeNull();
    expect(menuShortcut(menus, key('Delete'))).toBeNull();
    expect(
      menuShortcut([{ ...menus[0]!, disabled: true }], key('Digit1', { ctrl: true })),
    ).toBeNull();
  });

  it('UI-087 text fields keep their own keys', () => {
    const input = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const inside = document.createElement('span');
    editor.append(inside);
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(inside)).toBe(true);
    expect(isEditableTarget(checkbox)).toBe(false);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('UI-093 and UI-153 Dock items', () => {
  const app = (id: string, extra: Partial<AppEntry> = {}): AppEntry => ({
    id,
    title: id,
    icon: 'files',
    mountView: () => () => undefined,
    ...extra,
  });
  const win = (wid: number, a: string, state: DockWindow['state'] = 'normal'): DockWindow => ({
    wid,
    app: a,
    state,
    focused: false,
    attention: false,
    z: wid,
  });

  it('UI-093 each item counts its minimised windows', () => {
    const items = dockItems(
      [app('files'), app('terminal')],
      [win(1, 'files', 'minimised'), win(2, 'files'), win(3, 'terminal')],
      new Set(),
    );
    expect(items[0]).toMatchObject({ id: 'files', windows: 2, minimised: 1 });
    expect(items[1]).toMatchObject({ id: 'terminal', windows: 1, minimised: 0 });
  });

  it('UI-153 a fixed-size system panel (About) gets no Dock tile while it is open', () => {
    const about = app('about', {
      pinned: false,
      singleton: true,
      window: { resizable: false, maximizable: false },
    });
    const tool = app('tool', { pinned: false });
    expect(isSystemPanel(about)).toBe(true);
    expect(isSystemPanel(tool)).toBe(false);
    expect(
      isSystemPanel(
        app('settings', { singleton: true, window: { resizable: false, maximizable: false } }),
      ),
    ).toBe(false);
    const items = dockItems(
      [app('files'), about, tool],
      [win(1, 'about'), win(2, 'tool')],
      new Set(),
    );
    expect(items.map((i) => i.id)).toEqual(['files', 'tool']);
  });
});

describe('UI-040 preferences', () => {
  it('UI-040 defaults and Settings ranges', () => {
    expect(DEFAULT_PREFS).toMatchObject({
      clock24h: true,
      dockSize: 52,
      dockMagnifiedScale: 1.5,
      dockAutoHide: false,
      dockIndicators: true,
      titleDoubleClick: 'zoom',
      minimiseEffect: 'genie',
    });
    expect(withDefaults({ dockSize: 200, dockMagnifiedScale: 0.2 })).toMatchObject({
      dockSize: 80,
      dockMagnifiedScale: 1,
    });
    expect(withDefaults({ dockSize: Number.NaN })).toMatchObject({ dockSize: 52 });
  });

  it('UI-040 (contract C3) writes the window preferences on the root; absent means the default', () => {
    const root = { dataset: {} as DOMStringMap };
    applyPrefs(root, { ...DEFAULT_PREFS, titleDoubleClick: 'minimise', minimiseEffect: 'scale' });
    expect(root.dataset).toEqual({ titleDblclick: 'minimise', minimiseEffect: 'scale' });
    const el = document.createElement('div');
    applyPrefs(el, { ...DEFAULT_PREFS, titleDoubleClick: 'minimise', minimiseEffect: 'scale' });
    expect(el.getAttribute('data-title-dblclick')).toBe('minimise');
    expect(el.getAttribute('data-minimise-effect')).toBe('scale');
    applyPrefs(el, DEFAULT_PREFS);
    expect(el.hasAttribute('data-title-dblclick')).toBe(false);
    expect(el.hasAttribute('data-minimise-effect')).toBe(false);
  });
});

describe('UI-092 the selector contract', () => {
  it('UI-092 data-app says task-manager for the taskmgr app, on Dock items and windows', () => {
    expect(contractAppId('taskmgr')).toBe('task-manager');
    expect(contractAppId('files')).toBe('files');
    const dock = document.createElement('div');
    for (const id of ['files', 'taskmgr', 'trash']) {
      const b = document.createElement('button');
      b.setAttribute('data-dock-id', id);
      dock.append(b);
    }
    tagDock(dock);
    expect(
      Array.from(dock.querySelectorAll('[data-testid="dock-item"]')).map((b) =>
        b.getAttribute('data-app'),
      ),
    ).toEqual(['files', 'task-manager']);
    const section = document.createElement('section');
    tagWindow(section, 'taskmgr', 3);
    expect(section.getAttribute('data-app')).toBe('task-manager');
  });
});

describe('UI-077 the Keyboard Shortcuts sheet', () => {
  it('UI-077 lists every desktop action with its primary keys', () => {
    const sections = shortcutSections();
    const rows = sections.flatMap((s) => s.rows);
    expect(sections.map((s) => s.title)).toEqual(['Windows', 'Desktop']);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(Object.keys(DEFAULT_BINDINGS)));
    expect(rows.find((r) => r.id === 'overview')).toEqual({
      id: 'overview',
      label: ACTION_LABELS.overview,
      keys: ['Alt', 'O'],
    });
    expect(rows.find((r) => r.id === 'search')?.keys).toEqual(['Ctrl', 'Space']);
  });
});
