/**
 * `cd` (§3.14.2) and `pwd` (§3.14.3).
 */
import type { SysGen } from '../../src/_sys.ts';
import { errnoOf, errText } from '../../src/_sys.ts';
import { assign } from '../env.ts';
import type { Sh } from '../state.ts';
import { err, out } from '../state.ts';
import { getVar } from '../vars.ts';
import { shortOpts, usage } from './common.ts';

export function* cd(sh: Sh, argv: readonly string[]): SysGen<number> {
  const args = argv.slice(1);
  if (args[0] === '--') args.shift();
  if (args.length > 1) {
    yield* err(sh, 'cd: too many arguments\n');
    return 1;
  }
  const vars = sh.st.vars;
  let target = args[0];
  let print = false;
  if (target === undefined) {
    target = getVar(vars, 'HOME');
    if (target === undefined) {
      yield* err(sh, 'cd: HOME not set\n');
      return 1;
    }
  } else if (target === '-') {
    target = getVar(vars, 'OLDPWD');
    if (target === undefined) {
      yield* err(sh, 'cd: OLDPWD not set\n');
      return 1;
    }
    print = true;
  }
  if (target === '') return 0;
  let path: string;
  try {
    path = (yield* sh.sys.call('chdir', { path: target })).path;
  } catch (e) {
    yield* err(sh, `cd: ${target}: ${errText(e)}\n`);
    return 1;
  }
  const old = getVar(vars, 'PWD');
  if (old !== undefined) assign(sh, 'OLDPWD', old, { export: true });
  assign(sh, 'PWD', path, { export: true });
  if (print) yield* out(sh, `${path}\n`);
  return 0;
}

const PWD_SYNOPSIS = 'pwd [-L | -P]';

export function* pwd(sh: Sh, argv: readonly string[]): SysGen<number> {
  const { flags, bad } = shortOpts(argv.slice(1), 'LP');
  if (bad !== null) return yield* usage(sh, 'pwd', bad, PWD_SYNOPSIS);
  let cwd: { path: string; ino: string };
  try {
    cwd = yield* sh.sys.call('getcwd', {});
  } catch (e) {
    yield* err(sh, `pwd: cannot determine current directory: ${errText(e)}\n`);
    return 1;
  }
  const logical = getVar(sh.st.vars, 'PWD');
  if (flags.has('L') && !flags.has('P') && logical?.startsWith('/') === true) {
    try {
      const s = yield* sh.sys.call('stat', { path: logical });
      if (s.ino === cwd.ino) {
        yield* out(sh, `${logical}\n`);
        return 0;
      }
    } catch (e) {
      if (errnoOf(e) === undefined) throw e;
    }
  }
  yield* out(sh, `${cwd.path}\n`);
  return 0;
}
