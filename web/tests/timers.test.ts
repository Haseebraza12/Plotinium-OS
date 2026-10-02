import { describe, expect, it } from 'vitest';

import type { TimerApi } from '../src/boot/timers.ts';
import { createWatchdog, startCountdown } from '../src/boot/timers.ts';

/** A deterministic clock: `advance` fires every due timer in deadline order. */
function fakeTimers(): TimerApi & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    set: (fn, ms) => {
      const id = ++seq;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => {
      if (typeof h === 'number') due.delete(h);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of due)
          if (e[1].at <= end && (next === null || e[1].at < next[1].at)) next = e;
        if (next === null) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    pending: () => due.size,
  };
}

describe('the boot-menu countdown (boot §3.7)', () => {
  it('SVC-10 ticks 5, 4, 3, 2, 1, 0 from an absolute deadline and then picks the entry', () => {
    const t = fakeTimers();
    const ticks: number[] = [];
    let done = 0;
    startCountdown({
      seconds: 5,
      timers: t,
      onTick: (s) => ticks.push(s),
      onDone: () => {
        done++;
      },
    });
    expect(ticks).toEqual([5]);
    t.advance(4_999);
    expect(done).toBe(0);
    t.advance(1);
    expect(ticks).toEqual([5, 4, 3, 2, 1, 0]);
    expect(done).toBe(1);
    expect(t.pending()).toBe(0);
  });

  it('SVC-10 the first key or pointer press stops the countdown for good', () => {
    const t = fakeTimers();
    let done = 0;
    const c = startCountdown({
      seconds: 5,
      timers: t,
      onTick: () => undefined,
      onDone: () => {
        done++;
      },
    });
    t.advance(2_000);
    c.stop();
    c.stop();
    expect(c.running).toBe(false);
    t.advance(10_000);
    expect(done).toBe(0);
    expect(t.pending()).toBe(0);
  });
});

describe('the boot-stall watchdog (boot §3.9)', () => {
  it('SVC-18 fires once after 15 s without a boot event and names the last event and its age', () => {
    const t = fakeTimers();
    const stalls: [string, number][] = [];
    const w = createWatchdog({
      limitMs: 15_000,
      timers: t,
      onStall: (e, age) => stalls.push([e, age]),
    });
    t.advance(10_000);
    w.kick('storage started');
    t.advance(14_999);
    expect(stalls).toEqual([]);
    t.advance(1);
    expect(stalls).toEqual([['storage started', 15]]);
    w.kick('late event');
    t.advance(60_000);
    expect(stalls).toHaveLength(1);
  });

  it('SVC-18 the stall watchdog does not fire while the menu or login screen waits for the user', () => {
    const t = fakeTimers();
    let stalls = 0;
    const w = createWatchdog({
      limitMs: 15_000,
      timers: t,
      onStall: () => {
        stalls++;
      },
    });
    t.advance(5_000);
    w.pause();
    w.kick('ignored while paused');
    t.advance(120_000);
    expect(stalls).toBe(0);
    w.resume('login submitted');
    t.advance(14_000);
    expect(stalls).toBe(0);
    t.advance(1_000);
    expect(stalls).toBe(1);
  });

  it('SVC-18 a stopped watchdog never fires and leaves no timer behind', () => {
    const t = fakeTimers();
    let stalls = 0;
    const w = createWatchdog({
      limitMs: 15_000,
      timers: t,
      onStall: () => {
        stalls++;
      },
    });
    w.stop();
    w.resume('no effect');
    t.advance(60_000);
    expect(stalls).toBe(0);
    expect(t.pending()).toBe(0);
  });
});
