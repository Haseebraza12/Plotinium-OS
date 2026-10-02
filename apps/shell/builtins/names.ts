/**
 * Builtin names (shell-and-terminal.md §3.7.1). State builtins change the shell itself and run
 * only inside it; convenience builtins are also installed as `/bin` programs.
 */
export const STATE_BUILTINS = [
  'cd',
  'export',
  'unset',
  'exit',
  'history',
  'jobs',
  'fg',
  'bg',
  'wait',
] as const;

export const CONVENIENCE_BUILTINS = [
  'pwd',
  'echo',
  'kill',
  'help',
  'type',
  'true',
  'false',
] as const;

export type BuiltinName = (typeof STATE_BUILTINS)[number] | (typeof CONVENIENCE_BUILTINS)[number];

const ALL: ReadonlySet<string> = new Set([...STATE_BUILTINS, ...CONVENIENCE_BUILTINS]);
const CONVENIENCE: ReadonlySet<string> = new Set(CONVENIENCE_BUILTINS);

export function isBuiltin(name: string): name is BuiltinName {
  return ALL.has(name);
}

export function isConvenience(name: string): boolean {
  return CONVENIENCE.has(name);
}

/** Sorted, for completion and `help`. */
export const BUILTIN_NAMES: readonly string[] = [...ALL].sort();
