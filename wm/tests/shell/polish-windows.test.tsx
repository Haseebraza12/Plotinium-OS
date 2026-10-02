// @vitest-environment happy-dom
/**
 * Polish-wave window fixes in the desktop shell (docs/design/bug-hunt/BUGS.md, owner fix-windows):
 * keyboard focus (UI-017, UI-018), default sizes (UI-011), the kernel mirror (UI-034), the snap
 * preview (UI-038), the double-click and minimise preferences (UI-041), the window menu (UI-094)
 * and snapped corners (UI-154). The desktop runs with the dev harness (fake kernel on the real
 * compositor-port protocol, demo apps) under reduced motion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnimationDetail, WindowPhase } from '../../src/compositor/index.ts';
import {
  focusInto,
  focusIntoWhenReady,
  isChromeTarget,
  minimiseEffect,
  snapPreviewWriter,
  titleDoubleClickAction,
} from '../../src/shell/dom.ts';
import type { AppEntry, AppRegistry } from '../../src/shell/env.ts';
import { createDevEnv, type DevEnvOptions } from '../../src/shell/fixtures/dev-env.ts';
import { snapshotLayout } from '../../src/shell/layout.ts';
import { menusFor, windowActions, windowMenu } from '../../src/shell/menus.ts';
import { mountDesktop, type DesktopHandle } from '../../src/shell/mount.tsx';
import {
  createWindowAnimator,
  FALLBACK_TOKENS,
  type AnimationLike,
  type AnimTarget,
} from '../../src/shell/motion.ts';
import type { MenuEntry } from '../../src/shell/ui.ts';

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
  const html = document.documentElement;
  for (const a of ['data-theme', 'data-motion', 'data-title-dblclick', 'data-minimise-effect'])
    html.removeAttribute(a);
  document.body.replaceChildren();
});

/** The demo registry with manifest sizes, as apps/src/registry.ts passes them (UI-011). */
function withSizes(
  apps: AppRegistry,
  sizes: Record<string, { w: number; h: number }>,
): AppRegistry {
  const sized = (a: AppEntry): AppEntry => {
    const s = sizes[a.id];
    return s === undefined ? a : { ...a, window: { ...a.window, width: s.w, height: s.h } };
  };
  return {
    list: () => apps.list().map(sized),
    get: (id) => {
      const a = apps.get(id);
      return a === undefined ? undefined : sized(a);
    },
  };
}

function mount(opts: DevEnvOptions = {}, sizes?: Record<string, { w: number; h: number }>) {
  const dev = createDevEnv({ reducedMotion: true, login: false, restore: false, ...opts });
  const el = document.createElement('div');
  document.body.append(el);
  root = el;
  const env = sizes === undefined ? dev.env : { ...dev.env, apps: withSizes(dev.env.apps, sizes) };
  const h = mountDesktop(el, env);
  handle = h;
  dev.bindPrefs((p) => h.setPrefs(p));
  return { dev, h };
}

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const q = <T extends Element = HTMLElement>(sel: string): T | null =>
  document.querySelector<T>(sel);
const win = (app: string): HTMLElement | null => q(`[data-testid="window"][data-app="${app}"]`);
const inView = (app: string): boolean =>
  win(app)?.querySelector('[data-wm-view]')?.contains(document.activeElement) === true;
const content = (app: string): HTMLElement => {
  const el = win(app)?.querySelector<HTMLElement>('[data-wm-view] [tabindex="0"]');
  if (el === null || el === undefined) throw new Error(`no focusable content in ${app}`);
  return el;
};

function key(
  code: string,
  mods: { alt?: boolean; ctrl?: boolean; shift?: boolean } = {},
  k = code,
): void {
  (document.activeElement ?? window).dispatchEvent(
    new KeyboardEvent('keydown', {
      code,
      key: k,
      altKey: mods.alt === true,
      ctrlKey: mods.ctrl === true,
      shiftKey: mods.shift === true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function click(el: Element | null): void {
  if (el === null) throw new Error('nothing to click');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

function press(el: Element | null, x = 0, y = 0): { mousedownPrevented: boolean } {
  if (el === null) throw new Error('nothing to press');
  el.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 1,
      clientX: x,
      clientY: y,
    }),
  );
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  el.dispatchEvent(down);
  return { mousedownPrevented: down.defaultPrevented };
}

function pointer(el: Element, type: string, x: number, y: number): void {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 1,
      clientX: x,
      clientY: y,
    }),
  );
}

