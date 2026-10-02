/**
 * Menu-bar menus (ui-implementation-guide.md §3.4 MenuBar): the focused app's own menus from the
 * registry, completed with the shell's Window and Help menus, or the desktop's menus when no
 * window has focus. Pure.
 */
import type { AppEntry } from './env.ts';
import { shortcutOf } from './keys.ts';
import type { MenuBarMenu, MenuEntry } from './ui.ts';

export const WINDOW_MENU_ID = 'window';
export const HELP_MENU_ID = 'help';

/** What the Window menus know about the window they act on (its app's window hints). */
export interface WindowMenuState {
  /** Size is offered (false for fixed-size windows such as Settings and About). Default true. */
  readonly resizable?: boolean;
  /** Zoom and Full Screen are offered. Default true. */
  readonly maximizable?: boolean;
  /** The window's state, for the Restore and Exit Full Screen labels. */
  readonly state?: 'normal' | 'minimised' | 'maximised' | 'fullscreen';
}

const off = (disabled: boolean): { disabled?: true } => (disabled ? { disabled: true } : {});

/**
 * The menu bar's Window menu (window-manager.md §3.9: move, size, snap, minimise, maximise, full
 * screen, close). With no focused window every window command is disabled, but Overview still
 * works (UI-094).
 */
export function windowMenu(disabled: boolean, s: WindowMenuState = {}): MenuBarMenu {
  const item = (
    id: string,
    label: string,
    shortcut?: string[],
    unavailable = false,
  ): MenuEntry => ({
    id,
    label,
    ...(shortcut === undefined ? {} : { shortcut }),
    ...off(disabled || unavailable),
  });
  const noZoom = s.maximizable === false;
  return {
    id: WINDOW_MENU_ID,
    label: 'Window',
    items: [
      item('minimise', 'Minimise', shortcutOf('minimise')),
      item('zoom', 'Zoom', shortcutOf('maximise-toggle'), noZoom),
      item('fullscreen', 'Full Screen', undefined, noZoom),
      { kind: 'separator', id: 'window-sep-1' },
      item('move', 'Move'),
      item('size', 'Size', undefined, s.resizable === false),
      { kind: 'separator', id: 'window-sep-4' },
      item('snap-left', 'Move to Left Half', shortcutOf('snap-left')),
      item('snap-right', 'Move to Right Half', shortcutOf('snap-right')),
      { kind: 'separator', id: 'window-sep-2' },
      item('bring-all-to-front', 'Bring All to Front'),
      { id: 'overview', label: 'Overview', shortcut: shortcutOf('overview') },
      { kind: 'separator', id: 'window-sep-3' },
      item('close-window', 'Close Window', shortcutOf('close')),
    ],
  };
}

export function helpMenu(title: string): MenuBarMenu {
  return {
    id: HELP_MENU_ID,
    label: 'Help',
    items: [
      { id: 'app-help', label: `${title} Help` },
      { id: 'keyboard-shortcuts', label: 'Keyboard Shortcuts' },
    ],
  };
}

/** The menus for the focused app, or the desktop's when `app` is undefined. */
export function menusFor(app: AppEntry | undefined, apps: readonly AppEntry[]): MenuBarMenu[] {
  if (app === undefined) {
    return [
      {
        id: 'file',
        label: 'File',
        items: [
          {
            id: 'new-terminal',
            label: 'New Terminal Window',
            shortcut: shortcutOf('open-terminal'),
          },
          { id: 'search', label: 'Search…', shortcut: shortcutOf('search') },
        ],
      },
      {
        id: 'go',
        label: 'Go',
        items: apps
          .filter((a) => a.launchable !== false)
          .map((a): MenuEntry => ({ id: `app:${a.id}`, label: a.title })),
      },
      windowMenu(true),
      helpMenu('Plotinium'),
    ];
  }
  const own = app.menus ?? [
    {
      id: 'file',
      label: 'File',
      items: [
        { id: 'new-window', label: 'New Window' },
        { kind: 'separator', id: 'file-sep' },
        { id: 'close-window', label: 'Close Window', shortcut: shortcutOf('close') },
      ],
    },
  ];
  const withoutShell = own.filter((m) => m.id !== WINDOW_MENU_ID && m.id !== HELP_MENU_ID);
  const hints = app.window;
  return [
    ...withoutShell,
    windowMenu(false, {
      ...(hints?.resizable === undefined ? {} : { resizable: hints.resizable }),
      ...(hints?.maximizable === undefined ? {} : { maximizable: hints.maximizable }),
    }),
    helpMenu(app.title),
  ];
}

/**
 * The window menu (Alt+W, Shift+F10 or a right-click on the title bar or a drag region): the
 * keyboard alternative to dragging (WCAG 2.5.7; ui-implementation-guide.md WindowMenu).
 */
export function windowActions(maximised: boolean, s: WindowMenuState = {}): MenuEntry[] {
  const noZoom = s.maximizable === false;
  return [
    { id: 'move', label: 'Move' },
    { id: 'size', label: 'Size', ...off(s.resizable === false) },
    { kind: 'separator', id: 'wm-sep-0' },
    { id: 'snap-left', label: 'Move to Left Half', shortcut: shortcutOf('snap-left') },
    { id: 'snap-right', label: 'Move to Right Half', shortcut: shortcutOf('snap-right') },
    { kind: 'separator', id: 'wm-sep-1' },
    {
      id: 'zoom',
      label: maximised ? 'Restore' : 'Zoom',
      shortcut: shortcutOf('maximise-toggle'),
      ...off(noZoom),
    },
    {
      id: 'fullscreen',
      label: s.state === 'fullscreen' ? 'Exit Full Screen' : 'Full Screen',
      ...off(noZoom),
    },
    { id: 'minimise', label: 'Minimise', shortcut: shortcutOf('minimise') },
    { kind: 'separator', id: 'wm-sep-2' },
    { id: 'close-window', label: 'Close', shortcut: shortcutOf('close'), danger: true },
  ];
}
