/**
 * The memory system calls (syscall-abi.md §4.4.5; semantics in memory-and-paging.md §3.7, §4.2):
 * mem.alloc, mem.declare, mem.free, mem.stat, mem.prefetch, mem.hint.
 *
 * Shape mapping (the mm agent's integration notes; TODO(protocol) (b) there): protocol
 * `mem.alloc {bytes, key?, kind?: 'state' | 'buffer'} → {segId, bytes}` maps to the page model
 * `MemoryManager.alloc {kind: 'logical' | 'chunk', size, label} → {pageIds}`: `buffer` is `chunk`
 * (256 KiB pages), the default `state` is one `logical` page. The allocation's page ids are
 * consecutive, and `segId` is its first page id PLUS ONE (page ids start at 0 for a process without
 * a state page, and the protocol's `SegId` starts at 1; `segIdOf` / `firstPageOf`), so the
 * executor's `ctx.mem` knows every page id (`segId − 1 … segId − 1 + ⌈bytes / PAGE_CHUNK⌉ − 1`) and
 * `mem.free {segId}` frees the whole allocation.
 *
 * Every call reserves before it grants (MEM-06): the caller stays BLOCKED `mem` until reclaim has
 * made room. A process spawned before the memory manager was attached is registered and admitted
 * on its first memory call.
 */
import type { MemStat } from '@plotinium/protocol';

import { KernelError } from '../errors.ts';
import type { HandlerRegistry } from '../ipc/handlers.ts';
import type { MemoryManager } from '../mm/mm.ts';
import { DEFAULT_PARAMS } from '../mm/params.ts';
import type { PCB } from './pcb.ts';
import type { ProcessSystem } from './system.ts';
import { toKernelError } from './system.ts';

/** The protocol segment id of an allocation whose first page id is `firstPageId`. */
export function segIdOf(firstPageId: number): number {
  return firstPageId + 1;
}

/** The first page id of the allocation `segId` (the inverse of `segIdOf`). */
export function firstPageOf(segId: number): number {
  return segId - 1;
}

export interface MemSyscallDeps {
  readonly sys: ProcessSystem;
  readonly osSessionId: () => string;
}

/** `mem.stat` before the `mm` service is up: the configured budget, nothing accounted. */
function emptyStat(): MemStat {
  return {
    budget: DEFAULT_PARAMS.budget,
    accounted: 0,
    reservedWaiting: 0,
    resident: 0,
    swappedLocal: 0,
    swappedRemote: 0,
    speculative: 0,
    embed: { bytes: 0, state: 'absent' },
    kernel: 0,
    faults: 0,
    faultsPerSec: 0,
    hitRatio: 1,
    bytesIn: 0,
    bytesOut: 0,
    procs: [],
  };
}

export function registerMemSyscalls(reg: HandlerRegistry, d: MemSyscallDeps): void {
  const { sys } = d;
  /** pid → segId → page ids. */
  const segments = new Map<number, Map<number, number[]>>();

  const mmFor = async (pcb: PCB): Promise<MemoryManager> => {
    const mm = sys.mm;
    if (mm === null)
      throw new KernelError(
        'EAGAIN',
        { reason: 'no-free-memory' },
        'the memory manager is not running yet',
      );
    if (!mm.has(pcb.pid)) {
      mm.register(pcb.pid, {
        uid: pcb.cred.uid,
        app: pcb.name,
        label: (pcb.argv[0] ?? pcb.name).slice(0, 64),
        osSession: d.osSessionId(),
        checkpointable: pcb.checkpointable,
      });
      await mm.admit(pcb.pid, { prio: pcb.effPrio });
    }
    return mm;
  };
  const wrap = async <T>(f: () => Promise<T> | T): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw toKernelError(e);
    }
  };

  reg.register('mem.alloc', {
    handle: ({ pcb }, args) =>
      wrap(async () => {
        const mm = await mmFor(pcb);
        const { pageIds } = await mm.alloc(pcb.pid, {
          kind: args.kind === 'buffer' ? 'chunk' : 'logical',
          size: args.bytes,
          ...(args.key === undefined ? {} : { label: args.key }),
          prio: pcb.effPrio,
        });
        const first = pageIds[0];
        if (first === undefined) throw new KernelError('EINVAL', undefined, 'empty allocation');
        const segId = segIdOf(first);
        let segs = segments.get(pcb.pid);
        if (segs === undefined) {
          segs = new Map();
          segments.set(pcb.pid, segs);
        }
        segs.set(segId, pageIds);
        return { segId, bytes: args.bytes };
      }),
  });

  reg.register('mem.declare', {
    handle: ({ pcb }, args) =>
      wrap(async () => {
        const mm = await mmFor(pcb);
        await mm.declare(pcb.pid, args.key, args.bytes, { prio: pcb.effPrio });
        return { key: args.key, bytes: args.bytes };
      }),
  });

  reg.register('mem.free', {
    handle: ({ pcb }, args) =>
      wrap(async () => {
        const mm = await mmFor(pcb);
        if ('key' in args) return { bytes: mm.undeclare(pcb.pid, args.key) };
        const pages = segments.get(pcb.pid)?.get(args.segId);
        if (pages === undefined)
          throw new KernelError(
            'EINVAL',
            { reason: 'unknown-segment' },
            `no segment ${String(args.segId)}`,
          );
        const r = mm.free(pcb.pid, pages);
        segments.get(pcb.pid)?.delete(args.segId);
        return { bytes: r.freedBytes };
      }),
  });

  reg.register('mem.stat', {
    handle: ({ pcb }, args) =>
      wrap(() => {
        const mm = sys.mm;
        if (mm === null) return emptyStat();
        if (args.pid !== undefined && !mm.has(args.pid))
          throw new KernelError('ESRCH', undefined, `pid ${String(args.pid)} has no memory record`);
        return mm.memStat({
          ...(args.pid === undefined ? {} : { pid: args.pid }),
          callerUid: pcb.cred.uid,
        });
      }),
  });

  reg.register('mem.prefetch', {
    handle: (_caller, args) =>
      wrap(async () => {
        const mm = sys.mm;
        if (mm === null) throw new KernelError('EAGAIN', { reason: 'no-free-memory' });
        if (!('pid' in args)) {
          // App and file warm-up live in the pre-fetch jobs (predictive-prefetch.md); nothing to
          // page in for them here yet.
          return { bytes: 0, pages: 0 };
        }
        if (!mm.has(args.pid)) throw new KernelError('ESRCH');
        return mm.prefetch(args.pid, args.pages);
      }),
  });

  reg.register('mem.hint', {
    handle: (_caller, args) =>
      wrap(() => {
        sys.mm?.setHint(args.app, args.ttlMs);
        return {};
      }),
  });

  // Segment maps die with their process.
  sys.onProcessGone((pid) => {
    segments.delete(pid);
  });
}
