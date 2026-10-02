/**
 * Registration of the file-system system calls with the kernel's handler registry (syscall-abi.md
 * §4.4.2). A call is reachable only once it is registered here (stage 2 answers ENOSYS before).
 *
 * Every call gets BOTH a stage-5 `authorize` (authorize.ts: path resolution and the coarse rwx rule
 * of its §3.6.2 row) and a handler (handlers.ts) that repeats every check in phase 1 against the
 * current tree (SYS-01: a permission check on every call).
 */
import type { ArgsOf, CallName } from '@plotinium/protocol';

import type { KernelError } from '../errors.ts';
import type { HandlerRegistry } from '../ipc/handlers.ts';
import type { Caller } from '../ipc/ports.ts';
import {
  gate,
  ruleBatch,
  ruleChmod,
  ruleChown,
  ruleCopy,
  ruleCreate,
  ruleLink,
  ruleLookup,
  ruleMkdir,
  ruleOpen,
  ruleOwnFd,
  ruleQuota,
  ruleReaddir,
  ruleRemove,
  ruleRename,
  ruleTruncate,
  ruleUtimes,
  ruleWriteTo,
} from './authorize.ts';
import { FsHandlers } from './handlers.ts';
import type { KernelFs } from './kfs.ts';

/** The calls this module registers, in catalogue order. */
export const FS_SYSCALLS = [
  'open',
  'read',
  'write',
  'writeFile',
  'close',
  'seek',
  'stat',
  'lstat',
  'fstat',
  'readdir',
  'mkdir',
  'rmdir',
  'unlink',
  'rename',
  'symlink',
  'readlink',
  'link',
  'chmod',
  'chown',
  'truncate',
  'utimes',
  'statfs',
  'quota',
  'copy',
  'batch',
] as const satisfies readonly CallName[];

export type FsSyscall = (typeof FS_SYSCALLS)[number];

export interface FsSyscallOptions {
  /**
   * Plan-token verification for agent-class `batch` callers (agentic-shell.md, syscall-abi.md
   * §5.4). Absent: agent batches are refused with EPERM `no-token`.
   */
  readonly verifyPlanToken?: (caller: Caller, args: ArgsOf<'batch'>) => KernelError | null;
}

/** Register every file-system call on `reg`. Returns the handler object (tests, other modules). */
export function registerFsSyscalls(
  reg: HandlerRegistry,
  fs: KernelFs,
  opts: FsSyscallOptions = {},
): FsHandlers {
  const h = new FsHandlers(fs);
  reg.register('open', {
    authorize: (c, a) => gate(fs, c, 'open', ruleOpen(a)),
    handle: (c, a) => h.open(c, a),
  });
  reg.register('read', {
    authorize: (c, a) => gate(fs, c, 'read', ruleOwnFd(a.fd)),
    handle: (c, a) => h.read(c, a),
  });
  reg.register('write', {
    authorize: (c, a) => gate(fs, c, 'write', ruleOwnFd(a.fd)),
    handle: (c, a) => h.write(c, a),
  });
  reg.register('writeFile', {
    authorize: (c, a) => gate(fs, c, 'writeFile', ruleWriteTo(a)),
    handle: (c, a) => h.writeFile(c, a),
  });
  reg.register('close', {
    authorize: (c, a) => gate(fs, c, 'close', ruleOwnFd(a.fd)),
    handle: (c, a) => h.close(c, a),
  });
  reg.register('seek', {
    authorize: (c, a) => gate(fs, c, 'seek', ruleOwnFd(a.fd)),
    handle: (c, a) => h.seek(c, a),
  });
  reg.register('stat', {
    authorize: (c, a) => gate(fs, c, 'stat', ruleLookup(a.path, a.follow)),
    handle: (c, a) => h.stat(c, a),
  });
  reg.register('lstat', {
    authorize: (c, a) => gate(fs, c, 'lstat', ruleLookup(a.path, false)),
    handle: (c, a) => h.lstat(c, a),
  });
  reg.register('fstat', {
    authorize: (c, a) => gate(fs, c, 'fstat', ruleOwnFd(a.fd)),
    handle: (c, a) => h.fstat(c, a),
  });
  reg.register('readdir', {
    authorize: (c, a) => gate(fs, c, 'readdir', ruleReaddir(a)),
    handle: (c, a) => h.readdir(c, a),
  });
  reg.register('mkdir', {
    authorize: (c, a) => gate(fs, c, 'mkdir', ruleMkdir(a)),
    handle: (c, a) => h.mkdir(c, a),
  });
  reg.register('rmdir', {
    authorize: (c, a) => gate(fs, c, 'rmdir', ruleRemove(a.path)),
    handle: (c, a) => h.rmdir(c, a),
  });
  reg.register('unlink', {
    authorize: (c, a) => gate(fs, c, 'unlink', ruleRemove(a.path)),
    handle: (c, a) => h.unlink(c, a),
  });
  reg.register('rename', {
    authorize: (c, a) => gate(fs, c, 'rename', ruleRename(a)),
    handle: (c, a) => h.rename(c, a),
  });
  reg.register('symlink', {
    authorize: (c, a) => gate(fs, c, 'symlink', ruleCreate(a.path)),
    handle: (c, a) => h.symlink(c, a),
  });
  reg.register('readlink', {
    authorize: (c, a) => gate(fs, c, 'readlink', ruleLookup(a.path, false)),
    handle: (c, a) => h.readlink(c, a),
  });
  reg.register('link', {
    authorize: (c, a) => gate(fs, c, 'link', ruleLink(a)),
    handle: (c, a) => h.link(c, a),
  });
  reg.register('chmod', {
    authorize: (c, a) => gate(fs, c, 'chmod', ruleChmod(a.path)),
    handle: (c, a) => h.chmod(c, a),
  });
  reg.register('chown', {
    authorize: (c, a) => gate(fs, c, 'chown', ruleChown(a.path)),
    handle: (c, a) => h.chown(c, a),
    securityRelevant: () => true,
  });
  reg.register('truncate', {
    authorize: (c, a) => gate(fs, c, 'truncate', ruleTruncate(a)),
    handle: (c, a) => h.truncate(c, a),
  });
  reg.register('utimes', {
    authorize: (c, a) => gate(fs, c, 'utimes', ruleUtimes(a)),
    handle: (c, a) => h.utimes(c, a),
  });
  reg.register('statfs', {
    authorize: (c, a) =>
      gate(fs, c, 'statfs', a.path === undefined ? () => {} : ruleLookup(a.path, true)),
    handle: (c, a) => h.statfs(c, a),
  });
  reg.register('quota', {
    authorize: (c, a) => gate(fs, c, 'quota', ruleQuota(a)),
    handle: (c, a) => h.quota(c, a),
  });
  reg.register('copy', {
    authorize: (c, a) => gate(fs, c, 'copy', ruleCopy(a)),
    handle: (c, a) => h.copy(c, a),
  });
  reg.register('batch', {
    authorize: (c, a) => gate(fs, c, 'batch', ruleBatch(a, opts.verifyPlanToken)),
    handle: (c, a) => h.batch(c, a),
  });
  return h;
}
