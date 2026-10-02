/**
 * Desktop key bindings (window-manager.md §3.9, WM-07, WMD-08; ui-implementation-guide.md D-11).
 * Pure: the shell installs one capture-phase `keydown` listener on `window` and asks `matchKey`
 * which action an event is. Bindings match `KeyboardEvent.code` with exact modifiers, so they
 * work on any layout and with Alt on macOS (where `key` is a symbol).
 *
 * The table keeps the spec's primaries (Alt+` to switch, Alt+O for Overview, Ctrl+Space for
 * Search) and adds macOS-style aliases that a browser page can still receive (F3 and Ctrl+Up for
 * Overview, Meta+Space for Search, Alt+Tab and Cmd+Tab where the OS passes them through). Hints show only the
 * primaries; Alt+Tab, Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab, F6 and F10 are never shown (D-11).
 */

export type ShellAction =
  | 'switch-next'
  | 'switch-prev'
  | 'window-menu'
  | 'snap-left'
  | 'snap-right'
  | 'maximise-toggle'
  | 'restore-or-minimise'
  | 'minimise'
  | 'close'
  | 'open-terminal'
  | 'launcher'
  | 'focus-dock'
  | 'focus-menubar'
  | 'search'
  | 'overview'
  | 'control-centre';

/** The fields of a KeyboardEvent the matcher reads. */
export interface KeyLike {
  readonly code: string;
  readonly key: string;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly repeat?: boolean;
}

export interface Binding {
  readonly code: string;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  /** Shown in menus, help and Settings → Keyboard. */
  readonly primary?: boolean;
}

export type BindingTable = Readonly<Record<ShellAction, readonly Binding[]>>;

export const DEFAULT_BINDINGS: BindingTable = Object.freeze({
  'switch-next': [
    { code: 'Backquote', alt: true, primary: true },
    { code: 'KeyJ', alt: true },
    { code: 'Tab', alt: true },
    { code: 'Tab', meta: true },
  ],
  'switch-prev': [
    { code: 'Backquote', alt: true, shift: true, primary: true },
    { code: 'KeyK', alt: true },
    { code: 'Tab', alt: true, shift: true },
    { code: 'Tab', meta: true, shift: true },
  ],
  'window-menu': [{ code: 'KeyW', alt: true, primary: true }],
  'snap-left': [{ code: 'ArrowLeft', alt: true, shift: true, primary: true }],
  'snap-right': [{ code: 'ArrowRight', alt: true, shift: true, primary: true }],
  'maximise-toggle': [{ code: 'ArrowUp', alt: true, shift: true, primary: true }],
  'restore-or-minimise': [{ code: 'ArrowDown', alt: true, shift: true, primary: true }],
  minimise: [{ code: 'KeyM', alt: true, primary: true }],
  close: [{ code: 'KeyQ', alt: true, primary: true }],
  'open-terminal': [{ code: 'KeyT', alt: true, primary: true }],
  launcher: [{ code: 'KeyL', alt: true, primary: true }],
  'focus-dock': [{ code: 'KeyN', alt: true, primary: true }],
  'focus-menubar': [{ code: 'KeyB', alt: true, primary: true }],
  search: [
    { code: 'Space', ctrl: true, primary: true },
    { code: 'KeyS', alt: true },
    { code: 'Space', meta: true },
  ],
  overview: [
    { code: 'KeyO', alt: true, primary: true },
    { code: 'F3' },
    { code: 'ArrowUp', ctrl: true },
  ],
  'control-centre': [{ code: 'KeyC', alt: true, primary: true }],
});

function matches(b: Binding, ev: KeyLike): boolean {
  return (
    b.code === ev.code &&
    (b.alt ?? false) === ev.altKey &&
    (b.shift ?? false) === ev.shiftKey &&
    (b.ctrl ?? false) === ev.ctrlKey &&
    (b.meta ?? false) === ev.metaKey
  );
}

