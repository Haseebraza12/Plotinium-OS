/**
 * `getpid` and `proc.list` (syscall-abi.md §4.4.1). Both are class F, origin EV, no capability.
 */
import type { CallImpl } from '../ipc/handlers.ts';
import { listProcs } from '../proc/info.ts';
import type { SyscallContext } from './context.ts';

export function getpid(): CallImpl<'getpid'> {
  return {
    handle: ({ pcb }) => ({ pid: pcb.pid, ppid: pcb.ppid, pgid: pcb.pgid, sid: pcb.sid }),
  };
}

export function procList(k: SyscallContext): CallImpl<'proc.list'> {
  return {
    handle: ({ pcb }, args) => {
      const filter: { uid?: number; pgid?: number; cursor?: string; limit?: number } = {};
      if (args.uid !== undefined) filter.uid = args.uid;
      if (args.pgid !== undefined) filter.pgid = args.pgid;
      if (args.cursor !== undefined) filter.cursor = args.cursor;
      if (args.limit !== undefined) filter.limit = args.limit;
      const page = listProcs(k.procs.table.values(), filter, {
        viewer: pcb.cred,
        users: k.users,
        epochAtZero: k.epochAtZero,
        now: k.clock.now(),
      });
      return page.next === undefined
        ? { procs: page.procs }
        : { procs: page.procs, next: page.next };
    },
  };
}
