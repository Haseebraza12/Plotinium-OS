// @vitest-environment happy-dom
/**
 * The desktop-shell polish wave on the whole desktop (docs/design/bug-hunt/BUGS.md, owner
 * fix-desktop-shell): the dev harness environment (fake kernel on the real compositor-port
 * protocol, demo apps) with reduced motion on, as in desktop.test.tsx. Menu commands that reach
 * an app view are recorded by wrapping the registry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEntry, AppRegistry, DesktopEnv } from '../../src/shell/env.ts';
import { createDevEnv, type DevEnvOptions } from '../../src/shell/fixtures/dev-env.ts';
import { mountDesktop, type DesktopHandle } from '../../src/shell/mount.tsx';

vi.mock('@plotinium/ui', async (importOriginal) => {
  const { withUiAreas } = await import('./ui-areas.ts');
  return withUiAreas(await importOriginal());
});

let handle: DesktopHandle | undefined;
let root: HTMLElement | undefined;

afterEach(() => {
  handle?.dispose();
  root?.remove();
  handle = undefined;
  root = undefined;
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-motion');
  document.body.replaceChildren();
});

/** Records the menu commands each view receives; Task Manager gets menus with shortcuts. */
function recording(base: AppRegistry, log: string[]): AppRegistry {
  const wrap = (e: AppEntry): AppEntry => ({
    ...e,
    ...(e.id === 'taskmgr'
      ? {
          menus: [
            {
              id: 'view',
              label: 'View',
              items: [
                { id: 'view.processes', label: 'Processes', shortcut: ['Ctrl', '1'] },
                { id: 'view.memory', label: 'Memory', shortcut: ['Ctrl', '2'] },
              ],
            },
          ],
        }
      : {}),
    mountView: (container, ctx) => {
      const off = ctx.onMenuCommand((m, i) => log.push(`${e.id}:${m}:${i}`));
      const d = e.mountView(container, ctx);
      return typeof d === 'function'
        ? () => {
            off();
            d();
          }
        : d.then((fn) => () => {
            off();
            fn();
          });
    },
  });
  const list = base.list().map(wrap);
  return { list: () => list, get: (id) => list.find((a) => a.id === id) };
}

function mount(opts: DevEnvOptions = {}, patch: (env: DesktopEnv) => DesktopEnv = (e) => e) {
  const dev = createDevEnv({ reducedMotion: true, login: false, restore: false, ...opts });
  const log: string[] = [];
  const el = document.createElement('div');
  document.body.append(el);
  root = el;
  const h = mountDesktop(el, patch({ ...dev.env, apps: recording(dev.env.apps, log) }));
  handle = h;
  dev.bindPrefs((p) => h.setPrefs(p));
  return { dev, h, log };
}

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const q = <T extends Element = HTMLElement>(sel: string): T | null =>
  document.querySelector<T>(sel);
const win = (app: string): HTMLElement | null => q(`[data-testid="window"][data-app="${app}"]`);
const byText = (sel: string, text: string | RegExp): HTMLElement | undefined =>
  Array.from(document.querySelectorAll<HTMLElement>(sel)).find((el) =>
    typeof text === 'string' ? el.textContent.trim() === text : text.test(el.textContent),
  );

function key(
  code: string,
  mods: { alt?: boolean; ctrl?: boolean; shift?: boolean } = {},
  k = code,
  target: EventTarget = window,
): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    code,
    key: k,
    altKey: mods.alt === true,
    ctrlKey: mods.ctrl === true,
    shiftKey: mods.shift === true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
}

