/**
 * Local advisory locks (offline-and-sync.md §3.14.7; syscall-abi.md §4.4.7): the lease table
 * `lockd` falls back to when the server layer is not engaged (offline, or no lock engine linked).
 * S leases share, X excludes; waiters queue FIFO; a process's leases go when it exits (PROC-07).
 * They are advisory: they order cooperating processes, they do not make writes fail.
 */
import { uuidv7 } from '@plotinium/protocol';

import { KernelError } from '../errors.ts';

export interface LocalLease {
  readonly leaseId: string;
  readonly ino: string;
  readonly path: string;
  readonly pid: number;
  readonly holder: string;
  readonly mode: 'S' | 'X';
  readonly fence: number;
}

interface Waiter {
  readonly pid: number;
  readonly path: string;
  readonly holder: string;
  readonly mode: 'S' | 'X';
  readonly resolve: (l: LocalLease) => void;
  readonly reject: (e: KernelError) => void;
  cancelTimer: (() => void) | null;
}

export interface LocalLocksDeps {
  /** Arm a one-shot timer on the kernel timer heap; returns its cancel function. */
  readonly after: (ms: number, fn: () => void) => () => void;
  readonly onChange?: (
    kind: 'granted' | 'queued' | 'released',
    lease: { ino: string; mode: 'S' | 'X'; holder: string; fence?: number },
  ) => void;
}

export class LocalLocks {
  private readonly deps: LocalLocksDeps;
  private readonly held = new Map<string, LocalLease[]>();
  private readonly byId = new Map<string, LocalLease>();
  private readonly waiting = new Map<string, Waiter[]>();
  private readonly fences = new Map<string, number>();

  constructor(deps: LocalLocksDeps) {
    this.deps = deps;
  }

  private compatible(ino: string, mode: 'S' | 'X'): boolean {
    const h = this.held.get(ino) ?? [];
    if (h.length === 0) return true;
    return mode === 'S' && h.every((l) => l.mode === 'S');
  }

  private grant(ino: string, w: Omit<Waiter, 'resolve' | 'reject' | 'cancelTimer'>): LocalLease {
    const fence = (this.fences.get(ino) ?? 0) + 1;
    this.fences.set(ino, fence);
    const lease: LocalLease = {
      leaseId: uuidv7(),
      ino,
      path: w.path,
      pid: w.pid,
      holder: w.holder,
      mode: w.mode,
      fence,
    };
    const list = this.held.get(ino) ?? [];
    list.push(lease);
    this.held.set(ino, list);
    this.byId.set(lease.leaseId, lease);
    this.deps.onChange?.('granted', { ino, mode: w.mode, holder: w.holder, fence });
    return lease;
  }

  acquire(req: {
    readonly pid: number;
    readonly ino: string;
    readonly path: string;
    readonly holder: string;
    readonly mode: 'S' | 'X';
    readonly wait: boolean;
    readonly timeoutMs?: number | undefined;
  }): Promise<LocalLease> {
    const queue = this.waiting.get(req.ino) ?? [];
    if (queue.length === 0 && this.compatible(req.ino, req.mode))
      return Promise.resolve(this.grant(req.ino, req));
    if (!req.wait) {
      const holder = this.held.get(req.ino)?.[0]?.holder;
      return Promise.reject(
        new KernelError(
          'EBUSY',
          { reason: 'lease', ...(holder === undefined ? {} : { holder }) },
          'the file is locked',
        ),
      );
    }
    return new Promise<LocalLease>((resolve, reject) => {
      const w: Waiter = {
        pid: req.pid,
        path: req.path,
        holder: req.holder,
        mode: req.mode,
        resolve,
        reject,
        cancelTimer: null,
      };
      if (req.timeoutMs !== undefined) {
        w.cancelTimer = this.deps.after(req.timeoutMs, () => {
          this.dropWaiter(req.ino, w);
          reject(new KernelError('ETIMEDOUT', { reason: 'lock-timeout' }, 'lock wait timed out'));
        });
      }
      queue.push(w);
      this.waiting.set(req.ino, queue);
      this.deps.onChange?.('queued', { ino: req.ino, mode: req.mode, holder: req.holder });
    });
  }

  private dropWaiter(ino: string, w: Waiter): void {
    const q = this.waiting.get(ino);
    if (!q) return;
    const i = q.indexOf(w);
    if (i >= 0) q.splice(i, 1);
    if (q.length === 0) this.waiting.delete(ino);
  }

  /** Grant queued waiters in FIFO order while they are compatible. */
  private pump(ino: string): void {
    const q = this.waiting.get(ino);
    while (q && q.length > 0) {
      const next = q[0];
      if (next === undefined || !this.compatible(ino, next.mode)) break;
      q.shift();
      next.cancelTimer?.();
      next.resolve(this.grant(ino, next));
    }
    if (q?.length === 0) this.waiting.delete(ino);
  }

  release(leaseId: string, pid: number): void {
    const l = this.byId.get(leaseId);
    if (l?.pid !== pid) throw new KernelError('EINVAL', undefined, 'no such lease');
    this.drop(l);
  }

  private drop(l: LocalLease): void {
    this.byId.delete(l.leaseId);
    const list = (this.held.get(l.ino) ?? []).filter((x) => x.leaseId !== l.leaseId);
    if (list.length === 0) this.held.delete(l.ino);
    else this.held.set(l.ino, list);
    this.deps.onChange?.('released', {
      ino: l.ino,
      mode: l.mode,
      holder: l.holder,
      fence: l.fence,
    });
    this.pump(l.ino);
  }

  /** PROC-07: every lease of an exiting process, and its queued requests (ECANCELED). */
  releaseAll(pid: number): number {
    let n = 0;
    for (const [ino, q] of [...this.waiting]) {
      for (const w of q.filter((x) => x.pid === pid)) {
        this.dropWaiter(ino, w);
        w.cancelTimer?.();
        w.reject(new KernelError('ECANCELED', undefined, 'the process exited'));
      }
    }
    for (const l of [...this.byId.values()]) {
      if (l.pid !== pid) continue;
      this.drop(l);
      n++;
    }
    return n;
  }

  holders(ino: string): readonly LocalLease[] {
    return this.held.get(ino) ?? [];
  }

  /**
   * VFS §3.16.3: a change of `ino` by `pid` fails with EBUSY when another process holds S or X on
   * it and `pid` itself does not hold X. A process's own X lease never blocks its own writes
   * (UI-002); without a `pid` (a kernel-internal change) every holder counts.
   */
  blocks(ino: string, pid?: number): boolean {
    const held = this.held.get(ino) ?? [];
    if (held.length === 0) return false;
    if (pid !== undefined && held.some((l) => l.pid === pid && l.mode === 'X')) return false;
    return held.some((l) => l.pid !== pid);
  }

  queued(ino: string): number {
    return this.waiting.get(ino)?.length ?? 0;
  }

  leasesOf(pid: number): LocalLease[] {
    return [...this.byId.values()].filter((l) => l.pid === pid);
  }
}
