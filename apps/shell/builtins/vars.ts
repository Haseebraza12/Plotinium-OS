/**
 * `export [-p] [NAME[=value]...]` and `unset [-v] NAME...` (§3.4 "Variables").
 */
import type { SysGen } from '../../src/_sys.ts';
import { compareCodePoints } from '../glob.ts';
import { exportName, unassign } from '../env.ts';
import type { Sh } from '../state.ts';
import { err, out } from '../state.ts';
import { getVar, isName, isReadonly, varNames } from '../vars.ts';

function dq(value: string): string {
  return `"${value.replace(/["\\$`]/g, (c) => `\\${c}`)}"`;
}

/** `export NAME="value"` lines for every exported variable, in code-point order. */
export function exportListing(sh: Sh): string {
  const vars = sh.st.vars;
  return varNames(vars)
    .filter((n) => vars.vars[n]?.exported === true)
    .sort(compareCodePoints)
    .map((n) => `export ${n}=${dq(getVar(vars, n) ?? '')}\n`)
    .join('');
}

interface Outcome {
  status: number;
  msgs: string;
}

function applyExports(sh: Sh, args: readonly string[]): Outcome {
  const o: Outcome = { status: 0, msgs: '' };
  for (const a of args) {
    const eq = a.indexOf('=');
    const name = eq < 0 ? a : a.slice(0, eq);
    if (!isName(name)) {
      o.msgs += `export: '${a}': not a valid identifier\n`;
      o.status = 1;
    } else if (!exportName(sh, name, eq < 0 ? undefined : a.slice(eq + 1))) {
      o.msgs += `export: ${name}: readonly variable\n`;
      o.status = 1;
    }
  }
  return o;
}

function applyUnsets(sh: Sh, args: readonly string[]): Outcome {
  const o: Outcome = { status: 0, msgs: '' };
  for (const name of args) {
    if (!isName(name)) {
      o.msgs += `unset: '${name}': not a valid identifier\n`;
      o.status = 1;
    } else if (isReadonly(sh.st.vars, name) || !unassign(sh, name)) {
      o.msgs += `unset: ${name}: cannot unset: readonly variable\n`;
      o.status = 1;
    }
  }
  return o;
}

function* report(sh: Sh, o: Outcome): SysGen<number> {
  if (o.msgs.length > 0) yield* err(sh, o.msgs);
  return o.status;
}

/** The first `-p`/`-v` or `--` is an option; everything else is an operand. */
function operands(argv: readonly string[], opt: string): string[] {
  const args = argv.slice(1);
  if (args[0] === opt || args[0] === '--') args.shift();
  return args;
}

export function* exportBuiltin(sh: Sh, argv: readonly string[]): SysGen<number> {
  const args = operands(argv, '-p');
  if (args.length === 0) {
    yield* out(sh, exportListing(sh));
    return 0;
  }
  return yield* report(sh, applyExports(sh, args));
}

export function* unsetBuiltin(sh: Sh, argv: readonly string[]): SysGen<number> {
  return yield* report(sh, applyUnsets(sh, operands(argv, '-v')));
}