function click(el: Element | null | undefined): void {
  if (el === null || el === undefined) throw new Error('nothing to click');
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

async function openMenu(title: string): Promise<void> {
  click(
    q(`[role="menuitem"][aria-label="${title}"]`) ??
      byText('[role="menubar"] [role="menuitem"]', title),
  );
  await tick();
}

describe('UI-desktop-shell menu bar and status', () => {
  it('UI-023 kernel status events never re-create the menu-bar titles', async () => {
    const { dev } = mount();
    await tick();
    const atom = q('[role="menuitem"][aria-label="Plotinium"]');
    atom?.focus();
    for (let i = 0; i < 5; i++) {
      dev.seedStatus();
      dev.kernel.publish('mem.pressure', {
        accounted: (100 + i) * 1024 * 1024,
        budget: 256 * 1024 * 1024,
        level: 'ok',
      });
      await tick(2);
    }
    expect(q('[role="menuitem"][aria-label="Plotinium"]')).toBe(atom);
    expect(document.activeElement).toBe(atom);
  });

  it('UI-085 the desktop app menu has its own name; UI-086 it offers no dead Quit', async () => {
    mount();
    await tick();
    const desktop = q('[role="menuitem"][aria-label="Plotinium desktop"]');
    expect(desktop?.textContent).toContain('Plotinium');
    await openMenu('Plotinium desktop');
    const items = Array.from(
      document.querySelectorAll('[role="menu"][aria-label="Plotinium desktop"] [role="menuitem"]'),
    ).map((m) => m.textContent.trim());
    expect(items).toEqual(['About Plotinium', 'Settings…']);
    expect(q('nav[aria-label="Dock"]')).not.toBeNull();
    expect(q('[role="toolbar"][aria-label="Taskbar"]')).toBeNull();
  });

  it('UI-025 a degraded sync service turns the chip into "Sync unavailable"', async () => {
    const { dev } = mount();
    await tick();
    dev.seedStatus();
    dev.kernel.publish('svc.degraded', {
      name: 'syncd',
      critical: false,
      error: 'sync client not linked',
    });
    await tick();
    const chip = q('[data-testid="net-status"]');
    expect(chip?.getAttribute('aria-label')).toBe('Sync: Sync unavailable, sync client not linked');
    click(chip);
    await tick();
    const pop = q('[role="dialog"][aria-label="Connectivity and degraded services"]');
    expect(pop?.textContent).toContain('Sync unavailable');
    expect(pop?.textContent).not.toContain("You're offline");
  });

  it('UI-040 the "since" time of a degraded service follows Settings › 24-hour time', async () => {
    const at = Date.UTC(2026, 8, 24, 21, 5, 9);
    const { dev, h } = mount({ now: () => at });
    await tick();
    dev.seedStatus();
    dev.kernel.publish('svc.degraded', { name: 'syncd', critical: false, error: 'not linked' });
    await tick();
    click(q('[data-testid="net-status"]'));
    await tick();
    const pop = (): string =>
      q('[role="dialog"][aria-label="Connectivity and degraded services"]')?.textContent ?? '';
    expect(pop()).toMatch(/\d\d:05:09(?! ?[AP]M)/u);
    h.setPrefs({ clock24h: false });
    await tick();
    expect(pop()).toMatch(/\d{1,2}:05:09\s?[AP]M/u);
  });

  it('UI-040 the clock follows Settings › 24-hour time', async () => {
    const { h } = mount({ now: () => Date.UTC(2026, 8, 24, 21, 5) });
    await tick();
    const clock = (): string => q('[data-status-item="clock"]')?.textContent ?? '';
    expect(clock()).toMatch(/\d\d:05/u);
    h.setPrefs({ clock24h: false });
    await tick();
    expect(clock()).toMatch(/\d{1,2}:05 (AM|PM)/u);
  });
});

describe('UI-desktop-shell Control Centre and banners', () => {
  it('UI-073 a second click on the Control Centre button closes it for good', async () => {
    mount();
    await tick();
    const trigger = q('[data-status-item="control-centre"]');
    click(trigger);
    await tick();
    expect(q('[role="dialog"][aria-label="Control Centre"]')).not.toBeNull();
    click(trigger);
    await tick();
    expect(q('[role="dialog"][aria-label="Control Centre"]')).toBeNull();
    click(q('[data-status-item="clock"]'));
    await tick();
    expect(q('[role="dialog"][aria-label="Control Centre"]')).not.toBeNull();
    click(q('[data-status-item="clock"]'));
    await tick();
    expect(q('[role="dialog"][aria-label="Control Centre"]')).toBeNull();
  });

  it('UI-081 Alt+C moves focus into Control Centre and Escape returns it', async () => {
    mount();
    await tick();
    const search = q('[data-status-item="search"]');
    search?.focus();
    key('KeyC', { alt: true });
    await tick();
    const cc = q('[role="dialog"][aria-label="Control Centre"]');
    expect(cc?.contains(document.activeElement)).toBe(true);
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await tick();
    expect(q('[role="dialog"][aria-label="Control Centre"]')).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it('UI-024 opening Control Centre hands the banners over; none appear while it is open', async () => {
    const { h } = mount();
    await tick();
    h.notify({ id: 'a', level: 'warning', title: 'First', at: Date.now(), unread: true });
    await tick();
    expect(q('section[aria-label="Notification banners"]')?.textContent).toContain('First');
    click(q('[data-status-item="control-centre"]'));
    await tick();
    expect(q('section[aria-label="Notification banners"]')).toBeNull();
    h.notify({ id: 'b', level: 'error', title: 'Second', at: Date.now(), unread: true });
    await tick();
    expect(q('section[aria-label="Notification banners"]')).toBeNull();
    const centre = byText('section', /^Notifications/u);
    expect(centre?.textContent).toContain('Second');
    click(q('[data-status-item="control-centre"]'));
    await tick();
    expect(q('section[aria-label="Notification banners"]')?.textContent ?? '').not.toContain(
      'First',
    );
  });

  it('UI-024 Search and Overview hide the banners until they close', async () => {
    const { h } = mount();
    await tick();
    h.notify({ id: 'a', level: 'warning', title: 'Banner', at: Date.now(), unread: true });
    await tick();
    key('Space', { ctrl: true }, ' ');
    await tick();
    expect(q('section[aria-label="Notification banners"]')).toBeNull();
    key('Escape', {}, 'Escape', q('[role="combobox"]') ?? window);
    await tick();
    expect(q('section[aria-label="Notification banners"]')?.textContent).toContain('Banner');
  });

  it('UI-080 repeats merge into one banner with a count; one banner per source per 2 s', async () => {
    const { h } = mount();
    await tick();
    const n = (id: string, title: string) => ({
      id,
      level: 'warning' as const,
      title,
      app: 'task-manager' as const,
      appName: 'Task Manager',
      at: Date.now(),
      unread: true,
    });
    h.notify(n('1', 'Cannot pin pid 21'));
    h.notify(n('2', 'Cannot pin pid 21'));
    h.notify(n('3', 'Cannot pin pid 21'));
    h.notify(n('4', 'Something else'));
    await tick();
    const banners = q('section[aria-label="Notification banners"]');
    expect(banners?.querySelectorAll('article')).toHaveLength(1);
    expect(banners?.textContent).toContain('×3');
    expect(banners?.textContent).not.toContain('Something else');
  });

  it('UI-151 a service that recovers takes its "is degraded" banner and card with it', async () => {
    const { dev } = mount();
    await tick();
    dev.kernel.publish('svc.degraded', { name: 'sync', critical: false, error: 'connecting' });
    dev.kernel.publish('svc.degraded', { name: 'lockd', critical: false, error: 'local only' });
    await tick();
    // The banner cards only: the section's live region keeps the last announcement.
    const banners = (): string =>
      Array.from(document.querySelectorAll('section[aria-label="Notification banners"] article'))
        .map((a) => a.textContent)
        .join('\n');
    expect(banners()).toContain('Sync is degraded');
    dev.kernel.publish('svc.started', { name: 'sync', critical: false });
    await tick();
    expect(banners()).not.toContain('Sync is degraded');
    click(q('[data-status-item="control-centre"]'));
    await tick();
    const centre = byText('section', /^Notifications/u)?.textContent ?? '';
    expect(centre).not.toContain('Sync is degraded');
    // Another service's notification stays until that service recovers.
    expect(centre).toContain('File locking is degraded');
  });

  it('UI-074 a refused retry ends "Retrying…" with the reason', async () => {
    let answer: (v: string | undefined) => void = () => undefined;
    const { dev } = mount({}, (env) => ({
      ...env,
      retryService: () =>
        new Promise<string | undefined>((resolve) => {
          answer = resolve;
        }),
    }));
    await tick();
    dev.kernel.publish('svc.degraded', { name: 'lockd', critical: false, error: 'local only' });
    await tick();
    click(q('[data-status-item="control-centre"]'));
    await tick();
    click(byText('button', /^Degraded services: 1 degraded/u));
    await tick();
    click(q('button[aria-label="Retry lockd now"]'));
    await tick();
    expect(q('button[aria-label="Retrying lockd"]')?.textContent).toBe('Retrying…');
    answer('not self-healing');
    await tick();
    expect(q('button[aria-label="Retry lockd now"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Could not retry: not self-healing');
  });

  it('UI-072 the frame meter moves left while Control Centre is open', async () => {
    const { h } = mount();
    await tick();
    h.setPrefs({ frameMeter: true });
    await tick();
    const hud = (): HTMLElement | null =>
      q('[aria-label="Frame meter details"]')?.parentElement ?? null;
    expect(hud()?.dataset['shifted']).toBeUndefined();
    click(q('[data-status-item="control-centre"]'));
    await tick();
    expect(hud()?.dataset['shifted']).toBe('true');
  });
});

describe('UI-desktop-shell system actions, help and about', () => {
  it('UI-028 Log Out asks first, saves the layout strictly, then logs out', async () => {
    const { dev } = mount();
    await tick();
    await openMenu('Plotinium');
    click(byText('[role="menuitem"]', 'Log Out student…'));
    await tick();
    expect(document.body.textContent).toContain('Log out student?');
    click(byText('button', 'Log Out'));
    await tick();
    expect(dev.saved.at(-1)?.durability).toBe('strict');
    expect(dev.calls).toContain('power:logout');
  });

  it('UI-076 "About <App>" describes that app, not Plotinium', async () => {
    const { h, dev } = mount();
    await tick();
    h.launch('files');
    await tick();
    await openMenu('Files');
    click(byText('[role="menuitem"]', 'About Files'));
    await tick();
    const dialog = q('[role="dialog"][aria-modal="true"]');
    expect(dialog?.textContent).toContain('Files');
    expect(dialog?.textContent).toContain('Version 0.3.0 · build a1f93c2');
    expect(dev.kernel.launched.map((l) => l.app)).not.toContain('about');
  });

  it('UI-077 Help › Keyboard Shortcuts and "<App> Help" open the shell help sheet', async () => {
    const { h, dev } = mount();
    await tick();
    h.launch('taskmgr');
    await tick();
    await openMenu('Help');
    click(byText('[role="menuitem"]', 'Keyboard Shortcuts'));
    await tick();
    expect(q('[role="dialog"][aria-modal="true"]')?.textContent).toContain('Keyboard Shortcuts');
    expect(q('[role="dialog"][aria-modal="true"]')?.textContent).toContain('Overview');
    expect(dev.kernel.launched.map((l) => l.app)).not.toContain('settings');
    click(byText('button', 'Done'));
    await tick(10);
    await openMenu('Help');
    click(byText('[role="menuitem"]', 'Task Manager Help'));
    await tick();
    const sheet = q('[role="dialog"][aria-modal="true"]');
    expect(sheet?.textContent).toContain('Task Manager Help');
    expect(sheet?.querySelector('dt')?.textContent).toBe('Processes');
  });

  it('UI-077 a running singleton is sent where the launch asked (taskmgr memory → view.memory)', async () => {
    const { h, log, dev } = mount();
    await tick();
    h.launch('taskmgr');
    await tick();
    h.launch('taskmgr', ['memory']);
    await tick();
    expect(dev.kernel.launched.map((l) => l.app)).toEqual(['taskmgr']);
    expect(log).toContain('taskmgr:view:view.memory');
  });

  it('UI-077 without an agent the AI chip opens Settings › Privacy & AI', async () => {
    const { dev } = mount({}, (env) => ({
      ...env,
      search: { query: () => Promise.resolve({ results: [] }) },
    }));
    await tick();
    click(q('[data-status-item="ai"]'));
    await tick();
    expect(dev.kernel.launched.at(-1)).toEqual({ app: 'settings', argv: ['privacy'] });
  });

  it("UI-084 the Dock Trash opens Files at the Trash (Files' Go › Trash)", async () => {
    const { log, dev } = mount();
    await tick();
    click(q('[data-dock-id="trash"]'));
    await tick(10);
    expect(dev.kernel.launched.map((l) => l.app)).toEqual(['files']);
    expect(log).toContain('files:go:go.trash');
    click(q('[data-dock-id="trash"]'));
    await tick(10);
    expect(dev.kernel.launched.map((l) => l.app)).toEqual(['files']);
    expect(log.filter((l) => l === 'files:go:go.trash')).toHaveLength(2);
  });

  it("UI-087 a focused app's menu shortcut runs its item when the app did not handle the key", async () => {
    const { h, log } = mount();
    await tick();
    h.launch('taskmgr');
    await tick();
    const view = win('task-manager')?.querySelector('[data-wm-view]') ?? null;
    const ev = key('Digit2', { ctrl: true }, '2', view ?? window);
    await tick();
    expect(log).toContain('taskmgr:view:view.memory');
    expect(ev.defaultPrevented).toBe(true);
    // A key the app handled itself is left alone.
    const handled = new KeyboardEvent('keydown', {
      code: 'Digit1',
      key: '1',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    view?.dispatchEvent(handled);
    await tick();
    expect(log).not.toContain('taskmgr:view:view.processes');
  });
});

describe('UI-desktop-shell Dock and keyboard', () => {
  it('UI-078 Alt+N focuses the first app; Escape returns to the focused window', async () => {
    const { h } = mount();
    await tick();
    h.launch('editor');
    await tick();
    key('KeyN', { alt: true });
    await tick();
    expect(document.activeElement?.getAttribute('data-dock-id')).toBe('files');
    key('Escape', {}, 'Escape', document.activeElement ?? window);
    await tick();
    expect(win('editor')?.contains(document.activeElement)).toBe(true);
  });

  it('UI-078 Escape in a Dock item menu hands focus back to its icon', async () => {
    mount();
    await tick();
    const icon = q('[data-dock-id="terminal"]');
    icon?.focus();
    key('F10', { shift: true }, 'F10', icon ?? window);
    await tick();
    const menu = q('[role="menu"]');
    expect(menu).not.toBeNull();
    key('Escape', {}, 'Escape', document.activeElement ?? menu ?? window);
    await tick();
    expect(q('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(icon);
  });

  it('UI-088 Tab past the last stop wraps to the menu bar, Shift+Tab back to the last', async () => {
    mount();
    await tick();
    const dockStop = q('[data-dock-id="files"]');
    dockStop?.focus();
    const tab = key('Tab', {}, 'Tab', dockStop ?? window);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Plotinium');
    const back = key('Tab', { shift: true }, 'Tab', document.activeElement ?? window);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dockStop);
  });

  it('UI-092 and UI-153 contract ids; About gets no Dock tile', async () => {
    const { h } = mount();
    await tick();
    h.launch('taskmgr');
    h.launch('about');
    await tick();
    expect(q('[data-testid="dock-item"][data-app="task-manager"]')).not.toBeNull();
    expect(win('task-manager')).not.toBeNull();
    expect(win('about')).not.toBeNull();
    expect(q('[data-dock-id="about"]')).toBeNull();
  });

  it('UI-093 minimising a window shows the marker and says "1 minimised"', async () => {
    const { h } = mount();
    await tick();
    h.launch('terminal');
    await tick();
    key('KeyM', { alt: true });
    await tick();
    const button = q('[data-dock-id="terminal"]');
    expect(button?.getAttribute('aria-label')).toBe('Terminal, running, 1 window, 1 minimised');
  });

  it('UI-040 Dock size, auto-hide and indicators follow the preferences', async () => {
    const { h } = mount();
    await tick();
    h.setPrefs({ dockSize: 64, dockAutoHide: true, dockIndicators: false });
    await tick();
    const nav = q('nav[aria-label="Dock"]');
    expect(nav?.style.getPropertyValue('--pl-dock-icon')).toBe('64px');
    expect(nav?.dataset['autohide']).toBe('true');
    expect(nav?.dataset['indicators']).toBe('false');
    expect(document.documentElement.style.getPropertyValue('--pl-dock-reserve')).toBe('8px');
    h.setPrefs({ dockAutoHide: false });
    await tick();
    expect(document.documentElement.style.getPropertyValue('--pl-dock-reserve')).toBe('96px');
    h.setPrefs({ titleDoubleClick: 'minimise' });
    await tick();
    expect(document.documentElement.getAttribute('data-title-dblclick')).toBe('minimise');
  });
});

describe('UI-desktop-shell lock, Overview and Search', () => {
  it('UI-027 the lock makes the desktop inert, closes Search, and gives focus back after', async () => {
    const { h } = mount();
    await tick();
    h.launch('editor');
    await tick();
    const desktop = q('[data-testid="desktop"]');
    key('Space', { ctrl: true }, ' ');
    await tick();
    expect(q('[role="dialog"][aria-label="Search"]')).not.toBeNull();
    h.lock();
    await tick();
    expect(desktop?.hasAttribute('inert')).toBe(true);
    expect(desktop?.getAttribute('aria-hidden')).toBe('true');
    expect(q('[role="dialog"][aria-label="Search"]')).toBeNull();
    const input = q<HTMLInputElement>('[data-testid="login-password"]');
    if (input === null) throw new Error('no lock screen');
    input.value = 'plotinium';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    input.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick(12);
    expect(q('[data-testid="login-screen"]')).toBeNull();
    expect(desktop?.hasAttribute('inert')).toBe(false);
    expect(desktop?.hasAttribute('aria-hidden')).toBe(false);
    expect(win('editor')?.contains(document.activeElement)).toBe(true);
  });

  it('UI-027 Tab wraps inside the lock screen and never rests on the page body', async () => {
    const { h } = mount();
    await tick();
    h.lock();
    await tick();
    const gate = q('[data-testid="login-screen"]');
    if (gate === null) throw new Error('no lock screen');
    const stops = Array.from(
      gate.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]'),
    ).filter((el) => el.getAttribute('tabindex') !== '-1');
    const first = stops[0];
    const last = stops[stops.length - 1];
    last?.focus();
    expect(key('Tab', {}, 'Tab', last).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(key('Tab', { shift: true }, 'Tab', first).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    // From the body (a click on nothing), Tab goes back into the lock screen.
    (document.activeElement as HTMLElement | null)?.blur();
    key('Tab', {}, 'Tab', document.body);
    expect(gate.contains(document.activeElement)).toBe(true);
    // In the middle of the screen Tab is the browser's own.
    const mid = stops[1];
    mid?.focus();
    expect(key('Tab', {}, 'Tab', mid).defaultPrevented).toBe(false);
  });

  it('UI-083 Overview hides the bars and leaves on a click in the empty space', async () => {
    const { h } = mount();
    await tick();
    h.launch('files');
    await tick();
    key('F3');
    await tick();
    expect(q('[data-testid="desktop"]')?.dataset['overview']).toBe('true');
    click(q('[role="listbox"][aria-label="Open windows"]'));
    await new Promise((r) => setTimeout(r, 10));
    await tick();
    expect(q('[data-testid="desktop"]')?.dataset['overview']).toBeUndefined();
  });

  it('UI-083 a press on the bare desktop unfocuses the windows; a press in a window focuses it again', async () => {
    const { h } = mount();
    await tick();
    h.launch('files');
    await tick(20);
    const w = win('files');
    const frame = w?.querySelector('[data-focused]') ?? w;
    expect(frame?.getAttribute('data-focused')).toBe('true');
    const shell = q('[data-testid="desktop"]');
    shell?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    await tick();
    expect(frame?.getAttribute('data-focused')).toBe('false');
    expect(w?.contains(document.activeElement)).toBe(false);
    // The menu bar shows the desktop's own menu; window keys reach no window.
    expect(q('[role="menuitem"][aria-label="Plotinium desktop"]')).not.toBeNull();
    key('KeyM', { alt: true }, 'm');
    await tick();
    expect(h.layout().find((r) => r.app === 'files')?.state).not.toBe('minimised');
    // A press inside the window shows it focused again.
    w?.querySelector('[data-wm-view]')?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
    );
    await tick();
    expect(frame?.getAttribute('data-focused')).toBe('true');
    expect(q('[role="menuitem"][aria-label="Plotinium desktop"]')).toBeNull();
  });

  it('UI-046 with no search provider the palette says "Search apps"', async () => {
    mount({}, (env) => {
      const { search: _drop, ...rest } = env;
      return rest;
    });
    await tick();
    key('Space', { ctrl: true }, ' ');
    await tick();
    const box = q<HTMLInputElement>('[role="combobox"]');
    expect(box?.getAttribute('placeholder')).toBe('Search apps');
    expect(q('[role="dialog"][aria-label="Search"]')?.textContent).not.toContain('Semantic');
  });
});
