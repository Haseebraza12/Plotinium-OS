import fc from 'fast-check';
import { TELEMETRY_RING_SIZE } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { APPS, generateTrace } from '../eval/pre/persona.ts';
import { type Method, MfuBaseline, MruBaseline } from '../src/predictor/baselines.ts';
import {
  MarkovMethod,
  accuracy,
  chronologicalSplit,
  prequential,
} from '../src/predictor/evaluate.ts';
import {
  BOS,
  COLD_START_LAUNCHES,
  HALF_LIFE_MS,
  MarkovPredictor,
  decayed,
} from '../src/predictor/markov.ts';
import {
  type PrefetchInputs,
  bootlogLine,
  decidePrefetch,
  residencyHint,
} from '../src/predictor/prefetch.ts';
import {
  TelemetryRing,
  isTrainingLaunch,
  makeEvent,
  shouldRecord,
  validateEvent,
} from '../src/predictor/telemetry.ts';
import { arrayRing } from './doubles.ts';

const DAY0 = Date.parse('2026-09-01T00:00:00+05:00');
const SESSION = '0192f0c1-0000-7000-8000-000000000001';
const launch = (seq: number, app: string, ts: number, session = SESSION) =>
  makeEvent({
    seq,
    ts,
    tzOffsetMin: 300,
    kind: 'launch',
    app,
    prev: null,
    sessionPos: seq,
    origin: 'user',
    osSessionId: session,
  });

function trained(
  events = generateTrace({ persona: 'developer', seed: 7, days: 40, start: DAY0 }),
): MarkovPredictor {
  const m = new MarkovPredictor(APPS);
  for (const e of events) m.update(e);
  return m;
}

describe('telemetry (PRE-05)', () => {
  it('PRE-05 telemetry events contain no file names, paths or content', () => {
    const e = launch(1, 'editor', DAY0 + 9 * 3_600_000);
    expect(validateEvent(e)).toBe(true);
    expect(Object.keys(e).sort()).toEqual([
      'app',
      'dow',
      'hourBucket',
      'kind',
      'origin',
      'osSessionId',
      'prev',
      'seq',
      'sessionPos',
      'ts',
      'tzOffsetMin',
      'v',
      'weekend',
    ]);
    expect(validateEvent({ ...e, path: '/home/alice/secret.md' })).toBe(false);
    expect(validateEvent({ ...e, app: '/home/alice/x' })).toBe(false);
    expect(validateEvent({ ...e, title: 'Budget 2026.xlsx' })).toBe(false);
  });

  it('PRE-05 events carry the local hour bucket, day of week and weekend flag', () => {
    const sat = makeEvent({
      seq: 1,
      ts: Date.parse('2026-10-03T09:30:00+05:00'),
      tzOffsetMin: 300,
      kind: 'focus',
      app: 'files',
      prev: 'editor',
      sessionPos: 2,
      origin: 'user',
      osSessionId: SESSION,
    });
    expect([sat.hourBucket, sat.dow, sat.weekend, sat.prev]).toEqual([2, 6, true, null]);
    const custom = makeEvent({
      seq: 1,
      ts: Date.parse('2026-10-03T09:30:00+05:00'),
      tzOffsetMin: 300,
      kind: 'launch',
      app: 'files',
      prev: 'editor',
      sessionPos: 2,
      origin: 'user',
      osSessionId: SESSION,
      weekendDays: new Set([5]),
    });
    expect([custom.weekend, custom.prev]).toEqual([false, 'editor']);
  });

  it('PRE-05 pre-fetch spawns and session-restore launches are not used for training', () => {
    expect(shouldRecord('prefetch')).toBe(false);
    expect(shouldRecord('user')).toBe(true);
    const restore = makeEvent({
      seq: 1,
      ts: DAY0,
      tzOffsetMin: 300,
      kind: 'launch',
      app: 'files',
      prev: null,
      sessionPos: 1,
      origin: 'restore',
      osSessionId: SESSION,
    });
    expect(isTrainingLaunch(restore)).toBe(false);
    const m = new MarkovPredictor(APPS);
    m.update(restore);
    m.update(
      makeEvent({
        seq: 2,
        ts: DAY0,
        tzOffsetMin: 300,
        kind: 'close',
        app: 'files',
        prev: null,
        sessionPos: 1,
        origin: 'user',
        osSessionId: SESSION,
      }),
    );
    expect(m.launches).toBe(0);
  });

  it('PRE-05 the ring keeps the newest 4,096 events, can be read incrementally, cleared and exported', () => {
    const ring = new TelemetryRing(arrayRing);
    for (let i = 1; i <= TELEMETRY_RING_SIZE + 10; i++)
      expect(ring.record(launch(i, 'files', DAY0 + i))).toBe(true);
    expect(ring.size).toBe(TELEMETRY_RING_SIZE);
    const page = ring.read(TELEMETRY_RING_SIZE + 5, 3);
    expect(page.events.map((e) => e.seq)).toEqual([
      TELEMETRY_RING_SIZE + 6,
      TELEMETRY_RING_SIZE + 7,
      TELEMETRY_RING_SIZE + 8,
    ]);
    expect(page.next).toBe(TELEMETRY_RING_SIZE + 8);
    expect(ring.read(10_000)).toEqual({ events: [] });
    expect(
      ring.record({ ...launch(1, 'files', 0), path: '/x' } as unknown as ReturnType<typeof launch>),
    ).toBe(false);
    expect(ring.exportJsonl().split('\n')).toHaveLength(TELEMETRY_RING_SIZE);
    expect(ring.clear()).toBe(TELEMETRY_RING_SIZE);
    expect(ring.size).toBe(0);
  });
});

