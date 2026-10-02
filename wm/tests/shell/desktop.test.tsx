// @vitest-environment happy-dom
/**
 * The desktop shell rendered in happy-dom with the dev harness environment (fake kernel on the
 * real compositor-port protocol, demo apps). Reduced motion is on, so no WAAPI animation runs and
 * every window transition settles in a few microtasks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDevEnv,
  DEV_PASSWORD,
  type DevEnvOptions,
} from '../../src/shell/fixtures/dev-env.ts';
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

function mount(
  opts: DevEnvOptions = {},
  extra: { onPhase?: (p: 'login' | 'desktop') => void } = {},
) {
  const dev = createDevEnv({ reducedMotion: true, ...opts });
  const el = document.createElement('div');
  document.body.append(el);
  root = el;
  const h = mountDesktop(el, {
    ...dev.env,
    ...(extra.onPhase === undefined ? {} : { onPhase: extra.onPhase }),
  });
  handle = h;
  dev.bindPrefs((p) => h.setPrefs(p));
  return { dev, h };
}

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const q = <T extends Element = HTMLElement>(sel: string): T | null =>
  document.querySelector<T>(sel);
const windows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll('[data-testid="window"]'));
const win = (app: string): HTMLElement | null => q(`[data-testid="window"][data-app="${app}"]`);

function key(
  code: string,
  mods: { alt?: boolean; ctrl?: boolean; shift?: boolean; meta?: boolean } = {},
  k = code,
  type = 'keydown',
): void {
  window.dispatchEvent(
    new KeyboardEvent(type, {
      code,
      key: k,
      altKey: mods.alt === true,
      ctrlKey: mods.ctrl === true,
      shiftKey: mods.shift === true,
      metaKey: mods.meta === true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function click(el: Element | null): void {
  if (el === null) throw new Error('nothing to click');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function pointerDown(el: Element | null): void {
  if (el === null) throw new Error('nothing to press');
  el.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }),
  );
}

async function signIn(password: string): Promise<void> {
  const input = q<HTMLInputElement>('[data-testid="login-password"]');
  if (input === null) throw new Error('no password field');
  input.value = password;
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  const form = input.closest('form');
  form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await tick(8);
}

async function launch(h: DesktopHandle, app: string): Promise<void> {
  h.launch(app);
  await tick();
}

describe('login (BOOT-14)', () => {
  it('BOOT-14 lists the users and Guest, rejects a wrong password, then mounts the desktop', async () => {
    const phases: string[] = [];
    mount({ restore: false }, { onPhase: (p) => phases.push(p) });
    await tick();
    expect(q('[data-testid="login-screen"]')).not.toBeNull();
    expect(q('[data-testid="desktop"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="login-user-tile"]')).toHaveLength(2);
    expect(q('[data-testid="login-guest"]')?.getAttribute('data-user')).toBe('Guest');
    expect(phases).toEqual(['login']);

    await signIn('wrong');
    expect(document.body.textContent).toContain('Invalid username or password');
    expect(q('[data-testid="desktop"]')).toBeNull();

    await signIn(DEV_PASSWORD);
    await tick(8);
    expect(q('[data-testid="desktop"]')).not.toBeNull();
    expect(q('[data-testid="login-screen"]')).toBeNull();
    expect(phases).toEqual(['login', 'desktop']);
    expect(handle?.sessionId()).toBe('dev-session');
  });

  it('BOOT-14 the Guest tile signs in without a password', async () => {
    mount({ restore: false });
    await tick();
    const guest = q('[data-testid="login-guest"]');
    click(guest);
    await tick();
    const go = Array.from(document.querySelectorAll('button')).find((b) =>
      /continue|sign in/iu.test(b.textContent),
    );
    click(go ?? null);
    await tick(10);
    expect(q('[data-testid="desktop"]')).not.toBeNull();
  });

  it('OFF-03 shows the offline notice when the server is unreachable', async () => {
    mount({ restore: false, offline: true });
    await tick();
    expect(q('[data-testid="login-offline-notice"]')).not.toBeNull();
  });

  it('BOOT-14 locks the session and unlocks it with the password again', async () => {
    const { h } = mount({ login: false, restore: false });
    await tick();
    expect(q('[data-testid="login-screen"]')).toBeNull();
    h.lock();
    await tick();
    expect(q('[data-testid="login-screen"]')).not.toBeNull();
    expect(q('[data-testid="desktop"]')).not.toBeNull();
    key('KeyT', { alt: true });
    await tick();
    expect(windows()).toHaveLength(0);
    await signIn(DEV_PASSWORD);
    await tick(8);
    expect(q('[data-testid="login-screen"]')).toBeNull();
  });
});

describe('windows through the compositor (WM-01, WM-02, WM-04)', () => {
  it('WM-06 restores the saved layout, focuses the saved window and saves layouts back', async () => {
    const { h, dev } = mount({ login: false });
    await tick(10);
    expect(h.layout().map((r) => r.app)).toEqual(['terminal', 'taskmgr', 'files']);
    expect(windows()).toHaveLength(3);
    expect(win('files')?.getAttribute('data-focused')).toBe('true');
    // Saved at 1440 × 900; happy-dom's viewport is smaller, so the rectangle is scaled (§3.15 rule 3).
    const fx = window.innerWidth / 1440;
    expect(h.layout().find((r) => r.app === 'files')).toMatchObject({
      x: Math.round(72 * fx),
      w: Math.round(800 * fx),
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(dev.saved.at(-1)?.layout.windows.map((w) => w.app)).toEqual([
      'terminal',
      'taskmgr',
      'files',
    ]);
  });

  it('WM-01 opens windows from the kernel create message and raises the one you press', async () => {
    const { h, dev } = mount({ login: false, restore: false });
    await launch(h, 'files');
    await launch(h, 'terminal');
    expect(dev.kernel.launched.map((l) => l.app)).toEqual(['files', 'terminal']);
    expect(h.layout().map((r) => r.app)).toEqual(['files', 'terminal']);
    expect(win('terminal')?.getAttribute('data-focused')).toBe('true');
    pointerDown(win('files'));
    await tick();
    expect(h.layout().at(-1)?.app).toBe('files');
    expect(h.layout().map((r) => r.z)).toEqual([1, 2]);
    expect(win('files')?.getAttribute('data-focused')).toBe('true');
    expect(win('terminal')?.getAttribute('data-focused')).toBe('false');
    expect(dev.kernel.sent).toContainEqual(expect.objectContaining({ t: 'focused', wid: 1 }));
  });

  it('WM-01 mounts the app view into its window and follows setTitle', async () => {
    const { h } = mount({ login: false, restore: false });
    await launch(h, 'terminal');
    const view = win('terminal')?.querySelector('[data-wm-view]');
    expect(view?.querySelector('[data-app-view="terminal"]')).not.toBeNull();
    expect(win('terminal')?.textContent).toContain('student — sh — 80×24');
  });

  it('WM-01 unified apps get floating traffic lights; fixed-size apps lose resize handles', async () => {
    const { h } = mount({ login: false, restore: false });
    await launch(h, 'files');
    await launch(h, 'about');
    expect(win('files')?.querySelector('[data-titlebar="overlay"]')).not.toBeNull();
    expect(win('files')?.querySelectorAll('[data-testid^="window-resize-"]').length).toBe(8);
    expect(win('about')?.querySelectorAll('[data-edge]').length).toBe(0);
    expect(
      win('about')?.querySelector('[data-testid="window-maximise"]')?.getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('WM-04 minimises to the dock, restores from the dock, maximises and restores with the zoom button', async () => {
    const { h } = mount({ login: false, restore: false });
    await launch(h, 'terminal');
    click(win('terminal')?.querySelector('[data-testid="window-minimise"]') ?? null);
    await tick();
    expect(h.layout()[0]?.state).toBe('minimised');
    expect(win('terminal')?.getAttribute('data-state')).toBe('minimised');
    click(q('[data-testid="dock-item"][data-app="terminal"]'));
    await tick();
    expect(h.layout()[0]?.state).toBe('normal');
    click(win('terminal')?.querySelector('[data-testid="window-maximise"]') ?? null);
    await tick();
    const max = h.layout()[0];
    expect(max?.state).toBe('maximised');
    expect(max?.y).toBe(28);
    click(win('terminal')?.querySelector('[data-testid="window-maximise"]') ?? null);
    await tick();
    expect(h.layout()[0]?.state).toBe('normal');
  });

  it('WM-02 the dock lists the pinned apps, launches, focuses and minimises like WMD-10', async () => {
    const { h, dev } = mount({ login: false, restore: false });
    await tick();
    const ids = Array.from(document.querySelectorAll('[data-testid="dock-item"]')).map((b) =>
      b.getAttribute('data-app'),
    );
    // data-app follows the selector contract (UI-092): the app id taskmgr is `task-manager`.
    expect(ids).toEqual(['files', 'terminal', 'editor', 'task-manager', 'settings']);
    click(q('[data-testid="dock-item"][data-app="editor"]'));
    await tick();
    expect(dev.kernel.launched.map((l) => l.app)).toEqual(['editor']);
    expect(win('editor')).not.toBeNull();
    click(q('[data-testid="dock-item"][data-app="editor"]'));
    await tick();
    expect(h.layout()[0]?.state).toBe('minimised');
    expect(
      Array.from(document.querySelectorAll('[data-testid="dock-item"]')).map((b) =>
        b.getAttribute('data-app'),
      ),
    ).toContain('editor');
  });

  it('WM-02 a singleton app focuses its window instead of opening another', async () => {
    const { h, dev } = mount({ login: false, restore: false });
    await launch(h, 'taskmgr');
    await launch(h, 'files');
    await launch(h, 'taskmgr');
    expect(dev.kernel.launched.map((l) => l.app)).toEqual(['taskmgr', 'files']);
    expect(h.layout().at(-1)?.app).toBe('taskmgr');
  });

  it('WM-01 the close button asks the kernel, which closes the window', async () => {
    const { h, dev } = mount({ login: false, restore: false });
    await launch(h, 'editor');
    click(win('editor')?.querySelector('[data-testid="window-close"]') ?? null);
    await tick();
    expect(dev.kernel.sent).toContainEqual(
      expect.objectContaining({ t: 'closeRequested', wid: 1 }),
    );
    expect(windows()).toHaveLength(0);
    expect(h.layout()).toEqual([]);
  });

  it('WM-01 a close guard asks before discarding unsaved changes', async () => {
    const { h, dev } = mount({ login: false, restore: false });
    await launch(h, 'editor');
    dev.kernel.emit({ t: 'closeGuard', wid: 1, reason: 'os-report.md has unsaved changes.' });
    click(win('editor')?.querySelector('[data-testid="window-close"]') ?? null);
    await tick();
    expect(document.body.textContent).toContain('Discard unsaved changes?');
    expect(windows()).toHaveLength(1);
    const discard = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Discard and Close',
    );
    click(discard ?? null);
    await tick();
    expect(windows()).toHaveLength(0);
  });

  it('WM-01 kernel focus, title and attention messages reach the chrome', async () => {
    const { h, dev } = mount({ login: false, restore: false });
    await launch(h, 'files');
    await launch(h, 'terminal');
    dev.kernel.emit({ t: 'setTitle', wid: 1, title: 'Downloads' });
    dev.kernel.emit({ t: 'focus', wid: 1, seq: 99 });
    await tick();
    expect(win('files')?.textContent).toContain('Downloads');
    expect(h.layout().at(-1)?.app).toBe('files');
    dev.kernel.emit({ t: 'attention', wid: 2, level: 'info' });
    await tick();
    expect(win('terminal')).not.toBeNull();
    dev.kernel.emit({ t: 'suspend', wid: 2 });
    await tick();
    expect(win('terminal')?.textContent).toContain('Suspended');
  });
});

describe('keyboard (WM-07)', () => {
  it('WM-07 Alt+T opens a terminal, Alt+M minimises, Alt+Q closes', async () => {
    const { h } = mount({ login: false, restore: false });
    await tick();
    key('KeyT', { alt: true });
    await tick();
    expect(win('terminal')).not.toBeNull();
    key('KeyM', { alt: true });
    await tick();
    expect(h.layout()[0]?.state).toBe('minimised');
    click(q('[data-testid="dock-item"][data-app="terminal"]'));
    await tick();
    key('KeyQ', { alt: true });
    await tick();
    expect(h.layout()).toEqual([]);
  });

  it('WM-07 Alt+Shift+arrows snap and maximise the focused window', async () => {
    const { h } = mount({ login: false, restore: false });
    await launch(h, 'files');
    key('ArrowLeft', { alt: true, shift: true });
    await tick();
    expect(h.layout()[0]).toMatchObject({ x: 0, y: 28 });
    key('ArrowUp', { alt: true, shift: true });
    await tick();
    expect(h.layout()[0]?.state).toBe('maximised');
    key('ArrowDown', { alt: true, shift: true });
    await tick();
    expect(h.layout()[0]?.state).toBe('normal');
  });

  it('WM-07 Alt+` switches to the previous window when Alt is released', async () => {
    const { h } = mount({ login: false, restore: false });
    await launch(h, 'files');
    await launch(h, 'terminal');
    key('Backquote', { alt: true }, '`');
    key('Alt', {}, 'Alt', 'keyup');
    await tick();
    expect(h.layout().at(-1)?.app).toBe('files');
    key('Backquote', { alt: true }, '`');
    key('Escape', { alt: true }, 'Escape');
    key('Alt', {}, 'Alt', 'keyup');
    await tick();
    expect(h.layout().at(-1)?.app).toBe('files');
  });

  it('WM-07 Ctrl+Space opens Search; typing lists apps and files; Enter on an app launches it', async () => {
    const { h, dev } = mount({ login: false, restore: false });
    await tick();
    key('Space', { ctrl: true }, ' ');
    await tick();
    const box = q<HTMLInputElement>('[role="combobox"]');
    expect(box).not.toBeNull();
    expect(q('[role="dialog"][aria-label="Search"]')).not.toBeNull();
    if (box === null) return;
    box.value = 'term';
    box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    await tick();
    expect(document.body.textContent).toContain('Terminal');
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
      o.textContent.includes('Terminal'),
    );
    click(option ?? null);
    option?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    await tick();
    expect(dev.kernel.launched.map((l) => l.app)).toContain('terminal');
    expect(h.layout().length).toBeGreaterThan(0);
  });

  it('WM-07 F3 and Ctrl+Up open Overview; Escape closes it', async () => {
    const { h } = mount({ login: false, restore: false });
    await launch(h, 'files');
    key('F3');
    await tick();
    expect(q('[role="dialog"][aria-label="Overview"]')).not.toBeNull();
    expect(q('[data-overview="true"]')).not.toBeNull();
    key('F3');
    await new Promise((r) => setTimeout(r, 10));
    await tick();
    expect(q('[data-overview="true"]')).toBeNull();
    key('ArrowUp', { ctrl: true });
    await tick();
    expect(q('[role="dialog"][aria-label="Overview"]')).not.toBeNull();
  });

  it('WM-07 Alt+C toggles Control Centre, whose theme control changes the applied theme', async () => {
    const { dev } = mount({ login: false, restore: false, theme: 'dark' });
    await tick();
    expect(document.documentElement.dataset['theme']).toBe('dark');
    key('KeyC', { alt: true });
    await tick();
    expect(q('[role="dialog"][aria-label="Control Centre"]')).not.toBeNull();
    const light = Array.from(document.querySelectorAll('button, [role="radio"]')).find(
      (b) => b.textContent.trim() === 'Light',
    );
    click(light ?? null);
    await tick();
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(dev.calls).toContain('prefs:light');
    key('KeyC', { alt: true });
    await tick();
    expect(q('[role="dialog"][aria-label="Control Centre"]')).toBeNull();
  });
});

describe('status, notifications and power', () => {
  it('OFF-04 the menu bar shows memory and connectivity from kernel events', async () => {
    const { dev } = mount({ login: false, restore: false });
    await tick();
    dev.seedStatus();
    await tick();
    const bar = q('[data-testid="menubar"]');
    expect(bar?.textContent).toContain('142/256 MB');
    expect(q('[data-testid="net-status"]')).not.toBeNull();
  });

  it('WM-07 notifications from the handle and from the kernel show as banners', async () => {
    const { h, dev } = mount({ login: false, restore: false });
    await tick();
    h.notify({ id: 'n1', level: 'info', title: 'Indexed 12 files', at: Date.now(), unread: true });
    dev.kernel.emit({
      t: 'notify',
      n: {
        id: 'k1',
        level: 'warning',
        title: 'Lock lost',
        body: 'bob took it',
        source: { app: 'files' },
        at: Date.now(),
      },
    });
    await tick();
    expect(document.body.textContent).toContain('Indexed 12 files');
    expect(document.body.textContent).toContain('Lock lost');
  });

  it('WM-06 Shut Down asks first, saves the layout strictly, then calls power', async () => {
    const { dev } = mount({ login: false, restore: false });
    await tick();
    click(q('[role="menuitem"][aria-label="Plotinium"]'));
    await tick();
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((m) =>
      m.textContent.includes('Shut Down'),
    );
    click(item ?? null);
    await tick();
    expect(document.body.textContent).toContain('Shut down Plotinium?');
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Shut Down',
    );
    click(confirm ?? null);
    await tick();
    expect(dev.saved.at(-1)?.durability).toBe('strict');
    expect(dev.calls).toContain('power:shutdown');
  });

  it('WM-07 the handle applies preferences from outside the shell and disposes cleanly', async () => {
    const { h } = mount({ login: false, restore: false });
    await tick();
    h.setPrefs({ theme: 'light', reducedMotion: true });
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(h.prefs()).toMatchObject({ theme: 'light', reducedMotion: true });
    h.events([]);
    h.dispose();
    handle = undefined;
    expect(q('[data-testid="desktop"]')).toBeNull();
  });
});
