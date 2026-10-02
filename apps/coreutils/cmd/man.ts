/**
 * `man [SECTION] NAME`, `man -k KEYWORD`, `man -f NAME` (shell-and-terminal.md §3.12, §3.14.45).
 * Pages are the read-only seeds under /usr/share/man; on a terminal a page longer than the screen
 * opens the built-in pager on the alternate screen.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { mustErrno } from '../lib/errors.ts';
import type { Io } from '../lib/io.ts';
import { renderMarkdown } from '../lib/markdown.ts';
import { decodeText } from '../lib/sys.ts';
import type { SysGen } from '../lib/sys.ts';

export interface ManOpts {
  readonly mode: 'page' | 'apropos' | 'whatis';
  readonly section: '1' | '2' | null;
  readonly name: string;
}

export interface IndexEntry {
  readonly name: string;
  readonly section: number;
  readonly summary: string;
}

const MAN_ROOT = '/usr/share/man';

function* readFile(io: Io, path: string): SysGen<string> {
  const { fd } = yield* io.sys.call('open', { path, flags: 'r' });
  const parts: string[] = [];
  try {
    for (;;) {
      const buf = yield* io.sys.call('read', { fd, len: 65_536 });
      if (buf.byteLength === 0) break;
      parts.push(decodeText(buf));
    }
  } finally {
    yield* io.sys.call('close', { fd });
  }
  return parts.join('');
}

export function parseIndex(text: string): IndexEntry[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) return [];
  return data.filter(
    (e): e is IndexEntry =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as IndexEntry).name === 'string' &&
      typeof (e as IndexEntry).summary === 'string',
  );
}

export function whatisLine(e: IndexEntry): string {
  return `${e.name} (${e.section}) - ${e.summary}`;
}

export function apropos(entries: readonly IndexEntry[], keyword: string): string[] {
  const k = keyword.toLowerCase();
  return entries
    .filter((e) => e.name.toLowerCase().includes(k) || e.summary.toLowerCase().includes(k))
    .map(whatisLine);
}

/** The footer: the version right-aligned (identity spec §3.10 row 15). */
export function footer(version: string, columns: number): string {
  const text = `Plotinium ${version}`;
  return text.padStart(Math.max(text.length, columns));
}

// ---------------------------------------------------------------------------------------------
// Pager
// ---------------------------------------------------------------------------------------------

export type PagerAction =
  | { readonly k: 'move'; readonly by: number }
  | { readonly k: 'page'; readonly by: number }
  | { readonly k: 'top' }
  | { readonly k: 'bottom' }
  | { readonly k: 'search' }
  | { readonly k: 'next' }
  | { readonly k: 'quit' }
  | { readonly k: 'none' };

export function keyAction(key: string): PagerAction {
  switch (key) {
    case ' ':
    case '\x1b[6~':
    case 'f':
      return { k: 'page', by: 1 };
    case 'b':
    case '\x1b[5~':
      return { k: 'page', by: -1 };
    case 'j':
    case '\r':
    case '\n':
    case '\x1b[B':
      return { k: 'move', by: 1 };
    case 'k':
    case '\x1b[A':
      return { k: 'move', by: -1 };
    case 'g':
    case '\x1b[H':
      return { k: 'top' };
    case 'G':
    case '\x1b[F':
      return { k: 'bottom' };
    case '/':
      return { k: 'search' };
    case 'n':
      return { k: 'next' };
    case 'q':
    case 'Q':
    case '\x03':
      return { k: 'quit' };
    default:
      return { k: 'none' };
  }
}

/** The first line at or after `from` containing `term` (visible text), or -1. */
export function findLine(lines: readonly string[], term: string, from: number): number {
  if (term === '') return -1;
  // eslint-disable-next-line no-control-regex -- matching our own SGR sequences
  const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').toLowerCase();
  for (let i = Math.max(0, from); i < lines.length; i++)
    if (plain(lines[i] ?? '').includes(term.toLowerCase())) return i;
  return -1;
}

/** One read may carry several keys (typed ahead or pasted): split into keys and CSI sequences. */
export function splitKeys(text: string): string[] {
  // eslint-disable-next-line no-control-regex -- terminal escape sequences
  return text.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g) ?? [];
}

/** Buffered keyboard input on fd 0; end of input reads as `q`. */
class Keys {
  private pending: string[] = [];
  private readonly io: Io;

  constructor(io: Io) {
    this.io = io;
  }

  *next(): SysGen<string> {
    while (this.pending.length === 0) {
      const buf = yield* this.io.sys.call('read', { fd: 0, len: 64 });
      if (buf.byteLength === 0) return 'q';
      this.pending = splitKeys(decodeText(buf));
    }
    return this.pending.shift() ?? 'q';
  }
}

