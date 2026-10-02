/**
 * Small programs the Terminal bundles because the SYS-02 scripted session needs them and
 * apps/coreutils does not provide them yet (shell-and-terminal.md §3.14.53 "Additional commands"):
 * `sleep`, `head` and `clear`, and `complete` (§3.14.52), which `help` lists. When coreutils ships
 * its own, the registry prefers those (host/programs.ts). TODO(R3): move them to apps/coreutils
 * with man pages (SHL-12); `complete` also needs the kernel to route the `complete.*` calls.
 */
import { completionContext } from '../../shell/complete.ts';
import type {
  CompleteItem,
  CompleteQuery,
  Program,
  ProgramContext,
  SysGen,
} from '../../src/_sys.ts';
import { decodeText, encodeText, errnoOf, errText } from '../../src/_sys.ts';

function* say(ctx: ProgramContext, fd: number, text: string): SysGen<void> {
  try {
    yield* ctx.sys.call('write', { fd, data: encodeText(text) });
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// sleep NUMBER[SUFFIX]...
// ---------------------------------------------------------------------------------------------

const UNIT_MS: Readonly<Record<string, number>> = {
  '': 1_000,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses `sleep` operands into milliseconds, or an error message. */
export function sleepMs(args: readonly string[]): number | string {
  if (args.length === 0) return 'sleep: missing operand';
  let total = 0;
  for (const a of args) {
    const m = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(a);
    if (m === null) return `sleep: invalid time interval '${a}'`;
    total += Number(m[1]) * (UNIT_MS[m[2] ?? ''] ?? 1_000);
  }
  return Math.min(Math.round(total), 2_147_483_647);
}

interface SleepState {
  ms: number | string;
  left: number | null;
}

export const sleep: Program<SleepState> = {
  init: (argv) => ({ ms: sleepMs(argv.slice(1)), left: null }),
  *run(ctx, st): SysGen<number> {
    if (typeof st.ms === 'string') {
      yield* say(ctx, 2, `${st.ms}\n`);
      return 1;
    }
    st.left ??= st.ms;
    while (st.left > 0) {
      const chunk = Math.min(st.left, 60_000);
      const start = ctx.now();
      try {
        yield* ctx.sys.call('sleep', { ms: chunk });
        st.left -= chunk;
      } catch (e) {
        // A caught signal interrupts the sleep; carry on with what is left.
        if (errnoOf(e) !== 'ECANCELED') throw e;
        st.left -= Math.max(0, ctx.now() - start);
      }
    }
    return 0;
  },
};

// ---------------------------------------------------------------------------------------------
// head [-n N | -N] [-c N] [FILE...]
// ---------------------------------------------------------------------------------------------

export interface HeadOpts {
  lines: number;
  bytes: number | null;
  files: string[];
}

export function parseHead(args: readonly string[]): HeadOpts | string {
  const opts: HeadOpts = { lines: 10, bytes: null, files: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const count = (v: string | undefined): number | string =>
      v !== undefined && /^\d+$/.test(v)
        ? Number(v)
        : `head: invalid number of lines: '${v ?? ''}'`;
    if (a === '-n' || a === '-c') {
      const n = count(args[++i]);
      if (typeof n === 'string') return n;
      if (a === '-n') opts.lines = n;
      else opts.bytes = n;
    } else if (/^-n\d+$/.test(a)) opts.lines = Number(a.slice(2));
    else if (/^-\d+$/.test(a)) opts.lines = Number(a.slice(1));
    else if (a === '--') opts.files.push(...args.slice(i + 1));
    else if (a.startsWith('-') && a !== '-') return `head: invalid option -- '${a.slice(1, 2)}'`;
    else opts.files.push(a);
    if (a === '--') break;
  }
  return opts;
}

/** The first `lines` lines (or `bytes` bytes) of `text`. */
export function headOf(text: string, opts: Pick<HeadOpts, 'lines' | 'bytes'>): string {
  if (opts.bytes !== null) return decodeText(encodeText(text).slice(0, opts.bytes));
  if (opts.lines === 0) return '';
  let end = -1;
  for (let n = 0; n < opts.lines; n++) {
    end = text.indexOf('\n', end + 1);
    if (end < 0) return text;
  }
  return text.slice(0, end + 1);
}

interface HeadState {
  opts: HeadOpts | string;
}

function* headFd(ctx: ProgramContext, fd: number, opts: HeadOpts): SysGen<void> {
  let text = '';
  const want = (): boolean =>
    opts.bytes !== null
      ? encodeText(text).byteLength < opts.bytes
      : text.split('\n').length - 1 < opts.lines;
  while (want()) {
    const buf = yield* ctx.sys.call('read', { fd, len: 65_536 });
    if (buf.byteLength === 0) break;
    text += decodeText(buf);
  }
  yield* ctx.sys.call('write', { fd: 1, data: encodeText(headOf(text, opts)) });
}

export const head: Program<HeadState> = {
  init: (argv) => ({ opts: parseHead(argv.slice(1)) }),
  *run(ctx, st): SysGen<number> {
    const opts = st.opts;
    if (typeof opts === 'string') {
      yield* say(ctx, 2, `${opts}\nUsage: head [-n N] [-c N] [FILE...]\n`);
      return 2;
    }
    const files = opts.files.length === 0 ? ['-'] : opts.files;
    let status = 0;
    try {
      for (const [i, file] of files.entries()) {
        if (files.length > 1) yield* say(ctx, 1, `${i > 0 ? '\n' : ''}==> ${file} <==\n`);
        if (file === '-') {
          yield* headFd(ctx, 0, opts);
          continue;
        }
        let fd: number;
        try {
          fd = (yield* ctx.sys.call('open', { path: file, flags: 'r' })).fd;
        } catch (e) {
          yield* say(ctx, 2, `head: cannot open '${file}' for reading: ${errText(e)}\n`);
          status = 1;
          continue;
        }
        try {
          yield* headFd(ctx, fd, opts);
        } finally {
          yield* ctx.sys.call('close', { fd });
        }
      }
    } catch (e) {
      if (errnoOf(e) === 'EPIPE') return 141;
      throw e;
    }
    return status;
  },
};

// ---------------------------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------------------------

export const clear: Program<null> = {
  init: () => null,
  *run(ctx): SysGen<number> {
    yield* say(ctx, 1, '\x1b[H\x1b[2J\x1b[3J');
    return 0;
  },
};

// ---------------------------------------------------------------------------------------------
// complete --line TEXT | --stats | --bench [...]   (shell-and-terminal.md §3.14.52; UI-123)
// ---------------------------------------------------------------------------------------------

export type CompleteCmd =
  | { readonly mode: 'line'; readonly text: string }
  | { readonly mode: 'stats' }
  | { readonly mode: 'bench'; readonly args: readonly string[] }
  | { readonly mode: 'usage'; readonly problem: string };

const COMPLETE_USAGE =
  'Usage: complete --bench [--ns path|cmd|flag|hist] [--dir DIR | --synthetic N] [--queries Q] [--k K] [--seed S]\n' +
  '       complete --stats\n' +
  '       complete --line TEXT\n';

export function parseComplete(args: readonly string[]): CompleteCmd {
  const first = args[0];
  if (first === '--line') {
    if (args.length !== 2) return { mode: 'usage', problem: '--line takes one TEXT' };
    return { mode: 'line', text: args[1] ?? '' };
  }
  if (first === '--stats') {
    return args.length === 1
      ? { mode: 'stats' }
      : { mode: 'usage', problem: `extra operand '${args[1] ?? ''}'` };
  }
  if (first === '--bench') return { mode: 'bench', args: args.slice(1) };
  return {
    mode: 'usage',
    problem: first === undefined ? 'missing option' : `unrecognized option '${first}'`,
  };
}

/** One candidate as the shell's listing shows it: `dir/`, a flag with its text, or a name. */
export function candidateLine(item: CompleteItem): string {
  if (item.kind === 'd') return `${item.text}/`;
  if (item.kind === 'flag' && item.desc !== undefined) return `${item.text}  ${item.desc}`;
  return item.text;
}

function* lineCandidates(ctx: ProgramContext, text: string): SysGen<CompleteItem[]> {
  const where = completionContext(text, text.length);
  const value = where.value;
  if (where.where.ns === 'var') {
    const prefix = value.replace(/^\$\{?/, '');
    return [...ctx.env.keys()]
      .filter((n) => n.startsWith(prefix))
      .map((t) => ({ text: t, kind: 'f' }));
  }
  const slash = value.lastIndexOf('/');
  const base = slash < 0 ? value : value.slice(slash + 1);
  let query: CompleteQuery;
  if (where.where.ns === 'path') {
    const home = ctx.env.get('HOME') ?? '/';
    let dir = slash < 0 ? '' : value.slice(0, slash + 1);
    if (dir.startsWith('~/')) dir = `${home}/${dir.slice(2)}`;
    if (dir === '') dir = ctx.cwd;
    else if (!dir.startsWith('/')) dir = `${ctx.cwd === '/' ? '' : ctx.cwd}/${dir}`;
    if (dir.length > 1 && dir.endsWith('/')) dir = dir.slice(0, -1);
    query = { ns: 'path', prefix: base, dir };
  } else if (where.where.ns === 'flag') {
    query = { ns: 'flag', prefix: value, cmd: where.where.cmd };
  } else {
    query = { ns: 'cmd', prefix: value };
  }
  return (yield* ctx.sys.call('complete.query', query)).items;
}

interface UntypedSys {
  call(name: string, args: unknown): SysGen<unknown>;
}

export const complete: Program<CompleteCmd> = {
  init: (argv) => parseComplete(argv.slice(1)),
  *run(ctx, st): SysGen<number> {
    if (st.mode === 'usage') {
      yield* say(ctx, 2, `complete: ${st.problem}\n${COMPLETE_USAGE}Try 'help complete'.\n`);
      return 2;
    }
    if (st.mode === 'line') {
      let items: CompleteItem[];
      try {
        items = yield* lineCandidates(ctx, st.text);
      } catch (e) {
        if (errnoOf(e) === undefined) throw e;
        yield* say(ctx, 2, `complete: ${errText(e)}\n`);
        return 1;
      }
      const lines = items.map(candidateLine).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (lines.length > 0) yield* say(ctx, 1, `${lines.join('\n')}\n`);
      return lines.length > 0 ? 0 : 1;
    }
    // The statistics and the benchmark run inside the `complete` service, whose calls the kernel
    // does not route yet (requested in shell-and-terminal.md §4.8): say so instead of guessing.
    const call = st.mode === 'stats' ? 'complete.stats' : 'complete.bench';
    try {
      const res = yield* (ctx.sys as unknown as UntypedSys).call(
        call,
        st.mode === 'stats' ? {} : { queries: 10_000 },
      );
      yield* say(ctx, 1, `${JSON.stringify(res)}\n`);
      return 0;
    } catch (e) {
      if (errnoOf(e) !== 'ENOSYS') throw e;
      yield* say(
        ctx,
        2,
        `complete: --${st.mode}: the completion service is not reachable from this terminal yet (${call} is not wired); Tab completion still works\n`,
      );
      return 1;
    }
  },
};
