// @vitest-environment happy-dom
/**
 * The Terminal's keyboard chords and menus (UI-022, UI-126) and the view's small decisions
 * (UI-055 agent item, UI-129 start directory).
 */
import { chordLabel, TERMINAL_KEYS, type TerminalChord } from '@plotinium/ui/apps/terminal';
import { describe, expect, it } from 'vitest';

import { descriptor, TERMINAL_MENU, TERMINAL_SHORTCUTS } from '../manifest.ts';
import { agentStatusOf, startDirectory } from '../view.tsx';

/**
 * Chords Chrome keeps for itself on Linux and Windows outside app and full-screen mode (the page
 * never receives them: BrowserCommandController::IsReservedCommandOrKey), and the ones window-
 * manager.md §3.9 lists as used by Chrome.
 */
const CHROME_RESERVED: readonly TerminalChord[] = [
  { code: 'KeyW', ctrl: true },
  { code: 'KeyW', ctrl: true, shift: true },
  { code: 'KeyT', ctrl: true },
  { code: 'KeyT', ctrl: true, shift: true },
  { code: 'KeyN', ctrl: true },
  { code: 'KeyN', ctrl: true, shift: true },
  { code: 'KeyQ', ctrl: true, shift: true },
  { code: 'Tab', ctrl: true },
  { code: 'Tab', ctrl: true, shift: true },
  { code: 'PageDown', ctrl: true },
  { code: 'PageUp', ctrl: true },
  { code: 'F4', ctrl: true },
  { code: 'F4', alt: true },
  { code: 'Space', alt: true },
  { code: 'ArrowLeft', alt: true },
  { code: 'ArrowRight', alt: true },
  { code: 'KeyF', alt: true },
  { code: 'KeyE', alt: true },
  { code: 'Home', alt: true },
  { code: 'KeyT', alt: true, shift: true },
  { code: 'KeyI', alt: true, shift: true },
  { code: 'KeyA', alt: true, shift: true },
];

/** The window manager's default bindings (window-manager.md §3.9; wm/src/shell/keys.ts). */
const WM_BINDINGS: readonly TerminalChord[] = [
  ...['Backquote', 'KeyJ', 'Tab'].map((code) => ({ code, alt: true })),
  ...['Backquote', 'Tab'].map((code) => ({ code, alt: true, shift: true })),
  { code: 'KeyK', alt: true },
  ...['KeyW', 'KeyM', 'KeyQ', 'KeyT', 'KeyL', 'KeyN', 'KeyB', 'KeyS', 'KeyO', 'KeyC'].map(
    (code) => ({
      code,
      alt: true,
    }),
  ),
  ...['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map((code) => ({
    code,
    alt: true,
    shift: true,
  })),
  { code: 'Space', ctrl: true },
  { code: 'ArrowUp', ctrl: true },
  { code: 'F3' },
];

const same = (a: TerminalChord, b: TerminalChord): boolean =>
  a.code === b.code &&
  (a.ctrl ?? false) === (b.ctrl ?? false) &&
  (a.alt ?? false) === (b.alt ?? false) &&
  (a.shift ?? false) === (b.shift ?? false);

describe('UI-022 Terminal chords', () => {
  it('UI-022 no Terminal chord is Chrome-reserved or a window-manager binding', () => {
    for (const [action, chord] of Object.entries(TERMINAL_KEYS)) {
      expect(
        CHROME_RESERVED.some((r) => same(r, chord)),
        `${action} is Chrome's`,
      ).toBe(false);
      expect(
        WM_BINDINGS.some((r) => same(r, chord)),
        `${action} is the WM's`,
      ).toBe(false);
    }
  });

  it('UI-022 the menus show the chords the Terminal handles', () => {
    expect(TERMINAL_SHORTCUTS.newTab).toEqual(chordLabel(TERMINAL_KEYS.newTab));
    expect(TERMINAL_SHORTCUTS.closeTab).toEqual(chordLabel(TERMINAL_KEYS.closeTab));
    expect(TERMINAL_SHORTCUTS.nextTab).toEqual(chordLabel(TERMINAL_KEYS.nextTab));
    expect(TERMINAL_SHORTCUTS.prevTab).toEqual(chordLabel(TERMINAL_KEYS.prevTab));
    expect(TERMINAL_SHORTCUTS.copy).toEqual(chordLabel(TERMINAL_KEYS.copy));
    const shown = (descriptor.menus ?? []).flatMap((m) =>
      m.items.flatMap((i) =>
        'shortcut' in i && i.shortcut !== undefined ? [i.shortcut.join('+')] : [],
      ),
    );
    for (const hint of shown) {
      expect([
        'Ctrl+Shift+T',
        'Ctrl+Shift+W',
        'Ctrl+PageDown',
        'Ctrl+PageUp',
        'Ctrl+Tab',
      ]).not.toContain(hint);
    }
  });

  it('UI-126 the Terminal has an Edit menu with Copy, Paste and Select All', () => {
    const edit = (descriptor.menus ?? []).find((m) => m.id === 'edit');
    const ids = (edit?.items ?? []).flatMap((i) => ('id' in i ? [i.id] : []));
    expect(ids).toEqual([TERMINAL_MENU.copy, TERMINAL_MENU.paste, TERMINAL_MENU.selectAll]);
    expect((descriptor.menus ?? []).map((m) => m.label)).toEqual(['Shell', 'Edit', 'View']);
  });

  it('UI-130 the default window fits 80 × 24 cells of the 14 px mono face', () => {
    const cols = Math.floor(((descriptor.window.width ?? 0) - 32 - 14) / 8.4);
    expect(cols).toBeGreaterThanOrEqual(80);
    const rows = Math.floor(((descriptor.window.height ?? 0) - 38 - 40 - 26 - 16) / 21);
    expect(rows).toBeGreaterThanOrEqual(24);
  });
});

describe('UI-055 and UI-129 view decisions', () => {
  it('UI-055 the status strip says "AI unavailable" when no agent program can run here', () => {
    expect(agentStatusOf(true, null, false)).toEqual({ state: 'unavailable' });
    expect(agentStatusOf(false, null, true)).toEqual({ state: 'unavailable' });
    expect(agentStatusOf(true, null, true)).toBeUndefined();
    expect(agentStatusOf(true, { pid: 312, comm: 'ai.agent' })).toEqual({
      state: 'waiting',
      pid: 312,
      on: 'your confirmation',
    });
  });

  it('UI-129 a Terminal launched with a folder starts there', () => {
    expect(startDirectory(['/home/demo/Projects'])).toBe('/home/demo/Projects');
    expect(startDirectory([])).toBeUndefined();
    expect(startDirectory(['notes.md'])).toBeUndefined();
  });
});
