/**
 * Non-pre-emptive kernel sections (specs/03-kernel/processes-and-scheduling.md §3.11, §3.16 step 3;
 * syscall-abi.md §3.4).
 *
 * The single IndexedDB readwrite transaction of every T call, and phase 2 of every X call, run to
 * completion on behalf of a process. While a section is open:
 *   - the caller is BLOCKED (`io:<txn>`) and holds no run token, so there is nothing to pre-empt;
 *   - its pending call is non-restartable, so the pager must not suspend it (INV-P8) and a
 *     collateral restore is impossible (§3.15.3 condition 4);
 *   - a kill does not abort the section: the section commits or aborts as a whole and its reply is
 *     discarded (§3.16 step 3, §6 "kill during a T call or X phase 2").
 * Kernel synchronous work per task is budgeted at ≤ 4 ms p99 (§7); sections longer than the budget
 * are counted so the klog task timing can report them.
 */

/** §7: kernel synchronous work per task, p99 ≤ 4 ms. */
export const KERNEL_TASK_BUDGET_MS = 4;

export interface SectionInfo {
  readonly pid: number;
  readonly label: string;
  readonly startedAt: number;
  readonly killRequested: boolean;
}

export interface SectionEnd {
  /** True if the process was killed while the section ran: discard the reply (§3.16 step 3). */
  readonly discardReply: boolean;
  readonly durationMs: number;
  readonly overBudget: boolean;
}

interface Open {
  label: string;
  startedAt: number;
  killRequested: boolean;
}

export class NonPreemptiveSections {
  private readonly open = new Map<number, Open>();
  private completed = 0;
  private overBudgetCount = 0;
  private readonly budgetMs: number;

  constructor(budgetMs = KERNEL_TASK_BUDGET_MS) {
    this.budgetMs = budgetMs;
  }

  /** Open a section for `pid` (one at a time: a process has at most one outstanding call). */
  begin(pid: number, label: string, now: number): void {
    if (this.open.has(pid))
      throw new Error(`pid ${String(pid)} already has an open non-pre-emptive section`);
    this.open.set(pid, { label, startedAt: now, killRequested: false });
  }

  /** Close the section; the caller replies only when `discardReply` is false. */
  end(pid: number, now: number): SectionEnd {
    const s = this.open.get(pid);
    if (s === undefined) throw new Error(`pid ${String(pid)} has no open non-pre-emptive section`);
    this.open.delete(pid);
    const durationMs = Math.max(0, now - s.startedAt);
    const overBudget = durationMs > this.budgetMs;
    this.completed++;
    if (overBudget) this.overBudgetCount++;
    return { discardReply: s.killRequested, durationMs, overBudget };
  }

  /** True while `pid` is inside a section. */
  isOpen(pid: number): boolean {
    return this.open.has(pid);
  }

  /**
   * Kill path step 3: returns 'in-section' when the section must finish on its own (its reply
   * will be discarded), or 'none' when there is no section to wait for.
   */
  onKill(pid: number): 'in-section' | 'none' {
    const s = this.open.get(pid);
    if (s === undefined) return 'none';
    s.killRequested = true;
    return 'in-section';
  }

  /** INV-P8: a process inside a section has a non-restartable call in flight. */
  canSuspend(pid: number): boolean {
    return !this.open.has(pid);
  }

  info(pid: number): SectionInfo | undefined {
    const s = this.open.get(pid);
    return s === undefined
      ? undefined
      : { pid, label: s.label, startedAt: s.startedAt, killRequested: s.killRequested };
  }

  stats(): { open: number; completed: number; overBudget: number } {
    return { open: this.open.size, completed: this.completed, overBudget: this.overBudgetCount };
  }
}
