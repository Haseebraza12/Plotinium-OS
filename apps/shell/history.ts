/**
 * Command history (shell-and-terminal.md §3.9, §4.6; SHL-09, I-SH5).
 *
 * In memory: the last HISTSIZE lines. On disk: `$HISTFILE` (mode 0600), one entry per line with
 * newlines stored as `\n` escapes, appended with one `write` per command and rewritten to the last
 * 1,000 lines once it passes 1,200. Every added line also goes to the `hist` completion namespace.
 */
import type { SysGen } from '../src/_sys.ts';
import { encodeText, errnoOf, readAllText } from '../src/_sys.ts';
import type { Sh } from './state.ts';
import { varOr } from './state.ts';

export const HISTSIZE_DEFAULT = 1000;
export const HISTFILE_MAX_LINES = 1200;

export interface HistoryState {
  /** Oldest first. */
  lines: string[];
  /** The number shown for `lines[0]`. */
  first: number;
  /** Lines currently in `$HISTFILE`, as far as this shell knows. */
  fileLines: number;
}

export function newHistory(): HistoryState {
  return { lines: [], first: 1, fileLines: 0 };
}

export function escapeHistLine(line: string): string {
  return line.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

export function unescapeHistLine(s: string): string {
  return s.replace(/\\(\\|n)/g, (_m, c: string) => (c === 'n' ? '\n' : '\\'));
}

/** Non-empty, not starting with a space, and different from the previous entry (§3.9). */
export function shouldAdd(h: HistoryState, line: string): boolean {
  return line.trim().length > 0 && !line.startsWith(' ') && h.lines.at(-1) !== line;
}

export function addLine(h: HistoryState, line: string, size: number): void {
  h.lines.push(line);
  const drop = h.lines.length - size;
  if (drop > 0) {
    h.lines.splice(0, drop);
    h.first += drop;
  }
}

/** `history [N]`: `  501  ls -la ~`, the number right-aligned in 5 columns. */
export function formatHistory(h: HistoryState, n?: number): string {
  const start = n === undefined ? 0 : Math.max(0, h.lines.length - n);
  let text = '';
  for (let i = start; i < h.lines.length; i++) {
    text += `${String(h.first + i).padStart(5)}  ${h.lines[i] ?? ''}\n`;
  }
  return text;
}

/** Entries starting with `prefix`, most recent first, without duplicates (the ↑ fallback). */
export function prefixMatches(h: HistoryState, prefix: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = h.lines.length - 1; i >= 0; i--) {
    const line = h.lines[i] ?? '';
    if (line.startsWith(prefix) && line !== prefix && !seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

export function histSize(sh: Sh): number {
  const n = Number(varOr(sh.st, 'HISTSIZE', String(HISTSIZE_DEFAULT)));
  return Number.isInteger(n) && n >= 0 ? n : HISTSIZE_DEFAULT;
}

function histFile(sh: Sh): string | null {
  const f = varOr(sh.st, 'HISTFILE', '');
  return f.length > 0 ? f : null;
}

function splitFile(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function* readFileText(sh: Sh, path: string): SysGen<string | null> {
  let fd: number;
  try {
    fd = (yield* sh.sys.call('open', { path, flags: 'r' })).fd;
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
    return null;
  }
  try {
    return yield* readAllText(sh.sys, fd);
  } finally {
    yield* closeQuietly(sh, fd);
  }
}

function* closeQuietly(sh: Sh, fd: number): SysGen<void> {
  try {
    yield* sh.sys.call('close', { fd });
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
}

function* writeWhole(
  sh: Sh,
  path: string,
  text: string,
  flags: { flags: 'a' | 'w'; trunc?: boolean },
): SysGen<void> {
  const { fd } = yield* sh.sys.call('open', { path, create: true, mode: 0o600, ...flags });
  try {
    yield* sh.sys.call('write', { fd, data: encodeText(text) });
  } finally {
    yield* closeQuietly(sh, fd);
  }
}

/**
 * Loads `$HISTFILE` (§3.4 start-up step 3); an interactive shell also seeds the completion
 * service with it.
 */
export function* loadHistory(sh: Sh, seed = true): SysGen<void> {
  const path = histFile(sh);
  if (path === null) return;
  const text = yield* readFileText(sh, path);
  if (text === null) return;
  const lines = splitFile(text);
  const size = histSize(sh);
  const h = sh.st.hist;
  h.lines = lines.slice(Math.max(0, lines.length - size)).map(unescapeHistLine);
  h.first = 1;
  h.fileLines = lines.length;
  if (seed) yield* quietly(sh.sys.call('complete.hist.load', { lines: h.lines }));
}

/** Adds a line after it ran: memory, file, completion service. */
export function* recordHistory(sh: Sh, line: string): SysGen<void> {
  const h = sh.st.hist;
  if (!shouldAdd(h, line)) return;
  addLine(h, line, histSize(sh));
  const path = histFile(sh);
  if (path !== null) {
    try {
      yield* writeWhole(sh, path, `${escapeHistLine(line)}\n`, { flags: 'a' });
      h.fileLines++;
      if (h.fileLines > HISTFILE_MAX_LINES) yield* rewriteFile(sh, path);
    } catch (e) {
      // History is a convenience: a full disk or a read-only home must not break the shell.
      if (errnoOf(e) === undefined) throw e;
    }
  }
  yield* quietly(sh.sys.call('complete.hist.add', { line }));
}

/** Keeps the last HISTSIZE lines of the shared file (other shells may have appended to it). */
function* rewriteFile(sh: Sh, path: string): SysGen<void> {
  const text = yield* readFileText(sh, path);
  const lines = splitFile(text ?? '');
  const keep = lines.slice(Math.max(0, lines.length - HISTSIZE_DEFAULT));
  yield* writeWhole(sh, path, keep.map((l) => `${l}\n`).join(''), { flags: 'w', trunc: true });
  sh.st.hist.fileLines = keep.length;
}

/** `history -c`: the list, the file and this uid's `hist` namespace (I-SH5). */
export function* clearHistory(sh: Sh): SysGen<number> {
  const h = sh.st.hist;
  h.lines = [];
  h.first = 1;
  h.fileLines = 0;
  const path = histFile(sh);
  let status = 0;
  if (path !== null) {
    try {
      yield* sh.sys.call('truncate', { path, size: 0 });
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === undefined) throw e;
      if (errno !== 'ENOENT') status = 1;
    }
  }
  yield* quietly(sh.sys.call('complete.hist.clear', {}));
  return status;
}

/** The completion service is optional (SHL-17): its failures only cost completion quality. */
function* quietly(call: SysGen<unknown>): SysGen<void> {
  try {
    yield* call;
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
}
