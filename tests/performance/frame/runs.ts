/**
 * Turns the runs of one frame-trace scenario into the two result files its budgets need: the
 * frame p95 (median of the per-run p95s, WM §8.2 step 8) and the LoAF count (pooled over runs).
 */
import { median } from '../../support/percentile.ts';
import type { Budget } from '../budgets.schema.ts';
import type { Envelope } from '../envelope.ts';
import type { PerfResult, RunSummary } from '../result.ts';

import type { FrameStats, LoafSummary } from './parse.ts';

export interface FrameRun {
  stats: FrameStats;
  loaf: LoafSummary;
  accumulators?: Record<string, number>;
}

export interface Timing {
  startedAt: string;
  durationMs: number;
}

function frameRunSummary(r: FrameRun): RunSummary {
  const s = r.stats;
  return {
    n: Math.max(1, s.frames),
    p50: s.p50Ms,
    p95: s.p95Ms,
    p99: s.p99Ms,
    max: s.maxMs,
    valid: s.valid,
    ...(s.invalidReason === undefined ? {} : { notes: s.invalidReason }),
  };
}

/** The frame result's value: median of valid runs' p95 (all runs if none is valid). */
export function frameValue(runs: readonly FrameRun[]): number {
  if (runs.length === 0) throw new RangeError('no frame runs');
  const valid = runs.filter((r) => r.stats.valid);
  return median((valid.length > 0 ? valid : runs).map((r) => r.stats.p95Ms));
}

export function frameResults(
  frameBudget: Budget,
  loafBudget: Budget,
  runs: readonly FrameRun[],
  env: Envelope,
  timing: Timing,
): [PerfResult, PerfResult] {
  const common = { ...env, ...timing, verdict: 'report' as const };
  const frame: PerfResult = {
    ...common,
    budgetId: frameBudget.id,
    runs: runs.map(frameRunSummary),
    value: frameValue(runs),
    extra: {
      vsyncMs: runs.map((r) => r.stats.vsyncMs),
      droppedPct: runs.map((r) => r.stats.droppedPct),
      partialPct: runs.map((r) => r.stats.partialPct),
      onTimePct: runs.map((r) => r.stats.onTimePct),
      rawIntervalP95Ms: runs.map((r) => r.stats.rawIntervalP95Ms),
      accumulators: runs.map((r) => r.accumulators ?? {}),
    },
  };
  const loaf: PerfResult = {
    ...common,
    budgetId: loafBudget.id,
    runs: runs.map((r) => {
      const c = r.loaf.over50Ours;
      return {
        n: Math.max(1, r.stats.frames),
        p50: c,
        p95: c,
        p99: c,
        max: c,
        valid: r.stats.valid,
      };
    }),
    value: runs.reduce((sum, r) => sum + r.loaf.over50Ours, 0),
    extra: {
      loafUnattributed: runs.reduce((sum, r) => sum + r.loaf.over50Unattributed, 0),
      worstOursMs: Math.max(0, ...runs.map((r) => r.loaf.worstOursMs)),
      sources: [...new Set(runs.flatMap((r) => r.loaf.sources))].sort(),
    },
  };
  return [frame, loaf];
}
