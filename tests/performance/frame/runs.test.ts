import { describe, expect, it } from 'vitest';

import { budget } from '../budgets.ts';
import type { Envelope } from '../envelope.ts';
import { validatePerfResult } from '../result.ts';

import type { FrameStats, LoafSummary } from './parse.ts';
import { frameResults, frameValue, type FrameRun } from './runs.ts';

const env: Envelope = {
  commit: 'a1f93c2',
  build: '0.2.0+a1f93c2',
  machine: {
    class: 'lab-spec',
    cpu: 'Intel Core i5-12500',
    hwc: 12,
    ramGiB: 16,
    os: 'linux 6.8',
    refreshHz: 60,
    dpr: 1,
  },
  chrome: { version: '153.0.7310.12', channel: 'stable' },
};

function run(p95: number, valid = true, loaf: Partial<LoafSummary> = {}): FrameRun {
  const stats: FrameStats = {
    vsyncMs: 16.667,
    frames: 1199,
    p50Ms: 16.667,
    p95Ms: p95,
    p99Ms: p95,
    maxMs: 50,
    droppedPct: 1,
    partialPct: 0,
    rawIntervalP95Ms: 16.9,
    onTimePct: 98,
    valid,
    ...(valid ? {} : { invalidReason: 'variable refresh or trace loss' }),
  };
  return {
    stats,
    loaf: { over50Ours: 0, over50Unattributed: 0, worstOursMs: 0, sources: [], ...loaf },
  };
}

describe('TST-05 frame run aggregation', () => {
  it('TST-05 the gate value is the median of the three per-run p95 values', () => {
    expect(frameValue([run(16.6), run(33.3), run(16.7)])).toBe(16.7);
  });

  it('TST-05 invalid runs are left out of the median unless every run is invalid', () => {
    expect(frameValue([run(16.6), run(99, false), run(16.7)])).toBe(16.6);
    expect(frameValue([run(20, false), run(30, false), run(40, false)])).toBe(30);
    expect(() => frameValue([])).toThrow(RangeError);
  });

  it('TST-05 WM-03 runs become one frame result and one pooled LoAF result, both valid evidence', () => {
    const runs = [
      run(16.6, true, {
        over50Ours: 1,
        worstOursMs: 70,
        sources: ['http://localhost:4717/assets/wm.js'],
      }),
      run(16.7, false),
      run(16.5, true, { over50Unattributed: 2, sources: ['http://localhost:4717/assets/wm.js'] }),
    ];
    const [frame, loaf] = frameResults(
      budget('WM-03.drag-frame'),
      budget('WM-03.drag-loaf'),
      runs,
      env,
      {
        startedAt: '2026-10-20T21:30:00Z',
        durationMs: 75_000,
      },
    );
    expect(validatePerfResult(frame, 'frame-trace')).toEqual([]);
    expect(validatePerfResult(loaf, 'frame-trace')).toEqual([]);
    expect(frame.budgetId).toBe('WM-03.drag-frame');
    expect(frame.value).toBe(16.5);
    expect(frame.runs[1]).toMatchObject({ valid: false, notes: 'variable refresh or trace loss' });
    expect(loaf.value).toBe(1);
    expect(loaf.extra).toEqual({
      loafUnattributed: 2,
      worstOursMs: 70,
      sources: ['http://localhost:4717/assets/wm.js'],
    });
  });
});
