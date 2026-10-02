/**
 * Shell variables (shell-and-terminal.md §3.4). Plain data inside the shell's serialisable state.
 *
 * Entries are own data properties defined with `Object.defineProperty`, so a variable named
 * `__proto__` or `constructor` is an ordinary variable and never touches the prototype.
 */

export interface VarEntry {
  value: string;
  exported: boolean;
  readonly: boolean;
}

export interface VarTable {
  vars: Record<string, VarEntry>;
}

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isName(s: string): boolean {
  return NAME_RE.test(s);
}

export function newVars(): VarTable {
  return { vars: {} };
}

function entry(t: VarTable, name: string): VarEntry | undefined {
  return Object.hasOwn(t.vars, name) ? t.vars[name] : undefined;
}

function define(t: VarTable, name: string, e: VarEntry): void {
  Object.defineProperty(t.vars, name, {
    value: e,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function getVar(t: VarTable, name: string): string | undefined {
  return entry(t, name)?.value;
}

export function isReadonly(t: VarTable, name: string): boolean {
  return entry(t, name)?.readonly ?? false;
}

/** Sets a variable, keeping its exported flag. Returns false for a read-only variable. */
export function setVar(
  t: VarTable,
  name: string,
  value: string,
  opts: { export?: boolean; readonly?: boolean } = {},
): boolean {
  const old = entry(t, name);
  if (old?.readonly === true) return false;
  define(t, name, {
    value,
    exported: opts.export === true || (old?.exported ?? false),
    readonly: opts.readonly === true,
  });
  return true;
}

/** Marks a variable for export, creating it empty when the value is not given and it is unset. */
export function exportVar(t: VarTable, name: string, value?: string): boolean {
  const old = entry(t, name);
  if (value !== undefined) return setVar(t, name, value, { export: true });
  if (old === undefined) {
    define(t, name, { value: '', exported: true, readonly: false });
  } else {
    old.exported = true;
  }
  return true;
}

export function unsetVar(t: VarTable, name: string): boolean {
  const old = entry(t, name);
  if (old === undefined) return true;
  if (old.readonly) return false;
  // Deleting an own property never reaches the prototype, whatever the key.
  Reflect.deleteProperty(t.vars, name);
  return true;
}

export function varNames(t: VarTable): string[] {
  return Object.keys(t.vars);
}

/** The environment given to a program: exported variables only. */
export function exportedEnv(t: VarTable): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, e] of Object.entries(t.vars)) {
    if (e.exported) setOwn(env, name, e.value);
  }
  return env;
}

/**
 * The environment of a child `sh -c`: every variable, so non-exported ones are visible there
 * (shell-and-terminal.md §3.7.1 rule 2). Read-only shell variables such as UID are left out.
 */
export function allEnv(t: VarTable): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, e] of Object.entries(t.vars)) {
    if (!e.readonly) setOwn(env, name, e.value);
  }
  return env;
}

export function setOwn(rec: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(rec, key, { value, enumerable: true, writable: true, configurable: true });
}
