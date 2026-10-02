/**
 * The `sh` program (shell-and-terminal.md §3.4): `init(argv)` builds the serialisable state,
 * `run(ctx, st)` starts up once and then runs the interactive loop, a `-c` command, a script or
 * standard input. `run` may be re-entered from the top after a page-in; everything it needs to
 * continue is in `st` (processes-and-scheduling.md §3.5.1 rule 4).
 *
 * Usage: `sh [-il] [-c COMMAND [NAME [ARG...]] | FILE [ARG...]]`; `argv[0]` starting with `-`
 * marks a login shell.
 */
import type { SignalName } from '@plotinium/protocol';

import type { Program, ProgramContext, SysGen } from '../src/_sys.ts';
import { errnoOf, readAllText } from '../src/_sys.ts';
import { assign } from './env.ts';
import { prepareSource, runCursor } from './exec.ts';
import { banner } from './builtins/help.ts';
import { loadHistory } from './history.ts';
import { DEFAULT_PS2, defaultPs1 } from './prompt.ts';
import { interactive } from './repl.ts';
import type { Sh, ShellState } from './state.ts';
import { DEFAULT_VERSION, err, newState, put } from './state.ts';
import { getVar, isName, setVar } from './vars.ts';
import { getMode, giveTty } from './wait.ts';

/** Parses the shell's own arguments (no system calls: `init` must stay pure). */
export function initShell(argv: readonly string[]): ShellState {
  const st = newState(argv);
  const arg0 = argv[0] ?? 'sh';
  st.login = arg0.startsWith('-');
  st.name = st.login ? arg0.slice(1) : arg0;
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-c') {
      st.mode = 'command';
      st.command = argv[i + 1] ?? '';
      const rest = argv.slice(i + 2);
      if (rest.length > 0) st.name = rest[0] ?? st.name;
      st.positional = rest.slice(1);
      return st;
    }
    if (a === '-i') st.forceInteractive = true;
    else if (a === '-l' || a === '--login') st.login = true;
    else break;
  }
  const script = argv[i];
  if (script !== undefined) {
    st.mode = 'script';
    st.scriptPath = script;
    st.name = script;
    st.positional = argv.slice(i + 1);
  }
  return st;
}

/** Inherited environment variables are exported shell variables (pure). */
function importEnv(st: ShellState, env: ReadonlyMap<string, string>): void {
  env.forEach((value, name) => {
    if (isName(name)) setVar(st.vars, name, value, { export: true });
  });
}

function* quiet<T>(call: SysGen<T>): SysGen<T | null> {
  try {
    return yield* call;
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
    return null;
  }
}

/** Sets a variable unless it is already set (inherited values win in a non-login shell). */
function dflt(sh: Sh, name: string, value: string, exported = true): void {
  if (getVar(sh.st.vars, name) === undefined) assign(sh, name, value, { export: exported });
}

/** The environment of §3.4. */
function* buildEnv(sh: Sh): SysGen<void> {
  const st = sh.st;
  const cred = yield* quiet(sh.sys.call('proc.cred', {}));
  if (cred !== null) {
    const home = cred.uid === 0 ? '/root' : cred.home;
    for (const [name, value] of [
      ['HOME', home],
      ['USER', cred.user],
      ['LOGNAME', cred.user],
    ] as const) {
      if (st.login) assign(sh, name, value, { export: true });
      else dflt(sh, name, value);
      yield sh.tick;
    }
  }
  setVar(st.vars, 'UID', String(st.uid), { readonly: true });
  dflt(sh, 'PATH', '/bin');
  dflt(sh, 'SHELL', '/bin/sh');
  dflt(sh, 'HOSTNAME', 'plotinium');
  dflt(sh, 'LANG', 'C.UTF-8');
  if (st.mode === 'interactive') dflt(sh, 'TERM', 'xterm-256color');
  const now = yield* quiet(sh.sys.call('time.now', {}));
  if (now !== null) dflt(sh, 'TZ', now.tz);
  const home = getVar(st.vars, 'HOME');
  if (home !== undefined) dflt(sh, 'HISTFILE', `${home === '/' ? '' : home}/.sh_history`);
  dflt(sh, 'HISTSIZE', '1000');
  dflt(sh, 'PS1', defaultPs1(st.uid), false);
  dflt(sh, 'PS2', DEFAULT_PS2, false);
  if (st.login && home !== undefined) yield* quiet(sh.sys.call('chdir', { path: home }));
  const cwd = yield* quiet(sh.sys.call('getcwd', {}));
  if (cwd !== null) assign(sh, 'PWD', cwd.path, { export: true });
}