async function launch(h: DesktopHandle, app: string): Promise<void> {
  h.launch(app);
  await tick();
}

const titlebar = (app: string): HTMLElement | null =>
  win(app)?.querySelector<HTMLElement>('[data-testid="window-titlebar"]') ?? null;

describe('UI-017 focus after a restore', () => {
  it('UI-017 a window restored from the Dock gets keyboard focus in its content, not on the Minimise light', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    content('terminal').focus();
    const light = win('terminal')?.querySelector<HTMLElement>('[data-testid="window-minimise"]');
    light?.focus();
    click(light ?? null);
    await tick();
    expect(h.layout()[0]?.state).toBe('minimised');
    click(q('[data-testid="dock-item"][data-app="terminal"]'));
    await tick();
    expect(h.layout()[0]?.state).toBe('normal');
    expect(document.activeElement).toBe(content('terminal'));
  });

  it('UI-017 the same after the window switcher brings it back', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    await launch(h, 'editor');
    content('terminal').focus();
    await launch(h, 'files');
    key('KeyM', { alt: true });
    await tick();
    key('Backquote', { alt: true }, '`');
    window.dispatchEvent(
      new KeyboardEvent('keyup', { code: 'AltLeft', key: 'Alt', bubbles: true }),
    );
    await tick();
    expect(document.activeElement?.closest('[data-testid="window-titlebar"]')).toBeNull();
    expect(document.activeElement?.closest('[data-wm-view]')).not.toBeNull();
  });
});

describe('UI-018 keyboard focus follows the focused window', () => {
  it('UI-018 pressing another window’s title bar moves keyboard focus into it; the bar itself never takes it', async () => {
    const { h } = mount();
    await launch(h, 'editor');
    await launch(h, 'terminal');
    content('terminal').focus();
    const bar = titlebar('editor');
    const { mousedownPrevented } = press(bar, 200, 60);
    if (bar !== null) pointer(bar, 'pointerup', 200, 60);
    await tick();
    expect(mousedownPrevented).toBe(true);
    expect(win('editor')?.getAttribute('data-focused')).toBe('true');
    expect(document.activeElement).toBe(content('editor'));
  });

  it('UI-018 pressing the focused window’s own title bar keeps the control that has focus', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    const pre = content('terminal');
    pre.focus();
    const bar = titlebar('terminal');
    press(bar, 200, 60);
    if (bar !== null) pointer(bar, 'pointerup', 200, 60);
    await tick();
    expect(document.activeElement).toBe(pre);
  });

  it('UI-018 a window launched from the Dock takes keyboard focus', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    content('terminal').focus();
    click(q('[data-testid="dock-item"][data-app="editor"]'));
    await tick();
    expect(win('editor')?.getAttribute('data-focused')).toBe('true');
    expect(inView('editor')).toBe(true);
  });

  it('UI-018 Alt+M and Alt+Q hand keyboard focus to the next window', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    await launch(h, 'editor');
    content('editor').focus();
    key('KeyM', { alt: true });
    await tick();
    expect(inView('terminal')).toBe(true);
    click(q('[data-testid="dock-item"][data-app="editor"]'));
    await tick();
    expect(inView('editor')).toBe(true);
    key('KeyQ', { alt: true });
    await tick();
    expect(win('editor')).toBeNull();
    expect(inView('terminal')).toBe(true);
  });

  it('UI-018 a window that gains focus does not pull focus out of an open overlay', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    await launch(h, 'editor');
    const outside = document.createElement('input');
    document.body.append(outside);
    outside.focus();
    const cmp = h.compositor();
    if (cmp === null) throw new Error('no compositor');
    cmp.focus(1);
    await tick();
    expect(document.activeElement).toBe(outside);
  });
});

