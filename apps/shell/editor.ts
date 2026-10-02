/**
 * The line editor (shell-and-terminal.md §3.9, SHL-09): a pure state machine over keys.
 *
 * `feed` consumes decoded keyboard text and returns the bytes to echo plus at most one action for
 * the driver (repl.ts): submit a line, cancel, end of input, complete at the cursor, or fetch the
 * history entries for ↑. The state is plain data, so a half-typed line survives a page-out.
 */
import type { Key } from './keys.ts';
import { nextKey } from './keys.ts';
import { stringWidth, visibleText } from './wcwidth.ts';

export const LINE_MAX_BYTES = 8192;
const BELL = '\x07';

export interface EditorState {
  prompt: string;
  cols: number;
  buf: string;
  /** Cursor, a UTF-16 index on a code-point boundary. */
  cur: number;
  /** Earlier lines of a multi-line command, each ending in a newline. */
  pre: string;
  /** Cursor row relative to the prompt's first row, as last drawn. */
  row: number;
  hist: { matches: string[]; idx: number; saved: string } | null;
  search: { query: string; idx: number; saved: string; failed: boolean } | null;
  paste: boolean;
  /** Consecutive Tab presses. */
  tabs: number;
  /** A completion listing waiting for the `y` of "Display all N possibilities?". */
  pending: string | null;
}

export type EdAction =
  | { k: 'none' }
  /** The input ends inside an escape sequence: read more before feeding the rest. */
  | { k: 'more' }
  | { k: 'submit'; text: string }
  | { k: 'cancel' }
  | { k: 'eof' }
  | { k: 'complete'; line: string; cursor: number; again: boolean }
  /** ↑ needs the history entries starting with `prefix`; the key was not consumed. */
  | { k: 'hist'; prefix: string };

export interface Step {
  out: string;
  used: number;
  action: EdAction;
}

interface KeyResult {
  out: string;
  action: EdAction;
}

const NONE: EdAction = { k: 'none' };

