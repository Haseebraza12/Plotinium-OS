/**
 * The chronological, prequential evaluator (predictive-prefetch.md §3.10, §5.3; PRE-02).
 *
 * Per trace: the first 70 % (by time) trains, the last 30 % is held out; the last 15 % of the
 * training part is the validation slice for θ and H. On the held-out part every method first
 * predicts, then learns from the event (test-then-train), so no method ever sees the future. The
 * candidate rule is the same for every method: installed apps that are not running.
 */
import type { Method } from './baselines.ts';
import { MarkovPredictor, type PredictContext } from './markov.ts';
import { type TelemetryEventT, isTrainingLaunch } from './telemetry.ts';

export const TRAIN_FRACTION = 0.7;
export const VALIDATION_FRACTION = 0.15;

export interface Split {
  train: TelemetryEventT[];
  validation: TelemetryEventT[];
  test: TelemetryEventT[];
}

/** Chronological 70 / 30 split by training launches; validation is the last 15 % of train. */
export function chronologicalSplit(trace: readonly TelemetryEventT[]): Split {
  const sorted = [...trace].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  const launches = sorted.filter(isTrainingLaunch).length;
  const cutLaunch = Math.floor(launches * TRAIN_FRACTION);
  const valLaunch = Math.floor(cutLaunch * (1 - VALIDATION_FRACTION));
  let seen = 0;
  const split: Split = { train: [], validation: [], test: [] };
  for (const e of sorted) {
    const idx = seen;
    if (isTrainingLaunch(e)) seen++;
    if (idx >= cutLaunch) split.test.push(e);
    else {
      split.train.push(e);
      if (idx >= valLaunch) split.validation.push(e);
    }
  }
  return split;
}

/** The Markov model as an evaluation method. */
export class MarkovMethod implements Method {
  readonly name = 'markov2';
  readonly model: MarkovPredictor;

  constructor(apps: readonly string[], halfLife?: number) {
    this.model = new MarkovPredictor(apps, halfLife);
  }

  top(ctx: PredictContext, candidates: readonly string[], now: number, k: number): string[] {
    return this.model.rank(ctx, candidates, now, k).map((r) => r.app);
  }

  update(e: TelemetryEventT): void {
    this.model.update(e);
  }
}

export interface MethodScore {
  n: number;
  top1: number;
  top3: number;
}

export interface EvalResult {
  launches: number;
  scores: Record<string, MethodScore>;
}

/** Running apps per session, from launch and close events. */
class Running {
  private readonly open = new Map<string, Set<string>>();

  set(e: TelemetryEventT): Set<string> {
    let s = this.open.get(e.osSessionId);
    if (s === undefined) {
      s = new Set();
      this.open.set(e.osSessionId, s);
    }
    return s;
  }

  apply(e: TelemetryEventT): void {
    const s = this.set(e);
    if (e.kind === 'launch') s.add(e.app);
    else if (e.kind === 'close') s.delete(e.app);
  }
}

/**
 * Train every method on `train`, then run test-then-train over `test`. The Markov context of an
 * event comes from a shadow model so every method is asked with the same context.
 */
export function prequential(
  apps: readonly string[],
  split: Split,
  methods: readonly Method[],
): EvalResult {
  const shadow = new MarkovPredictor(apps);
  const running = new Running();
  for (const e of split.train) {
    for (const m of methods) m.update(e);
    shadow.update(e);
    running.apply(e);
  }
  const scores: Record<string, MethodScore> = {};
  for (const m of methods) scores[m.name] = { n: 0, top1: 0, top3: 0 };
  let launches = 0;
  for (const e of split.test) {
    if (isTrainingLaunch(e)) {
      const open = running.set(e);
      const candidates = apps.filter((a) => !open.has(a));
      const ctx = shadow.contextFor(e);
      launches++;
      for (const m of methods) {
        const top = m.top(ctx, candidates, e.ts, 3);
        const s = scores[m.name];
        if (s === undefined) continue;
        s.n++;
        if (top[0] === e.app) s.top1++;
        if (top.includes(e.app)) s.top3++;
      }
    }
    // Learn only after predicting (no leakage).
    for (const m of methods) m.update(e);
    shadow.update(e);
    running.apply(e);
  }
  return { launches, scores };
}

export function accuracy(s: MethodScore): { top1: number; top3: number } {
  return s.n === 0 ? { top1: 0, top3: 0 } : { top1: s.top1 / s.n, top3: s.top3 / s.n };
}