describe('UI-011 default sizes in the shell', () => {
  it('UI-011 each app opens at its manifest size, cascaded', async () => {
    const { h } = mount({}, { files: { w: 900, h: 560 }, terminal: { w: 700, h: 420 } });
    await launch(h, 'files');
    await launch(h, 'terminal');
    const [files, term] = h.layout();
    expect({ w: files?.w, h: files?.h }).toEqual({ w: 900, h: 560 });
    expect({ w: term?.w, h: term?.h }).toEqual({ w: 700, h: 420 });
    expect([files?.x, files?.y]).not.toEqual([term?.x, term?.y]);
  });
});

describe('UI-040 the work area follows the Dock size', () => {
  it('UI-040 a larger Dock or auto-hide re-lays out maximised windows at once', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    const cmp = h.compositor();
    if (cmp === null) throw new Error('no compositor');
    const [t] = h.layout();
    if (t === undefined) throw new Error('no window');
    await cmp.toggleMaximise(t.wid);
    const bottom = (): number => {
      const row = h.layout()[0];
      return (row?.y ?? 0) + (row?.h ?? 0);
    };
    const reserve = (): number =>
      Number.parseFloat(document.documentElement.style.getPropertyValue('--pl-dock-reserve'));
    expect(bottom()).toBe(window.innerHeight - reserve());
    h.setPrefs({ dockSize: 80 });
    await tick();
    expect(reserve()).toBe(112);
    expect(bottom()).toBe(window.innerHeight - 112);
    h.setPrefs({ dockAutoHide: true });
    await tick();
    expect(bottom()).toBe(window.innerHeight - 8);
    expect(h.layout()[0]?.state).toBe('maximised');
  });
});

describe('UI-034 the kernel mirror', () => {
  it('UI-034 an untouched window is reported to the kernel, and a raise reports every new z', async () => {
    const { h, dev } = mount();
    await launch(h, 'terminal');
    await launch(h, 'editor');
    const geo = (wid: number) =>
      dev.kernel.sent.filter(
        (m): m is { t: string; wid: number; z: number; state: string } =>
          typeof m === 'object' &&
          m !== null &&
          (m as { t?: unknown }).t === 'geometry' &&
          (m as { wid?: unknown }).wid === wid,
      );
    expect(geo(1).at(-1)).toMatchObject({ state: 'normal', z: 1 });
    expect(geo(2).at(-1)).toMatchObject({ state: 'normal', z: 2 });
    const cmp = h.compositor();
    if (cmp === null) throw new Error('no compositor');
    cmp.focus(1);
    await tick();
    expect(geo(1).at(-1)?.z).toBe(2);
    expect(geo(2).at(-1)?.z).toBe(1);
  });
});

describe('UI-038 snap preview', () => {
  it('UI-038 a drag into the left zone shows the preview at the target half, and it hides on release', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    const preview = q('[data-testid="snap-preview"]');
    expect(preview?.getAttribute('data-visible')).toBe('false');
    expect(preview?.getAttribute('aria-hidden')).toBe('true');
    const bar = titlebar('terminal');
    if (bar === null) throw new Error('no title bar');
    const r = h.layout()[0];
    const x0 = (r?.x ?? 0) + 100;
    const y0 = (r?.y ?? 0) + 10;
    press(bar, x0, y0);
    pointer(bar, 'pointermove', x0 - 50, y0 + 20);
    pointer(bar, 'pointermove', 2, y0 + 40);
    expect(preview?.getAttribute('data-visible')).toBe('true');
    const cmp = h.compositor();
    if (cmp === null) throw new Error('no compositor');
    const work = cmp.model.work;
    expect(preview?.style.width).toBe(`${String(Math.floor(work.w / 2))}px`);
    expect(preview?.style.transform).toBe(`translate3d(0px, ${String(work.y)}px, 0)`);
    pointer(bar, 'pointerup', 2, y0 + 40);
    await tick();
    expect(preview?.getAttribute('data-visible')).toBe('false');
    expect(h.layout()[0]).toMatchObject({ x: 0, y: work.y });
  });
});

