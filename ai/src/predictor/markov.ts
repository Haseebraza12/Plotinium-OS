/**
 * Witten-Bell interpolated Markov-2 predictor with back-off to Markov-1, the time-bucket MFU and
 * the global MFU (predictive-prefetch.md §3.4; canonical C12; PRE-01).
 *
 * Counts decay lazily with half-life H = 14 days: each is stored as `(value, t)` and read as
 * `value · 2^(−(now − t)/H)`. All counts of a context decay at the same rate, so a context total
 * kept as its own decayed pair equals the sum of its members exactly. One update touches 4
 * contexts: O(1) expected. A prediction reads at most 4·|C| counts: O(|V|), |V| ≤ 32.
 *
 *   λ(c)   = N(c) / (N(c) + T(c))            (0 when N(c) = 0)
 *   P_G(a) = (N(g,a) + 1) / (N(g) + |V|)
 *   P_0(a) = λ(c0)·N(c0,a)/N(c0) + (1 − λ(c0))·P_G(a)
 *   P_1(a) = λ(c1)·N(c1,a)/N(c1) + (1 − λ(c1))·P_0(a)
 *   P_2(a) = λ(c2)·N(c2,a)/N(c2) + (1 − λ(c2))·P_1(a)
 *   P(a)   = P_2(a) / Σ_{b∈C} P_2(b),  C = installed apps that are not running.
 *
 * T(c), the number of apps with a decayed count above ε = 0.05, is counted at read time over the
 * context's members, which keeps it exact under decay without mutating the model on a read.
 * Cold start: under 50 training launches the ranking is P_0 with confidence 0 (no pre-fetch).
 *
 * Plotinium note: counts use the built-in Map, the hashing primitive §10.2 allows; the spec's
 * `dsa/hashtable` needs dense int keys and is a TODO(dsa) swap once S6 is implemented.
 */
import type { PredictModel, Prediction } from '@plotinium/protocol';

import { type TelemetryEventT, isTrainingLaunch } from './telemetry.ts';

export const HALF_LIFE_MS = 14 * 24 * 3_600_000;
export const EPSILON = 0.05;
export const COLD_START_LAUNCHES = 50;
export const BOS = '^';

interface Count {
  v: number;
  t: number;
}

interface Ctx {
  members: Map<string, Count>;
  total: Count;
}

export function decayed(c: Count | undefined, now: number, halfLife = HALF_LIFE_MS): number {
  if (c === undefined) return 0;
  return c.v * 2 ** (-Math.max(0, now - c.t) / halfLife);
}

export interface PredictContext {
  prev2: string;
  prev1: string;
  hourBucket: number;
  weekend: boolean;
}

export interface Ranked {
  app: string;
  p: number;
}

export interface PredictionSet {
  model: PredictModel;
  coldStart: boolean;
  launches: number;
  predictions: Prediction[];
}

const BUCKET_LABEL = [
  '00:00–04:00',
  '04:00–08:00',
  '08:00–12:00',
  '12:00–16:00',
  '16:00–20:00',
  '20:00–24:00',
];

export class MarkovPredictor {
  private readonly ctxs = new Map<string, Ctx>();
  private launchCount = 0;
  private session = '';
  private hist1 = BOS;
  private hist2 = BOS;
  private readonly halfLife: number;
  readonly apps: readonly string[];

  constructor(apps: readonly string[], halfLife = HALF_LIFE_MS) {
    this.apps = [...apps];
    this.halfLife = halfLife;
  }

  get launches(): number {
    return this.launchCount;
  }

  static keys(c: PredictContext): { c2: string; c1: string; c0: string; g: string } {
    return {
      c2: `2|${c.prev2}|${c.prev1}`,
      c1: `1|${c.prev1}`,
      c0: `0|${c.hourBucket}|${c.weekend ? 1 : 0}`,
      g: 'g',
    };
  }

  /** The context of the NEXT launch in `e`'s session, before `e` is learned. */
  contextFor(e: TelemetryEventT): PredictContext {
    const same = e.osSessionId === this.session;
    return {
      prev2: same ? this.hist2 : BOS,
      prev1: same ? this.hist1 : BOS,
      hourBucket: e.hourBucket,
      weekend: e.weekend,
    };
  }

  private bump(key: string, app: string, now: number): void {
    let c = this.ctxs.get(key);
    if (c === undefined) {
      c = { members: new Map(), total: { v: 0, t: now } };
      this.ctxs.set(key, c);
    }
    c.members.set(app, { v: decayed(c.members.get(app), now, this.halfLife) + 1, t: now });
    c.total = { v: decayed(c.total, now, this.halfLife) + 1, t: now };
  }

  /** O(1) update on one event; non-training events only move the session history. */
  update(e: TelemetryEventT): void {
    if (!isTrainingLaunch(e)) return;
    const ctx = this.contextFor(e);
    const k = MarkovPredictor.keys(ctx);
    for (const key of [k.c2, k.c1, k.c0, k.g]) this.bump(key, e.app, e.ts);
    this.launchCount++;
    if (e.osSessionId !== this.session) {
      this.session = e.osSessionId;
      this.hist1 = BOS;
    }
    this.hist2 = this.hist1;
    this.hist1 = e.app;
  }

