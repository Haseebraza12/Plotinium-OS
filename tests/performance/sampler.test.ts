import { describe, expect, it } from 'vitest';

import { sampleAsync, sampleSync, summary, type Clock } from './sampler.ts';

/** A clock that advances by the given steps on each read, so op i "takes" durations[i] ms. */
function steppingClock(durations: readonly number[]): Clock {
  let t = 0;
  let reads = 0;
  return () => {
    // Reads come in pairs (before, after): advance on the "after" read.
    if (reads % 2 === 1) t += durations[(reads - 1) / 2] ?? 0;
    reads++;
    return t;
  };
}

describe('TST-04 per-op sampler', () => {
  it('TST-04 the sampler discards the warm-up and keeps exactly n samples', () => {
    const calls: number[] = [];
    const out = sampleSync((i) => calls.push(i), {
      n: 20,
      warmupPct: 10,
      clock: steppingClock(Array.from({ length: 20 }, (_, i) => i + 1)),
    });
    expect(calls).toHaveLength(22);
    expect(out).toHaveLength(20);
    expect(Array.from(out)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(summary(out).p95).toBe(19);
  });

  it('TST-04 asynchronous operations are awaited before the clock stops', async () => {
    const out = await sampleAsync(() => Promise.resolve(), {
      n: 5,
      warmupPct: 0,
      clock: steppingClock([3, 3, 3, 3, 30]),
    });
    expect(Array.from(out)).toEqual([3, 3, 3, 3, 30]);
    expect(summary(out).max).toBe(30);
  });

  it('TST-04 the default clock measures real time and bad options are refused', async () => {
    const real = sampleSync(() => 0, { n: 10 });
    expect(real.every((x) => x >= 0)).toBe(true);
    expect((await sampleAsync(() => Promise.resolve(1), { n: 3 })).length).toBe(3);
    expect(() => sampleSync(() => 0, { n: 0 })).toThrow(RangeError);
    expect(() => sampleSync(() => 0, { n: 10, warmupPct: 100 })).toThrow(RangeError);
    await expect(sampleAsync(() => Promise.resolve(), { n: 1.5 })).rejects.toThrow(RangeError);
  });
});