describe('UI-041 window preferences', () => {
  it('UI-041 the title-bar double-click follows data-title-dblclick: minimise, none, then zoom', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    const html = document.documentElement;
    const dbl = (): void => {
      titlebar('terminal')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    };
    html.dataset['titleDblclick'] = 'none';
    dbl();
    await tick();
    expect(h.layout()[0]?.state).toBe('normal');
    html.dataset['titleDblclick'] = 'minimise';
    dbl();
    await tick();
    expect(h.layout()[0]?.state).toBe('minimised');
    click(q('[data-testid="dock-item"][data-app="terminal"]'));
    await tick();
    html.removeAttribute('data-title-dblclick');
    dbl();
    await tick();
    expect(h.layout()[0]?.state).toBe('maximised');
  });

  it('UI-041 zoom never maximises a fixed-size window', async () => {
    const { h } = mount();
    await launch(h, 'about');
    titlebar('about')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await tick();
    expect(h.layout()[0]?.state).toBe('normal');
  });

  it('UI-041 the minimise effect reads data-minimise-effect; Scale shrinks straight into the dock icon', async () => {
    const html = document.documentElement;
    expect(minimiseEffect(html)).toBe('genie');
    html.dataset['minimiseEffect'] = 'scale';
    expect(minimiseEffect(html)).toBe('scale');
    const played: { frames: Keyframe[] }[] = [];
    const el: AnimTarget = {
      style: { willChange: '', transformOrigin: '' },
      dataset: {},
      animate: (frames) => {
        played.push({ frames });
        const a: AnimationLike = {
          finished: Promise.resolve(),
          cancel: () => undefined,
          finish: () => undefined,
        };
        return a;
      },
    };
    const make = (effect: 'genie' | 'scale') =>
      createWindowAnimator({
        element: () => el,
        window: () => ({ rect: { x: 100, y: 100, w: 400, h: 300 }, app: 'files' }),
        dockIcon: () => ({ x: 580, y: 820, width: 40, height: 40 }),
        flush: () => undefined,
        viewportH: () => 900,
        tokens: () => FALLBACK_TOKENS,
        effect: () => effect,
      });
    await make('scale').play(1, 'minimising', {});
    expect(played[0]?.frames).toEqual([
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translate(300px, 440px) scale(0.12)' },
    ]);
    await make('genie').play(1, 'minimising', {});
    expect(played[1]?.frames).toHaveLength(3);
    await make('scale').play(1, 'restoring', {});
    expect(played[2]?.frames.at(-1)).toEqual({ opacity: 1, transform: 'none' });
  });
});

describe('UI-156 open animation origin', () => {
  it('UI-156 the open animation grows from the given point, else from 50% 60%', async () => {
    const el: AnimTarget = {
      style: { willChange: '', transformOrigin: '' },
      dataset: {},
      animate: () => ({
        finished: Promise.resolve(),
        cancel: () => undefined,
        finish: () => undefined,
      }),
    };
    const a = createWindowAnimator({
      element: () => el,
      window: () => ({ rect: { x: 100, y: 100, w: 400, h: 300 }, app: 'files' }),
      dockIcon: () => undefined,
      flush: () => undefined,
      viewportH: () => 900,
      tokens: () => FALLBACK_TOKENS,
    });
    const detail: AnimationDetail = { origin: { x: 600, y: 850 } };
    const phase: WindowPhase = 'opening';
    await a.play(1, phase, detail);
    expect(el.style.transformOrigin).toBe('500px 750px');
    await a.play(1, phase, {});
    expect(el.style.transformOrigin).toBe('50% 60%');
  });
});

