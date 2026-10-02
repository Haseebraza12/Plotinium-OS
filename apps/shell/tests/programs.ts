/**
 * Test-double programs for the fake kernel: tiny stand-ins for coreutils (the real ones are
 * another package's work) written against the same program model and system calls.
 */
import type { Program, ProgramContext, SysGen } from '../../src/_sys.ts';
import { errnoOf, readAllText, writeText } from '../../src/_sys.ts';

interface Args {
  argv: string[];
}

function simple(body: (ctx: ProgramContext, argv: string[]) => SysGen<number>): Program<Args> {
  return {
    init: (argv) => ({ argv: [...argv] }),
    run: (ctx, st) => body(ctx, st.argv),
  };
}

function* readInput(ctx: ProgramContext, path: string | undefined): SysGen<string | null> {
  if (path === undefined || path === '-') return yield* readAllText(ctx.sys, 0);
  try {
    const { fd } = yield* ctx.sys.call('open', { path, flags: 'r' });
    const text = yield* readAllText(ctx.sys, fd);
    yield* ctx.sys.call('close', { fd });
    return text;
  } catch (e) {
    const errno = errnoOf(e);
    if (errno === undefined) throw e;
    yield* writeText(ctx.sys, 2, `${path}: ${errno}\n`);
    return null;
  }
}

/** `cat [FILE...]`. */
export const cat = simple(function* (ctx, argv) {
  const files = argv.length > 1 ? argv.slice(1) : [undefined];
  let status = 0;
  for (const f of files) {
    const text = yield* readInput(ctx, f);
    if (text === null) status = 1;
    else yield* writeText(ctx.sys, 1, text);
  }
  return status;
});

/** `grep [-c] TEXT [FILE]`: substring match; 1 when nothing matches. */
export const grep = simple(function* (ctx, argv) {
  const count = argv[1] === '-c';
  const args = argv.slice(count ? 2 : 1);
  const text = (yield* readInput(ctx, args[1])) ?? '';
  const hits = text
    .split('\n')
    .filter((l, i, a) => !(i === a.length - 1 && l === '') && l.includes(args[0] ?? ''));
  yield* writeText(ctx.sys, 1, count ? `${hits.length}\n` : hits.map((l) => `${l}\n`).join(''));
  return hits.length > 0 ? 0 : 1;
});

/** `args WORD...`: prints each argument in brackets, to check expansion. */
export const args = simple(function* (ctx, argv) {
  yield* writeText(
    ctx.sys,
    1,
    `${argv
      .slice(1)
      .map((a) => `[${a}]`)
      .join('')}\n`,
  );
  return 0;
});

/** `printenv NAME`: 1 when unset. */
export const printenv = simple(function* (ctx, argv) {
  const v = ctx.env.get(argv[1] ?? '');
  if (v === undefined) return 1;
  yield* writeText(ctx.sys, 1, `${v}\n`);
  return 0;
});

/** `sleep N`: sleeps N seconds of the virtual clock. */
export const sleep = simple(function* (ctx, argv) {
  yield* ctx.sys.call('sleep', { ms: Number(argv[1] ?? '1') * 1000 });
  return 0;
});

/** `top`: runs until signalled. */
export const top = simple(function* (ctx) {
  for (;;) yield* ctx.sys.call('sleep', { ms: 1000 });
});

/** `yes`: writes `y` lines until its reader goes away (SIGPIPE ends it). */
export const yes = simple(function* (ctx) {
  for (;;) yield* writeText(ctx.sys, 1, 'y\n');
});

/** `head -n N`: the first N lines of stdin. */
export const head = simple(function* (ctx, argv) {
  const n = Number(argv[2] ?? '10');
  let got = '';
  let lines = 0;
  while (lines < n) {
    const buf = yield* ctx.sys.call('read', { fd: 0, len: 4096 });
    if (buf.byteLength === 0) break;
    got += new TextDecoder().decode(buf);
    lines = got.split('\n').length - 1;
  }
  yield* writeText(
    ctx.sys,
    1,
    got
      .split('\n')
      .slice(0, n)
      .map((l) => `${l}\n`)
      .join(''),
  );
  return 0;
});

/** `status N [SECS]`: exits with N, after sleeping SECS seconds when given. */
export const status = simple(function* (ctx, argv) {
  yield ctx.tick;
  if (argv[2] !== undefined) yield* ctx.sys.call('sleep', { ms: Number(argv[2]) * 1000 });
  return Number(argv[1] ?? '0');
});

/** `readtty`: reads one line from the terminal and echoes it. */
export const readtty = simple(function* (ctx) {
  const buf = yield* ctx.sys.call('read', { fd: 0, len: 4096 });
  yield* writeText(ctx.sys, 1, `got:${new TextDecoder().decode(buf)}`);
  return 0;
});

/** `echo` as a /bin program, for builtins that run as programs inside pipelines. */
export const echoProgram = simple(function* (ctx, argv) {
  yield* writeText(ctx.sys, 1, `${argv.slice(1).join(' ')}\n`);
  return 0;
});
