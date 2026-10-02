/**
 * `chmod` MODE parsing and evaluation (virtual-file-system.md §5.4): octal of up to four digits
 * (setuid and setgid rejected), or symbolic `[ugoa]*[+-=][rwxXt]*` clauses separated by commas.
 */
import type { ModeChange } from '@plotinium/protocol';

type Op = '+' | '-' | '=';

interface Action {
  readonly op: Op;
  readonly perms: string;
}

interface Clause {
  /** The who mask, or null when no who letter was given (then umask applies to + and =). */
  readonly who: number | null;
  readonly others: boolean;
  readonly actions: readonly Action[];
}

export type ModeSpec =
  | { readonly kind: 'octal'; readonly bits: number }
  | { readonly kind: 'symbolic'; readonly clauses: readonly Clause[] };

const WHO: Readonly<Record<string, number>> = { u: 0o700, g: 0o070, o: 0o007, a: 0o777 };
const STICKY = 0o1000;

function parseClause(text: string): Clause | null {
  let i = 0;
  let who = 0;
  let others = false;
  while (i < text.length && 'ugoa'.includes(text.charAt(i))) {
    const c = text.charAt(i);
    who |= WHO[c] ?? 0;
    if (c === 'o' || c === 'a') others = true;
    i++;
  }
  const hasWho = i > 0;
  const actions: Action[] = [];
  while (i < text.length) {
    const op = text.charAt(i);
    if (op !== '+' && op !== '-' && op !== '=') return null;
    i++;
    let perms = '';
    while (i < text.length && 'rwxXt'.includes(text.charAt(i))) perms += text.charAt(i++);
    actions.push({ op, perms });
  }
  if (actions.length === 0) return null;
  return { who: hasWho ? who : null, others, actions };
}

/** The parsed MODE, or null when it is invalid (`chmod: invalid mode`, EINVAL). */
export function parseMode(text: string): ModeSpec | null {
  if (/^[0-7]{1,4}$/.test(text)) {
    const bits = parseInt(text, 8);
    return bits > 0o1777 ? null : { kind: 'octal', bits };
  }
  const clauses: Clause[] = [];
  for (const part of text.split(',')) {
    const clause = parseClause(part);
    if (clause === null) return null;
    clauses.push(clause);
  }
  return { kind: 'symbolic', clauses };
}

function permBits(perms: string, oldMode: number, isDir: boolean): number {
  let bits = 0;
  for (const p of perms) {
    if (p === 'r') bits |= 0o444;
    else if (p === 'w') bits |= 0o222;
    else if (p === 'x') bits |= 0o111;
    else if (p === 'X' && (isDir || (oldMode & 0o111) !== 0)) bits |= 0o111;
  }
  return bits;
}

interface Delta {
  add: number;
  clear: number;
}

/** Folds one action into a `(mode & ~clear) | add` delta. */
function fold(delta: Delta, clause: Clause, action: Action, rwxIn: number, umask: number): void {
  const mask = clause.who ?? 0o777;
  let rwx = rwxIn & mask;
  if (clause.who === null && action.op !== '-') rwx &= ~umask;
  const sticky = action.perms.includes('t') && (clause.who === null || clause.others) ? STICKY : 0;
  const set = rwx | sticky;
  const clear = action.op === '+' ? 0 : action.op === '-' ? set : mask;
  const add = action.op === '-' ? 0 : set;
  delta.clear |= clear;
  delta.add = (delta.add & ~clear) | add;
}

/** The new mode of one inode (the X test uses the original mode, POSIX). */
export function applyMode(spec: ModeSpec, oldMode: number, isDir: boolean, umask: number): number {
  if (spec.kind === 'octal') return spec.bits;
  const delta: Delta = { add: 0, clear: 0 };
  for (const clause of spec.clauses) {
    for (const action of clause.actions) {
      fold(delta, clause, action, permBits(action.perms, oldMode, isDir), umask);
    }
  }
  return ((oldMode & ~delta.clear) | delta.add) & 0o7777;
}

/**
 * The `chmod` call argument, or null when the result depends on each inode (`X`), in which case the
 * caller evaluates per inode. `add` and `clear` are disjoint, so either evaluation order agrees.
 */
export function toModeChange(spec: ModeSpec, umask: number): ModeChange | null {
  if (spec.kind === 'octal') return { op: 'set', bits: spec.bits };
  const delta: Delta = { add: 0, clear: 0 };
  for (const clause of spec.clauses) {
    for (const action of clause.actions) {
      if (action.perms.includes('X')) return null;
      fold(delta, clause, action, permBits(action.perms, 0, false), umask);
    }
  }
  return { op: 'delta', add: delta.add, clear: delta.clear & ~delta.add };
}
