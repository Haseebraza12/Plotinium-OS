/**
 * Thrashing guard (memory-and-paging.md §3.14; KMM-11, Spec §9.2 thrashing text).
 */
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_PARAMS } from './params.ts';
import { ThrashingGuard } from './thrash.ts';

const T0 = 100_000;

/** Record `rate` faults in each of `seconds` seconds starting at `start`. */
function burst(g: ThrashingGuard, start: number, seconds: number, rate: number): number {
  for (let s = 0; s < seconds; s++) {
    for (let i = 0; i < rate; i++)
      g.recordFault(start + s * 1_000 + Math.floor((i * 1_000) / (rate + 1)));
  }
  return start + seconds * 1_000;
}

describe('ThrashingGuard (§3.14)', () => {
  it('MEM-06 thrashing guard: turns on after 5 consecutive seconds above 20 faults/s, within 6 s', () => {
    const listener = vi.fn();
    const g = new ThrashingGuard(DEFAULT_PARAMS, T0, listener);
    const end = burst(g, T0, 5, 21);
    expect(g.isOn(end - 1)).toBe(false);
    expect(g.isOn(end)).toBe(true);
    expect(end - T0).toBeLessThanOrEqual(6_000);
    expect(listener).toHaveBeenCalledWith(true, end, 21);
    expect(g.faultsPerSec(end)).toBe(21);
    expect(g.episodeCount).toBe(1);
    expect(g.faults).toBe(105);
  });

  it('MEM-06 thrashing guard: exactly 20 faults/s is not above the threshold, and a dip resets the streak', () => {
    const g = new ThrashingGuard(DEFAULT_PARAMS, T0);
    let t = burst(g, T0, 6, 20);
    expect(g.isOn(t)).toBe(false);
    t = burst(g, t, 4, 30);
    t = burst(g, t, 1, 5);
    t = burst(g, t, 4, 30);
    expect(g.isOn(t)).toBe(false);
    t = burst(g, t, 1, 30);
    expect(g.isOn(t)).toBe(true);
  });

  it('MEM-06 thrashing guard: turns off only after 5 consecutive seconds below 10 faults/s (hysteresis)', () => {
    const listener = vi.fn();
    const g = new ThrashingGuard(DEFAULT_PARAMS, T0, listener);
    let t = burst(g, T0, 5, 25);
    expect(g.isOn(t)).toBe(true);
    t = burst(g, t, 10, 15); // between the thresholds: stays on
    expect(g.isOn(t)).toBe(true);
    t = burst(g, t, 4, 5);
    expect(g.isOn(t)).toBe(true);
    t = burst(g, t, 1, 5);
    expect(g.isOn(t)).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(false, t, 5);
  });

  it('MEM-06 thrashing guard: a long idle gap turns it off in one step', () => {
    const g = new ThrashingGuard(DEFAULT_PARAMS, T0);
    const t = burst(g, T0, 5, 40);
    expect(g.isOn(t)).toBe(true);
    g.tick(t + 3_600_000);
    expect(g.isOn(t + 3_600_000)).toBe(false);
    expect(g.faultsPerSec(t + 3_600_000)).toBe(0);
    // Buckets stay aligned after the jump.
    g.recordFault(t + 3_600_500);
    expect(g.faultsPerSec(t + 3_601_000)).toBe(1);
  });
});
