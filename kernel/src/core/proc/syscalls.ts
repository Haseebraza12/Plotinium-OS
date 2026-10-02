/**
 * The process and job-control system calls (syscall-abi.md §4.4.1; semantics in
 * processes-and-scheduling.md §3.6, §3.9, §3.17, §4.5): spawn, exit, wait, kill, nice,
 * setpriority, getpriority, setpgid, sig.action, proc.info, proc.cred, getcwd, chdir, umask,
 * tcsetpgrp, tcgetpgrp, sleep and uptime.
 *
 * Registered by `createKernel` BEFORE the I/O layer (`installIo`), so a subsystem that owns a
 * richer implementation (for example `chdir` resolved by the VFS) simply registers over it.
 */
import { bitsToCaps } from '@plotinium/protocol';

import { KernelError } from '../errors.ts';
import type { HandlerRegistry } from '../ipc/handlers.ts';
import { NO_REPLY } from '../ipc/handlers.ts';
import { normalisePath } from '../ipc/scope.ts';
import { toProcInfo } from './info.ts';
import type { ProcManager } from './manager.ts';
import type { PCB } from './pcb.ts';
import { setDisposition } from './signals.ts';
import type { ProcessSystem } from './system.ts';
import type { UserDirectory } from './users.ts';

export interface ProcSyscallDeps {
  readonly procs: ProcManager;
  readonly sys: ProcessSystem;
  readonly users: UserDirectory;
  readonly now: () => number;
  /** Wall-clock epoch (ms) of kernel time 0. */
  readonly epochAtZero: number;
}

function schedulingOf(p: PCB): { priority: number; nice: number; effPrio: number } {
  return { priority: p.priority, nice: p.nice, effPrio: p.effPrio };
}

function mayControl(caller: PCB, target: PCB): boolean {
  return (
    caller.cred.uid === 0 ||
    caller.cred.uid === target.cred.uid ||
    bitsToCaps(caller.caps).includes('kill.other')
  );
}

