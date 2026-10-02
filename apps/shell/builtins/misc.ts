/**
 * `exit`, `history` (§3.14.43), `type`, `true` and `false`.
 */
import type { SysGen } from '../../src/_sys.ts';
import { clearHistory, formatHistory, loadHistory } from '../history.ts';
import { hasStoppedJobs } from '../jobs.ts';
import { findInPath } from '../lookup.ts';
import type { Sh } from '../state.ts';
import { err, out } from '../state.ts';
import { isBuiltin } from './names.ts';

/**
 * `exit [N]`. With stopped jobs an interactive shell warns once; an `exit` on the very next line
 * exits (§3.8). A non-numeric N is reported and exits with 2.
 */
export function* exitBuiltin(sh: Sh, argv: readonly string[]): SysGen<number> {
  const st = sh.st;
  if (argv.length > 2) {
    yield* err(sh, 'exit: too many arguments\n');
    return 1;
  }
  const arg = argv[1];
  let code = st.status;
  if (arg !== undefined) {
    if (/^[+-]?[0-9]+$/.test(arg)) {
      code = ((Number(arg) % 256) + 256) % 256;
    } else {
      yield* err(sh, `exit: ${arg}: numeric argument required\n`);
      code = 2;
    }
  }
  if (st.mode === 'interactive' && hasStoppedJobs(st.jobs) && st.exitWarnedLine !== st.lineNo - 1) {
    yield* err(sh, 'There are stopped jobs.\n');
    st.exitWarnedLine = st.lineNo;
    return 1;
  }
  st.exitCode = code;
  return code;
}

export function* historyBuiltin(sh: Sh, argv: readonly string[]): SysGen<number> {
  const args = argv.slice(1);
  if (args[0] === '-c') {
    if (args.length > 1) {
      yield* err(sh, 'history: too many arguments\n');
      return 2;
    }
    return yield* clearHistory(sh);
  }
  if (args.length > 1) {
    yield* err(sh, 'history: too many arguments\n');
    return 2;
  }
  const n = args[0];
  if (n !== undefined && !/^[0-9]+$/.test(n)) {
    yield* err(sh, `history: ${n}: numeric argument required\n`);
    return 2;
  }
  // A child shell (`history | grep ls`) has no list of its own: it reads the shared file.
  if (sh.st.mode !== 'interactive' && sh.st.hist.lines.length === 0) yield* loadHistory(sh, false);
  yield* out(sh, formatHistory(sh.st.hist, n === undefined ? undefined : Number(n)));
  return 0;
}

/** `type NAME...`: `cd is a shell builtin`, `ls is /bin/ls`, `sh: type: foo: not found`. */
export function* typeBuiltin(sh: Sh, argv: readonly string[]): SysGen<number> {
  let status = 0;
  for (const name of argv.slice(1)) {
    let line: string | null = null;
    if (isBuiltin(name)) {
      line = `${name} is a shell builtin`;
    } else {
      const path = name.includes('/') ? null : yield* findInPath(sh, name);
      if (path !== null) line = `${name} is ${path.replace(/\.json$/, '')}`;
    }
    if (line === null) {
      yield* err(sh, `sh: type: ${name}: not found\n`);
      status = 1;
    } else {
      yield* out(sh, `${line}\n`);
    }
  }
  return status;
}

// eslint-disable-next-line require-yield -- a builtin has the generator signature even when it makes no call
export function* trueBuiltin(): SysGen<number> {
  return 0;
}

// eslint-disable-next-line require-yield -- a builtin has the generator signature even when it makes no call
export function* falseBuiltin(): SysGen<number> {
  return 1;
}
