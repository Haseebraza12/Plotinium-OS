/**
 * The local layer of lockd (virtual-file-system.md §3.16.1): a per-device table
 * `ino → {holders, waiters FIFO}` that arbitrates between the processes of this kernel. Many S or
 * one X; a process that is the only holder may upgrade S → X; a new request queues behind an
 * earlier waiter so writers are not starved (offline-and-sync.md §3.14.1 "Fairness").
 */
import type { LeaseMode, LeaseScope } from './types.ts';

export interface Holder {
  /** The id returned to the process (`lock.release {leaseId}`). */
  readonly id: string;
  readonly pid: number;
  readonly ino: string;
  /** Effective uid of the process (the principal of a later server acquire). */
  readonly principal: number;
  mode: LeaseMode;
  scope: LeaseScope;
  /** The server fence the process writes under (kept after a loss: the stale-fence path). */
  fence: number | null;
  lost: boolean;
}

export class LocalLockTable {
  private readonly byIno = new Map<string, Holder[]>();
  private readonly waiting = new Map<string, number>();

  holders(ino: string): readonly Holder[] {
    return this.byIno.get(ino) ?? [];
  }

  inos(): string[] {
    return [...this.byIno.keys()];
  }

  /** Whether `pid` may take `mode` on `ino` next to the current holders. */
  compatible(ino: string, pid: number, mode: LeaseMode): boolean {
    const hs = this.holders(ino).filter((h) => !h.lost);
    if (hs.length === 0) return true;
    if (mode === 'X') return hs.every((h) => h.pid === pid);
    return hs.every((h) => h.mode === 'S' || h.pid === pid);
  }

  /** The strongest mode held on `ino` by live holders, or null. */
  strongest(ino: string): LeaseMode | null {
    const hs = this.holders(ino).filter((h) => !h.lost);
    if (hs.length === 0) return null;
    return hs.some((h) => h.mode === 'X') ? 'X' : 'S';
  }

  /** A local process other than `pid` holding `ino` (for EBUSY `detail.holder`). */
  otherHolder(ino: string, pid: number): Holder | undefined {
    return this.holders(ino).find((h) => h.pid !== pid && !h.lost);
  }

  add(h: Holder): void {
    const list = this.byIno.get(h.ino) ?? [];
    list.push(h);
    this.byIno.set(h.ino, list);
  }

  /** Remove the first holder of `pid` with `id`; null when there is none. */
  remove(pid: number, id: string): Holder | null {
    for (const [ino, list] of this.byIno) {
      const i = list.findIndex((h) => h.pid === pid && h.id === id);
      if (i < 0) continue;
      const [h] = list.splice(i, 1);
      if (list.length === 0) this.byIno.delete(ino);
      return h ?? null;
    }
    return null;
  }

  byPid(pid: number): Holder[] {
    const out: Holder[] = [];
    for (const list of this.byIno.values()) for (const h of list) if (h.pid === pid) out.push(h);
    return out;
  }

  /** Waiters queued per inode (for `lock.status.queued` and fairness). */
  waiters(ino: string): number {
    return this.waiting.get(ino) ?? 0;
  }

  addWaiter(ino: string, delta: 1 | -1): void {
    const n = (this.waiting.get(ino) ?? 0) + delta;
    if (n <= 0) this.waiting.delete(ino);
    else this.waiting.set(ino, n);
  }
}
