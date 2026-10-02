/**
 * Process groups, sessions and TTY job control (processes-and-scheduling.md §3.17.2, KPS-09;
 * syscall-abi.md §3.9 "TTY job control").
 *
 * Each TTY that is a controlling terminal has a binding `{tty, sid, fgPgid}`. The TTY device
 * itself (line discipline, `tty.open`, `tty.input`, attributes) belongs to the TTY subsystem; this
 * module owns only the process side: which group is in the foreground, `tcsetpgrp` /
 * `tcgetpgrp`, the kernel-authority `ttySignal` (Ctrl-C, Ctrl-Z, Ctrl-\ go to the foreground group
 * whatever its uid), SIGTTIN for background readers and SIGHUP on hang-up.
 *
 * Integration: the TTY subsystem calls `attach(tty, sid, pgid)` when a session leader opens its
 * controlling TTY, `ttySignal` from the line discipline, `checkRead` before a TTY read, and
 * `hangup` when the Terminal window closes. It may install `setFdResolver` so that `tcsetpgrp`
 * maps an fd to its TTY; the default treats fds 0–2 of a process with a controlling TTY as that
 * TTY.
 */
import type { SignalName } from '@plotinium/protocol';

import { KernelError } from '../errors.ts';
import type { PCB } from './pcb.ts';
import { dispositionOf } from './signals.ts';

export interface TtyBinding {
  readonly tty: number;
  sid: number;
  fgPgid: number;
}

/** fd → TTY number of `pcb`, or null when the fd is not a TTY. */
export type FdTtyResolver = (pcb: PCB, fd: number) => number | null;

export interface JobControlDeps {
  /** Every live process of group `pgid` (the process table scan). */
  readonly members: (pgid: number) => readonly PCB[];
  /** Deliver `sig` to every member of `pgid` with kernel authority; returns the count. */
  readonly signalGroup: (pgid: number, sig: SignalName) => number;
}

export class JobControl {
  private readonly deps: JobControlDeps;
  private readonly ttys = new Map<number, TtyBinding>();
  private resolver: FdTtyResolver | null = null;

  constructor(deps: JobControlDeps) {
    this.deps = deps;
  }

  setFdResolver(fn: FdTtyResolver | null): void {
    this.resolver = fn;
  }

  ttyOfFd(pcb: PCB, fd: number): number | null {
    if (this.resolver !== null) return this.resolver(pcb, fd);
    return fd >= 0 && fd <= 2 ? pcb.tty : null;
  }

  /** `tty` becomes the controlling terminal of session `sid`, foreground group `fgPgid`. */
  attach(tty: number, sid: number, fgPgid: number): TtyBinding {
    const b: TtyBinding = { tty, sid, fgPgid };
    this.ttys.set(tty, b);
    return b;
  }

  detach(tty: number): void {
    this.ttys.delete(tty);
  }

  binding(tty: number): TtyBinding | undefined {
    return this.ttys.get(tty);
  }

  foreground(tty: number): number | null {
    return this.ttys.get(tty)?.fgPgid ?? null;
  }

  /** Whether `pcb` is in the foreground group of its controlling TTY (ps flag `+`). */
  isForeground(pcb: PCB): boolean {
    if (pcb.tty === null) return false;
    return this.ttys.get(pcb.tty)?.fgPgid === pcb.pgid;
  }

  /** Every foreground pid of the TTY (focus pinning of the focused Terminal, MEM-02). */
  foregroundPids(tty: number): number[] {
    const fg = this.foreground(tty);
    if (fg === null) return [];
    return this.deps.members(fg).map((p) => p.pid);
  }

  private bindingFor(caller: PCB, fd: number): TtyBinding {
    const tty = this.ttyOfFd(caller, fd);
    if (tty === null)
      throw new KernelError('ENOTTY', undefined, `fd ${String(fd)} is not a terminal`);
    let b = this.ttys.get(tty);
    if (b === undefined && caller.tty === tty) b = this.attach(tty, caller.sid, caller.pgid);
    if (b === undefined) throw new KernelError('ENOTTY', undefined, 'not a controlling terminal');
    return b;
  }

  /**
   * `tcsetpgrp(fd, pgid)` (§3.17.2): only a process of the TTY's session, to a group of that
   * session (EPERM). A background caller that does not ignore SIGTTOU gets SIGTTOU and the call
   * is refused (POSIX); shells ignore SIGTTOU so they can take the terminal back.
   */
  tcsetpgrp(caller: PCB, fd: number, pgid: number): void {
    const b = this.bindingFor(caller, fd);
    if (caller.sid !== b.sid)
      throw new KernelError('EPERM', { reason: 'foreign' }, 'not in the terminal session');
    const group = this.deps.members(pgid).filter((p) => p.state !== 'TERMINATED');
    if (group.length === 0)
      throw new KernelError('EPERM', undefined, `no process group ${String(pgid)}`);
    if (group.some((p) => p.sid !== b.sid))
      throw new KernelError('EPERM', { reason: 'foreign' }, 'the group is in another session');
    if (b.fgPgid !== caller.pgid && dispositionOf(caller, 'SIGTTOU') === 'default') {
      this.deps.signalGroup(caller.pgid, 'SIGTTOU');
      throw new KernelError('EPERM', undefined, 'background process group (SIGTTOU)');
    }
    b.fgPgid = pgid;
  }

  tcgetpgrp(caller: PCB, fd: number): number {
    return this.bindingFor(caller, fd).fgPgid;
  }

  /** The line discipline's keys (Ctrl-C, Ctrl-Z, Ctrl-\) with kernel authority (§3.17.2). */
  ttySignal(tty: number, sig: SignalName): number {
    const fg = this.foreground(tty);
    return fg === null ? 0 : this.deps.signalGroup(fg, sig);
  }

  /**
   * Before a TTY read: a background reader's group gets SIGTTIN (default: stop, `Stopped (tty
   * input)`) and the read must not proceed. Returns true when the read may go ahead.
   */
  checkRead(pcb: PCB, tty: number): boolean {
    const b = this.ttys.get(tty);
    if (b === undefined || b.fgPgid === pcb.pgid) return true;
    if (dispositionOf(pcb, 'SIGTTIN') === 'ignore') return false;
    this.deps.signalGroup(pcb.pgid, 'SIGTTIN');
    return false;
  }

  /** Terminal window closed or session leader exited: SIGHUP then SIGCONT to the foreground group. */
  hangup(tty: number): void {
    const fg = this.foreground(tty);
    if (fg !== null) {
      this.deps.signalGroup(fg, 'SIGHUP');
      this.deps.signalGroup(fg, 'SIGCONT');
    }
    this.detach(tty);
  }

  /** The TTYs whose session is `sid` (kill-path step 7). */
  ttysOfSession(sid: number): number[] {
    const out: number[] = [];
    for (const b of this.ttys.values()) if (b.sid === sid) out.push(b.tty);
    return out;
  }
}
