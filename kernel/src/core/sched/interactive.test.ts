/**
 * KPS-11: the interactive hint pauses the background band for at most 1 s in any 2 s.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InteractiveHint } from './interactive.ts';

describe('KPS-11 interactive pause duty cycle', () => {
  it('KPS-11 a continuous gesture gives pause 1 s, run 1 s, pause 1 s (about 50 % duty cycle)', () => {
    const h = new InteractiveHint();
    expect(h.isPaused(0)).toBe(false);
    expect(h.nextChangeAt(0)).toBeNull();
    h.set(true, 0);
    expect(h.gestureActive).toBe(true);
    expect(h.isPaused(0)).toBe(true);
    expect(h.nextChangeAt(10)).toBe(1_000);
    expect(h.isPaused(999)).toBe(true);
    expect(h.isPaused(1_000)).toBe(false);
    expect(h.nextChangeAt(1_500)).toBe(2_000);
    expect(h.isPaused(1_999)).toBe(false);
    expect(h.isPaused(2_000)).toBe(true);
    expect(h.nextChangeAt(2_500)).toBe(3_000);
    expect(h.isPaused(3_000)).toBe(false);
    // Only intervals that still intersect the current 2 s window are kept (bounded memory).
    expect(h.pausedWithin(2_000, 4_000, 4_000)).toBe(1_000);
    h.set(false, 4_100);
    expect(h.isPaused(4_100)).toBe(false);
    expect(h.nextChangeAt(4_100)).toBeNull();
  });

  it('KPS-11 a gesture that ends early ends the pause at once', () => {
    const h = new InteractiveHint();
    h.set(true, 100);
    h.set(false, 400);
    expect(h.isPaused(400)).toBe(false);
    expect(h.pausedWithin(0, 2_000, 2_000)).toBe(300);
  });

  it('KPS-11 short gestures that restart quickly still pause at most 1 s in any 2 s window', () => {
    const h = new InteractiveHint();
    h.set(true, 0);
    h.set(false, 600);
    h.set(true, 700); // may pause only until the window holds 1,000 ms
    expect(h.isPaused(700)).toBe(true);
    expect(h.nextChangeAt(700)).toBe(1_100);
    expect(h.isPaused(1_100)).toBe(false);
    expect(h.nextChangeAt(1_100)).toBe(2_100); // cool-down after a capped pause
    expect(h.pausedWithin(-1_000, 1_100, 1_100)).toBe(1_000);
  });

  it('KPS-11 a pause that starts with pause time already in the window is capped by the window', () => {
    const h = new InteractiveHint(1_000, 2_000);
    h.set(true, 0);
    h.set(false, 500); // [0, 500]
    h.set(true, 1_000);
    h.set(false, 1_400); // [1000, 1400]
    h.set(true, 1_600); // window (−400, 1600] holds 900 ms: only 100 ms of budget
    expect(h.isPaused(1_600)).toBe(true);
    expect(h.nextChangeAt(1_600)).toBe(1_700);
    expect(h.isPaused(1_700)).toBe(false);
    expect(h.nextChangeAt(1_700)).toBe(2_700); // capped, so a cool-down follows
    expect(h.pausedWithin(-300, 1_700, 1_700)).toBe(1_000);
    expect(h.isPaused(2_700)).toBe(true);
  });

  it('KPS-11 no 2 s window ever holds more than 1 s of pause, for any gesture pattern (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_500 }), { minLength: 1, maxLength: 30 }),
        (gaps) => {
          const h = new InteractiveHint();
          let t = 0;
          let active = false;
          let pausedSomewhere = false;
          for (const g of gaps) {
            active = !active;
            h.set(active, t);
            // Probe every window ending inside this segment, at its own end time (history is pruned).
            for (let x = t; x < t + g; x += 25) {
              pausedSomewhere ||= h.isPaused(x);
              expect(h.pausedWithin(x - 2_000, x, x)).toBeLessThanOrEqual(1_000 + 1e-6);
              const next = h.nextChangeAt(x);
              if (next !== null) expect(next).toBeGreaterThanOrEqual(x);
            }
            t += g;
          }
          // A gesture of at least one probe step always produces some pause.
          if (gaps[0] !== undefined && gaps[0] >= 25) expect(pausedSomewhere).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('KPS-11 constructor rejects a pause cap that does not fit its window', () => {
    expect(() => new InteractiveHint(0, 2_000)).toThrow(RangeError);
    expect(() => new InteractiveHint(2_000, 2_000)).toThrow(RangeError);
  });
});
