/**
 * Dispatcher stage 5 for the file-system calls (syscall-abi.md §3.3, §3.6; virtual-file-system.md
 * §3.6.2 "Check order"; SYS-01, VFS-04).
 *
 * Every fs call has an `authorize` that resolves its paths on the current in-memory tree (x on every
 * directory traversed, vfs/path) and applies the coarse rwx rule of its row in §3.6.2 with the
 * PCB's credentials (vfs/perm). It returns only resolution errnos (ENOENT, ENOTDIR, ELOOP, EACCES,
 * ENAMETOOLONG, EAGAIN offline), EACCES and EPERM, with no side effect.
 *
 * When a path crosses a directory that is not in memory yet, stage 5 cannot decide synchronously
 * and passes; the handler then repeats EVERY check inside phase 1 (the vfs planners check the whole
 * §3.6.2 matrix against the current tree after loading), so no call ever skips its permission check.
 * Stage 5 also completes the `fs.scope` capability: the RESOLVED path must lie under an allowed
 * prefix, so a symlink cannot escape the scope (§3.3 stage 4 checks the lexical path only).
 */
import type { ArgsOf, CallName, ErrDetail, Errno } from '@plotinium/protocol';
import { bitsToCaps } from '@plotinium/protocol';
import type { InodeRec, ResolveOpts } from '@plotinium/vfs';
import {
  checkChmod,
  checkChown,
  checkCopySource,
  checkCreate,
  checkLink,
  checkOpen,
  checkReaddir,
  checkRemove,
  checkRename,
  checkUtimes,
} from '@plotinium/vfs';
import type { Check } from '@plotinium/vfs';

import { KernelError } from '../errors.ts';
import type { Caller } from '../ipc/ports.ts';
import { isUnder, normalisePath } from '../ipc/scope.ts';
import { reasonOf } from './errno.ts';
import type { FsActor, KernelFs } from './kfs.ts';
import { actorOf } from './kfs.ts';

/** The errnos stage 5 may answer (syscall-abi.md §3.3 stage 5; EAGAIN: unmirrored, offline). */
const STAGE5_ERRNOS: ReadonlySet<Errno> = new Set<Errno>([
  'EACCES',
  'EPERM',
  'ENOENT',
  'ENOTDIR',
  'ELOOP',
  'ENAMETOOLONG',
  'EAGAIN',
]);

/** Stage 5 cannot decide: a directory on the path (or the cwd) is not in memory. */
class Defer extends Error {
  constructor() {
    super('stage 5 deferred to the handler');
    this.name = 'Defer';
  }
}

/** Stage 5 refuses the call with `error`. */
class Deny extends Error {
  readonly error: KernelError;

  constructor(error: KernelError) {
    super(error.message);
    this.name = 'Deny';
    this.error = error;
  }
}

function deny(errno: Errno, call: CallName, path?: string, detail?: string): never {
  const reason = reasonOf(errno, detail, call);
  const d: ErrDetail = {
    ...(reason === undefined ? {} : { reason }),
    ...(path === undefined || path === '' ? {} : { path }),
  };
  throw new Deny(new KernelError(errno, Object.keys(d).length === 0 ? undefined : d));
}

interface Found {
  readonly node: InodeRec | null;
  readonly parent: InodeRec | null;
  readonly name: string | null;
  readonly path: string;
}

/** The per-call checking context. */
export class Gate {
  readonly fs: KernelFs;
  readonly caller: Caller;
  readonly actor: FsActor;
  readonly call: CallName;

  constructor(fs: KernelFs, caller: Caller, call: CallName) {
    this.fs = fs;
    this.caller = caller;
    this.actor = actorOf(caller.pcb);
    this.call = call;
  }

  get cred(): FsActor['cred'] {
    return this.actor.cred;
  }

  /**
   * Resolve on the in-memory tree. Resolution errnos deny; an unloaded directory defers; the
   * resolver's answers about the final name itself (EEXIST for `mkdir /`, EBUSY for `rmdir /`,
   * EINVAL for `rmdir .`) are not permission failures and are left to the handler.
   */
  resolve(path: string, opts: ResolveOpts): Found {
    const a = this.actor;
    if (!path.startsWith('/') && a.cwdIno !== '' && this.fs.tree.inode(a.cwdIno) === undefined)
      throw new Defer();
    const r = this.fs.resolveNow(a, path, opts);
    if (r.kind === 'load') throw new Defer();
    if (r.kind === 'err') {
      if (!STAGE5_ERRNOS.has(r.errno)) throw new Defer();
      return deny(r.errno, this.call, path, r.detail);
    }
    this.checkScope(r.path);
    return r;
  }

