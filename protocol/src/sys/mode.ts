/**
 * `chmod` mode strings → the ABI's `ModeChange` (syscall-abi.md §4.2; grammar and evaluation in
 * virtual-file-system.md §5.4).
 *
 * The `chmod` system call takes `{op:'set', bits}` or `{op:'delta', add, clear}`; symbolic modes
 * such as `o-w` become deltas in user space (the shell's `chmod` command and the agent's plan steps
 * call this module). The result applies as `newMode = (oldMode & ~clear) | add`.
 *
 * Supported: octal `1*4(0-7)` with no setuid/setgid bit and a value ≤ 0o1777; symbolic clauses
 * `*who 1*(op *perm)` with who ∈ u g o a, op ∈ + - =, perm ∈ r w x t. When a clause has no who
 * letter, POSIX applies the caller's umask to `+` and `=`, so the caller passes its umask.
 *
 * Not expressible as one delta, therefore rejected here (undefined → EINVAL): `X` (it depends on
 * each inode's old mode and type), `s`, `S`, `T`, copy forms such as `g=u`, and empty clauses.
 */
import type { ModeChange } from './common.ts';

const WHO_MASK: Readonly<Record<string, number>> = { u: 0o700, g: 0o070, o: 0o007, a: 0o777 };
const PERM_BITS: Readonly<Record<string, number>> = { r: 0o444, w: 0o222, x: 0o111 };
const STICKY = 0o1000;
const OCTAL = /^[0-7]{1,4}$/;
const CLAUSE = /^([ugoa]*)((?:[-+=][rwxt]*)+)$/;
const ACTION = /([-+=])([rwxt]*)/g;

/** Parse an octal or symbolic mode string; undefined when it is invalid or unsupported. */
export function parseMode(spec: string, umask: number): ModeChange | undefined {
  if (OCTAL.test(spec)) {
    const bits = Number.parseInt(spec, 8);
    if ((bits & 0o6000) !== 0 || bits > 0o1777) return undefined;
    return { op: 'set', bits };
  }
  let add = 0;
  let clear = 0;
  for (const clause of spec.split(',')) {
    const m = CLAUSE.exec(clause);
    if (m === null) return undefined;
    const whoLetters = m[1] ?? '';
    const implicit = whoLetters.length === 0;
    let whoMask = implicit ? 0o777 : 0;
    for (const letter of whoLetters) whoMask |= WHO_MASK[letter] ?? 0;
    for (const action of (m[2] ?? '').matchAll(ACTION)) {
      const op = action[1];
      const perms = action[2] ?? '';
      let bits = 0;
      for (const p of perms) bits |= PERM_BITS[p] ?? 0;
      let rwx = bits & whoMask;
      if (implicit && (op === '+' || op === '=')) rwx &= ~umask & 0o777;
      const sticky = perms.includes('t') && (implicit || /[oa]/.test(whoLetters)) ? STICKY : 0;
      let stepAdd = 0;
      let stepClear = 0;
      if (op === '+') stepAdd = rwx | sticky;
      else if (op === '-') stepClear = rwx | sticky;
      else {
        // "=": replace the who bits by rwx; "=" never clears the sticky bit (§5.4).
        stepAdd = rwx | sticky;
        stepClear = whoMask & ~rwx;
      }
      // Compose with the earlier steps: later steps win on the bits they touch.
      add = (add & ~stepClear) | stepAdd;
      clear = (clear & ~stepAdd) | stepClear;
    }
  }
  return { op: 'delta', add, clear };
}

/** Apply a `ModeChange` to a mode: `set` replaces it, `delta` is `(mode & ~clear) | add`. */
export function applyModeChange(mode: number, change: ModeChange): number {
  return change.op === 'set' ? change.bits : (mode & ~change.clear) | change.add;
}
