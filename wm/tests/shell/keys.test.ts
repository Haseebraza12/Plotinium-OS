import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BINDINGS,
  isNavigationKey,
  isSwitcherRelease,
  matchKey,
  shortcutOf,
  type KeyLike,
  type ShellAction,
} from '../../src/shell/keys.ts';

function key(code: string, mods: Partial<Omit<KeyLike, 'code' | 'key'>> = {}, k = code): KeyLike {
  return {
    code,
    key: k,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
  };
}

describe('desktop key bindings', () => {
  it.each<[string, KeyLike, ShellAction]>([
    ['Alt+` switches to the next window', key('Backquote', { altKey: true }), 'switch-next'],
    [
      'Alt+Shift+` switches back',
      key('Backquote', { altKey: true, shiftKey: true }),
      'switch-prev',
    ],
    ['Alt+Tab is an alias', key('Tab', { altKey: true }), 'switch-next'],
    ['Cmd+Tab is an alias', key('Tab', { metaKey: true }), 'switch-next'],
    ['Cmd+Shift+Tab goes back', key('Tab', { metaKey: true, shiftKey: true }), 'switch-prev'],
    ['Ctrl+Space opens Search', key('Space', { ctrlKey: true }), 'search'],
    ['Cmd+Space opens Search', key('Space', { metaKey: true }), 'search'],
    ['F3 opens Overview', key('F3'), 'overview'],
    ['Ctrl+Up opens Overview', key('ArrowUp', { ctrlKey: true }), 'overview'],
    ['Alt+O opens Overview', key('KeyO', { altKey: true }), 'overview'],
    ['Alt+Shift+Left snaps left', key('ArrowLeft', { altKey: true, shiftKey: true }), 'snap-left'],
    [
      'Alt+Shift+Up toggles maximise',
      key('ArrowUp', { altKey: true, shiftKey: true }),
      'maximise-toggle',
    ],
    ['Alt+M minimises', key('KeyM', { altKey: true }), 'minimise'],
    ['Alt+Q closes', key('KeyQ', { altKey: true }), 'close'],
    ['Alt+T opens a terminal', key('KeyT', { altKey: true }), 'open-terminal'],
    ['Alt+C toggles Control Centre', key('KeyC', { altKey: true }), 'control-centre'],
    ['Alt+N focuses the dock', key('KeyN', { altKey: true }), 'focus-dock'],
    ['Alt+B focuses the menu bar', key('KeyB', { altKey: true }), 'focus-menubar'],
  ])('WM-07 %s', (_name, ev, action) => {
    expect(matchKey(ev)).toBe(action);
  });

  it('WM-07 matches modifiers exactly (Ctrl+Alt+` and a bare ` are not the switcher)', () => {
    expect(matchKey(key('Backquote', { altKey: true, ctrlKey: true }))).toBeNull();
    expect(matchKey(key('Backquote'))).toBeNull();
    expect(matchKey(key('KeyQ', { ctrlKey: true }))).toBeNull();
  });

  it('WM-07 matches by physical code, so the Alt symbol a macOS layout types does not matter', () => {
    expect(matchKey(key('KeyM', { altKey: true }, 'µ'))).toBe('minimise');
  });

  it('WM-07 guards Alt+Left and Alt+Right from browser history', () => {
    expect(isNavigationKey(key('ArrowLeft', { altKey: true }))).toBe(true);
    expect(isNavigationKey(key('ArrowRight', { altKey: true }))).toBe(true);
    expect(isNavigationKey(key('ArrowLeft', { altKey: true, ctrlKey: true }))).toBe(false);
    expect(isNavigationKey(key('ArrowLeft'))).toBe(false);
  });

  it('WM-07 shows only primary bindings, never Alt+Tab or the Cmd symbol', () => {
    expect(shortcutOf('switch-next')).toEqual(['Alt', '`']);
    expect(shortcutOf('search')).toEqual(['Ctrl', 'Space']);
    expect(shortcutOf('snap-left')).toEqual(['Alt', 'Shift', '←']);
    expect(shortcutOf('overview')).toEqual(['Alt', 'O']);
    for (const action of Object.keys(DEFAULT_BINDINGS) as ShellAction[]) {
      const shown = shortcutOf(action).join('+');
      expect(shown).not.toMatch(/Tab|⌘|Meta|F10/u);
    }
  });

  it('WM-07 commits the switcher when Alt or Meta is released', () => {
    expect(isSwitcherRelease({ key: 'Alt' })).toBe(true);
    expect(isSwitcherRelease({ key: 'Meta' })).toBe(true);
    expect(isSwitcherRelease({ key: 'Shift' })).toBe(false);
  });

  it('WM-07 honours a custom binding table', () => {
    const table = { ...DEFAULT_BINDINGS, minimise: [{ code: 'KeyH', ctrl: true, primary: true }] };
    expect(matchKey(key('KeyH', { ctrlKey: true }), table)).toBe('minimise');
    expect(matchKey(key('KeyM', { altKey: true }), table)).toBeNull();
    expect(shortcutOf('minimise', table)).toEqual(['Ctrl', 'H']);
  });
});