describe('UI-094 window menu', () => {
  const ids = (items: readonly MenuEntry[]) =>
    items.filter((i) => i.kind !== 'separator' && i.kind !== 'header').map((i) => i.id);
  const disabled = (items: readonly MenuEntry[], id: string) =>
    items.some((i) => i.id === id && 'disabled' in i && i.disabled === true);

  it('UI-094 the desktop Window menu keeps Overview enabled with no window; it lists Move, Size and Full Screen', () => {
    const menu = windowMenu(true);
    expect(ids(menu.items)).toEqual(
      expect.arrayContaining(['move', 'size', 'fullscreen', 'overview', 'minimise', 'zoom']),
    );
    expect(disabled(menu.items, 'overview')).toBe(false);
    expect(disabled(menu.items, 'move')).toBe(true);
    const app: AppEntry = {
      id: 'settings',
      title: 'Settings',
      icon: 'settings',
      window: { resizable: false, maximizable: false },
      mountView: () => () => undefined,
    };
    const own = menusFor(app, [app]).find((m) => m.id === 'window');
    expect(disabled(own?.items ?? [], 'size')).toBe(true);
    expect(disabled(own?.items ?? [], 'zoom')).toBe(true);
    expect(disabled(own?.items ?? [], 'move')).toBe(false);
  });

  it('UI-094 the in-window menu has Move, Size, snaps, Zoom or Restore, Full Screen, Minimise and Close', () => {
    expect(ids(windowActions(false))).toEqual([
      'move',
      'size',
      'snap-left',
      'snap-right',
      'zoom',
      'fullscreen',
      'minimise',
      'close-window',
    ]);
    const fixed = windowActions(false, { resizable: false, maximizable: false });
    expect(disabled(fixed, 'size')).toBe(true);
    expect(disabled(fixed, 'fullscreen')).toBe(true);
    const full = windowActions(false, { state: 'fullscreen' });
    expect(full.find((i) => i.id === 'fullscreen')).toMatchObject({ label: 'Exit Full Screen' });
  });

  it('UI-094 a right-click on the title bar opens the window menu; Escape gives focus back to the window', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    const pre = content('terminal');
    pre.focus();
    titlebar('terminal')?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 80 }),
    );
    await tick();
    const menu = q('[role="menu"][aria-label="Window"]');
    expect(menu).not.toBeNull();
    key('Escape', {}, 'Escape');
    await tick();
    expect(q('[role="menu"][aria-label="Window"]')).toBeNull();
    expect(document.activeElement).toBe(pre);
  });

  it('UI-094 when the right-click left focus on the window section, Escape moves it on into the content', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    const pre = content('terminal');
    pre.focus();
    // A browser's right mouse button focuses the nearest focusable ancestor: the section.
    const section = win('terminal');
    if (section === null) throw new Error('no window');
    section.setAttribute('tabindex', '-1');
    section.focus();
    expect(document.activeElement).toBe(section);
    titlebar('terminal')?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 80 }),
    );
    await tick();
    expect(q('[role="menu"][aria-label="Window"]')).not.toBeNull();
    key('Escape', {}, 'Escape');
    await tick();
    expect(document.activeElement).toBe(pre);
  });

  it('UI-094 Move from the window menu moves with the arrow keys, announces, and Enter keeps it; Escape reverts', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    content('terminal').focus();
    const start = h.layout()[0];
    const pick = async (label: string): Promise<void> => {
      titlebar('terminal')?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 80,
        }),
      );
      await tick();
      const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((m) =>
        m.textContent.trim().startsWith(label),
      );
      click(item ?? null);
      await tick();
    };
    await pick('Move');
    key('ArrowRight', {}, 'ArrowRight');
    key('ArrowRight', {}, 'ArrowRight');
    key('ArrowDown', { shift: true }, 'ArrowDown');
    expect(h.layout()[0]).toMatchObject({ x: (start?.x ?? 0) + 32, y: (start?.y ?? 0) + 1 });
    const live = win('terminal')?.querySelector('[role="status"]');
    expect(live?.textContent).toMatch(/^Moved to \d+, \d+$/u);
    key('Enter', {}, 'Enter');
    key('ArrowRight', {}, 'ArrowRight');
    await tick();
    expect(h.layout()[0]?.x).toBe((start?.x ?? 0) + 32);
    await pick('Size');
    key('ArrowRight', {}, 'ArrowRight');
    expect(h.layout()[0]?.w).toBe((start?.w ?? 0) + 16);
    key('Escape', {}, 'Escape');
    await tick();
    expect(h.layout()[0]?.w).toBe(start?.w);
    await pick('Full Screen');
    expect(h.layout()[0]?.state).toBe('fullscreen');
  });
});

