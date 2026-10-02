/**
 * Test-only manual clock: time moves only when a test calls `advance`/`advanceTo`, and due timers
 * run in (deadline, creation) order with `now()` set to each deadline. Linear scans are fine at
 * test sizes (this is not a priority queue for production: C16).
 */
import type { Clock, Timer } from '../clock.ts';

interface Pending {
  readonly at: number;
  readonly seq: number;
  readonly fn: () => void;
  cancelled: boolean;
}

export class ManualClock implements Clock {
  #now: number;
  #seq = 0;
  #timers: Pending[] = [];

  constructor(start = Date.UTC(2026, 10, 14, 9, 0, 0)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimer(delayMs: number, fn: () => void): Timer {
    const t: Pending = {
      at: this.#now + Math.max(0, delayMs),
      seq: this.#seq++,
      fn,
      cancelled: false,
    };
    this.#timers.push(t);
    return {
      cancel: () => {
        t.cancelled = true;
      },
    };
  }

  /** Number of armed (not cancelled, not fired) timers. */
  get pending(): number {
    return this.#timers.filter((t) => !t.cancelled).length;
  }

  /** The earliest armed deadline. */
  nextAt(): number | undefined {
    let min: number | undefined;
    for (const t of this.#timers) if (!t.cancelled && (min === undefined || t.at < min)) min = t.at;
    return min;
  }

  /** Moves time forward by `ms`, firing every timer that falls due (including ones armed meanwhile). */
  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.#now + ms);
  }

  async advanceTo(target: number): Promise<void> {
    for (;;) {
      let next: Pending | undefined;
      for (const t of this.#timers) {
        if (t.cancelled || t.at > target) continue;
        if (next === undefined || t.at < next.at || (t.at === next.at && t.seq < next.seq))
          next = t;
      }
      if (next === undefined) break;
      next.cancelled = true;
      this.#now = Math.max(this.#now, next.at);
      next.fn();
      await flush();
    }
    this.#timers = this.#timers.filter((t) => !t.cancelled);
    this.#now = Math.max(this.#now, target);
    await flush();
  }
}

/** Lets pending promise chains (fake database calls) settle. */
export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
