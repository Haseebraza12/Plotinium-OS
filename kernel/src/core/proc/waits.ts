/**
 * `wait` (syscall-abi.md §4.4.1; processes-and-scheduling.md §3.17.3): a parent collects the state
 * changes of its children: exit (a zombie, reaped by the wait), stop (`untraced`) and continue
 * (`continued`).
 *
 * Targets: `pid > 0` one child, `-1` any child, `< -1` any child in group `|pid|`. No matching
 * child at all is ESRCH `no-child` (ECHILD is only requested, §9.2). With `nohang` and nothing
 * to report the answer is `{pid: 0}`. Otherwise the caller blocks (BLOCKED `wait:<pid>`) until a
 * matching change is recorded; the process system cancels the wait on a caught signal
 * (ECANCELED) or a kill.
 */
import type { WaitArgs, WaitRet, WaitStatus } from '@plotinium/protocol';

import { KernelError } from '../errors.ts';
import { waitStatusOf } from './lifecycle.ts';
import type { PCB } from './pcb.ts';
import { isZombie } from './pcb.ts';

type Change =
  { readonly kind: 'stopped'; readonly status: WaitStatus } | { readonly kind: 'continued' };

interface Waiter {
  readonly parent: number;
  readonly args: WaitArgs;
  readonly resolve: (r: WaitRet) => void;
  readonly reject: (e: KernelError) => void;
}

export interface ChildWaitsDeps {
  readonly get: (pid: number) => PCB | undefined;
  /** Reap a zombie child on behalf of `by` (removes it from the table). */
  readonly reap: (child: PCB, by: number) => void;
}

export class ChildWaits {
  private readonly deps: ChildWaitsDeps;
  /** Unreported stop/continue changes per child pid (the newest wins, as in POSIX). */
  private readonly changes = new Map<number, Change>();
  private readonly waiters = new Map<number, Waiter[]>();

  constructor(deps: ChildWaitsDeps) {
    this.deps = deps;
  }

  private matches(parent: PCB, target: number): PCB[] {
    const out: PCB[] = [];
    for (const pid of parent.children) {
      const c = this.deps.get(pid);
      if (c === undefined || c.ppid !== parent.pid) continue;
      if (target > 0 ? c.pid === target : target === -1 || c.pgid === -target) out.push(c);
    }
    return out;
  }

  /** One non-blocking attempt: a result, `'none'` (children exist, nothing to report) or ESRCH. */
  poll(parent: PCB, args: WaitArgs): WaitRet | 'none' {
    const kids = this.matches(parent, args.pid);
    if (kids.length === 0) throw new KernelError('ESRCH', { reason: 'no-child' }, 'no such child');
    // A child whose kill is still pending (TERMINATED, slice ending) is reported once it completes.
    const zombie = kids.find(isZombie);
    if (zombie !== undefined) {
      const status = waitStatusOf(zombie);
      this.changes.delete(zombie.pid);
      this.deps.reap(zombie, parent.pid);
      return { pid: zombie.pid, status };
    }
    for (const c of kids) {
      const ch = this.changes.get(c.pid);
      if (ch === undefined) continue;
      if (ch.kind === 'stopped' && args.untraced === true) {
        this.changes.delete(c.pid);
        return { pid: c.pid, status: ch.status };
      }
      if (ch.kind === 'continued' && args.continued === true) {
        this.changes.delete(c.pid);
        return { pid: c.pid, status: { kind: 'continued' } };
      }
    }
    return 'none';
  }

  /** `wait`: a result now, `{pid: 0}` with `nohang`, or a promise settled by a later change. */
  wait(parent: PCB, args: WaitArgs): WaitRet | Promise<WaitRet> {
    const r = this.poll(parent, args);
    if (r !== 'none') return r;
    if (args.nohang === true) return { pid: 0 };
    return new Promise<WaitRet>((resolve, reject) => {
      const list = this.waiters.get(parent.pid) ?? [];
      list.push({ parent: parent.pid, args, resolve, reject });
      this.waiters.set(parent.pid, list);
    });
  }

  /** A child of `parentPid` changed state: satisfy (or fail) its parent's waiters. */
  notify(parentPid: number): void {
    const list = this.waiters.get(parentPid);
    if (list === undefined || list.length === 0) return;
    const parent = this.deps.get(parentPid);
    this.waiters.delete(parentPid);
    const keep: Waiter[] = [];
    for (const w of list) {
      if (parent === undefined || parent.state === 'TERMINATED') continue;
      try {
        const r = this.poll(parent, w.args);
        if (r === 'none') keep.push(w);
        else w.resolve(r);
      } catch (e) {
        w.reject(e instanceof KernelError ? e : new KernelError('EIO'));
      }
    }
    if (keep.length > 0)
      this.waiters.set(parentPid, [...keep, ...(this.waiters.get(parentPid) ?? [])]);
  }

  childStopped(child: PCB, status: WaitStatus): void {
    this.changes.set(child.pid, { kind: 'stopped', status });
    this.notify(child.ppid);
  }

  childContinued(child: PCB): void {
    this.changes.set(child.pid, { kind: 'continued' });
    this.notify(child.ppid);
  }

  /** The child is gone (reaped or re-parented): forget its unreported changes. */
  forget(pid: number): void {
    this.changes.delete(pid);
  }

  /** Cancel every wait of `parentPid` (caught signal: ECANCELED; kill: the reply is dropped). */
  cancel(parentPid: number, err: KernelError): number {
    const list = this.waiters.get(parentPid) ?? [];
    this.waiters.delete(parentPid);
    for (const w of list) w.reject(err);
    return list.length;
  }

  /** Waiters currently blocked (tests, leak checks). */
  get blocked(): number {
    let n = 0;
    for (const l of this.waiters.values()) n += l.length;
    return n;
  }
}
