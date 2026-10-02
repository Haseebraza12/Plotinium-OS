/**
 * The PRE-02 baselines (predictive-prefetch.md §3.10): MFU ranks apps by launch count so far, MRU
 * by most recent launch. Both learn online from training launches only and use the same candidate
 * rule as the model (running apps excluded). Ties break by app id so runs are reproducible.
 */
import type { PredictContext } from './markov.ts';
import { type TelemetryEventT, isTrainingLaunch } from './telemetry.ts';

export interface Method {
  readonly name: string;
  /** The top-k apps among `candidates` for the next launch, best first. */
  top(ctx: PredictContext, candidates: readonly string[], now: number, k: number): string[];
  update(e: TelemetryEventT): void;
}

function topBy(candidates: readonly string[], score: (app: string) => number, k: number): string[] {
  return [...candidates]
    .sort((a, b) => score(b) - score(a) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, k);
}

export class MfuBaseline implements Method {
  readonly name = 'mfu';
  private readonly counts = new Map<string, number>();

  top(_ctx: PredictContext, candidates: readonly string[], _now: number, k: number): string[] {
    return topBy(candidates, (a) => this.counts.get(a) ?? 0, k);
  }

  update(e: TelemetryEventT): void {
    if (isTrainingLaunch(e)) this.counts.set(e.app, (this.counts.get(e.app) ?? 0) + 1);
  }
}

export class MruBaseline implements Method {
  readonly name = 'mru';
  private readonly last = new Map<string, number>();
  private tick = 0;

  top(_ctx: PredictContext, candidates: readonly string[], _now: number, k: number): string[] {
    return topBy(candidates, (a) => this.last.get(a) ?? -1, k);
  }

  update(e: TelemetryEventT): void {
    if (isTrainingLaunch(e)) this.last.set(e.app, ++this.tick);
  }
}
