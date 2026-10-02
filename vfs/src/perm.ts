/**
 * @plotinium/vfs/perm: the one permission matrix shared by client and server (VFS-04, PVFS-16).
 *
 * ISOMORPHIC: the kernel checks rwx with this module and the server re-checks with the SAME module
 * (boundary B3), so it uses neither DOM nor Node APIs and imports only protocol TYPES.
 * Spec: virtual-file-system.md §3.6 and §5.2 (checks), §5.4 (chmod grammar and evaluation).
 */
import type { Errno, ModeChange, WsModeChange } from '@plotinium/protocol';

export const R = 4;
export const W = 2;
export const X = 1;
export const STICKY = 0o1000;
/** Plotinium stores only the nine rwx bits and the sticky bit (§3.2). */
export const MODE_MASK = 0o1777;
/** setuid and setgid are rejected in v1 (EINVAL). */
export const SETID_BITS = 0o6000;
/** Spec §9.3: the default umask. */
export const DEFAULT_UMASK = 0o022;
/** A symlink's mode is always 0o777 and never checked (§3.2). */
export const SYMLINK_MODE = 0o777;

export type InodeKind = 'f' | 'd' | 'l';

/** Credentials from the PCB, never from syscall arguments (C3). `groups` includes the primary gid. */
export interface Cred {
  readonly uid: number;
  readonly gid: number;
  readonly groups: readonly number[];
}

