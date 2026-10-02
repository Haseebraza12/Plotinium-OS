/**
 * PID allocation (processes-and-scheduling.md §3.3.2, KPS-02).
 *
 * - pid 0 is never allocated (it means "the kernel" in klog, audit and events);
 * - pid 1 is `init`, created before any other PCB;
 * - `alloc()` returns the first p ≥ nextPid (wrapping from 32,767 to 2) that is not a live pid, an
 *   unreaped zombie, or the pgid or sid of any live process, then sets nextPid = p + 1;
 * - PROC_MAX and NPROC_PER_UID are checked before any search (EAGAIN).
 *
 * Because PROC_MAX (4,096) ≪ PID_MAX, the scan ends within PROC_MAX + (live groups and sessions)
 * probes; amortised O(1).
 */
import { KernelError } from '../errors.ts';
import type { ProcessTable } from './table.ts';

export const PID_MAX = 32_767;
export const INIT_PID = 1;
export const FIRST_PID = 2;
export const PROC_MAX = 4_096;
export const NPROC_PER_UID = 1_024;

export class PidAllocator {
  private nextPid = FIRST_PID;
  private readonly procs: ProcessTable;
  private readonly procMax: number;
  private readonly nprocPerUid: number;

  constructor(procs: ProcessTable, limits: { procMax?: number; nprocPerUid?: number } = {}) {
    this.procs = procs;
    this.procMax = limits.procMax ?? PROC_MAX;
    this.nprocPerUid = limits.nprocPerUid ?? NPROC_PER_UID;
  }

  /** The pid the next scan starts from (for tests and `sched`). */
  get cursor(): number {
    return this.nextPid;
  }

  /** O(n): pgids and sids named by live (non-reaped) processes. */
  private groupIds(): Set<number> {
    const ids = new Set<number>();
    for (const p of this.procs.values()) {
      if (p.state === 'TERMINATED') continue;
      ids.add(p.pgid);
      ids.add(p.sid);
    }
    return ids;
  }

  /** Throws EAGAIN when a limit is reached or no pid is free. */
  alloc(uid: number): number {
    if (this.procs.size >= this.procMax)
      throw new KernelError('EAGAIN', { reason: 'pid-space' }, 'process table full');
    if (uid !== 0) {
      let mine = 0;
      for (const p of this.procs.values()) if (p.cred.uid === uid) mine++;
      if (mine >= this.nprocPerUid)
        throw new KernelError('EAGAIN', { reason: 'pid-space' }, 'per-user process limit');
    }
    const groups = this.groupIds();
    let p = this.nextPid;
    for (let probes = 0; probes < PID_MAX; probes++) {
      if (!this.procs.has(p) && !groups.has(p)) {
        this.nextPid = p >= PID_MAX ? FIRST_PID : p + 1;
        return p;
      }
      p = p >= PID_MAX ? FIRST_PID : p + 1;
    }
    throw new KernelError('EAGAIN', { reason: 'pid-space' }, 'no free pid');
  }
}
