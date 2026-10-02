/**
 * Port records: the kernel's view of the two channels that carry system calls (syscall-abi.md
 * §3.1, §3.2). Caller identity is a function of the port and the dispatch state only (C3,
 * INV-ABI-3); nothing in a frame is trusted except as a consistency check.
 */
import type { SysRes } from '@plotinium/protocol';

import type { PCB } from '../proc/pcb.ts';

/** Executor control port. `slice` is written by the scheduler at dispatch. */
export interface ExecPortRec {
  readonly kind: 'exec';
  readonly index: number;
  slice: { pid: number; sliceSeq: number } | null;
  /** Identity mismatches seen on this executor (a second one terminates it). */
  suspect: number;
  /** Deliver a reply to the process `pid` (the host wraps it in a dispatch or resume frame). */
  reply(pid: number, res: SysRes): void;
}

export type ViewCloseReason = 'window-closed' | 'process-exit' | 'abi-mismatch';

/** View port, bound to `(pid, wid)` at `window.create`. */
export interface ViewPortRec {
  readonly kind: 'view';
  readonly pid: number;
  readonly wid: number;
  open: boolean;
  /** Replies still owed on this port (at most 64, §3.1 rule 5). */
  outstanding: number;
  /** Whether the view completed the ABI `hello` handshake. */
  greeted: boolean;
  reply(res: SysRes): void;
  close(reason: ViewCloseReason): void;
}

export type PortRec = ExecPortRec | ViewPortRec;

/** Who is calling, derived from the port (never from message fields). */
export interface Caller {
  readonly pcb: PCB;
  readonly origin: 'E' | 'V';
  /** The bound window of a view port; null for executor callers. */
  readonly wid: number | null;
}

export function execPort(index: number, reply: (pid: number, res: SysRes) => void): ExecPortRec {
  return { kind: 'exec', index, slice: null, suspect: 0, reply };
}

export function viewPort(
  pid: number,
  wid: number,
  reply: (res: SysRes) => void,
  close: (reason: ViewCloseReason) => void,
): ViewPortRec {
  const rec: ViewPortRec = {
    kind: 'view',
    pid,
    wid,
    open: true,
    outstanding: 0,
    greeted: false,
    reply,
    close: (reason) => {
      if (!rec.open) return;
      rec.open = false;
      close(reason);
    },
  };
  return rec;
}
