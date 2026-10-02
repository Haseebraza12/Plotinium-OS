/**
 * `ProcInfo` rows for `proc.list` (syscall-abi.md §4.4.1): world-visible like `ps -e`, except that
 * the argv of other uids is reduced to argv[0] (privacy; root sees everything).
 */
import type { ProcInfo } from '@plotinium/protocol';

import type { PCB, ProcCred } from './pcb.ts';
import type { UserDirectory } from './users.ts';

export interface InfoContext {
  readonly viewer: ProcCred;
  readonly users: UserDirectory;
  /** Wall-clock epoch (ms) of kernel time 0. */
  readonly epochAtZero: number;
  /** Kernel clock now. */
  readonly now: number;
}

export function toProcInfo(pcb: PCB, ctx: InfoContext): ProcInfo {
  const sameUser = ctx.viewer.uid === 0 || ctx.viewer.uid === pcb.cred.uid;
  const lifeMs = Math.max(1, ctx.now - pcb.createdAt);
  const accesses = pcb.mm.hits + pcb.mm.faults;
  return {
    pid: pcb.pid,
    ppid: pcb.ppid,
    pgid: pcb.pgid,
    uid: pcb.cred.uid,
    user: ctx.users.nameOf(pcb.cred.uid),
    state: pcb.state,
    class: pcb.cls,
    waitingOn: pcb.waitingOn === null ? null : pcb.waitingOn.slice(0, 128),
    priority: pcb.priority,
    nice: pcb.nice,
    effPrio: pcb.effPrio,
    cpuPct: Math.min(100 * 64, (pcb.cpuTimeMs / lifeMs) * 100),
    cpuTimeMs: pcb.cpuTimeMs,
    residentBytes: pcb.residentBytes,
    swappedBytes: pcb.mm.pagedOutBytes,
    faults: pcb.mm.faults,
    hitRatio: accesses === 0 ? 1 : pcb.mm.hits / accesses,
    speculative: pcb.speculative,
    argv: sameUser ? [...pcb.argv] : pcb.argv.slice(0, 1),
    executor: pcb.worker,
    windows: [...pcb.windows].slice(0, 32),
    startedAt: Math.max(0, Math.floor(ctx.epochAtZero + pcb.createdAt)),
  };
}

export interface ListPage {
  readonly procs: ProcInfo[];
  readonly next?: string;
}

/**
 * One page of processes in pid order. The cursor is the decimal pid to continue after; an
 * unparsable cursor restarts from the beginning, which is always safe for a listing.
 */
export function listProcs(
  all: readonly PCB[],
  filter: { uid?: number; pgid?: number; cursor?: string; limit?: number },
  ctx: InfoContext,
): ListPage {
  const after = filter.cursor === undefined ? 0 : Number.parseInt(filter.cursor, 10) || 0;
  const limit = filter.limit ?? 1_024;
  const rows = all
    .filter((p) => p.pid > after)
    .filter((p) => filter.uid === undefined || p.cred.uid === filter.uid)
    .filter((p) => filter.pgid === undefined || p.pgid === filter.pgid)
    .sort((a, b) => a.pid - b.pid);
  const page = rows.slice(0, limit);
  const procs = page.map((p) => toProcInfo(p, ctx));
  const last = page[page.length - 1];
  return rows.length > limit && last !== undefined ? { procs, next: String(last.pid) } : { procs };
}
