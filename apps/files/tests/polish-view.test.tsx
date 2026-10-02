// @vitest-environment happy-dom
/**
 * The Files window in a DOM, mounted inside a non-modal `role="dialog"` window frame as the
 * desktop mounts it: the fixes of the polish wave that live in apps/files/view.tsx
 * (docs/design/bug-hunt/BUGS.md, fix-files-editor): UI-014, UI-015, UI-016, UI-099, UI-104,
 * UI-106, UI-108, UI-110, UI-115.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerEditorWindow } from '../lib/open-docs.ts';
import { mount } from '../view.tsx';
import { demoWorld } from './fake-sys.ts';
import { mountView, settle, type MountedView } from './view-harness.ts';

let view: MountedView | undefined;
afterEach(() => {
  view?.dispose();
  view = undefined;
  vi.useRealTimers();
});

async function openFiles(argv: readonly string[] = ['/home/alice/notes']): Promise<MountedView> {
  const w = demoWorld();
  view = mountView(mount, { app: 'files', sys: w.alice, argv });
  await settle();
  return view;
}

function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="row"][data-id]')].find(
    (r) => r.querySelector('[data-col="name"]')?.textContent?.includes(name) === true,
  );
  if (found === undefined) throw new Error(`no row ${name}`);
  return found;
}

function key(target: Element, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function toastText(): string | undefined {
  return document.querySelector('[data-testid="app-toast"]')?.textContent ?? undefined;
}

describe('Files window (polish wave)', () => {
  it('UI-014 keeps a single-file selection after the inspector loads, and Enter opens it', async () => {
    const v = await openFiles();
    const file = row('week6-standup.md');
    file.click();
    // The inspector's lock read runs 150 ms after the click and replaces the app state.
    await new Promise((r) => setTimeout(r, 400));
    await settle();
    expect(row('week6-standup.md').getAttribute('aria-selected')).toBe('true');
    const info = document.querySelector('aside[aria-label="File info"]');
    expect(info?.querySelector('h3')?.textContent).toBe('week6-standup.md');
    expect(info?.textContent).not.toContain('Select a file to see its info');
    row('week6-standup.md').focus();
    key(row('week6-standup.md'), { key: 'Enter' });
    expect(v.launched).toEqual([{ app: 'editor', argv: ['/home/alice/notes/week6-standup.md'] }]);
  });

  it('UI-015 window-level shortcuts work inside the role="dialog" window frame', async () => {
    const v = await openFiles();
    expect(v.frame.getAttribute('role')).toBe('dialog');
    const file = row('week6-standup.md');
    file.click();
    file.focus();
    // Ctrl+Shift+N: the New Folder sheet.
    key(file, { key: 'N', ctrlKey: true, shiftKey: true });
    await settle(2);
    const sheet = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(sheet?.textContent).toContain('New Folder');
    // A key typed into the sheet's field is the field's, not the window's.
    const field = sheet?.querySelector('input');
    expect(field).not.toBeNull();
    key(field as HTMLInputElement, { key: 'Backspace' });
    await settle(2);
    expect(v.titles.at(-1)).toBe('notes');
    [...(sheet?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Cancel')?.click();
    await settle(2);
    // Alt+↑ goes to the enclosing folder; Alt+← comes back.
    key(row('week6-standup.md'), { key: 'ArrowUp', altKey: true });
    await settle();
    expect(v.titles.at(-1)).toBe('alice');
    key(row('notes'), { key: 'ArrowLeft', altKey: true });
    await settle();
    expect(v.titles.at(-1)).toBe('notes');
    // Alt+Enter hides and shows the inspector.
    expect(document.querySelector('aside[aria-label="File info"]')).not.toBeNull();
    key(row('week6-standup.md'), { key: 'Enter', altKey: true });
    await settle(2);
    expect(document.querySelector('aside[aria-label="File info"]')).toBeNull();
  });

  it('UI-016 the background context menu opens on empty space inside the window frame', async () => {
    await openFiles();
    const body = document.querySelector('[role="grid"] [role="rowgroup"][tabindex="-1"]');
    expect(body).not.toBeNull();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 300,
      clientY: 400,
    });
    body?.dispatchEvent(event);
    await settle(2);
    expect(event.defaultPrevented).toBe(true);
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.getAttribute('aria-label')).toBe('Actions for notes');
    const labels = [...(menu?.querySelectorAll('[role^="menuitem"]') ?? [])].map(
      (i) => i.textContent ?? '',
    );
    expect(labels.some((l) => l.includes('New Folder'))).toBe(true);
    expect(labels.some((l) => l.includes('Open in Terminal'))).toBe(true);
  });

  it('UI-099 a toast fades after its lifetime even while the window keeps changing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const w = demoWorld();
    view = mountView(mount, { app: 'files', sys: w.alice, argv: ['/home/alice/notes'] });
    await vi.advanceTimersByTimeAsync(50);
    view.menu('edit.paste');
    await vi.advanceTimersByTimeAsync(0);
    expect(toastText()).toContain('Nothing to paste');
    // The app state changes every 500 ms (inspector toggles); the toast still goes at 3.5 s.
    for (let t = 0; t < 3_000; t += 500) {
      view.menu('view.inspector');
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(toastText()).toContain('Nothing to paste');
    await vi.advanceTimersByTimeAsync(600);
    expect(toastText()).toBeUndefined();
  });

  it('UI-104 a file already open in an Editor window is shown there, not opened twice', async () => {
    const path = '/home/alice/notes/week6-standup.md';
    const reveal = vi.fn((_p: string, _line?: number) => Promise.resolve(false));
    const unregister = registerEditorWindow({ wid: 3, has: (p) => p === path, reveal });
    try {
      const v = await openFiles();
      row('week6-standup.md').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await settle();
      expect(reveal).toHaveBeenCalledWith(path, undefined);
      expect(v.launched).toEqual([]);
      // The Editor window could not take the focus: say where the file is.
      expect(toastText()).toContain('“week6-standup.md” is already open in an Editor window');
    } finally {
      unregister();
    }
  });

  it('UI-106 the inspector offers no History or Share it cannot carry out', async () => {
    await openFiles();
    row('week6-standup.md').click();
    await settle();
    const info = document.querySelector('aside[aria-label="File info"]');
    const buttons = [...(info?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(buttons).toContain('Open');
    expect(buttons).not.toContain('History');
    expect(buttons).not.toContain('Share');
  });

  it('UI-108 closing a sheet puts focus back in the list, never on the page', async () => {
    const v = await openFiles();
    v.menu('file.new-folder');
    await settle(2);
    const sheet = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(sheet?.textContent).toContain('New Folder');
    [...(sheet?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Cancel')?.click();
    await settle();
    const active = document.activeElement;
    expect(active).not.toBe(document.body);
    expect(active?.closest('[role="grid"]')).not.toBeNull();
  });

  it('UI-110 menu-bar commands that cannot act say why instead of doing nothing', async () => {
    const v = await openFiles();
    v.menu('file.open');
    await settle(2);
    expect(toastText()).toContain('Select a file or folder first');
    v.menu('edit.paste');
    await settle(2);
    expect(toastText()).toContain('Nothing to paste');
    v.menu('go.downloads');
    await settle(2);
    expect(toastText()).toContain('There is no Downloads folder');
    v.menu('go.back');
    await settle(2);
    expect(toastText()).toContain('There is no previous folder');
  });

  it('UI-115 your own files can change permissions even when your name shows as u<uid>', async () => {
    const w = demoWorld();
    // UI-012 (kernel side): proc.cred names the user u1001, the directory still says alice.
    view = mountView(mount, {
      app: 'files',
      sys: w.alice,
      argv: ['/home/alice/notes'],
      extras: {
        'proc.cred': () => ({
          uid: 1001,
          gid: 1001,
          groups: [1001],
          user: 'u1001',
          groupNames: ['alice'],
          home: '/home/alice',
          ruid: 1001,
        }),
      },
    });
    await settle();
    const sidebarHome = [...document.querySelectorAll('nav, aside')]
      .map((n) => n.textContent ?? '')
      .join(' ');
    expect(sidebarHome).toContain('Home');
    expect(sidebarHome).not.toContain('u1001');
    const file = row('week6-standup.md');
    file.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
    await settle(2);
    const chmod = [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].find((i) =>
      (i.textContent ?? '').includes('Change Permissions'),
    );
    expect(chmod).toBeDefined();
    expect(chmod?.getAttribute('aria-disabled')).not.toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(2);
    const info = document.querySelector('aside[aria-label="File info"]');
    expect([...(info?.querySelectorAll('button') ?? [])].map((b) => b.textContent)).toContain(
      'Change…',
    );
  });
});
