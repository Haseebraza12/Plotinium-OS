/**
 * Process manager: PCB creation, `init` at pid 1, termination, re-parenting and reaping
 * (processes-and-scheduling.md §3.2, §3.3, §3.4 rule 4, §3.16).
 *
 * The kill path's per-subsystem steps (fds, leases, windows, pages, executor slot) belong to the
 * VFS, lockd, the window mirror, mm and the scheduler; each registers a cleanup with
 * `onTerminate`, which runs once per process on entry to TERMINATED (PROC-07, INV-P7).
 */
import type { Cap, ProcClass } from '@plotinium/protocol';

import { KernelBug, KernelError } from '../errors.ts';
import type { Lifecycle, TransitionReason } from './lifecycle.ts';
import type { ExitReason, PCB, ProcCred, ProcKind, WaitReason } from './pcb.ts';
import { createPcb, isZombie } from './pcb.ts';
import { INIT_PID, PidAllocator } from './pid.ts';
import type { ProcessTable } from './table.ts';

export const ROOT_CRED: ProcCred = Object.freeze({
  uid: 0,
  gid: 0,
  groups: Object.freeze([]),
  ruid: 0,
});

export interface CreateProcessOptions {
  readonly ppid: number;
  readonly kind: ProcKind;
  readonly cls: ProcClass;
  readonly name: string;
  readonly argv?: readonly string[];
  readonly cred: ProcCred;
  readonly caps?: readonly Cap[];
  readonly pgid?: number;
  readonly sid?: number;
  readonly priority?: number;
  readonly nice?: number;
  readonly cwdPath?: string;
  /** Default: the parent's (with `cwdPath` defaulting to the parent's too). */
  readonly cwdIno?: string;
  readonly manifestPath?: string | null;
  readonly checkpointable?: boolean;
  readonly env?: ReadonlyMap<string, string>;
  /** Controlling TTY; default: inherited from the parent (§3.17.2). */
  readonly tty?: number | null;
  readonly umask?: number;
}

export type TerminateHook = (pcb: PCB) => void;

export interface ProcManagerDeps {
  readonly table: ProcessTable;
  readonly lifecycle: Lifecycle;
  readonly now: () => number;
  readonly limits?: { procMax?: number; nprocPerUid?: number };
}

export class ProcManager {
  readonly table: ProcessTable;
  readonly pids: PidAllocator;
  private readonly lifecycle: Lifecycle;
  private readonly now: () => number;
  private readonly hooks: TerminateHook[] = [];

  constructor(deps: ProcManagerDeps) {
    this.table = deps.table;
    this.lifecycle = deps.lifecycle;
    this.now = deps.now;
    this.pids = new PidAllocator(deps.table, deps.limits);
  }

  get(pid: number): PCB | undefined {
    return this.table.get(pid);
  }