  private stats(key: string, now: number): { n: number; t: number; count(app: string): number } {
    const c = this.ctxs.get(key);
    if (c === undefined) return { n: 0, t: 0, count: () => 0 };
    let t = 0;
    for (const m of c.members.values()) if (decayed(m, now, this.halfLife) > EPSILON) t++;
    return {
      n: decayed(c.total, now, this.halfLife),
      t,
      count: (app) => decayed(c.members.get(app), now, this.halfLife),
    };
  }

  /** Per-component terms of P_2(a), for the reason string and `predict --why`. */
  components(
    ctx: PredictContext,
    app: string,
    now: number,
  ): { m2: number; m1: number; m0: number; g: number; p2: number } {
    const k = MarkovPredictor.keys(ctx);
    const s2 = this.stats(k.c2, now);
    const s1 = this.stats(k.c1, now);
    const s0 = this.stats(k.c0, now);
    const sg = this.stats(k.g, now);
    const lam = (s: { n: number; t: number }): number => (s.n > 0 ? s.n / (s.n + s.t) : 0);
    const ml = (s: { n: number; count(a: string): number }): number =>
      s.n > 0 ? s.count(app) / s.n : 0;
    const pg = (sg.count(app) + 1) / (sg.n + this.apps.length);
    const l2 = lam(s2);
    const l1 = lam(s1);
    const l0 = lam(s0);
    const m2 = l2 * ml(s2);
    const m1 = (1 - l2) * l1 * ml(s1);
    const m0 = (1 - l2) * (1 - l1) * l0 * ml(s0);
    const g = (1 - l2) * (1 - l1) * (1 - l0) * pg;
    return { m2, m1, m0, g, p2: m2 + m1 + m0 + g };
  }

  private p0(ctx: PredictContext, app: string, now: number): number {
    const k = MarkovPredictor.keys(ctx);
    const s0 = this.stats(k.c0, now);
    const sg = this.stats(k.g, now);
    const l0 = s0.n > 0 ? s0.n / (s0.n + s0.t) : 0;
    const pg = (sg.count(app) + 1) / (sg.n + this.apps.length);
    return l0 * (s0.n > 0 ? s0.count(app) / s0.n : 0) + (1 - l0) * pg;
  }

  /** Normalised distribution over the candidates (P_2, or P_0 in cold start). */
  distribution(ctx: PredictContext, candidates: readonly string[], now: number): Ranked[] {
    const cold = this.launchCount < COLD_START_LAUNCHES;
    const raw = candidates.map((app) => ({
      app,
      p: cold ? this.p0(ctx, app, now) : this.components(ctx, app, now).p2,
    }));
    const sum = raw.reduce((s, r) => s + r.p, 0);
    return raw.map((r) => ({ app: r.app, p: sum > 0 ? r.p / sum : 0 }));
  }

  /** Top k in one pass over the candidates (k ≤ 10: a short sorted insertion, ties by app id). */
  rank(ctx: PredictContext, candidates: readonly string[], now: number, k = 3): Ranked[] {
    const top: Ranked[] = [];
    for (const r of this.distribution(ctx, candidates, now)) {
      let i = top.length;
      while (i > 0) {
        const prev = top[i - 1];
        if (prev === undefined || prev.p > r.p || (prev.p === r.p && prev.app < r.app)) break;
        i--;
      }
      if (i < k) {
        top.splice(i, 0, r);
        if (top.length > k) top.pop();
      }
    }
    return top;
  }

  /** The published prediction set with confidence and a reason for each entry (PRE-06). */
  predict(ctx: PredictContext, candidates: readonly string[], now: number, k = 3): PredictionSet {
    const cold = this.launchCount < COLD_START_LAUNCHES;
    const top = this.rank(ctx, candidates, now, k);
    const keys = MarkovPredictor.keys(ctx);
    const obs = (key: string): number => Math.round(this.stats(key, now).n);
    const predictions = top.map((r) => {
      let reason: string;
      if (cold)
        reason = `most used overall (cold start ${this.launchCount}/${COLD_START_LAUNCHES})`;
      else {
        const c = this.components(ctx, r.app, now);
        const best = Math.max(c.m2, c.m1, c.m0, c.g);
        if (best === c.m2)
          reason = `after ${ctx.prev2} → ${ctx.prev1} (markov-2, ${obs(keys.c2)} obs)`;
        else if (best === c.m1) reason = `after ${ctx.prev1} (markov-1, ${obs(keys.c1)} obs)`;
        else if (best === c.m0) {
          reason = `${ctx.weekend ? 'weekend' : 'weekday'} ${BUCKET_LABEL[ctx.hourBucket] ?? ''} (time bucket, ${obs(keys.c0)} obs)`;
        } else reason = `most used overall (${obs(keys.g)} obs)`;
      }
      return {
        app: r.app,
        confidence: cold ? 0 : Math.min(1, Math.max(0, r.p)),
        reason: reason.slice(0, 200),
      };
    });
    const model: PredictModel = cold
      ? this.stats(keys.c0, now).n > 0
        ? 'mfu-bucket'
        : 'mfu'
      : 'markov2';
    return { model, coldStart: cold, launches: this.launchCount, predictions };
  }
}