function* readSearch(io: Io, keys: Keys, rows: number): SysGen<string> {
  let term = '';
  yield* io.write(1, `\x1b[${rows};1H\x1b[2K/`);
  for (;;) {
    const key = yield* keys.next();
    if (key === '\r' || key === '\n') return term;
    if (key === '\x1b' || key === '\x03') return '';
    if (key === '\x7f') term = term.slice(0, -1);
    else if (!key.startsWith('\x1b')) term += key;
    yield* io.write(1, `\x1b[${rows};1H\x1b[2K/${term}`);
  }
}

function* pager(io: Io, lines: readonly string[], rows: number): SysGen<void> {
  const height = Math.max(1, rows - 1);
  const last = Math.max(0, lines.length - height);
  let top = 0;
  let term = '';
  const keys = new Keys(io);
  const saved = yield* io.sys.call('tty.getattr', { fd: 0 });
  yield* io.sys.call('tty.setattr', { fd: 0, canonical: false, echo: false, altScreen: true });
  try {
    for (;;) {
      const status = top >= last ? '(END)' : ':';
      yield* io.write(
        1,
        `\x1b[H\x1b[2J${lines.slice(top, top + height).join('\r\n')}\x1b[${rows};1H${status}`,
      );
      const action = keyAction(yield* keys.next());
      if (action.k === 'quit') return;
      if (action.k === 'move') top += action.by;
      else if (action.k === 'page') top += action.by * height;
      else if (action.k === 'top') top = 0;
      else if (action.k === 'bottom') top = last;
      else if (action.k === 'search' || action.k === 'next') {
        if (action.k === 'search') term = yield* readSearch(io, keys, rows);
        const hit = findLine(lines, term, action.k === 'next' ? top + 1 : top);
        if (hit !== -1) top = hit;
      }
      top = Math.min(last, Math.max(0, top));
    }
  } finally {
    yield* io.sys.call('tty.setattr', {
      fd: 0,
      canonical: saved.canonical,
      echo: saved.echo,
      altScreen: saved.altScreen,
    });
  }
}

function* version(io: Io): SysGen<string> {
  try {
    return (yield* io.sys.call('uname', {})).version;
  } catch {
    return '';
  }
}

export default defineCommand<ManOpts>({
  name: 'man',
  parse(args) {
    const p = parseFor('man', args);
    const ops = [...p.operands];
    if (p.has('k') || p.has('f')) {
      if (ops.length !== 1) throw new UsageError(p.has('k') ? 'apropos what?' : 'whatis what?');
      return { mode: p.has('k') ? 'apropos' : 'whatis', section: null, name: ops[0] ?? '' };
    }
    let section: '1' | '2' | null = null;
    if (ops.length === 2 && (ops[0] === '1' || ops[0] === '2'))
      section = ops.shift() === '1' ? '1' : '2';
    if (ops.length !== 1)
      throw new UsageError(
        ops.length === 0 ? 'What manual page do you want?' : `extra operand '${ops[1] ?? ''}'`,
      );
    return { mode: 'page', section, name: ops[0] ?? '' };
  },
  *run(io, opts) {
    if (opts.mode !== 'page') {
      let entries: IndexEntry[];
      try {
        entries = parseIndex(yield* readFile(io, `${MAN_ROOT}/index.json`));
      } catch (e) {
        if (e instanceof SyntaxError) entries = [];
        else {
          mustErrno(e);
          entries = [];
        }
      }
      const found =
        opts.mode === 'apropos'
          ? apropos(entries, opts.name)
          : entries.filter((e) => e.name === opts.name).map(whatisLine);
      if (found.length === 0) {
        yield* io.error(
          opts.mode === 'apropos'
            ? `${opts.name}: nothing appropriate`
            : `no manual entry for ${opts.name}`,
        );
        return 1;
      }
      yield* io.lines(found);
      return 0;
    }
    if (opts.name.includes('/')) {
      yield* io.error(`no manual entry for ${opts.name}`);
      return 1;
    }
    let source: string | null = null;
    for (const section of opts.section === null ? ['1', '2'] : [opts.section]) {
      try {
        source = yield* readFile(io, `${MAN_ROOT}/${section}/${opts.name}.md`);
        break;
      } catch (e) {
        mustErrno(e);
      }
    }
    if (source === null) {
      yield* io.error(`no manual entry for ${opts.name}`);
      return 1;
    }
    const tty = yield* io.isTty(1);
    const cols = yield* io.columns();
    const lines = [...renderMarkdown(source, cols, tty), '', footer(yield* version(io), cols)];
    const rows = yield* io.rows();
    if (tty && lines.length > rows - 1) yield* pager(io, lines, rows);
    else yield* io.lines(lines);
    return 0;
  },
});
