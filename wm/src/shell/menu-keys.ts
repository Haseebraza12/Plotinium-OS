/**
 * App-menu key equivalents (UI-087). A focused app's menus show shortcuts such as Ctrl+1 or
 * Alt+Ctrl+Q; the descriptors only draw them, so the shell binds them: a key the app itself did
 * not handle (`defaultPrevented`) runs the matching menu item, exactly as choosing it would.
 * Pure: the shell's bubble-phase `keydown` listener asks `menuShortcut` which item a key is.
 */
import type { KeyLike } from './keys.ts';
import type { MenuBarMenu } from './ui.ts';

/** A parsed shortcut: exact modifiers and the physical key (`KeyboardEvent.code`). */
export interface Chord {
  readonly code: string;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

const MODIFIERS: Readonly<Record<string, 'alt' | 'shift' | 'ctrl' | 'meta'>> = {
  Alt: 'alt',
  Option: 'alt',
  '⌥': 'alt',
  Shift: 'shift',
  '⇧': 'shift',
  Ctrl: 'ctrl',
  Control: 'ctrl',
  '⌃': 'ctrl',
  Meta: 'meta',
  Cmd: 'meta',
  '⌘': 'meta',
};

const NAMED: Readonly<Record<string, string>> = {
  '`': 'Backquote',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ';': 'Semicolon',
  "'": 'Quote',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  '↵': 'Enter',
  '⏎': 'Enter',
  Esc: 'Escape',
  Escape: 'Escape',
  Delete: 'Delete',
  Del: 'Delete',
  Backspace: 'Backspace',
  '⌫': 'Backspace',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/** The `code` of one key label: letters, digits, F-keys and the named keys above. */
function codeOf(label: string): string | null {
  if (/^[A-Za-z]$/u.test(label)) return `Key${label.toUpperCase()}`;
  if (/^[0-9]$/u.test(label)) return `Digit${label}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/u.test(label)) return label;
  return NAMED[label] ?? null;
}

/** ['Ctrl', 'Shift', 'N'] → the chord, or null when a key is not understood. */
export function parseShortcut(keys: readonly string[]): Chord | null {
  const mods = { alt: false, shift: false, ctrl: false, meta: false };
  let code: string | null = null;
  for (const key of keys) {
    const mod = MODIFIERS[key];
    if (mod !== undefined) {
      mods[mod] = true;
      continue;
    }
    if (code !== null) return null;
    code = codeOf(key);
    if (code === null) return null;
  }
  return code === null ? null : { code, ...mods };
}

/**
 * Only chords with Ctrl, Alt or Meta (or a function key) are bound: a bare key or Shift+key
 * would fire while someone types.
 */
function bindable(chord: Chord): boolean {
  return chord.ctrl || chord.alt || chord.meta || /^F\d+$/u.test(chord.code);
}

function matches(chord: Chord, ev: KeyLike): boolean {
  return (
    chord.code === ev.code &&
    chord.alt === ev.altKey &&
    chord.shift === ev.shiftKey &&
    chord.ctrl === ev.ctrlKey &&
    chord.meta === ev.metaKey
  );
}

/** The enabled menu item whose shortcut is `ev`, if any. */
export function menuShortcut(
  menus: readonly MenuBarMenu[],
  ev: KeyLike,
): { menuId: string; itemId: string } | null {
  for (const menu of menus) {
    if (menu.disabled === true) continue;
    for (const item of menu.items) {
      if (item.kind === 'separator' || item.kind === 'header') continue;
      if (item.disabled === true || item.shortcut === undefined) continue;
      const chord = parseShortcut(item.shortcut);
      if (chord !== null && bindable(chord) && matches(chord, ev))
        return { menuId: menu.id, itemId: item.id };
    }
  }
  return null;
}

/** Text fields keep their own keys (Ctrl+C, Ctrl+A …): the shell never takes them there. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as { closest?: unknown }).closest !== 'function')
    return false;
  const el = target as Element;
  return (
    el.closest(
      'input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
    ) !== null
  );
}
