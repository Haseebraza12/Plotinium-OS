/**
 * TEST-ONLY virtual clock for syncd and lockd timers. Storage work (the fake IndexedDB) runs on
 * real macrotasks, so `advance` settles them after every timer it fires.
 */
import type { Clock, Timer } from '../../ports.ts';

interface Entry {
  readonly at: number;
  readonly seq: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/** Let promise chains and fake-IDB transactions (setTimeout 0) run to completion. */
export async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

export class FakeClock implements Clock {
  /** Wall clock at mono 0 (2027-01-15T08:00:00Z). */
  readonly wall0 = Date.UTC(2027, 0, 15, 8, 0, 0);
  private t = 0;
  private seq = 0;
  private timers: Entry[] = [];

  now(): number {
    return this.wall0 + this.t;
  }

  mono(): number {
    return this.t;
  }

  after(ms: number, fn: () => void): Timer {
    const e: Entry = { at: this.t + Math.max(0, ms), seq: this.seq++, fn, cancelled: false };
    this.timers.push(e);
    return {
      cancel: () => {
        e.cancelled = true;
      },
    };
  }

  /** Timers still armed. */
  armed(): number {
    return this.timers.filter((e) => !e.cancelled).length;
  }

  /** The delay until the next armed timer, or null. */
  nextIn(): number | null {
    const live = this.timers.filter((e) => !e.cancelled);
    if (live.length === 0) return null;
    return Math.min(...live.map((e) => e.at)) - this.t;
  }

  /**
   * Move virtual time forward by `ms`, firing due timers in order and settling `perTimer` rounds
   * after each, then `rounds` at the end.
   */
  async advance(ms: number, rounds = 40, perTimer = rounds): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.timers = this.timers.filter((e) => !e.cancelled);
      let next: Entry | undefined;
      for (const e of this.timers)
        if (
          e.at <= end &&
          (next === undefined || e.at < next.at || (e.at === next.at && e.seq < next.seq))
        )
          next = e;
      if (next === undefined) break;
      this.t = Math.max(this.t, next.at);
      next.cancelled = true;
      next.fn();
      await settle(perTimer);
    }
    this.t = end;
    await settle(rounds);
  }
}