export function registerProcSyscalls(reg: HandlerRegistry, d: ProcSyscallDeps): void {
  const { procs, sys } = d;
  const get = (pid: number): PCB => {
    const p = procs.get(pid);
    if (p === undefined) throw new KernelError('ESRCH', undefined, `no process ${String(pid)}`);
    return p;
  };

  reg.register('spawn', {
    handle: ({ pcb }, args) => sys.spawnSyscall(pcb, args),
  });

  reg.register('exit', {
    handle: ({ pcb }, args) => {
      sys.requestExit(pcb, args.code);
      return NO_REPLY;
    },
  });

  reg.register('wait', {
    handle: ({ pcb }, args) => sys.wait(pcb, args),
  });

  reg.register('kill', {
    handle: ({ pcb }, args) => sys.kill(pcb, args.pid, args.sig),
    securityRelevant: ({ pcb }, args) => {
      if (args.pid <= 0) return false;
      const t = procs.get(args.pid);
      return t !== undefined && (t.cred.uid !== pcb.cred.uid || t.kind !== 'user');
    },
  });

  reg.register('nice', {
    handle: ({ pcb }, args) => {
      if (args.inc < 0 && pcb.cred.uid !== 0)
        throw new KernelError('EPERM', { reason: 'root-only' }, 'a negative increment needs root');
      sys.setPriority(pcb, { nice: pcb.nice + args.inc });
      return schedulingOf(pcb);
    },
  });

  reg.register('setpriority', {
    handle: ({ pcb }, args) => {
      const targets =
        args.group === true
          ? procs
              .groupMembers(args.pid === 0 ? pcb.pgid : args.pid)
              .filter((p) => p.state !== 'TERMINATED')
          : [args.pid === 0 ? pcb : get(args.pid)];
      if (targets.length === 0) throw new KernelError('ESRCH', undefined, 'no such process group');
      for (const t of targets) {
        if (!mayControl(pcb, t) || t.kind !== 'user')
          throw new KernelError(
            'EPERM',
            { reason: 'owner' },
            `pid ${String(t.pid)} belongs to another user`,
          );
        const raises =
          (args.priority !== undefined && args.priority < t.priority) ||
          (args.nice !== undefined && args.nice < t.nice);
        if (raises && pcb.cred.uid !== 0)
          throw new KernelError('EPERM', { reason: 'root-only' }, 'raising priority needs root');
      }
      for (const t of targets) {
        sys.setPriority(t, {
          ...(args.priority === undefined ? {} : { priority: args.priority }),
          ...(args.nice === undefined ? {} : { nice: args.nice }),
        });
      }
      const first = targets[0] ?? pcb;
      return schedulingOf(first);
    },
    securityRelevant: ({ pcb }, args) => {
      if (args.pid === 0 || args.group === true) return false;
      return procs.get(args.pid)?.cred.uid !== pcb.cred.uid;
    },
  });

  reg.register('getpriority', {
    handle: (_c, args) => {
      const p = get(args.pid);
      return { ...schedulingOf(p), band: p.band };
    },
  });

  reg.register('setpgid', {
    handle: ({ pcb }, args) => {
      const target = args.pid === 0 ? pcb : get(args.pid);
      if (target !== pcb && target.ppid !== pcb.pid)
        throw new KernelError('ESRCH', undefined, 'not the caller or one of its children');
      if (target.sid !== pcb.sid)
        throw new KernelError('EPERM', { reason: 'foreign' }, 'another session');
      if (target.sessionLeader && target.sid === target.pid)
        throw new KernelError('EPERM', undefined, 'a session leader keeps its group');
      const pgid = args.pgid === 0 ? target.pid : args.pgid;
      if (pgid !== target.pid) {
        const group = procs.groupMembers(pgid).filter((p) => p.state !== 'TERMINATED');
        if (group.length === 0 || group.some((p) => p.sid !== pcb.sid))
          throw new KernelError(
            'EPERM',
            undefined,
            `no process group ${String(pgid)} in this session`,
          );
      }
      target.pgid = pgid;
      return { pgid };
    },
  });

  reg.register('sig.action', {
    handle: ({ pcb }, args) => ({ old: setDisposition(pcb, args.sig, args.action) }),
  });

  reg.register('proc.info', {
    handle: ({ pcb }, args) => {
      const p = get(args.pid);
      const info = toProcInfo(p, {
        viewer: pcb.cred,
        users: d.users,
        epochAtZero: d.epochAtZero,
        now: d.now(),
      });
      const own = pcb.cred.uid === 0 || pcb.cred.uid === p.cred.uid;
      return {
        ...info,
        ...(own ? { caps: bitsToCaps(p.caps) } : {}),
        ...(p.exitReason === null ? {} : { exitReason: p.exitReason }),
      };
    },
  });

  reg.register('proc.cred', {
    handle: ({ pcb }) => {
      const user = d.users.nameOf(pcb.cred.uid);
      const info = sys.hooks.userInfo?.(pcb.cred.uid);
      const home = info?.home ?? (pcb.cred.uid === 0 ? '/root' : `/home/${user}`);
      // Group names by gid (UI-012): a user name is not a group name, so the fallback is `g<gid>`.
      const groupNames =
        info?.groupNames ??
        pcb.cred.groups.map(
          (g) => sys.hooks.groupName?.(g) ?? (g === 0 ? 'root' : `g${String(g)}`),
        );
      return {
        uid: pcb.cred.uid,
        gid: pcb.cred.gid,
        groups: [...pcb.cred.groups],
        user,
        groupNames: [...groupNames],
        home,
        ruid: pcb.cred.ruid,
      };
    },
  });

  reg.register('getcwd', {
    handle: ({ pcb }) => ({ path: pcb.cwdPath, ino: pcb.cwdIno }),
  });

  reg.register('chdir', {
    handle: async ({ pcb }, args) => {
      const resolved = await (sys.hooks.resolveDir?.(pcb, args.path) ?? {
        path: normalisePath(args.path, pcb.cwdPath),
        ino: '',
      });
      pcb.cwdPath = resolved.path;
      pcb.cwdIno = resolved.ino;
      return resolved;
    },
  });

  reg.register('umask', {
    handle: ({ pcb }, args) => {
      const old = pcb.umask;
      if (args.mask !== undefined) pcb.umask = args.mask;
      return { old };
    },
  });

  reg.register('tcsetpgrp', {
    handle: ({ pcb }, args) => {
      sys.jobs.tcsetpgrp(pcb, args.fd, args.pgid);
      return {};
    },
  });

  reg.register('tcgetpgrp', {
    handle: ({ pcb }, args) => ({ pgid: sys.jobs.tcgetpgrp(pcb, args.fd) }),
  });

  reg.register('sleep', {
    handle: ({ pcb }, args) => sys.sleep(pcb, args.ms),
  });

  reg.register('uptime', {
    handle: () => {
      const uids = new Set<number>();
      for (const p of procs.table.values())
        if (p.kind === 'user' && p.state !== 'TERMINATED') uids.add(p.cred.uid);
      const [a, b, c] = sys.load;
      return {
        bootAt: Math.max(0, Math.floor(d.epochAtZero)),
        uptimeMs: Math.max(0, d.now()),
        users: uids.size,
        load: [a, b, c] as [number, number, number],
      };
    },
  });
}