  onTerminate(hook: TerminateHook): () => void {
    this.hooks.push(hook);
    return () => {
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  /** pid 1, created before any other PCB (§3.3.2 rule 2). It never exits. */
  createInit(): PCB {
    if (this.table.size > 0) throw new KernelBug('init must be the first process');
    const pcb = createPcb({
      pid: INIT_PID,
      ppid: 0,
      kind: 'kthread',
      cls: 'system',
      name: 'init',
      argv: ['init'],
      cred: ROOT_CRED,
      priority: 0,
      now: this.now(),
    });
    this.table.set(pcb.pid, pcb);
    this.lifecycle.spawned(pcb);
    this.park(pcb, 'wait:-1');
    return pcb;
  }

  /** Allocate a pid and a PCB in state NEW (spawn record and `proc.spawn` event). */
  create(opts: CreateProcessOptions): PCB {
    const parent = this.table.get(opts.ppid);
    if (!parent || parent.state === 'TERMINATED')
      throw new KernelError('ESRCH', undefined, 'parent is gone');
    const pid = this.pids.alloc(opts.cred.uid);
    const pcb = createPcb({
      pid,
      ppid: opts.ppid,
      pgid: opts.pgid ?? parent.pgid,
      sid: opts.sid ?? parent.sid,
      kind: opts.kind,
      cls: opts.cls,
      name: opts.name,
      argv: opts.argv ?? [opts.name],
      cred: opts.cred,
      caps: opts.caps ?? [],
      priority: opts.priority ?? 20,
      nice: opts.nice ?? 0,
      cwdPath: opts.cwdPath ?? parent.cwdPath,
      cwdIno: opts.cwdIno ?? (opts.cwdPath === undefined ? parent.cwdIno : ''),
      manifestPath: opts.manifestPath ?? null,
      checkpointable: opts.checkpointable ?? false,
      env: opts.env ?? parent.env,
      umask: opts.umask ?? parent.umask,
      tty: opts.tty === undefined ? parent.tty : opts.tty,
      now: this.now(),
    });
    this.table.set(pid, pcb);
    parent.children.add(pid);
    this.lifecycle.spawned(pcb);
    return pcb;
  }

  /**
   * An in-kernel process (kthread or started service) that runs as event handlers: it is
   * admitted, dispatched once and then sleeps BLOCKED on `waitingOn`, so `ps` shows it sleeping.
   */
  park(pcb: PCB, waitingOn: WaitReason): void {
    this.lifecycle.transition(pcb, 'READY', 'admit');
    this.lifecycle.transition(pcb, 'RUNNING', 'dispatch');
    this.lifecycle.transition(pcb, 'BLOCKED', 'block', { waitingOn });
  }

  /** A kernel thread or service PCB: child of init, uid 0, class system (§3.2). */
  createKernelProcess(name: string, kind: 'kthread' | 'service' | 'special', priority = 0): PCB {
    const pcb = this.create({
      ppid: INIT_PID,
      kind,
      cls: 'system',
      name,
      argv: [`[${name}]`],
      cred: ROOT_CRED,
      priority,
    });
    this.park(pcb, `svc:${name}`);
    return pcb;
  }

  /**
   * Enter TERMINATED (kill path steps 2, 7, 10, 11): run the subsystem cleanups, re-parent the
   * children to init, and reap at once when the parent is init.
   */
  terminate(
    pcb: PCB,
    reason: TransitionReason,
    exit: { code: number; reason: ExitReason; by?: number },
  ): void {
    if (pcb.state === 'TERMINATED') return;
    this.enterZombie(pcb, reason, exit);
    this.reparentChildren(pcb);
    this.reapIfOrphaned(pcb);
  }

  /**
   * Kill-path steps 2 (state) and 11 (log) for the proc side, then the registered cleanups. The
   * scheduler's kill path (core/sched/kill.ts) calls the three steps separately through its hooks.
   */
  enterZombie(
    pcb: PCB,
    reason: TransitionReason,
    exit: { code: number; reason: ExitReason; by?: number },
  ): void {
    if (pcb.pid === INIT_PID)
      throw new KernelError('EPERM', { reason: 'init' }, 'init cannot be terminated');
    this.lifecycle.transition(pcb, 'TERMINATED', reason, {
      exitCode: exit.code,
      exitReason: exit.reason,
      ...(exit.by === undefined ? {} : { by: exit.by }),
    });
    this.runTerminateHooks(pcb);
  }

  /**
   * The registered subsystem cleanups (fds, leases, windows, …; kill-path steps 5, 6 and 8). The
   * scheduler's kill path calls this once per process; a failing hook is isolated so the others
   * still run (the kill path must always complete, INV-P7).
   */
  runTerminateHooks(pcb: PCB): Error[] {
    const errors: Error[] = [];
    for (const hook of [...this.hooks]) {
      try {
        hook(pcb);
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }
    }
    return errors;
  }

  /** Live (non-reaped) children of `pid`. */
  childrenOf(pid: number): PCB[] {
    const parent = this.table.get(pid);
    if (!parent) return [];
    const out: PCB[] = [];
    for (const c of parent.children) {
      const child = this.table.get(c);
      if (child) out.push(child);
    }
    return out;
  }

  /** Every process whose pgid is `pgid` (zombies included). O(n). */
  groupMembers(pgid: number): PCB[] {
    return this.table.values().filter((p) => p.pgid === pgid);
  }

  /** Kill-path step 7: every child's ppid becomes 1; zombie children are reaped by init at once. */
  reparentChildren(pcb: PCB): void {
    const init = this.table.get(INIT_PID);
    for (const childPid of pcb.children) {
      const child = this.table.get(childPid);
      if (!child) continue;
      child.ppid = INIT_PID;
      init?.children.add(childPid);
      // A child whose kill is still pending is reaped by init when that kill completes.
      if (isZombie(child)) this.reap(child, INIT_PID);
    }
    pcb.children.clear();
  }

  /** Kill-path step 10 (last part): `init` reaps its children immediately (§3.4 rule 4). */
  reapIfOrphaned(pcb: PCB): void {
    if (isZombie(pcb) && pcb.ppid === INIT_PID) this.reap(pcb, INIT_PID);
  }

  /** Remove a zombie from the table (its parent's `wait` returned it, or the parent is init). */
  reap(pcb: PCB, by: number): void {
    if (pcb.state !== 'TERMINATED') throw new KernelBug(`reap of live pid ${String(pcb.pid)}`);
    this.lifecycle.reaped(pcb, by);
    this.table.get(pcb.ppid)?.children.delete(pcb.pid);
    this.table.delete(pcb.pid);
  }
}
