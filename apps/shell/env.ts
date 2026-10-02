/**
 * Variable changes with their side effects: changing PATH clears the command cache (§3.7.2).
 */
import type { Sh } from './state.ts';
import { exportVar, setVar, unsetVar } from './vars.ts';

function touched(sh: Sh, name: string): void {
  if (name === 'PATH') sh.st.cmdCache = {};
}

export function assign(
  sh: Sh,
  name: string,
  value: string,
  opts: { export?: boolean } = {},
): boolean {
  const ok = setVar(sh.st.vars, name, value, opts);
  if (ok) touched(sh, name);
  return ok;
}

export function exportName(sh: Sh, name: string, value?: string): boolean {
  const ok = exportVar(sh.st.vars, name, value);
  if (ok) touched(sh, name);
  return ok;
}

export function unassign(sh: Sh, name: string): boolean {
  const ok = unsetVar(sh.st.vars, name);
  if (ok) touched(sh, name);
  return ok;
}