/** The action bound to `ev`, or null. */
export function matchKey(ev: KeyLike, table: BindingTable = DEFAULT_BINDINGS): ShellAction | null {
  for (const action of Object.keys(table) as ShellAction[]) {
    if (table[action].some((b) => matches(b, ev))) return action;
  }
  return null;
}

/**
 * Navigation guard (§3.9 rule 2): while the desktop is mounted, Alt+Left and Alt+Right never
 * reach the browser's history, bound or not.
 */
export function isNavigationKey(ev: KeyLike): boolean {
  return (
    ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.code === 'ArrowLeft' || ev.code === 'ArrowRight')
  );
}

const CODE_LABEL: Readonly<Record<string, string>> = {
  Backquote: '`',
  Space: 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

/** The keycaps of an action's primary binding, for `Kbd` and menu shortcuts. */
export function shortcutOf(action: ShellAction, table: BindingTable = DEFAULT_BINDINGS): string[] {
  const b = table[action].find((x) => x.primary === true) ?? table[action][0];
  if (b === undefined) return [];
  const keys: string[] = [];
  if (b.ctrl === true) keys.push('Ctrl');
  if (b.alt === true) keys.push('Alt');
  if (b.shift === true) keys.push('Shift');
  const label = CODE_LABEL[b.code] ?? b.code.replace(/^Key|^Digit/u, '');
  keys.push(label);
  return keys;
}

/** True when the key only releases the switcher's modifier (Alt up commits, §3.9). */
export function isSwitcherRelease(ev: Pick<KeyLike, 'key'>): boolean {
  return ev.key === 'Alt' || ev.key === 'AltGraph' || ev.key === 'Meta';
}

/** What each desktop key does, in the words of the Keyboard Shortcuts sheet (UI-077). */
export const ACTION_LABELS: Readonly<Record<ShellAction, string>> = Object.freeze({
  'switch-next': 'Switch to the next window',
  'switch-prev': 'Switch to the previous window',
  'window-menu': 'Open the window menu',
  'snap-left': 'Move the window to the left half',
  'snap-right': 'Move the window to the right half',
  'maximise-toggle': 'Zoom or restore the window',
  'restore-or-minimise': 'Restore or minimise the window',
  minimise: 'Minimise the window',
  close: 'Close the window',
  'open-terminal': 'Open a new Terminal window',
  launcher: 'Open the launcher',
  'focus-dock': 'Move focus to the Dock',
  'focus-menubar': 'Move focus to the menu bar',
  search: 'Search',
  overview: 'Overview',
  'control-centre': 'Control Centre',
});

export interface ShortcutSection {
  readonly id: string;
  readonly title: string;
  readonly rows: readonly {
    readonly id: ShellAction;
    readonly label: string;
    readonly keys: string[];
  }[];
}

const SECTIONS: readonly { id: string; title: string; actions: readonly ShellAction[] }[] = [
  {
    id: 'windows',
    title: 'Windows',
    actions: [
      'switch-next',
      'switch-prev',
      'minimise',
      'close',
      'maximise-toggle',
      'restore-or-minimise',
      'snap-left',
      'snap-right',
      'window-menu',
    ],
  },
  {
    id: 'desktop',
    title: 'Desktop',
    actions: [
      'search',
      'launcher',
      'overview',
      'control-centre',
      'open-terminal',
      'focus-menubar',
      'focus-dock',
    ],
  },
];

/**
 * The Keyboard Shortcuts sheet: every desktop action with its primary keys only (D-11: hints
 * never show the browser-reserved aliases).
 */
export function shortcutSections(table: BindingTable = DEFAULT_BINDINGS): ShortcutSection[] {
  return SECTIONS.map((s) => ({
    id: s.id,
    title: s.title,
    rows: s.actions.map((id) => ({ id, label: ACTION_LABELS[id], keys: shortcutOf(id, table) })),
  }));
}
