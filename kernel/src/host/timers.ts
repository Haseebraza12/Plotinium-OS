/**
 * Kernel timers for the worker host, as `KernelTimers` (boot-and-services.md §4.2; KPS-13): ONE
 * platform timer armed for the earliest deadline, re-armed whenever the minimum changes.
 *
 * The kernel timer heap is `core/sched/timers.ts` on `dsa/heap` (C16). While HEAP_IMPLEMENTED is
 * false the host keeps pending timers in a Map and finds the minimum by a linear scan (fine for
 * the handful of boot timers). TODO(dsa/heap): hand `KernelTimers` to the sched service's
 * TimerHeap once the heap ships, and delete this stand-in.
 */
import type { KernelTimers } from '@plotinium/services';

import type { KernelClock } from '../core/host.ts';

export interface PlatformTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

interface Entry {
  readonly id: number;
  readonly deadline: number;
  readonly priority: number;
  readonly fire: () => void;
}

export class HostTimers implements KernelTimers {
  private readonly clock: KernelClock;
  private readonly platform: PlatformTimer;
  private readonly entries = new Map<number, Entry>();
  private nextId = 1;
  private armedFor: number | null = null;
  private handle: unknown = null;

  constructor(clock: KernelClock, platform: PlatformTimer) {
    this.clock = clock;
    this.platform = platform;
  }

  now(): number {
    return this.clock.now();
  }

  get pending(): number {
    return this.entries.size;
  }

  at(deadlineMs: number, fire: () => void, priority = 0): number {
    const id = this.nextId++;
    this.entries.set(id, { id, deadline: deadlineMs, priority, fire });
    this.rearm();
    return id;
  }

  cancel(handle: number): boolean {
    const had = this.entries.delete(handle);
    if (had) this.rearm();
    return had;
  }

  private earliest(): number | null {
    let min: number | null = null;
    for (const e of this.entries.values()) if (min === null || e.deadline < min) min = e.deadline;
    return min;
  }

  private rearm(): void {
    const min = this.earliest();
    if (min === this.armedFor) return;
    if (this.handle !== null) this.platform.clear(this.handle);
    this.handle = null;
    this.armedFor = min;
    if (min === null) return;
    this.handle = this.platform.set(
      () => {
        this.handle = null;
        this.armedFor = null;
        this.runDue();
      },
      Math.max(0, min - this.clock.now()),
    );
  }

  /** Fire every due timer in (deadline, priority, arm order) order, then re-arm. */
  runDue(): void {
    const now = this.clock.now();
    const due = [...this.entries.values()]
      .filter((e) => e.deadline <= now)
      .sort((a, b) => a.deadline - b.deadline || a.priority - b.priority || a.id - b.id);
    for (const e of due) {
      if (!this.entries.delete(e.id)) continue;
      try {
        e.fire();
      } catch {
        // A failing callback must not stop the other timers.
      }
    }
    this.rearm();
  }
}
