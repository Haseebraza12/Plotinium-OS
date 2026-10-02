/**
 * The memory manager's ports into the process system (memory-and-paging.md §4.3; the mm agent's
 * integration notes "HOST WIRING" and "KERNEL LIFECYCLE CALLS"):
 *
 *   - `memExecutorPort(sys)`: the §4.3 page frames (`checkpoint`, `pageOut`, `pageIn`, `release`)
 *     sent to the process's home executor, plus `restore` (placement + `load` from the state
 *     page). A releasing checkpoint first takes the process off the scheduler (`freeze`); a
 *     process that cannot be suspended right now answers EBUSY and the pager moves on.
 *   - `memHooks(sys, deps)`: `setWaiting` → PCB `waitingOn`, `suspended` / `resumed` → the
 *     PROC-06 transitions, events → the bus, records → klog, soft-limit flags → the PCB.
 *   - `createMemoryManager`: one call that builds the manager with both and attaches it.
 */
import type { EventData } from '@plotinium/protocol';

import type { EventBus } from '../events/bus.ts';
import type { Klog } from '../klog/klog.ts';
import type {
  CheckpointResult,
  ExecPage,
  MemExecutorPort,
  MemoryManagerDeps,
  MmHooks,
} from '../mm/mm.ts';
import { MemoryManager } from '../mm/mm.ts';
import type { MmClock } from '../mm/reserve.ts';
import type { TimerHeap } from '../sched/timers.ts';
import type { ProcManager } from './manager.ts';
import type { ProcessSystem } from './system.ts';

export function memExecutorPort(
  sys: ProcessSystem,
  pageSize: (pid: number, pageId: number) => number,
): MemExecutorPort {
  return {
    async pageOut(pid: number, pageIds: number[]): Promise<ExecPage[]> {
      const sizes = pageIds.map((id) => pageSize(pid, id));
      const r = await sys.memRequest(pid, (reqId) => ({
        t: 'pageOut',
        reqId,
        pid,
        pageIds,
        sizes,
      }));
      if (r.t !== 'pagedOut') throw new Error(`pageOut: unexpected ${r.t}`);
      return r.pages.map((pg) => ({
        pageId: pg.pageId,
        header: pg.header,
        body: pg.body,
        sha256: pg.sha256,
      }));
    },
    async checkpoint(pid: number, release: boolean): Promise<CheckpointResult> {
      if (release) sys.freeze(pid);
      let r;
      try {
        r = await sys.memRequest(pid, (reqId) => ({ t: 'checkpoint', reqId, pid, release }));
      } catch (e) {
        if (release) sys.thaw(pid);
        throw e;
      }
      if (r.t !== 'checkpointed') throw new Error(`checkpoint: unexpected ${r.t}`);
      if (!r.ok) {
        if (release) sys.thaw(pid);
        return { ok: false, errno: 'EINVAL', msg: r.msg };
      }
      return { ok: true, header: r.header, body: r.body, sha256: r.sha256, bytes: r.bytes };
    },
    async pageIn(pid: number, pageId: number, body: ArrayBuffer, sha256: string): Promise<void> {
      const r = await sys.memRequest(
        pid,
        (reqId) => ({ t: 'pageIn', reqId, pid, pageId, body, sha256 }),
        [body],
      );
      if (r.t !== 'pagedIn' || !r.ok) throw new Error(`pageIn of page ${String(pageId)} failed`);
    },
    async release(
      pid: number,
      pageIds: number[],
      dropProcess: boolean,
    ): Promise<{ bytes: number }> {
      const r = await sys.memRequest(pid, (reqId) => ({
        t: 'release',
        reqId,
        pid,
        pageIds,
        dropProcess,
      }));
      if (r.t !== 'released') throw new Error(`release: unexpected ${r.t}`);
      return { bytes: r.bytes };
    },
    restore(pid, page, from): Promise<void> {
      return sys.restore(pid, page, from);
    },
  };
}

/**
 * The executor port of the kernel's process system with page sizes read from the attached memory
 * manager: what a host passes as `MemoryLink.executor` when it builds the manager itself.
 */
export function kernelMemPort(sys: ProcessSystem): MemExecutorPort {
  return memExecutorPort(sys, (pid, pageId) => {
    try {
      return sys.mm?.page(pid, pageId).size ?? 0;
    } catch {
      return 0;
    }
  });
}

export interface MemHookDeps {
  readonly procs: ProcManager;
  readonly bus: EventBus;
  readonly klog: Klog;
  readonly now: () => number;
  /** Desktop notice (thrashing); default: a klog warning. */
  readonly notice?: (text: string) => void;
}

export function memHooks(sys: ProcessSystem, d: MemHookDeps): MmHooks {
  return {
    setWaiting: (pid, on) => {
      const p = d.procs.get(pid);
      if (p === undefined || on === null) return;
      if (p.state === 'BLOCKED' && p.waitingOn !== on) sys.annotate(p, on);
      else if (p.state === 'NEW') p.waitingOn = on;
    },
    suspended: (pid) => {
      sys.onSuspended(pid);
    },
    resumed: (pid) => {
      sys.onResumed(pid);
    },
    restoring: (pid, done, total) => {
      d.klog.line(
        d.now(),
        'mm',
        'info',
        `restoring pid ${String(pid)}: ${String(done)}/${String(total)} bytes`,
        pid,
      );
    },
    restored: (pid, bytes, ms) => {
      d.klog.line(
        d.now(),
        'mm',
        'info',
        `restored ${String(bytes)} bytes in ${String(Math.round(ms))} ms`,
        pid,
      );
    },
    event: <T extends 'mem.fault' | 'mem.evict' | 'mem.pressure'>(topic: T, data: EventData[T]) => {
      d.bus.publish(topic, data);
    },
    klog: (rec) => {
      d.klog.append(rec);
    },
    notice: (_kind, text) => {
      if (d.notice) d.notice(text);
      else d.klog.line(d.now(), 'mm', 'warn', text);
    },
    softLimit: (pid, over) => {
      const p = d.procs.get(pid);
      if (p !== undefined) p.mm.overSoftLimit = over;
    },
  };
}

/** The memory manager's clock on the kernel timer heap (KPS-13). */
export function timerHeapClock(timers: TimerHeap, now: () => number): MmClock {
  return {
    now,
    schedule: (ms, fn) => {
      const id = timers.arm(now() + Math.max(0, ms), () => fn(), { label: 'mm' });
      return () => {
        timers.cancel(id);
      };
    },
  };
}

export type MemoryOptions = Omit<MemoryManagerDeps, 'executor' | 'hooks' | 'clock'> & {
  readonly clock?: MmClock;
  readonly notice?: (text: string) => void;
};

/** Build the memory manager on this process system and attach it (the `mm` service start). */
export function createMemoryManager(
  sys: ProcessSystem,
  d: Omit<MemHookDeps, 'notice'>,
  opts: MemoryOptions,
): MemoryManager {
  let mm: MemoryManager | null = null;
  const size = (pid: number, pageId: number): number => {
    try {
      return mm?.page(pid, pageId).size ?? 0;
    } catch {
      return 0;
    }
  };
  const { notice, clock, ...rest } = opts;
  mm = new MemoryManager({
    ...rest,
    clock: clock ?? timerHeapClock(sys.timers, d.now),
    executor: memExecutorPort(sys, size),
    hooks: memHooks(sys, { ...d, ...(notice === undefined ? {} : { notice }) }),
  });
  sys.attachMemory(mm);
  return mm;
}