  /** An existing node (following the final symlink when `follow`). */
  node(path: string, follow: boolean): InodeRec {
    const r = this.resolve(path, { follow });
    return r.node ?? deny('ENOENT', this.call, path);
  }

  /** `fs.scope` on the resolved path (§3.3 stage 4, second half). */
  private checkScope(resolved: string): void {
    const pcb = this.caller.pcb;
    if (pcb.fsScope === null || !bitsToCaps(pcb.caps).includes('fs.scope')) return;
    if (resolved === '.' || !resolved.startsWith('/')) return;
    const allowed = pcb.fsScope.map((p) => normalisePath(p, '/'));
    if (!allowed.some((prefix) => isUnder(resolved, prefix))) {
      throw new Deny(
        new KernelError('EPERM', { reason: 'scope', path: resolved }, 'outside the allowed scope'),
      );
    }
  }

  /** Throw a perm.ts check result (EACCES or EPERM) for `path`. */
  check(c: Check, path: string): void {
    if (c !== null) deny(c, this.call, path);
  }
}

/** Run a gate: the error to reply, or null to go on to the handler. Never throws (ABI-12). */
export function gate(
  fs: KernelFs,
  caller: Caller,
  call: CallName,
  rule: (g: Gate) => void,
): KernelError | null {
  if (!fs.mounted) return null;
  try {
    rule(new Gate(fs, caller, call));
    return null;
  } catch (e) {
    if (e instanceof Deny) return e.error;
    // Defer, or anything unexpected: the handler repeats every check (and reports bugs as EIO).
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The rules of §3.6.2, one per call
// ---------------------------------------------------------------------------------------------

/** `stat`, `lstat`, `readlink`, `statfs`: x on every ancestor (resolution alone). */
export function ruleLookup(path: string, follow: boolean): (g: Gate) => void {
  return (g) => {
    g.node(path, follow);
  };
}

export function ruleReaddir(a: ArgsOf<'readdir'>): (g: Gate) => void {
  return (g) => {
    const dir = g.node(a.path, true);
    if (dir.type !== 'd') return deny('ENOTDIR', g.call, a.path);
    g.check(checkReaddir(g.cred, dir, a.plus === true), a.path);
  };
}

export function ruleOpen(a: ArgsOf<'open'>): (g: Gate) => void {
  return (g) => {
    const read = a.flags === 'r' || a.flags === 'rw';
    const write = a.flags !== 'r' || a.trunc === true;
    if (a.create === true) {
      const slot = g.resolve(a.path, { follow: false, parent: 'create' });
      if (slot.node === null) {
        if (slot.parent !== null) g.check(checkCreate(g.cred, slot.parent), a.path);
        return;
      }
      if (a.excl === true) return; // EEXIST is the handler's
    }
    const n = g.resolve(a.path, { follow: a.follow }).node;
    if (n === null || n.type === 'l') return; // ENOENT / ELOOP (no-follow) are the handler's
    if (n.type === 'd') return; // EISDIR for write access is the handler's
    g.check(checkOpen(g.cred, n, read, write), a.path);
  };
}

export function ruleCreate(path: string): (g: Gate) => void {
  return (g) => {
    const slot = g.resolve(path, { follow: false, parent: 'create' });
    if (slot.node === null && slot.parent !== null) g.check(checkCreate(g.cred, slot.parent), path);
  };
}

export function ruleMkdir(a: ArgsOf<'mkdir'>): (g: Gate) => void {
  // With `parents`, every missing level is checked by the planner as it is created.
  return a.parents === true ? () => {} : ruleCreate(a.path);
}

/** `unlink`, `rmdir`: w+x on the parent, then the sticky rule (EACCES before EPERM). */
export function ruleRemove(path: string): (g: Gate) => void {
  return (g) => {
    const e = g.resolve(path, { follow: false, parent: 'remove' });
    if (e.parent === null || e.node === null) return; // '/', or ENOENT: the handler's
    g.check(checkRemove(g.cred, e.parent, e.node), path);
  };
}

export function ruleRename(a: ArgsOf<'rename'>): (g: Gate) => void {
  return (g) => {
    const s = g.resolve(a.from, { follow: false, parent: 'remove' });
    const d = g.resolve(a.to, { follow: false, parent: 'remove' });
    if (s.parent === null || s.node === null || d.parent === null) return;
    const same = s.parent.ino === d.parent.ino;
    if (same && s.name === d.name) return;
    const target = d.node !== null && d.node.ino !== s.node.ino ? d.node : null;
    g.check(checkRename(g.cred, s.parent, s.node, d.parent, target, same), a.from);
  };
}

export function ruleLink(a: ArgsOf<'link'>): (g: Gate) => void {
  return (g) => {
    const src = g.node(a.existing, false);
    const slot = g.resolve(a.path, { follow: false, parent: 'create' });
    if (slot.node !== null || slot.parent === null) return;
    g.check(checkLink(g.cred, src, slot.parent), a.path);
  };
}

export function ruleChmod(path: string): (g: Gate) => void {
  return (g) => {
    g.check(checkChmod(g.cred, g.node(path, true)), path);
  };
}

export function ruleChown(path: string): (g: Gate) => void {
  return (g) => {
    g.node(path, true);
    g.check(checkChown(g.cred), path);
  };
}

export function ruleWriteTo(a: ArgsOf<'writeFile'>): (g: Gate) => void {
  return (g) => {
    const slot = g.resolve(a.path, { follow: false, parent: 'create' });
    if (slot.node === null) {
      // A new name needs w+x on the parent; with `create: false` the handler answers ENOENT.
      if (slot.parent !== null && a.create) g.check(checkCreate(g.cred, slot.parent), a.path);
      return;
    }
    const n = g.resolve(a.path, { follow: true }).node;
    if (n === null || n.type !== 'f') return;
    g.check(checkOpen(g.cred, n, false, true), a.path);
  };
}

export function ruleTruncate(a: ArgsOf<'truncate'>): (g: Gate) => void {
  return (g) => {
    if (!('path' in a)) {
      if (!g.fs.fds.has(g.actor.pid, a.fd)) deny('EBADF', g.call);
      return;
    }
    const n = g.node(a.path, true);
    if (n.type !== 'f') return;
    g.check(checkOpen(g.cred, n, false, true), a.path);
  };
}

export function ruleUtimes(a: ArgsOf<'utimes'>): (g: Gate) => void {
  return (g) => {
    const n = g.node(a.path, true);
    const explicit = typeof a.atime === 'number' || typeof a.mtime === 'number';
    g.check(checkUtimes(g.cred, n, explicit), a.path);
  };
}

export function ruleCopy(a: ArgsOf<'copy'>): (g: Gate) => void {
  return (g) => {
    const src = g.node(a.from, a.recursive !== true);
    g.check(checkCopySource(g.cred, src), a.from);
    let into: InodeRec | null = null;
    try {
      into = g.resolve(a.to, { follow: true }).node;
    } catch (e) {
      if (!(e instanceof Deny) || e.error.errno !== 'ENOENT') throw e;
    }
    if (into?.type === 'd') {
      g.check(checkCreate(g.cred, into), a.to);
      return;
    }
    const slot = g.resolve(a.to, { follow: false, parent: 'create' });
    if (slot.node === null && slot.parent !== null) g.check(checkCreate(g.cred, slot.parent), a.to);
  };
}

/** `quota` of another uid is root-only (EPERM `root-only`). */
export function ruleQuota(a: ArgsOf<'quota'>): (g: Gate) => void {
  return (g) => {
    if (a.uid !== undefined && a.uid !== g.cred.uid && g.cred.uid !== 0) deny('EPERM', g.call);
  };
}

/** fd calls: the fd must be one of the caller's own open files (EBADF). */
export function ruleOwnFd(fd: number): (g: Gate) => void {
  return (g) => {
    if (!g.fs.fds.has(g.actor.pid, fd)) deny('EBADF', g.call);
  };
}

/**
 * `batch`: an agent-class caller needs a plan token (EPERM `no-token`) that the agent subsystem's
 * verifier accepts (§5.4). Each op is authorised by its planner in phase 1 against the batch's own
 * overlay, because op i may depend on ops 0..i−1 (a `mkdir` followed by a `write` inside it).
 */
export function ruleBatch(
  a: ArgsOf<'batch'>,
  verify: ((caller: Caller, args: ArgsOf<'batch'>) => KernelError | null) | undefined,
): (g: Gate) => void {
  return (g) => {
    if (g.caller.pcb.cls !== 'agent') return;
    if (a.token === undefined || verify === undefined) deny('EPERM', g.call, undefined, 'no-token');
    const denied = verify(g.caller, a);
    if (denied !== null) throw new Deny(denied);
  };
}
