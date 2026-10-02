/**
 * Kernel log records (processes-and-scheduling.md §4.6, syscall-abi.md §3.7 trace level,
 * boot-and-services.md §4.5 `KlogLine`).
 *
 * The ring assigns `seq`; producers pass everything else. `t` is the kernel monotonic clock (ms).
 */
import type { Errno, PState } from '@plotinium/protocol';

export type KlogLevel = 'info' | 'warn' | 'degraded' | 'fail' | 'panic';

/** One lifecycle transition (PROC-06). `from === to` is an annotation (waitingOn change). */
export interface KlogProc {
  readonly kind: 'proc';
  readonly t: number;
  readonly pid: number;
  /** Owner uid, so `dmesg` can hide other users' processes after they are reaped. */
  readonly uid?: number;
  readonly from: PState | null;
  readonly to: PState | null;
  readonly reason: string;
  readonly waitingOn?: string;
  readonly by?: number;
  readonly exitCode?: number;
  readonly detail?: string;
}

/** A free-text line from a subsystem (boot log, services, warnings). */
export interface KlogLine {
  readonly kind: 'line';
  readonly t: number;
  readonly sub: string;
  readonly level: KlogLevel;
  readonly msg: string;
  readonly pid?: number;
}

/** A trace-level audit record (syscall-abi.md §3.7): `{t, pid, uid, call, errno, µs}`. */
export interface KlogTrace {
  readonly kind: 'trace';
  readonly t: number;
  readonly pid: number;
  readonly uid: number;
  readonly call: string;
  readonly errno: Errno | null;
  readonly us: number;
}

/** Memory-manager record (memory-and-paging.md §4.6); structurally the mm module's `KlogMem`. */
export interface KlogMem {
  readonly kind: 'mem';
  readonly t: number;
  readonly ev: string;
  readonly pid?: number;
  readonly pageId?: number;
  readonly bytes?: number;
  readonly ms?: number;
  readonly detail?: string;
}

export type KlogInput = KlogProc | KlogLine | KlogTrace | KlogMem;
export type KlogRecord = KlogInput & { readonly seq: number };

/** Severity of a record: lines carry their own, trace errors are warnings, the rest is info. */
export function levelOf(rec: KlogInput): KlogLevel {
  if (rec.kind === 'line') return rec.level;
  if (rec.kind === 'trace') return rec.errno === null ? 'info' : 'warn';
  return 'info';
}