export function newEditor(prompt: string, cols: number, pre = ''): EditorState {
  return {
    prompt,
    cols: Math.max(2, cols),
    buf: '',
    cur: 0,
    pre,
    row: 0,
    hist: null,
    search: null,
    paste: false,
    tabs: 0,
    pending: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Layout and drawing
// ---------------------------------------------------------------------------------------------

/** How a character is shown: control characters as `^X`, newlines as a line break. */
function shown(ch: string): string {
  const c = ch.codePointAt(0) ?? 0;
  if (ch === '\n') return '\r\n';
  if (c < 0x20 || c === 0x7f) return `^${String.fromCharCode(c === 0x7f ? 0x3f : c + 0x40)}`;
  return ch;
}

function display(s: string): string {
  let out = '';
  for (const ch of s) out += shown(ch);
  return out;
}

interface Pos {
  row: number;
  col: number;
}

/** Advances a screen position over `text`; `pending` marks a wrap the terminal has not done yet. */
function advance(start: Pos, text: string, cols: number): Pos & { pending: boolean } {
  let { row, col } = start;
  for (const ch of text) {
    if (ch === '\n') {
      row++;
      col = 0;
      continue;
    }
    const w = stringWidth(visibleText(shown(ch)));
    if (col + w > cols) {
      row++;
      col = 0;
    }
    col += w;
  }
  if (col >= cols) return { row: row + 1, col: 0, pending: true };
  return { row, col, pending: false };
}

/** Redraws prompt and text in place and puts the cursor at `cursor` (an index into `text`). */
function render(ed: EditorState, prompt: string, text: string, cursor: number): string {
  let o = ed.row > 0 ? `\x1b[${ed.row}A` : '';
  o += `\r${prompt}${display(text)}\x1b[J`;
  const p0 = advance({ row: 0, col: 0 }, visibleText(prompt), ed.cols);
  const end = advance(p0, text, ed.cols);
  const at = advance(p0, text.slice(0, cursor), ed.cols);
  if (end.pending) o += '\r\n';
  const up = end.row - at.row;
  if (up > 0) o += `\x1b[${up}A`;
  o += '\r';
  if (at.col > 0) o += `\x1b[${at.col}C`;
  ed.row = at.row;
  return o;
}

function searchPrompt(s: NonNullable<EditorState['search']>): string {
  return `(${s.failed ? 'failed ' : ''}reverse-i-search)'${s.query}': `;
}

/** Redraws the current line (normal or search mode). */
export function redraw(ed: EditorState, history: readonly string[] = []): string {
  const s = ed.search;
  if (s === null) return render(ed, ed.prompt, ed.buf, ed.cur);
  const match = s.idx >= 0 ? (history[s.idx] ?? '') : '';
  const at = Math.max(0, match.indexOf(s.query));
  return render(ed, searchPrompt(s), match, at);
}

/** Draws the prompt and line from a fresh line (the cursor is at column 0). */
export function draw(ed: EditorState): string {
  ed.row = 0;
  return redraw(ed);
}

/** Moves the cursor below the input, ready for output that follows the line. */
function below(ed: EditorState): string {
  const p0 = advance({ row: 0, col: 0 }, visibleText(ed.prompt), ed.cols);
  const end = advance(p0, ed.buf, ed.cols);
  const down = end.row - ed.row;
  return `${down > 0 ? `\x1b[${down}B` : ''}\r\n`;
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

function prevIndex(s: string, i: number): number {
  if (i <= 0) return 0;
  const lo = s.charCodeAt(i - 1);
  if (i >= 2 && lo >= 0xdc00 && lo <= 0xdfff) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return i - 2;
  }
  return i - 1;
}

function nextIndex(s: string, i: number): number {
  if (i >= s.length) return s.length;
  const cp = s.codePointAt(i) ?? 0;
  return i + (cp > 0xffff ? 2 : 1);
}

function wordLeft(s: string, i: number): number {
  let j = i;
  while (j > 0 && /\s/.test(s[j - 1] ?? '')) j--;
  while (j > 0 && !/\s/.test(s[j - 1] ?? '')) j--;
  return j;
}

function wordRight(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s[j] ?? '')) j++;
  while (j < s.length && !/\s/.test(s[j] ?? '')) j++;
  return j;
}

const encoder = new TextEncoder();

/** Inserts text at the cursor; past LINE_MAX_BYTES the input is refused with the bell. */
export function insertText(ed: EditorState, text: string): string {
  const size = encoder.encode(ed.pre + ed.buf + text).length;
  if (size > LINE_MAX_BYTES) return BELL;
  ed.buf = ed.buf.slice(0, ed.cur) + text + ed.buf.slice(ed.cur);
  ed.cur += text.length;
  return redraw(ed);
}

function edit(ed: EditorState, buf: string, cur: number): string {
  ed.buf = buf;
  ed.cur = cur;
  return redraw(ed);
}

function moveTo(ed: EditorState, cur: number): string {
  if (cur === ed.cur) return '';
  ed.cur = cur;
  return redraw(ed);
}

function killRange(ed: EditorState, from: number, to: number): string {
  if (from === to) return '';
  return edit(ed, ed.buf.slice(0, from) + ed.buf.slice(to), from);
}

// ---------------------------------------------------------------------------------------------
// History and search
// ---------------------------------------------------------------------------------------------

/** Gives the editor the entries ↑ walks through (most recent first). */
export function startHistory(ed: EditorState, matches: string[]): void {
  ed.hist = { matches, idx: -1, saved: ed.buf };
}

function histUp(ed: EditorState): KeyResult {
  const h = ed.hist;
  if (h === null) return { out: '', action: { k: 'hist', prefix: ed.buf } };
  const next = h.matches[h.idx + 1];
  if (next === undefined) return { out: BELL, action: NONE };
  h.idx++;
  return { out: edit(ed, next, next.length), action: NONE };
}

function histDown(ed: EditorState): KeyResult {
  const h = ed.hist;
  if (h === null || h.idx < 0) return { out: BELL, action: NONE };
  h.idx--;
  const line = h.idx < 0 ? h.saved : (h.matches[h.idx] ?? '');
  return { out: edit(ed, line, line.length), action: NONE };
}

/** Newest entry at or before `from` containing `query` (Ctrl-R is a linear substring search). */
function findBack(history: readonly string[], query: string, from: number): number {
  for (let i = Math.min(from, history.length - 1); i >= 0; i--) {
    if ((history[i] ?? '').includes(query)) return i;
  }
  return -1;
}

function searchTo(
  ed: EditorState,
  history: readonly string[],
  query: string,
  from: number,
): string {
  const s = ed.search;
  if (s === null) return '';
  const idx = findBack(history, query, from);
  s.query = query;
  s.failed = idx < 0;
  if (idx >= 0) s.idx = idx;
  return redraw(ed, history) + (idx < 0 ? BELL : '');
}

function leaveSearch(ed: EditorState, history: readonly string[], accept: boolean): string {
  const s = ed.search;
  if (s === null) return '';
  const match = s.idx >= 0 ? history[s.idx] : undefined;
  const line = accept && match !== undefined ? match : s.saved;
  ed.search = null;
  ed.buf = line;
  ed.cur = accept ? Math.max(0, line.indexOf(s.query)) : line.length;
  return redraw(ed);
}

function searchKey(ed: EditorState, key: Key, history: readonly string[]): KeyResult {
  const s = ed.search;
  if (s === null) return { out: '', action: NONE };
  if (key.k === 'text')
    return { out: searchTo(ed, history, s.query + key.s, history.length - 1), action: NONE };
  if (key.k === 'backspace') {
    const q = s.query.slice(0, prevIndex(s.query, s.query.length));
    return { out: searchTo(ed, history, q, history.length - 1), action: NONE };
  }
  if (key.k === 'ctrl' && key.c === 'r')
    return { out: searchTo(ed, history, s.query, s.idx - 1), action: NONE };
  if (key.k === 'ctrl' && (key.c === 'g' || key.c === 'c')) {
    return { out: leaveSearch(ed, history, false), action: NONE };
  }
  const out = leaveSearch(ed, history, true);
  if (key.k === 'esc') return { out, action: NONE };
  const next = applyKey(ed, key, history);
  return { out: out + next.out, action: next.action };
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

function submit(ed: EditorState): KeyResult {
  ed.cur = ed.buf.length;
  const out = redraw(ed) + '\r\n';
  return { out, action: { k: 'submit', text: ed.pre + ed.buf } };
}

function ctrlKey(ed: EditorState, c: string, history: readonly string[]): KeyResult {
  const b = ed.buf;
  const none = (out: string): KeyResult => ({ out, action: NONE });
  switch (c) {
    case 'a':
      return none(moveTo(ed, 0));
    case 'e':
      return none(moveTo(ed, b.length));
    case 'b':
      return none(moveTo(ed, prevIndex(b, ed.cur)));
    case 'f':
      return none(moveTo(ed, nextIndex(b, ed.cur)));
    case 'd':
      if (b.length === 0)
        return ed.pre.length === 0 ? { out: '', action: { k: 'eof' } } : none(BELL);
      return none(killRange(ed, ed.cur, nextIndex(b, ed.cur)));
    case 'c':
      ed.cur = b.length;
      return { out: `${redraw(ed)}^C\r\n`, action: { k: 'cancel' } };
    case 'k':
      return none(killRange(ed, ed.cur, b.length));
    case 'u':
      return none(killRange(ed, 0, ed.cur));
    case 'w':
      return none(killRange(ed, wordLeft(b, ed.cur), ed.cur));
    case 'l':
      ed.row = 0;
      return none(`\x1b[H\x1b[2J${redraw(ed)}`);
    case 'r':
      ed.search = { query: '', idx: -1, saved: b, failed: false };
      return none(redraw(ed, history));
    case 'p':
      return histUp(ed);
    case 'n':
      return histDown(ed);
    default:
      return none('');
  }
}

function applyKey(ed: EditorState, key: Key, history: readonly string[]): KeyResult {
  if (ed.search !== null) return searchKey(ed, key, history);
  if (ed.paste) {
    if (key.k === 'pasteEnd') ed.paste = false;
    return { out: key.k === 'text' ? insertText(ed, key.s) : '', action: NONE };
  }
  const none = (out: string): KeyResult => ({ out, action: NONE });
  const b = ed.buf;
  switch (key.k) {
    case 'text':
      return none(insertText(ed, key.s));
    case 'pasteStart':
      ed.paste = true;
      return none('');
    case 'enter':
      return submit(ed);
    case 'tab':
      return { out: '', action: { k: 'complete', line: b, cursor: ed.cur, again: ed.tabs > 1 } };
    case 'backspace':
      return none(ed.cur === 0 ? BELL : killRange(ed, prevIndex(b, ed.cur), ed.cur));
    case 'delete':
      return none(killRange(ed, ed.cur, nextIndex(b, ed.cur)));
    case 'left':
      return none(moveTo(ed, prevIndex(b, ed.cur)));
    case 'right':
      return none(moveTo(ed, nextIndex(b, ed.cur)));
    case 'home':
      return none(moveTo(ed, 0));
    case 'end':
      return none(moveTo(ed, b.length));
    case 'wordLeft':
      return none(moveTo(ed, wordLeft(b, ed.cur)));
    case 'wordRight':
      return none(moveTo(ed, wordRight(b, ed.cur)));
    case 'up':
      return histUp(ed);
    case 'down':
      return histDown(ed);
    case 'ctrl':
      return ctrlKey(ed, key.c, history);
    case 'esc':
    case 'pasteEnd':
    case 'ignore':
      return none('');
  }
}

function answerPending(ed: EditorState, key: Key): string {
  const listing = ed.pending ?? '';
  ed.pending = null;
  ed.tabs = 0;
  const yes = key.k === 'text' && (key.s === 'y' || key.s === 'Y');
  return `\r\n${yes ? listing : ''}${draw(ed)}`;
}

/**
 * Feeds keyboard text to the editor. Stops at the first action for the driver; `used` says how
 * much of `input` was consumed (a `hist` action leaves its key unconsumed).
 */
export function feed(ed: EditorState, input: string, history: readonly string[]): Step {
  let out = '';
  let used = 0;
  for (;;) {
    const d = nextKey(input, used, ed.paste);
    if (d === null) return { out, used, action: used < input.length ? { k: 'more' } : NONE };
    if (ed.pending !== null) {
      out += answerPending(ed, d.key);
      used += d.len;
      continue;
    }
    if (d.key.k !== 'tab') ed.tabs = 0;
    else ed.tabs++;
    if (
      d.key.k !== 'up' &&
      d.key.k !== 'down' &&
      !(d.key.k === 'ctrl' && (d.key.c === 'p' || d.key.c === 'n'))
    ) {
      ed.hist = null;
    }
    const r = applyKey(ed, d.key, history);
    if (r.action.k === 'hist') return { out, used, action: r.action };
    used += d.len;
    out += r.out;
    if (r.action.k !== 'none') return { out, used, action: r.action };
  }
}

/** Starts a continuation line (`PS2`) after input that does not parse yet. */
export function continueLine(ed: EditorState, text: string, ps2: string): string {
  ed.pre = `${text}\n`;
  ed.buf = '';
  ed.cur = 0;
  ed.prompt = ps2;
  ed.hist = null;
  return draw(ed);
}

/** Shows completion candidates under the line, then the line again (§3.10). */
export function showListing(ed: EditorState, listing: string, count: number, ask: boolean): string {
  if (ask) {
    ed.pending = listing;
    return `${below(ed)}Display all ${count} possibilities? (y or n)`;
  }
  return `${below(ed)}${listing}${draw(ed)}`;
}

export function bell(): string {
  return BELL;
}
