/**
 * Kernel clocks for the two hosts: the platform clock (workers) and a manual clock (Node tests,
 * frozen-clock test mode, C12).
 */
import type { KernelClock } from '../core/host.ts';

export class ManualClock implements KernelClock {
  private t: number;
  private readonly epoch0: number;
  private readonly zone: { tz: string; offsetMin: number };

  constructor(opts: { epoch0?: number; t0?: number; tz?: string; offsetMin?: number } = {}) {
    this.t = opts.t0 ?? 0;
    this.epoch0 = opts.epoch0 ?? Date.UTC(2026, 8, 24, 9, 0, 0);
    this.zone = { tz: opts.tz ?? 'Asia/Karachi', offsetMin: opts.offsetMin ?? 300 };
  }

  now(): number {
    return this.t;
  }

  epochMs(): number {
    return this.epoch0 + this.t;
  }

  timeZone(): { tz: string; offsetMin: number } {
    return this.zone;
  }

  advance(ms: number): void {
    if (!(ms >= 0)) throw new RangeError('a clock only moves forward');
    this.t += ms;
  }
}

/** `performance.now()` plus `Date.now()`, and the zone from `Intl`. */
export function platformClock(
  perf: { now(): number },
  date: { now(): number } = Date,
): KernelClock {
  return {
    now: () => perf.now(),
    epochMs: () => date.now(),
    timeZone: () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return {
        tz: /^[A-Za-z]/.test(tz) ? tz : 'UTC',
        offsetMin: -new Date(date.now()).getTimezoneOffset(),
      };
    },
  };
}
