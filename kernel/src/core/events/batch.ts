/**
 * At most one delivery per animation frame (syscall-abi.md §3.8 rule 5, boundary B2).
 *
 * The host supplies `schedule` (requestAnimationFrame in the kernel worker, a manual tick in
 * tests). Items pushed within one frame are flushed together, in push order.
 */
export type FrameScheduler = (cb: () => void) => void;

export class FrameBatcher<T> {
  private items: T[] = [];
  private armed = false;
  private readonly schedule: FrameScheduler;
  private readonly flushTo: (batch: T[]) => void;

  constructor(schedule: FrameScheduler, flushTo: (batch: T[]) => void) {
    this.schedule = schedule;
    this.flushTo = flushTo;
  }

  get pending(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.armed) return;
    this.armed = true;
    this.schedule(() => {
      this.flush();
    });
  }

  /** Deliver everything collected so far as one batch (also used on close). */
  flush(): void {
    this.armed = false;
    if (this.items.length === 0) return;
    const batch = this.items;
    this.items = [];
    this.flushTo(batch);
  }
}