describe('UI-094 leaving full screen', () => {
  it('UI-094 Escape twice leaves full screen even when the app content stops the key (xterm)', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    const pre = content('terminal');
    // Like xterm: the content takes every key and stops its propagation.
    pre.addEventListener('keydown', (ev) => ev.stopPropagation());
    pre.focus();
    const cmp = h.compositor();
    const wid = h.layout()[0]?.wid;
    if (cmp === null || wid === undefined) throw new Error('no window');
    await cmp.toggleFullscreen(wid);
    expect(h.layout()[0]?.state).toBe('fullscreen');
    key('Escape', {}, 'Escape');
    await tick();
    expect(h.layout()[0]?.state).toBe('fullscreen');
    key('Escape', {}, 'Escape');
    await tick();
    expect(h.layout()[0]?.state).toBe('normal');
  });
});

describe('UI-154 snapped corners in the shell', () => {
  it('UI-154 Alt+Shift+Left marks the window snapped left; restoring clears it', async () => {
    const { h } = mount();
    await launch(h, 'terminal');
    key('ArrowLeft', { alt: true, shift: true });
    await tick();
    expect(win('terminal')?.getAttribute('data-snap')).toBe('left');
    key('ArrowDown', { alt: true, shift: true });
    await tick();
    expect(win('terminal')?.hasAttribute('data-snap')).toBe(false);
    expect(h.layout()[0]?.state).toBe('normal');
  });
});

