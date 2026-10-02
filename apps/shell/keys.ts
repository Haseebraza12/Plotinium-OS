/**
 * Keyboard input decoding for the line editor (shell-and-terminal.md §3.9). xterm.js turns keys
 * into bytes; this turns the decoded text back into keys: control characters, CSI and SS3
 * sequences (arrows, Home/End, Delete, Ctrl-arrows) and bracketed paste (`ESC[200~` … `ESC[201~`).
 */

export type Key =
  | { k: 'text'; s: string }
  | { k: 'enter' }
  | { k: 'tab' }
  | { k: 'backspace' }
  | { k: 'delete' }
  | { k: 'left' }
  | { k: 'right' }
  | { k: 'up' }
  | { k: 'down' }
  | { k: 'home' }
  | { k: 'end' }
  | { k: 'wordLeft' }
  | { k: 'wordRight' }
  /** Ctrl plus a letter, `c` in lower case. */
  | { k: 'ctrl'; c: string }
  | { k: 'esc' }
  | { k: 'pasteStart' }
  | { k: 'pasteEnd' }
  | { k: 'ignore' };

export interface Decoded {
  key: Key;
  len: number;
}

const PASTE_END = '\x1b[201~';

/* eslint-disable no-control-regex -- matching ESC is the point of these patterns */
const CSI_SEQ = /^\x1b\[([0-9;]*)([\x40-\x7e])/;
const CSI_PARTIAL = /^\x1b\[[0-9;]*$/;
/* eslint-enable no-control-regex */

const CSI_FINAL: Readonly<Record<string, Key['k']>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
};

const TILDE: Readonly<Record<string, Key['k']>> = {
  '1': 'home',
  '7': 'home',
  '4': 'end',
  '8': 'end',
  '3': 'delete',
  '200': 'pasteStart',
  '201': 'pasteEnd',
};

function simple(k: Key['k']): Key {
  return { k } as Key;
}

function csi(params: string, final: string): Key {
  if (final === '~') return simple(TILDE[params.split(';')[0] ?? ''] ?? 'ignore');
  const base = CSI_FINAL[final];
  if (base === undefined) return { k: 'ignore' };
  // `ESC[1;5C`: modifier 5 is Ctrl.
  const ctrl = params.split(';')[1] === '5';
  if (ctrl && base === 'right') return { k: 'wordRight' };
  if (ctrl && base === 'left') return { k: 'wordLeft' };
  return simple(base);
}

function escape(s: string, i: number): Decoded | null {
  const next = s[i + 1];
  if (next === undefined) return { key: { k: 'esc' }, len: 1 };
  if (next === '[') {
    const m = CSI_SEQ.exec(s.slice(i, i + 32));
    if (m === null) return CSI_PARTIAL.test(s.slice(i)) ? null : { key: { k: 'ignore' }, len: 2 };
    return { key: csi(m[1] ?? '', m[2] ?? ''), len: m[0].length };
  }
  if (next === 'O') {
    const f = s[i + 2];
    if (f === undefined) return null;
    return { key: simple(CSI_FINAL[f] ?? 'ignore'), len: 3 };
  }
  // Alt+key: not bound (Alt letters belong to the browser and the window manager, §3.9).
  return { key: { k: 'ignore' }, len: 2 };
}

/** Pasted text runs up to the end marker; newlines become `\n`. */
function pasted(s: string, i: number): Decoded | null {
  if (s.startsWith(PASTE_END, i)) return { key: { k: 'pasteEnd' }, len: PASTE_END.length };
  const esc = s.indexOf('\x1b', i);
  if (esc === i) {
    // A lone ESC that may be the start of the end marker waits for more input.
    return PASTE_END.startsWith(s.slice(i)) ? null : { key: { k: 'text', s: '\x1b' }, len: 1 };
  }
  const end = esc < 0 ? s.length : esc;
  const text = s.slice(i, end).replace(/\r\n?/g, '\n');
  return { key: { k: 'text', s: text }, len: end - i };
}

/**
 * The key starting at `s[i]`, or null when `s` ends inside an escape sequence and more input is
 * needed. Runs of printable characters come back as one `text` key.
 */
export function nextKey(s: string, i: number, paste: boolean): Decoded | null {
  if (i >= s.length) return null;
  if (paste) return pasted(s, i);
  const c = s.charCodeAt(i);
  if (c === 0x1b) return escape(s, i);
  if (c === 0x0d) return { key: { k: 'enter' }, len: s[i + 1] === '\n' ? 2 : 1 };
  if (c === 0x0a) return { key: { k: 'enter' }, len: 1 };
  if (c === 0x09) return { key: { k: 'tab' }, len: 1 };
  if (c === 0x7f || c === 0x08) return { key: { k: 'backspace' }, len: 1 };
  if (c < 0x20) return { key: { k: 'ctrl', c: String.fromCharCode(c + 0x60) }, len: 1 };
  let j = i + 1;
  while (j < s.length) {
    const d = s.charCodeAt(j);
    if (d < 0x20 || d === 0x7f) break;
    j++;
  }
  return { key: { k: 'text', s: s.slice(i, j) }, len: j - i };
}
