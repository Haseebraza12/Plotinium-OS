/**
 * Shared pieces of the builtins: the signature and the usage-error format of §3.13.
 */
import type { SysGen } from '../../src/_sys.ts';
import type { Sh } from '../state.ts';
import { err } from '../state.ts';

export type Builtin = (sh: Sh, argv: readonly string[]) => SysGen<number>;

/** `<cmd>: invalid option -- 'x'`, `Usage: <synopsis>`, `Try 'man <cmd>'.`; status 2. */
export function* usage(sh: Sh, cmd: string, opt: string, synopsis: string): SysGen<number> {
  yield* err(sh, `${cmd}: invalid option -- '${opt}'\nUsage: ${synopsis}\nTry 'man ${cmd}'.\n`);
  return 2;
}

/**
 * Splits leading short-option clusters (`-lp`) from the operands; `--` ends the options.
 * Returns the first character not in `allowed` as `bad`.
 */
export function shortOpts(
  args: readonly string[],
  allowed: string,
): { flags: Set<string>; rest: string[]; bad: string | null } {
  const flags = new Set<string>();
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    for (const c of a.slice(1)) {
      if (!allowed.includes(c)) return { flags, rest: [], bad: c };
      flags.add(c);
    }
  }
  return { flags, rest: args.slice(i), bad: null };
}