describe('DOM helpers', () => {
  function windowDom(): {
    section: HTMLElement;
    view: HTMLElement;
    light: HTMLButtonElement;
    bar: HTMLElement;
  } {
    const section = document.createElement('section');
    const bar = document.createElement('div');
    const light = document.createElement('button');
    bar.append(light);
    const view = document.createElement('div');
    view.setAttribute('data-wm-view', '');
    section.append(bar, view);
    document.body.append(section);
    return { section, view, light, bar };
  }

  it('UI-017 focusInto never returns focus to the chrome, and skips controls that cannot take focus', () => {
    const { section, view, light } = windowDom();
    const off = document.createElement('button');
    off.disabled = true;
    const input = document.createElement('input');
    view.append(off, input);
    expect(focusInto(section, light)).toBe(input);
    expect(document.activeElement).toBe(input);
    const auto = document.createElement('button');
    auto.setAttribute('data-autofocus', '');
    view.append(auto);
    expect(focusInto(section, null)).toBe(auto);
  });

  it('UI-018 focusIntoWhenReady moves on to the first control once a lazy view renders it', async () => {
    const { section, view } = windowDom();
    const stop = focusIntoWhenReady(section, null, 1_000);
    expect(document.activeElement).toBe(section);
    const input = document.createElement('input');
    view.append(input);
    await tick();
    expect(document.activeElement).toBe(input);
    stop();
  });

  it('UI-018 focusIntoWhenReady moves from a fallback control to [data-autofocus] once it renders', async () => {
    const { section, view } = windowDom();
    const add = document.createElement('button');
    view.append(add);
    const stop = focusIntoWhenReady(section, null, 1_000);
    expect(document.activeElement).toBe(add);
    // The Editor's toolbar renders first; CodeMirror's text surface mounts a moment later.
    const text = document.createElement('div');
    text.tabIndex = 0;
    text.setAttribute('data-autofocus', '');
    view.append(text);
    await tick();
    expect(document.activeElement).toBe(text);
    stop();
  });

  it('UI-018 focusIntoWhenReady leaves focus alone once the user moved it or pressed in the window', async () => {
    const moved = windowDom();
    const first = document.createElement('button');
    const other = document.createElement('input');
    moved.view.append(first, other);
    focusIntoWhenReady(moved.section, null, 1_000);
    other.focus();
    const late = document.createElement('div');
    late.tabIndex = 0;
    late.setAttribute('data-autofocus', '');
    moved.view.append(late);
    await tick();
    expect(document.activeElement).toBe(other);

    const pressed = windowDom();
    const button = document.createElement('button');
    pressed.view.append(button);
    focusIntoWhenReady(pressed.section, null, 1_000);
    expect(document.activeElement).toBe(button);
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    const text = document.createElement('div');
    text.tabIndex = 0;
    text.setAttribute('data-autofocus', '');
    pressed.view.append(text);
    await tick();
    expect(document.activeElement).toBe(button);
  });

  it('UI-018 isChromeTarget: title bar and drag regions are chrome; controls and app content are not', () => {
    const { section, view, light, bar } = windowDom();
    const region = document.createElement('div');
    region.setAttribute('data-pl-drag-region', '');
    const regionButton = document.createElement('button');
    region.append(regionButton);
    const text = document.createElement('p');
    view.append(region, text);
    expect(isChromeTarget(bar, section)).toBe(true);
    expect(isChromeTarget(light, section)).toBe(false);
    expect(isChromeTarget(region, section)).toBe(true);
    expect(isChromeTarget(regionButton, section)).toBe(false);
    expect(isChromeTarget(text, section)).toBe(false);
    expect(isChromeTarget(document.body, section)).toBe(false);
  });

  it('UI-041 titleDoubleClickAction reads zoom, minimise and none, defaulting to zoom', () => {
    const html = document.documentElement;
    expect(titleDoubleClickAction(html)).toBe('zoom');
    html.dataset['titleDblclick'] = 'minimise';
    expect(titleDoubleClickAction(html)).toBe('minimise');
    html.dataset['titleDblclick'] = 'none';
    expect(titleDoubleClickAction(html)).toBe('none');
    html.dataset['titleDblclick'] = 'bogus';
    expect(titleDoubleClickAction(html)).toBe('zoom');
  });

  it('UI-038 the preview writer places the element and toggles data-visible', () => {
    const el = document.createElement('div');
    const write = snapPreviewWriter(() => el);
    write({ x: 0, y: 28, w: 640, h: 700 });
    expect([el.style.transform, el.style.width, el.style.height, el.dataset['visible']]).toEqual([
      'translate3d(0px, 28px, 0)',
      '640px',
      '700px',
      'true',
    ]);
    write(null);
    expect(el.dataset['visible']).toBe('false');
    expect(el.style.width).toBe('640px');
    snapPreviewWriter(() => undefined)(null);
  });

  it('UI-096 a snapshot saves each window as the model persists it (compact mode)', () => {
    const w = {
      wid: 1,
      pid: 1,
      app: 'files',
      title: 'Files',
      icon: 'files',
      x: 0,
      y: 28,
      w: 760,
      h: 500,
      cw: 760,
      ch: 500,
      z: 1,
      state: 'maximised' as const,
      prevState: 'maximised' as const,
      snap: null,
      restoreRect: { x: 40, y: 68, w: 500, h: 300 },
      focused: true,
      limits: { minW: 320, minH: 200, maxW: Infinity, maxH: Infinity },
      flags: {
        restoring: false,
        suspended: false,
        crashed: false,
        notResponding: false,
        attention: false,
        closeGuard: null,
        secureStrip: false,
        closing: false,
      },
      dirtyBits: 0,
      createdAt: 0,
    };
    const base = {
      windows: [w],
      argv: () => [],
      osSessionId: 's',
      uid: 1,
      now: 0,
      viewport: { w: 760, h: 600, dpr: 1 },
    };
    expect(snapshotLayout(base).windows[0]).toMatchObject({ state: 'maximised' });
    const saved = snapshotLayout({
      ...base,
      persisted: () => ({
        rect: { x: 40, y: 68, w: 500, h: 300 },
        restoreRect: null,
        state: 'normal',
        prevState: 'normal',
        snap: null,
      }),
    });
    expect(saved.windows[0]).toMatchObject({
      state: 'normal',
      rect: { x: 40, y: 68, w: 500, h: 300 },
      restoreRect: null,
      z: 1,
      focused: true,
    });
  });
});