describe('Witten-Bell Markov-2 (PRE-01)', () => {
  it('PRE-01 decayed counts halve after 14 days and context totals equal the sum of their members', () => {
    expect(decayed({ v: 8, t: 0 }, HALF_LIFE_MS)).toBeCloseTo(4);
    expect(decayed({ v: 8, t: 10 }, 0)).toBe(8);
    expect(decayed(undefined, 1)).toBe(0);
    const m = new MarkovPredictor(['a', 'b', 'c']);
    const s = '0192f0c1-0000-7000-8000-00000000000f';
    m.update(launch(1, 'a', 0, s));
    m.update(launch(2, 'b', HALF_LIFE_MS, s));
    m.update(launch(3, 'a', 2 * HALF_LIFE_MS, s));
    const now = 3 * HALF_LIFE_MS;
    const ctx = { prev2: BOS, prev1: BOS, hourBucket: 0, weekend: false };
    const g = m.components(ctx, 'a', now);
    expect(g.p2).toBeGreaterThan(0);
    // Global context: a = 2^-3 + 2^-1, b = 2^-2, total = the sum.
    const dist = m.distribution(ctx, ['a', 'b', 'c'], now);
    expect(dist.reduce((x, r) => x + r.p, 0)).toBeCloseTo(1);
  });

  it('PRE-01 Witten-Bell probabilities over the candidate set sum to 1', () => {
    const m = trained();
    fc.assert(
      fc.property(
        fc.subarray([...APPS], { minLength: 1 }),
        fc.constantFrom(...APPS),
        fc.constantFrom(...APPS),
        fc.integer({ min: 0, max: 5 }),
        fc.boolean(),
        (cands, p1, p2, hb, we) => {
          const dist = m.distribution(
            { prev2: p2, prev1: p1, hourBucket: hb, weekend: we },
            cands,
            DAY0 + 41 * 86_400_000,
          );
          expect(dist.reduce((s, r) => s + r.p, 0)).toBeCloseTo(1, 9);
          for (const r of dist) expect(r.p).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('PRE-01 the incremental model equals a model rebuilt in batch from the same events', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 2, max: 12 }),
        (seed, days) => {
          const events = generateTrace({ persona: 'writer', seed, days, start: DAY0 });
          const incremental = new MarkovPredictor(APPS);
          const now = DAY0 + (days + 1) * 86_400_000;
          const ctx = { prev2: 'editor', prev1: 'files', hourBucket: 2, weekend: false };
          for (const e of events) {
            incremental.update(e);
            incremental.rank(ctx, APPS, e.ts, 3); // predictions in between must not change the model
          }
          const batch = trained(events);
          expect(incremental.distribution(ctx, APPS, now)).toEqual(
            batch.distribution(ctx, APPS, now),
          );
          expect(incremental.launches).toBe(batch.launches);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('PRE-01 with fewer than 50 launches the ranking is time-bucketed MFU with confidence 0', () => {
    const m = new MarkovPredictor(APPS);
    for (let i = 0; i < COLD_START_LAUNCHES - 1; i++)
      m.update(launch(i + 1, i % 3 === 0 ? 'terminal' : 'editor', DAY0 + 9 * 3_600_000 + i));
    const ctx = { prev2: BOS, prev1: BOS, hourBucket: 2, weekend: false };
    const set = m.predict(ctx, APPS, DAY0 + 10 * 3_600_000);
    expect(set.coldStart).toBe(true);
    expect(set.model).toBe('mfu-bucket');
    expect(set.predictions.map((p) => p.app).slice(0, 2)).toEqual(['editor', 'terminal']);
    expect(set.predictions.every((p) => p.confidence === 0)).toBe(true);
    expect(set.predictions[0]?.reason).toBe('most used overall (cold start 49/50)');
    expect(new MarkovPredictor(APPS).predict({ ...ctx, hourBucket: 5 }, APPS, DAY0).model).toBe(
      'mfu',
    );
  });

  it('PRE-06 after cold start predictions carry a confidence and a reason naming the winning component', () => {
    const m = trained();
    const set = m.predict(
      { prev2: 'files', prev1: 'editor', hourBucket: 2, weekend: false },
      APPS.filter((a) => a !== 'editor'),
      DAY0 + 41 * 86_400_000,
    );
    expect(set.model).toBe('markov2');
    expect(set.predictions[0]?.app).toBe('terminal');
    expect(set.predictions[0]?.confidence).toBeGreaterThan(0.4);
    expect(set.predictions[0]?.reason).toMatch(/^after files → editor \(markov-2, \d+ obs\)$/);
    const other = m.predict(
      { prev2: 'music', prev1: 'calendar', hourBucket: 0, weekend: true },
      APPS,
      DAY0 + 41 * 86_400_000,
      10,
    );
    expect(other.predictions.length).toBeLessThanOrEqual(8);
    expect(other.predictions.every((p) => p.reason.length > 0 && p.reason.length <= 200)).toBe(
      true,
    );
  });

  it('PRE-01 one prediction takes at most 5 ms p95 with 32 apps and 5,000 events of history', () => {
    const apps = Array.from({ length: 32 }, (_, i) => `app-${i}`);
    const m = new MarkovPredictor(apps);
    let x = 1;
    for (let i = 0; i < 5_000; i++) {
      x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
      m.update(
        launch(
          i + 1,
          apps[x % 32] ?? 'app-0',
          DAY0 + i * 60_000,
          `0192f0c1-0000-7000-8000-${String(Math.floor(i / 8)).padStart(12, '0')}`,
        ),
      );
    }
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      m.predict(
        {
          prev2: `app-${i % 32}`,
          prev1: `app-${(i * 7) % 32}`,
          hourBucket: i % 6,
          weekend: i % 2 === 0,
        },
        apps,
        DAY0 + 5_000 * 60_000,
      );
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThanOrEqual(5);
  });
});

describe('evaluation (PRE-02)', () => {
  it('PRE-02 the split is chronological 70/30 with the last 15 % of training as validation', () => {
    const trace = generateTrace({ persona: 'operator', seed: 3, days: 30, start: DAY0 });
    const s = chronologicalSplit([...trace].reverse());
    const lastTrain = s.train[s.train.length - 1];
    const firstTest = s.test[0];
    expect(lastTrain !== undefined && firstTest !== undefined && lastTrain.ts <= firstTest.ts).toBe(
      true,
    );
    const launches = trace.filter(isTrainingLaunch).length;
    expect(s.test.filter(isTrainingLaunch).length).toBe(launches - Math.floor(launches * 0.7));
    expect(s.validation.length).toBeGreaterThan(0);
    expect(s.validation.every((e) => s.train.includes(e))).toBe(true);
  });

  it('PRE-02 the evaluation never trains any method on an event before predicting it', () => {
    const trace = generateTrace({ persona: 'developer', seed: 11, days: 20, start: DAY0 });
    const split = chronologicalSplit(trace);
    const log: string[] = [];
    const spy: Method = {
      name: 'spy',
      top: (_c, _cands, now) => {
        log.push(`p${now}`);
        return [];
      },
      update: (e) => {
        if (isTrainingLaunch(e)) log.push(`u${e.ts}`);
      },
    };
    prequential(APPS, split, [spy]);
    for (const e of split.test.filter(isTrainingLaunch)) {
      const p = log.indexOf(`p${e.ts}`);
      const u = log.indexOf(`u${e.ts}`);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(u);
    }
  });

  it('PRE-02 top-3 accuracy of the Markov model beats the better of MFU and MRU on persona traces (unit fixture, not the claim)', () => {
    for (const persona of ['developer', 'writer', 'operator'] as const) {
      const trace = generateTrace({ persona, seed: 1234, days: 60, start: DAY0 });
      expect(trace.filter(isTrainingLaunch).length).toBeGreaterThanOrEqual(500);
      const r = prequential(APPS, chronologicalSplit(trace), [
        new MarkovMethod(APPS),
        new MfuBaseline(),
        new MruBaseline(),
      ]);
      const acc = (n: string) => accuracy(r.scores[n] ?? { n: 0, top1: 0, top3: 0 });
      expect(acc('markov2').top3, persona).toBeGreaterThan(
        Math.max(acc('mfu').top3, acc('mru').top3),
      );
      expect(r.launches).toBeGreaterThan(100);
    }
    expect(accuracy({ n: 0, top1: 0, top3: 0 })).toEqual({ top1: 0, top3: 0 });
  });
});

describe('pre-fetch policy (PRE-04)', () => {
  const MB = 1_048_576;
  const base: PrefetchInputs = {
    enabled: true,
    safeMode: false,
    coldStart: false,
    top1: { app: 'editor', confidence: 0.6 },
    theta: 0.4,
    running: new Set(['terminal']),
    jobAlive: false,
    wastedAt: () => undefined,
    now: 100_000,
    lastInputAt: 97_000,
    gestureInProgress: false,
    interactiveBusy: false,
    budgetBytes: 1_024 * MB,
    accountedBytes: 400 * MB,
    reservedBytes: 0,
    declaredBytes: () => 20 * MB,
    reclaimRunning: false,
    thrashing: false,
  };

  it('PRE-04 a confident prediction starts a prefetch job at priority 39 when idle with free memory', () => {
    expect(decidePrefetch(base)).toEqual({ start: true, app: 'editor', priority: 39 });
  });

  it('PRE-04 no prefetch job starts within 2 s of user input, during a gesture or with interactive work ready', () => {
    expect(decidePrefetch({ ...base, lastInputAt: 98_500 })).toEqual({
      start: false,
      reason: 'not idle',
    });
    expect(decidePrefetch({ ...base, gestureInProgress: true })).toEqual({
      start: false,
      reason: 'not idle',
    });
    expect(decidePrefetch({ ...base, interactiveBusy: true })).toEqual({
      start: false,
      reason: 'not idle',
    });
  });

  it('PRE-04 no prefetch job starts when free memory is below the app bytes plus 16 MB', () => {
    expect(decidePrefetch({ ...base, accountedBytes: 1_024 * MB - 35 * MB }).start).toBe(false);
    expect(
      decidePrefetch({ ...base, accountedBytes: 1_024 * MB - 37 * MB, reservedBytes: 0 }),
    ).toEqual({ start: false, reason: 'memory' });
    expect(decidePrefetch({ ...base, reclaimRunning: true })).toEqual({
      start: false,
      reason: 'memory',
    });
    expect(decidePrefetch({ ...base, thrashing: true })).toEqual({
      start: false,
      reason: 'memory',
    });
    expect(decidePrefetch({ ...base, accountedBytes: 900 * MB })).toEqual({
      start: false,
      reason: 'memory',
    });
  });

  it('PRE-04 disabled, safe mode, cold start, low confidence, running, busy and recently wasted apps are skipped', () => {
    expect(decidePrefetch({ ...base, enabled: false }).start).toBe(false);
    expect(decidePrefetch({ ...base, safeMode: true })).toEqual({
      start: false,
      reason: 'safe mode',
    });
    expect(decidePrefetch({ ...base, coldStart: true })).toEqual({
      start: false,
      reason: 'cold start',
    });
    expect(decidePrefetch({ ...base, top1: undefined })).toEqual({
      start: false,
      reason: 'no prediction',
    });
    expect(decidePrefetch({ ...base, top1: { app: 'editor', confidence: 0.39 } })).toEqual({
      start: false,
      reason: 'below θ',
    });
    expect(decidePrefetch({ ...base, top1: { app: 'terminal', confidence: 0.9 } })).toEqual({
      start: false,
      reason: 'running',
    });
    expect(decidePrefetch({ ...base, jobAlive: true })).toEqual({ start: false, reason: 'busy' });
    expect(decidePrefetch({ ...base, wastedAt: () => 50_000 })).toEqual({
      start: false,
      reason: 'wasted',
    });
    expect(decidePrefetch({ ...base, wastedAt: () => -600_000 }).start).toBe(true);
  });

  it('AIN-C4 a residency hint lasts 60 s for a confident top-1 and the stage-6 bootlog line names the jobs', () => {
    expect(residencyHint({ app: 'editor', confidence: 0.5 }, 0.4, 1_000)).toEqual({
      app: 'editor',
      until: 61_000,
    });
    expect(residencyHint({ app: 'editor', confidence: 0.3 }, 0.4, 1_000)).toBeUndefined();
    expect(residencyHint(undefined, 0.4, 1_000)).toBeUndefined();
    expect(
      bootlogLine([
        { app: 'terminal', confidence: 0.62 },
        { app: 'files', confidence: 0.44 },
      ]),
    ).toBe('session: pre-fetch terminal (0.62), files (0.44)');
    expect(bootlogLine([], 'cold start', '12/50 launches')).toBe(
      'session: pre-fetch skipped (cold start: 12/50 launches)',
    );
    expect(bootlogLine([])).toBe('session: pre-fetch skipped (no prediction)');
  });
});
