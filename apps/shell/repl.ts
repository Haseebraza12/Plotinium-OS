/**
 * The interactive read–eval loop (shell-and-terminal.md §3.4 step 5, §3.8, §3.9).
 *
 * While a line is edited the terminal is in raw mode without echo or signals and bracketed paste
 * is on; before a line runs, the shell's own mode (canonical, `isig` on) is restored so Ctrl-C and
 * Ctrl-Z reach the job.
 */
import type { SysGen } from '../src/_sys.ts';
import { errnoOf } from '../src/_sys.ts';
import { exitBuiltin } from './builtins/misc.ts';
import type { Completer } from './complete.ts';
import {
  candidates,
  COMPLETE_LIMIT,
  completionContext,
  formatListing,
  historyMatches,
  outcome,
  serviceCompleter,
} from './complete.ts';
import type { EditorState } from './editor.ts';
import {
  bell,
  continueLine,
  draw,
  feed,
  insertText,
  newEditor,
  showListing,
  startHistory,
} from './editor.ts';
import { prepareSource, runCursor } from './exec.ts';
import { recordHistory } from './history.ts';
import { parse } from './parser.ts';
import { DEFAULT_PS2, defaultPs1, expandPrompt } from './prompt.ts';
import type { Sh } from './state.ts';
import { put, varOr } from './state.ts';
import { setVar } from './vars.ts';
import { COOKED, notify, reap, setMode } from './wait.ts';

const RAW = { canonical: false, echo: false, isig: false };
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';

type LineEvent = { k: 'submit'; text: string } | { k: 'cancel' } | { k: 'eof'; hangup: boolean };

/** Splits off an incomplete UTF-8 sequence at the end of `bytes`; returns where it starts. */
export function utf8Complete(bytes: readonly number[]): number {
  let i = bytes.length - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && ((bytes[i] ?? 0) & 0xc0) === 0x80) {
    i--;
    cont++;
  }
  if (i < 0) return bytes.length;
  const lead = bytes[i] ?? 0;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return bytes.length - i < need ? i : bytes.length;
}

const decoder = new TextDecoder();

/** Updates COLUMNS, LINES and the editor width after SIGWINCH. */
function* refreshSize(sh: Sh): SysGen<void> {
  const st = sh.st;
  st.sig.winch = false;
  try {
    const a = yield* sh.sys.call('tty.getattr', { fd: 0 });
    setVar(st.vars, 'COLUMNS', String(a.cols), { export: true });
    setVar(st.vars, 'LINES', String(a.rows), { export: true });
    if (st.ed) st.ed.cols = a.cols;
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
}

function cols(sh: Sh): number {
  const n = Number(varOr(sh.st, 'COLUMNS', '80'));
  return Number.isInteger(n) && n > 1 ? n : 80;
}

/** Reads keyboard bytes into `st.input.text`. */
function* readInput(sh: Sh): SysGen<'data' | 'eof' | 'signal'> {
  const st = sh.st;
  let buf: ArrayBuffer;
  try {
    buf = yield* sh.sys.call('read', { fd: 0, len: 4096 });
  } catch (e) {
    const errno = errnoOf(e);
    if (errno === undefined) throw e;
    return errno === 'ECANCELED' || errno === 'EAGAIN' ? 'signal' : 'eof';
  }
  if (buf.byteLength === 0) return 'eof';
  const bytes = [...st.input.bytes, ...new Uint8Array(buf)];
  const cut = utf8Complete(bytes);
  st.input.bytes = bytes.slice(cut);
  st.input.text += decoder.decode(new Uint8Array(bytes.slice(0, cut)));
  return 'data';
}

function* beginLine(sh: Sh): SysGen<EditorState> {
  const st = sh.st;
  yield* reap(sh);
  yield* notify(sh);
  if (st.sig.winch) yield* refreshSize(sh);
  const ed = newEditor(expandPrompt(varOr(st, 'PS1', defaultPs1(st.uid)), st), cols(sh));
  st.ed = ed;
  yield* setMode(sh, RAW);
  yield* put(sh, 2, PASTE_ON + draw(ed));
  return ed;
}

function* completeAt(
  sh: Sh,
  ed: EditorState,
  req: { line: string; cursor: number; again: boolean },
  completer: Completer,
): SysGen<void> {
  const noticed = sh.st.completeNotice;
  const ctx = completionContext(req.line, req.cursor);
  const c = yield* candidates(sh, ctx, completer);
  // The one-time degraded notice moved the cursor below the line: draw the line again.
  let out = noticed === sh.st.completeNotice ? '' : draw(ed);
  const o = outcome(c, ctx, req.again);
  if (o.k === 'bell') out += bell();
  else if (o.k === 'insert') out += insertText(ed, o.text);
  else {
    const ask = o.items.length > COMPLETE_LIMIT || c.truncated;
    out += showListing(ed, formatListing(o.items, ed.cols), o.items.length, ask);
  }
  yield* put(sh, 2, out);
}

function* readLine(sh: Sh, completer: Completer): SysGen<LineEvent> {
  const st = sh.st;
  let needMore = false;
  for (;;) {
    const ed = st.ed ?? (yield* beginLine(sh));
    if (needMore || st.input.text.length === 0) {
      const r = yield* readInput(sh);
      if (r === 'eof') return { k: 'eof', hangup: true };
      if (r === 'signal' && st.sig.winch) yield* refreshSize(sh);
      if (r === 'data') needMore = false;
      continue;
    }
    const step = feed(ed, st.input.text, st.hist.lines);
    st.input.text = st.input.text.slice(step.used);
    if (step.out.length > 0) yield* put(sh, 2, step.out);
    const a = step.action;
    if (a.k === 'more') needMore = true;
    else if (a.k === 'hist') startHistory(ed, yield* historyMatches(sh, a.prefix, completer));
    else if (a.k === 'complete') yield* completeAt(sh, ed, a, completer);
    else if (a.k === 'cancel') return { k: 'cancel' };
    else if (a.k === 'eof') return { k: 'eof', hangup: false };
    else if (a.k === 'submit') {
      const p = parse(a.text);
      if (p.ok || p.kind !== 'incomplete') return { k: 'submit', text: a.text };
      yield* put(sh, 2, continueLine(ed, a.text, varOr(st, 'PS2', DEFAULT_PS2)));
    }
  }
}

/** Runs (or resumes) the current line, then records it in history (§3.9: added after it ran). */
function* finishLine(sh: Sh): SysGen<void> {
  const st = sh.st;
  yield* runCursor(sh);
  const line = st.exec?.histLine ?? null;
  st.exec = null;
  if (line !== null) yield* recordHistory(sh, line);
}

/** The interactive loop; returns the exit status. */
export function* interactive(sh: Sh): SysGen<number> {
  const st = sh.st;
  const completer = serviceCompleter(sh);
  for (;;) {
    if (st.exitCode !== null) return st.exitCode;
    if (st.exec !== null) {
      yield* finishLine(sh);
      continue;
    }
    const ev = yield* readLine(sh, completer);
    st.ed = null;
    yield* put(sh, 2, PASTE_OFF);
    yield* setMode(sh, st.ttyMode ?? COOKED);
    if (ev.k === 'cancel') {
      st.status = 130;
      continue;
    }
    st.lineNo++;
    st.sig.intr = false;
    if (ev.k === 'eof') {
      if (ev.hangup) st.exitCode = st.status;
      else yield* exitBuiltin(sh, ['exit']);
      continue;
    }
    if (yield* prepareSource(sh, ev.text, ev.text)) yield* finishLine(sh);
    else yield* recordHistory(sh, ev.text);
  }
}