export interface PermSubject {
  readonly type: InodeKind;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

/** A failed check, or null when allowed. */
export type Check = Errno | null;

/**
 * The permission function (§3.6.1). Root bypasses r and w; it gets x on directories, and on files
 * only when SOME x bit is set. The x test uses `(want & X) === 0`, the critic fix: `want !== X`
 * wrongly granted r+x on a file with no x bits.
 */
export function may(cred: Cred, n: PermSubject, want: number): boolean {
  if (cred.uid === 0) return (want & X) === 0 || n.type === 'd' || (n.mode & 0o111) !== 0;
  // One class only: an owner gets the owner bits even if group or other would grant more.
  // The primary gid is tested too (syscall-abi.md §3.6), in case a PCB omits it from `groups`.
  const shift = cred.uid === n.uid ? 6 : cred.gid === n.gid || cred.groups.includes(n.gid) ? 3 : 0;
  return ((n.mode >> shift) & 7 & want) === want;
}

/** Whether the sticky rule forbids `cred` removing or replacing entry `c` of directory `p`. */
export function stickyDenies(cred: Cred, p: PermSubject, c: PermSubject): boolean {
  return (p.mode & STICKY) !== 0 && cred.uid !== 0 && cred.uid !== c.uid && cred.uid !== p.uid;
}

export function checkCreate(cred: Cred, parent: PermSubject): Check {
  return may(cred, parent, W | X) ? null : 'EACCES';
}

/** EACCES (w+x on the parent) is tested before EPERM (sticky), as Linux `may_delete` does. */
export function checkRemove(cred: Cred, parent: PermSubject, child: PermSubject): Check {
  if (!may(cred, parent, W | X)) return 'EACCES';
  return stickyDenies(cred, parent, child) ? 'EPERM' : null;
}

export function checkRename(
  cred: Cred,
  srcParent: PermSubject,
  moved: PermSubject,
  dstParent: PermSubject,
  replaced: PermSubject | null,
  sameParent: boolean,
): Check {
  const a = checkRemove(cred, srcParent, moved);
  if (a !== null) return a;
  const b = checkCreate(cred, dstParent);
  if (b !== null) return b;
  if (replaced !== null) {
    const c = checkRemove(cred, dstParent, replaced);
    if (c !== null) return c;
  }
  // A directory that changes parent rewrites its "..", so it needs w on itself.
  if (moved.type === 'd' && !sameParent && !may(cred, moved, W)) return 'EACCES';
  return null;
}

export function checkChmod(cred: Cred, n: PermSubject): Check {
  return cred.uid === 0 || cred.uid === n.uid ? null : 'EPERM';
}

/** Spec: chown is root-only. */
export function checkChown(cred: Cred): Check {
  return cred.uid === 0 ? null : 'EPERM';
}

/** `link`: w+x on the new parent; a regular file; owner, or both r and w (protected_hardlinks). */
export function checkLink(cred: Cred, file: PermSubject, parent: PermSubject): Check {
  const c = checkCreate(cred, parent);
  if (c !== null) return c;
  if (file.type !== 'f') return 'EPERM';
  return cred.uid === 0 || cred.uid === file.uid || may(cred, file, R | W) ? null : 'EPERM';
}

export function checkUtimes(cred: Cred, n: PermSubject, explicit: boolean): Check {
  if (explicit) return cred.uid === 0 || cred.uid === n.uid ? null : 'EPERM';
  return cred.uid === n.uid || may(cred, n, W) ? null : 'EACCES';
}

/** `open`: r for read, w for write or truncate, both for read-write. */
export function checkOpen(cred: Cred, n: PermSubject, read: boolean, write: boolean): Check {
  const want = (read ? R : 0) | (write ? W : 0);
  return may(cred, n, want) ? null : 'EACCES';
}

/** `readdir` needs r; `readdirPlus` needs r and x. */
export function checkReaddir(cred: Cred, dir: PermSubject, plus: boolean): Check {
  return may(cred, dir, plus ? R | X : R) ? null : 'EACCES';
}

/** `rm -r`: r, w and x on every directory of the subtree (r enumerates, w and x remove). */
export function checkSubtreeDir(cred: Cred, dir: PermSubject): Check {
  return may(cred, dir, R | W | X) ? null : 'EACCES';
}

/** `cp -r` sources: r on files, r+x on directories; symlinks are copied as strings. */
export function checkCopySource(cred: Cred, n: PermSubject): Check {
  if (n.type === 'l') return null;
  return may(cred, n, n.type === 'd' ? R | X : R) ? null : 'EACCES';
}

/**
 * Mode of a new inode (§3.6 umask). Files default to 0o666, directories to 0o777; umask never clears
 * the sticky bit of a directory; a symlink is always 0o777.
 */
export function createMode(type: InodeKind, requested: number | undefined, umask: number): number {
  if (type === 'l') return SYMLINK_MODE;
  const req = requested ?? (type === 'd' ? 0o777 : 0o666);
  const rwx = req & ~umask & 0o777;
  return type === 'd' ? rwx | (req & STICKY) : rwx;
}

// ---------------------------------------------------------------------------------------------
// chmod modes (§5.4). Octal is exact; symbolic clauses are evaluated per inode because `X` depends
// on the inode's type and ORIGINAL mode.
// ---------------------------------------------------------------------------------------------

export interface ModeAction {
  readonly op: '+' | '-' | '=';
  readonly perms: string;
}
export interface ModeClause {
  readonly who: string;
  readonly actions: readonly ModeAction[];
}
export type ModeSpec =
  | { readonly kind: 'octal'; readonly bits: number }
  | { readonly kind: 'symbolic'; readonly clauses: readonly ModeClause[] }
  /** The syscall's `{op: 'delta'}` form (syscall-abi.md §4.2): `(mode & ~clear) | add`. */
  | { readonly kind: 'delta'; readonly add: number; readonly clear: number };

const OCTAL = /^[0-7]{1,4}$/;
const CLAUSE = /^([ugoa]*)((?:[-+=][rwxXt]*)+)$/;
const ACTION = /([-+=])([rwxXt]*)/g;
const WHO_MASK: Readonly<Record<string, number>> = { u: 0o700, g: 0o070, o: 0o007, a: 0o777 };

function octalOk(bits: number): boolean {
  return Number.isInteger(bits) && bits >= 0 && (bits & SETID_BITS) === 0 && bits <= MODE_MASK;
}

/** Parse a chmod mode (number, octal string or symbolic string); EINVAL when invalid or unsupported. */
export function parseModeSpec(spec: number | string): ModeSpec | 'EINVAL' {
  if (typeof spec === 'number') return octalOk(spec) ? { kind: 'octal', bits: spec } : 'EINVAL';
  if (OCTAL.test(spec)) {
    const bits = Number.parseInt(spec, 8);
    return octalOk(bits) ? { kind: 'octal', bits } : 'EINVAL';
  }
  const clauses: ModeClause[] = [];
  for (const text of spec.split(',')) {
    const m = CLAUSE.exec(text);
    if (m === null) return 'EINVAL';
    const actions: ModeAction[] = [];
    for (const a of (m[2] ?? '').matchAll(ACTION)) {
      const op = a[1];
      if (op !== '+' && op !== '-' && op !== '=') return 'EINVAL';
      actions.push({ op, perms: a[2] ?? '' });
    }
    clauses.push({ who: m[1] ?? '', actions });
  }
  return { kind: 'symbolic', clauses };
}

/** The ModeSpec of a syscall `ModeChange`; EINVAL for setuid, setgid or bits beyond 0o1777. */
export function fromModeChange(change: ModeChange): ModeSpec | 'EINVAL' {
  if (change.op === 'set')
    return octalOk(change.bits) ? { kind: 'octal', bits: change.bits } : 'EINVAL';
  if ((change.add & SETID_BITS) !== 0 || change.add > MODE_MASK) return 'EINVAL';
  return { kind: 'delta', add: change.add & MODE_MASK, clear: change.clear & MODE_MASK };
}

/** Evaluate a parsed spec against one inode (§5.4 `evaluate`). */
export function applyModeSpec(
  spec: ModeSpec,
  oldMode: number,
  isDir: boolean,
  umask: number,
): number {
  if (spec.kind === 'octal') return spec.bits;
  if (spec.kind === 'delta') return ((oldMode & ~spec.clear) | spec.add) & MODE_MASK;
  let mode = oldMode;
  for (const clause of spec.clauses) {
    const implicit = clause.who.length === 0;
    let whoMask = implicit ? 0o777 : 0;
    for (const w of clause.who) whoMask |= WHO_MASK[w] ?? 0;
    for (const { op, perms } of clause.actions) {
      let bits = 0;
      for (const p of perms) {
        if (p === 'r') bits |= 0o444;
        else if (p === 'w') bits |= 0o222;
        else if (p === 'x') bits |= 0o111;
        else if (p === 'X' && (isDir || (oldMode & 0o111) !== 0)) bits |= 0o111;
      }
      let rwx = bits & whoMask;
      if (implicit && op !== '-') rwx &= ~umask & 0o777;
      const sticky = perms.includes('t') && (implicit || /[oa]/.test(clause.who)) ? STICKY : 0;
      if (op === '+') mode |= rwx | sticky;
      else if (op === '-') mode &= ~(rwx | sticky);
      else mode = (mode & ~whoMask) | rwx | sticky; // "=" never clears the sticky bit
    }
  }
  return mode & MODE_MASK;
}

const CLASSES = [
  ['u', 6],
  ['g', 3],
  ['o', 0],
] as const;

function rwxLetters(v: number, xLetter: 'x' | 'X'): string {
  return `${v & 4 ? 'r' : ''}${v & 2 ? 'w' : ''}${v & 1 ? xLetter : ''}`;
}

/** Explicit-who clauses equal to one implicit-who action under `umask` (POSIX umask rule). */
function explicitAction(op: '+' | '-' | '=', perms: string, umask: number): string[] {
  const hasX = perms.includes('X');
  let req = 0;
  for (const p of perms) req |= p === 'r' ? 4 : p === 'w' ? 2 : p === 'x' ? 1 : 0;
  const sticky = perms.includes('t');
  if (op === '-') return [`a-${rwxLetters(req, 'x')}${hasX ? 'X' : ''}${sticky ? 't' : ''}`];
  return CLASSES.map(([who, shift]) => {
    const allowed = ~(umask >> shift) & 7;
    const letters = rwxLetters(req & allowed, 'x') + (hasX && (allowed & 1) !== 0 ? 'X' : '');
    return `${who}${op}${letters}${sticky && who === 'o' ? 't' : ''}`;
  });
}

/**
 * The wire form of a spec (offline-and-sync.md §4.2 `WsModeChange`). The wire carries no umask, so
 * a clause without a *who* part is rewritten into explicit clauses under the caller's umask; the
 * server then evaluates exactly what the kernel evaluated (§3.12.6).
 */
export function toWireMode(spec: ModeSpec, umask: number): WsModeChange {
  if (spec.kind === 'octal') return { absolute: spec.bits };
  const clauses: string[] = [];
  if (spec.kind === 'delta') {
    for (const [who, shift] of CLASSES) {
      const clear = (spec.clear >> shift) & 7;
      const add = (spec.add >> shift) & 7;
      const t = who === 'o' ? STICKY : 0;
      const minus = rwxLetters(clear, 'x') + ((spec.clear & t) !== 0 ? 't' : '');
      const plus = rwxLetters(add, 'x') + ((spec.add & t) !== 0 ? 't' : '');
      if (minus !== '') clauses.push(`${who}-${minus}`);
      if (plus !== '') clauses.push(`${who}+${plus}`);
    }
    return { symbolic: clauses.length === 0 ? 'u+' : clauses.join(',') };
  }
  for (const clause of spec.clauses) {
    if (clause.who.length > 0) {
      clauses.push(clause.who + clause.actions.map((a) => a.op + a.perms).join(''));
    } else {
      for (const a of clause.actions) clauses.push(...explicitAction(a.op, a.perms, umask));
    }
  }
  return { symbolic: clauses.join(',') };
}

/** Parse and evaluate in one step; EINVAL for a bad or unsupported spec. */
export function evaluateMode(
  spec: number | string,
  oldMode: number,
  isDir: boolean,
  umask: number,
): number | 'EINVAL' {
  const parsed = parseModeSpec(spec);
  return parsed === 'EINVAL' ? parsed : applyModeSpec(parsed, oldMode, isDir, umask);
}

/** `ls -l` form, for example `drwxrwxrwt` or `-rw-r--r--` (§3.22). */
export function formatMode(type: InodeKind, mode: number): string {
  const lead = type === 'd' ? 'd' : type === 'l' ? 'l' : '-';
  const rwx = (shift: number): string => {
    const v = (mode >> shift) & 7;
    return `${v & 4 ? 'r' : '-'}${v & 2 ? 'w' : '-'}${v & 1 ? 'x' : '-'}`;
  };
  let other = rwx(0);
  if ((mode & STICKY) !== 0) other = other.slice(0, 2) + (mode & 1 ? 't' : 'T');
  return lead + rwx(6) + rwx(3) + other;
}
