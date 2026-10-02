// @vitest-environment happy-dom
/**
 * Regressions the Wave 3 verifier (verify-b) found on the Docker build after the polish-wave
 * fixes (docs/design/bug-hunt/verify/verify-b.md): the parts of UI-015 and UI-108 that the
 * earlier tests did not reach because they ran without the desktop around the window.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { mount } from '../view.tsx';
import { demoWorld } from './fake-sys.ts';
import { mountView, settle, type MountedView } from './view-harness.ts';

let view: MountedView | undefined;
let guard: ((e: KeyboardEvent) => void) | undefined;
afterEach(() => {
  view?.dispose();
  view = undefined;
  if (guard !== undefined) document.removeEventListener('keydown', guard, true);
  guard = undefined;
});

async function openFiles(argv: readonly string[] = ['/home/alice/notes']): Promise<MountedView> {
  view = mountView(mount, { app: 'files', sys: demoWorld().alice, argv });
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

function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The desktop's navigation guard (wm/src/shell/keys.ts isNavigationKey, Desktop.tsx). */
function installDesktopGuard(): void {
  guard = (e: KeyboardEvent): void => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))
      e.preventDefault();
  };
  document.addEventListener('keydown', guard, true);
}

describe('Files window inside the desktop (verify-b)', () => {
  it('UI-015 Alt+← and Alt+→ go back and forward although the desktop prevents their default', async () => {
    const v = await openFiles();
    installDesktopGuard();
    row('week6-standup.md').click();
    key(row('week6-standup.md'), { key: 'ArrowUp', altKey: true });
    await settle();
    expect(v.titles.at(-1)).toBe('alice');
    const back = key(row('notes'), { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
    await settle();
    // The browser never sees it (the guard), and the window went back.
    expect(back.defaultPrevented).toBe(true);
    expect(v.titles.at(-1)).toBe('notes');
    key(row('week6-standup.md'), { key: 'ArrowRight', code: 'ArrowRight', altKey: true });
    await settle();
    expect(v.titles.at(-1)).toBe('alice');
  });

  it('UI-015 Alt+← on a toolbar button goes back instead of moving along the toolbar', async () => {
    const v = await openFiles();
    installDesktopGuard();
    key(row('week6-standup.md'), { key: 'ArrowUp', altKey: true });
    await settle();
    expect(v.titles.at(-1)).toBe('alice');
    const toolbarButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.closest('[role="toolbar"]') !== null && b.closest('[role="radiogroup"]') === null,
    );
    expect(toolbarButton).toBeDefined();
    toolbarButton?.focus();
    key(toolbarButton as HTMLButtonElement, { key: 'ArrowLeft', altKey: true });
    await settle();
    expect(v.titles.at(-1)).toBe('notes');
    expect(document.activeElement).toBe(toolbarButton);
  });

  it('UI-108 Escape on the background menu, or one of its items, leaves focus in the list', async () => {
    await openFiles();
    const body = document.querySelector('[role="grid"] [role="rowgroup"][tabindex="-1"]');
    expect(body).not.toBeNull();
    const openMenu = async (): Promise<HTMLElement> => {
      body?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 300,
          clientY: 400,
        }),
      );
      await settle(2);
      await wait(20);
      const item = document.querySelector<HTMLElement>('[role="menu"] [role^="menuitem"]');
      expect(item).not.toBeNull();
      expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull();
      return item as HTMLElement;
    };
    const item = await openMenu();
    key(item, { key: 'Escape' });
    // Past the menu's 100 ms exit fade.
    await wait(250);
    await settle();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest('[role="grid"]')).not.toBeNull();

    await openMenu();
    const refresh = [
      ...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]'),
    ].find((i) => i.textContent?.includes('Refresh') === true);
    expect(refresh).toBeDefined();
    refresh?.click();
    await wait(250);
    await settle();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest('[role="grid"]')).not.toBeNull();
  });
});
