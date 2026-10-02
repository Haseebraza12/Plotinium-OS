/**
 * The Terminal's own keyboard chords (UI-022, UI-126; ui-implementation-guide.md D-11, UIG-21;
 * window-manager.md §3.9).
 *
 * Chrome keeps some chords for itself outside app and full-screen mode, and a page never receives
 * them: Ctrl+Shift+W closes the browser window, Ctrl+Shift+T reopens a tab, Ctrl+Tab and
 * Ctrl+PageUp/PageDown switch browser tabs, Ctrl+T/N/W open and close them. A Terminal hint that
 * shows one of those invites the user to close the whole OS session. The tab chords are therefore
 * Alt+Shift chords, which neither Chrome nor the window manager uses (the WM's Alt letters and
 * Alt+Shift+arrows are left alone, and Shift+Alt+T is Chrome's toolbar focus), and the letters are
 * matched on `event.code`, so layouts and the macOS Option characters do not change them.
 *
 * Copy is Ctrl+Shift+C (Ctrl+C stays the interrupt key); Ctrl+V is left to the browser's own paste
 * (the shell binds no Ctrl-V), which xterm turns into a bracketed paste.
 */

export type TerminalKeyAction = 'newTab' | 'closeTab' | 'nextTab' | 'prevTab' | 'copy';

export interface TerminalChord {
  /** `KeyboardEvent.code`. */
  readonly code: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
}

export const TERMINAL_KEYS: Readonly<Record<TerminalKeyAction, TerminalChord>> = Object.freeze({
  newTab: { code: 'KeyN', alt: true, shift: true },
  closeTab: { code: 'KeyW', alt: true, shift: true },
  nextTab: { code: 'BracketRight', alt: true, shift: true },
  prevTab: { code: 'BracketLeft', alt: true, shift: true },
  copy: { code: 'KeyC', ctrl: true, shift: true },
});

interface KeyLike {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

function matches(chord: TerminalChord, ev: KeyLike): boolean {
  return (
    chord.code === ev.code &&
    (chord.ctrl ?? false) === ev.ctrlKey &&
    (chord.alt ?? false) === ev.altKey &&
    (chord.shift ?? false) === ev.shiftKey &&
    !ev.metaKey
  );
}

/** The Terminal action bound to `ev`, or null (the key goes to the TTY). */
export function terminalKeyAction(ev: KeyLike): TerminalKeyAction | null {
  for (const action of Object.keys(TERMINAL_KEYS) as TerminalKeyAction[]) {
    if (matches(TERMINAL_KEYS[action], ev)) return action;
  }
  return null;
}

/** Ctrl+V: the browser pastes into xterm's textarea, as long as xterm does not see the key. */
export function isPasteKey(ev: KeyLike): boolean {
  return ev.code === 'KeyV' && ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey;
}

const CODE_LABEL: Readonly<Record<string, string>> = {
  BracketLeft: '[',
  BracketRight: ']',
};

/** The keycaps of a chord, as menus and `Kbd` show them: `['Alt', 'Shift', 'N']`. */
export function chordLabel(chord: TerminalChord): string[] {
  const keys: string[] = [];
  if (chord.ctrl === true) keys.push('Ctrl');
  if (chord.alt === true) keys.push('Alt');
  if (chord.shift === true) keys.push('Shift');
  keys.push(CODE_LABEL[chord.code] ?? chord.code.replace(/^Key|^Digit/u, ''));
  return keys;
}
