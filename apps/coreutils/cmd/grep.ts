/**
 * `grep [-i] [-v] [-n] [-c] [-l] [-r] [-F] [-w] [-H | -h] [-e PATTERN]... [PATTERN] [FILE...]`
 * (shell-and-terminal.md §3.14.21). ECMAScript regular expressions with the `u` flag, evaluated in
 * this process (the kernel never runs a user regular expression). Status: 0 a line was selected,
 * 1 none, 2 on any error.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import { escapeName } from '../lib/format.ts';
import { listDir, tryStat } from '../lib/fs.ts';
import type { Io } from '../lib/io.ts';
import { join } from '../lib/path.ts';
import type { SysGen } from '../lib/sys.ts';

export interface GrepOpts {
  readonly ignoreCase: boolean;
  readonly invert: boolean;
  readonly number: boolean;
  readonly count: boolean;
  readonly list: boolean;
  readonly recursive: boolean;
  readonly fixed: boolean;
  readonly word: boolean;
  readonly withName: boolean | null;
  readonly patterns: readonly string[];
  readonly files: readonly string[];
}

const CHUNK = 65_536;
const BINARY_PROBE = 8_192;
const RED = '\x1b[1;31m';
const RESET = '\x1b[0m';

/** One regular expression for all patterns; throws SyntaxError for an invalid one. */
export function compile(
  opts: Pick<GrepOpts, 'patterns' | 'fixed' | 'word' | 'ignoreCase'>,
): RegExp {
  const parts = opts.patterns.map((p) => {
    const body = opts.fixed ? p.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&') : p;
    return opts.word ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : `(?:${body})`;
  });
  return new RegExp(parts.join('|'), `gu${opts.ignoreCase ? 'i' : ''}`);
}

export function matches(re: RegExp, line: string): boolean {
  re.lastIndex = 0;
  return re.test(line);
}

/** Wraps every non-empty match in bold red. */
export function highlight(re: RegExp, line: string): string {
  re.lastIndex = 0;
  return line.replace(re, (m) => (m.length === 0 ? m : `${RED}${m}${RESET}`));
}

interface Scan {
  selected: number;
  binary: boolean;
}

/** Output settings fixed for the whole run. */
interface Out {
  readonly re: RegExp;
  readonly opts: GrepOpts;
  readonly tty: boolean;
  readonly withName: boolean;
}

function* emit(io: Io, out: Out, name: string, lineNo: number, line: string): SysGen<void> {
  const prefix = `${out.withName ? `${escapeName(name, out.tty)}:` : ''}${out.opts.number ? `${lineNo}:` : ''}`;
  const text = out.tty && !out.opts.invert ? highlight(out.re, line) : line;
  yield* io.line(prefix + text);
}

/** Reads `fd` line by line, printing selected lines unless counting, listing or binary. */
function* scanFd(io: Io, out: Out, fd: number, name: string): SysGen<Scan> {
  const decoder = new TextDecoder();
  const scan: Scan = { selected: 0, binary: false };
  let pending = '';
  let lineNo = 0;
  let first = true;
  const quiet = (): boolean => out.opts.count || out.opts.list || scan.binary;
  for (;;) {
    const buf = yield* io.sys.call('read', { fd, len: CHUNK });
    const bytes = new Uint8Array(buf);
    if (first) {
      scan.binary = bytes.subarray(0, BINARY_PROBE).includes(0);
      first = false;
    }
    const done = bytes.length === 0;
    pending += decoder.decode(bytes, { stream: !done });
    const lines = pending.split('\n');
    pending = done ? '' : (lines.pop() ?? '');
    if (done && lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      lineNo += 1;
      if (matches(out.re, line) === out.opts.invert) continue;
      scan.selected += 1;
      if (out.opts.list) return scan;
      if (!quiet()) yield* emit(io, out, name, lineNo, line);
    }
    if (done) return scan;
  }
}

function* grepFile(io: Io, out: Out, path: string): SysGen<number> {
  let fd: number | null = null;
  let scan: Scan;
  try {
    fd = path === '-' ? 0 : (yield* io.sys.call('open', { path, flags: 'r' })).fd;
    scan = yield* scanFd(io, out, fd, path === '-' ? '(standard input)' : path);
  } finally {
    if (fd !== null && fd !== 0) yield* io.sys.call('close', { fd });
  }
  const name = escapeName(path === '-' ? '(standard input)' : path, out.tty);
  if (out.opts.count) yield* io.line(`${out.withName ? `${name}:` : ''}${scan.selected}`);
  else if (out.opts.list && scan.selected > 0) yield* io.line(name);
  else if (scan.binary && scan.selected > 0) yield* io.line(`Binary file ${name} matches`);
  return scan.selected;
}

/** Every regular file below `dir`; symlinks inside the walk are not followed. */
function* walkFiles(io: Io, dir: string, out: string[], errors: string[]): SysGen<void> {
  let entries;
  try {
    entries = yield* listDir(io.sys, dir, false);
  } catch (e) {
    errors.push(`${dir}: ${describe(e)}`);
    return;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.type === 'd') yield* walkFiles(io, path, out, errors);
    else if (e.type === 'f') out.push(path);
  }
}

export default defineCommand<GrepOpts>({
  name: 'grep',
  parse(args) {
    const p = parseFor('grep', args);
    const operands = [...p.operands];
    const patterns = p.has('e') ? p.values('e') : operands.splice(0, 1);
    if (patterns.length === 0) throw new UsageError('no pattern given');
    return {
      ignoreCase: p.has('i'),
      invert: p.has('v'),
      number: p.has('n'),
      count: p.has('c'),
      list: p.has('l'),
      recursive: p.has('r'),
      fixed: p.has('F'),
      word: p.has('w'),
      withName: p.has('H') ? true : p.has('h') ? false : null,
      patterns,
      files: operands,
    };
  },
  *run(io, opts) {
    let re: RegExp;
    try {
      re = compile(opts);
    } catch (e) {
      yield* io.error(`invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    const files = opts.files.length > 0 ? opts.files : [opts.recursive ? '.' : '-'];
    const out: Out = {
      re,
      opts,
      tty: yield* io.isTty(1),
      withName: opts.withName ?? (files.length > 1 || opts.recursive),
    };
    let selected = 0;
    let error = false;
    for (const file of files) {
      try {
        const st = file === '-' ? null : yield* tryStat(io.sys, file, true);
        if (st !== null && !st.ok) throw st.error;
        if (st?.ok === true && st.stat.type === 'd') {
          if (!opts.recursive) {
            yield* io.error(`${file}: Is a directory`);
            error = true;
            continue;
          }
          const found: string[] = [];
          const errors: string[] = [];
          yield* walkFiles(io, file, found, errors);
          for (const path of found) selected += yield* grepFile(io, out, path);
          for (const message of errors) yield* io.error(message);
          error ||= errors.length > 0;
          continue;
        }
        selected += yield* grepFile(io, out, file);
      } catch (e) {
        mustErrno(e);
        yield* io.error(`${file}: ${describe(e)}`);
        error = true;
      }
    }
    return error ? 2 : selected > 0 ? 0 : 1;
  },
});
