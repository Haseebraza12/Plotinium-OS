/**
 * The builtin registry (shell-and-terminal.md §3.7.1).
 */
import type { Builtin } from './common.ts';
import { cd, pwd } from './dir.ts';
import { echo } from './echo.ts';
import { helpBuiltin } from './help.ts';
import { bgBuiltin, fgBuiltin, jobsBuiltin, waitBuiltin } from './jobctl.ts';
import { killBuiltin } from './kill.ts';
import { exitBuiltin, falseBuiltin, historyBuiltin, trueBuiltin, typeBuiltin } from './misc.ts';
import type { BuiltinName } from './names.ts';
import { exportBuiltin, unsetBuiltin } from './vars.ts';

export type { Builtin } from './common.ts';
export { BUILTIN_NAMES, isBuiltin, isConvenience } from './names.ts';

export const BUILTINS: Readonly<Record<BuiltinName, Builtin>> = {
  cd,
  pwd,
  echo,
  export: exportBuiltin,
  unset: unsetBuiltin,
  exit: exitBuiltin,
  history: historyBuiltin,
  jobs: jobsBuiltin,
  fg: fgBuiltin,
  bg: bgBuiltin,
  wait: waitBuiltin,
  kill: killBuiltin,
  help: helpBuiltin,
  type: typeBuiltin,
  true: trueBuiltin,
  false: falseBuiltin,
};