/**
 * §3.4 step 1 ignores SIGINT for the shell itself. Catching it instead has the same effect on the
 * shell (the hook only sets a flag) and also interrupts a blocking `wait` builtin, which §3.8
 * requires ("Ctrl-C interrupts the wait").
 */
const CAUGHT: readonly SignalName[] = ['SIGINT', 'SIGWINCH'];
const IGNORED: readonly SignalName[] = ['SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGQUIT'];

/** §3.4 start-up: steps 1–4 for an interactive shell, step 2 only otherwise. */
function* startup(sh: Sh, ctx: ProgramContext): SysGen<void> {
  const st = sh.st;
  st.pid = ctx.pid;
  st.pgid = ctx.pgid;
  st.uid = ctx.uid;
  importEnv(st, ctx.env);
  if (st.mode === 'stdin') {
    const tty = yield* quiet(sh.sys.call('isatty', { fd: 0 }));
    if (tty?.tty === true || st.forceInteractive) st.mode = 'interactive';
  }
  if (st.mode === 'interactive') {
    for (const sig of CAUGHT) yield* quiet(sh.sys.call('sig.action', { sig, action: 'catch' }));
    for (const sig of IGNORED) yield* quiet(sh.sys.call('sig.action', { sig, action: 'ignore' }));
    yield* giveTty(sh, st.pgid);
    st.ttyMode = yield* getMode(sh);
    const attr = yield* quiet(sh.sys.call('tty.getattr', { fd: 0 }));
    if (attr !== null) {
      setVar(st.vars, 'COLUMNS', String(attr.cols), { export: true });
      setVar(st.vars, 'LINES', String(attr.rows), { export: true });
    }
  }
  yield* buildEnv(sh);
  if (st.mode !== 'interactive') return;
  yield* loadHistory(sh);
  const uname = yield* quiet(sh.sys.call('uname', {}));
  st.version = uname?.version ?? DEFAULT_VERSION;
  yield* put(sh, 2, `${banner(st.version)}\n`);
}

function* readScript(sh: Sh, path: string): SysGen<string | null> {
  const opened = yield* quiet(sh.sys.call('open', { path, flags: 'r' }));
  if (opened === null) return null;
  try {
    return yield* readAllText(sh.sys, opened.fd);
  } finally {
    yield* quiet(sh.sys.call('close', { fd: opened.fd }));
  }
}

/** `sh -c`, `sh FILE` and a non-terminal stdin: run the text and exit with its status. */
function* batch(sh: Sh): SysGen<number> {
  const st = sh.st;
  if (st.exec === null) {
    let source: string | null;
    if (st.mode === 'command') source = st.command ?? '';
    else if (st.mode === 'script') source = yield* readScript(sh, st.scriptPath ?? '');
    else source = yield* readAllText(sh.sys, 0);
    if (source === null) {
      yield* err(sh, `sh: ${st.scriptPath ?? ''}: No such file or directory\n`);
      st.exitCode = 127;
      return 127;
    }
    yield* prepareSource(sh, source, null);
  }
  yield* runCursor(sh);
  st.exec = null;
  st.exitCode ??= st.status;
  return st.exitCode;
}

export const shell: Program<ShellState> = {
  checkpointable: true,
  init: initShell,
  *run(ctx: ProgramContext, st: ShellState): SysGen<number> {
    const sh: Sh = { sys: ctx.sys, st, tick: ctx.tick };
    if (st.exitCode !== null) return st.exitCode;
    if (st.phase === 'start') {
      yield* startup(sh, ctx);
      st.phase = 'loop';
    }
    return st.mode === 'interactive' ? yield* interactive(sh) : yield* batch(sh);
  },
  signal(_ctx: ProgramContext, st: ShellState, sig: SignalName): void {
    if (sig === 'SIGINT') st.sig.intr = true;
    if (sig === 'SIGWINCH') st.sig.winch = true;
  },
};

export default shell;
