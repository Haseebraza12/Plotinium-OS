import { describe, expect, it } from 'vitest';

import { MemoryBudgetStore } from './budget-memory.ts';
import {
  budgetLeft,
  chargedRows,
  crossedAlerts,
  isBudgetPool,
  keyString,
  localClock,
  parseKeyString,
  semesterStartOf,
  type BudgetLimits,
  type BudgetRow,
  type NewLlmRequest,
  type PoolState,
  type Settlement,
} from './budget.ts';
import { createPricing, PRICING_VERSION, usdToMicro } from './pricing.ts';

const LIMITS: BudgetLimits = {
  monthUsd: 50,
  totalUsd: 250,
  userUsdDay: 2,
  demoUsdDay: 3,
  demoCallsDay: 20,
  examinerUsdDay: 15,
  examinerCallsDay: 100,
};
const CLOCK = localClock(Date.UTC(2026, 8, 25, 7, 0, 0), 'Asia/Karachi');

function req(id: string, reserved: number): NewLlmRequest {
  return {
    requestId: id,
    uid: 1001,
    osSessionId: null,
    pid: null,
    promptId: null,
    turn: 1,
    purpose: 'plan',
    requestedModel: 'claude-opus-5-5',
    effort: 'medium',
    pricingVersion: PRICING_VERSION,
    reservedMicroUsd: reserved,
  };
}

const settled = (id: string, cost: number): Settlement => ({
  requestId: id,
  status: 'ok',
  servedModel: 'claude-opus-5-5',
  stopReason: 'end_turn',
  refusalCategory: null,
  providerRequestId: 'req_x',
  tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
  costMicroUsd: cost,
  latencyMs: 10,
  error: null,
});

describe('LLM pricing (backend-api.md §3.13.2 price table)', () => {
  it('AIS-09 cost is input, output, cache reads and cache writes at the served model price, in whole micro-USD rounded up', () => {
    const p = createPricing();
    expect(p.version).toBe('2026-09-24');
    // Opus 5.5: $4 / $20 per MTok, cache read $0.20, cache write (5 min) $5
    expect(
      p.costMicroUsd('claude-opus-5-5', {
        input: 1000,
        output: 500,
        cacheRead: 2000,
        cacheWrite: 400,
      }),
    ).toBe(16_400);
    expect(
      p.costMicroUsd('claude-opus-5-5', { input: 0, output: 0, cacheRead: 1, cacheWrite: 0 }),
    ).toBe(1); // 0.2 -> 1
    // 1-hour writes cost 2 x input
    expect(
      p.costMicroUsd('claude-opus-5-5', {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 10,
        cacheWrite1h: 4,
      }),
    ).toBe(6 * 5 + 4 * 8);
    expect(
      p.costMicroUsd('claude-opus-5', {
        input: 1000,
        output: 1000,
        cacheRead: 1000,
        cacheWrite: 0,
      }),
    ).toBe(5000 + 25_000 + 500);
    expect(
      p.costMicroUsd('claude-opus-5-5', {
        input: -5,
        output: Number.NaN,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBe(0);
  });

  it('AIS-09 an unknown model is priced at the dearest known row, and the reservation takes the dearest of requested and fallback', () => {
    const p = createPricing();
    expect(p.priceOf('claude-unknown')).toMatchObject({
      known: false,
      output: 25_000,
      input: 5000,
    });
    expect(p.priceOf('claude-opus-5-5')).toMatchObject({ known: true, input: 4000 });
    expect(p.reserveMicroUsd(['claude-opus-5-5'], 1000, 8000)).toBe(1000 * 4 + 8000 * 20);
    expect(p.reserveMicroUsd(['claude-opus-5-5', 'claude-opus-5'], 1000, 8000)).toBe(
      1000 * 5 + 8000 * 25,
    );
    expect(p.reserveMicroUsd([], 1, 1)).toBe(30);
    const custom = createPricing(
      {
        'claude-opus-5-5': {
          input: 1,
          output: 2,
          cacheRead: 0.1,
          cacheWrite5m: 1.25,
          cacheWrite1h: 2,
        },
      },
      'v2',
    );
    expect(custom.version).toBe('v2');
    expect(
      custom.costMicroUsd('claude-opus-5-5', {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBe(30);
    expect(() =>
      createPricing({
        bad: { input: -1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      }),
    ).toThrow(RangeError);
    expect(usdToMicro(2.5)).toBe(2_500_000);
    expect(() => usdToMicro(-1)).toThrow(RangeError);
  });
});

describe('LLM budget pools and periods (backend-api.md §3.13.2; database.md §3.21)', () => {
  it('AIS-09 days are calendar days in PLOTINIUM_TZ and the next budget day is at local midnight', () => {
    expect(CLOCK).toEqual({
      day: '2026-09-25',
      year: 2026,
      month: 9,
      msToNextDay: 12 * 3600 * 1000,
    });
    // 20:30 UTC is already the next day in Karachi (UTC+5)
    expect(localClock(Date.UTC(2026, 8, 25, 20, 30, 0, 250), 'Asia/Karachi')).toMatchObject({
      day: '2026-09-26',
      msToNextDay: 22.5 * 3600 * 1000 - 250,
    });
    expect(localClock(Date.UTC(2026, 11, 31, 23, 0, 0), 'UTC').day).toBe('2026-12-31');
    expect(semesterStartOf(2026, 9)).toBe('2026-08-01');
    expect(semesterStartOf(2027, 1)).toBe('2026-08-01');
    expect(semesterStartOf(2027, 3)).toBe('2027-02-01');
  });

  it('AIS-09 the examiner role has its own daily cap separate from the demo account', () => {
    const user = chargedRows({ uid: 1001, kind: 'user' }, CLOCK, LIMITS);
    expect(user.map(keyString)).toEqual([
      'global/month/2026-09-01',
      'global/semester/2026-08-01',
      'uid:1001/day/2026-09-25',
    ]);
    expect(user.map((r) => [r.limitMicroUsd, r.callLimit])).toEqual([
      [50_000_000, null],
      [250_000_000, null],
      [2_000_000, null],
    ]);
    const examiner = chargedRows({ uid: 2001, kind: 'examiner' }, CLOCK, LIMITS);
    expect(examiner.slice(2)).toEqual([
      {
        pool: 'uid:2001',
        period: 'day',
        periodStart: '2026-09-25',
        limitMicroUsd: 15_000_000,
        callLimit: 100,
      },
      {
        pool: 'examiners',
        period: 'day',
        periodStart: '2026-09-25',
        limitMicroUsd: 15_000_000,
        callLimit: 100,
      },
    ]);
    const guest = chargedRows({ uid: 60001, kind: 'guest' }, CLOCK, LIMITS);
    expect(guest.slice(2).map(keyString)).toEqual([
      'uid:60001/day/2026-09-25',
      'demo/day/2026-09-25',
    ]);
    expect(guest[3]).toMatchObject({ limitMicroUsd: 3_000_000, callLimit: 20 });
    expect(chargedRows({ uid: 900, kind: 'demo' }, CLOCK, LIMITS)).toHaveLength(4);
    expect(chargedRows({ uid: 0, kind: 'root' }, CLOCK, LIMITS, '2026-09-01')[1]?.periodStart).toBe(
      '2026-09-01',
    );
  });

  it('AIS-09 charged keys round-trip through the llm_requests.charged_keys text format', () => {
    for (const r of chargedRows({ uid: 60001, kind: 'guest' }, CLOCK, LIMITS)) {
      expect(parseKeyString(keyString(r))).toEqual({
        pool: r.pool,
        period: r.period,
        periodStart: r.periodStart,
      });
    }
    for (const bad of [
      'x/day/2026-09-25',
      'global/week/2026-09-25',
      'global/day/26-9-25',
      'global/day/2026-09-25/x',
      'global',
    ]) {
      expect(() => parseKeyString(bad)).toThrow(RangeError);
    }
    expect(isBudgetPool('uid:12')).toBe(true);
    expect(isBudgetPool('uid:')).toBe(false);
  });

  it('AIS-09 a reservation is all or nothing over the charged rows, and settlement is unconditional and happens once', async () => {
    const store = new MemoryBudgetStore(() => 0);
    const rows: BudgetRow[] = [
      {
        pool: 'global',
        period: 'month',
        periodStart: '2026-09-01',
        limitMicroUsd: 1000,
        callLimit: null,
      },
      { pool: 'uid:1', period: 'day', periodStart: '2026-09-25', limitMicroUsd: 500, callLimit: 2 },
    ];
    expect(await store.reserve(rows, req('a', 400))).toEqual({ ok: true });
    expect(await store.reserve(rows, req('b', 200))).toEqual({
      ok: false,
      exhausted: [{ pool: 'uid:1', period: 'day', periodStart: '2026-09-25' }],
    });
    expect(store.pool(rows[0] as BudgetRow)).toMatchObject({ reservedMicroUsd: 400, calls: 1 }); // nothing of 'b' stuck
    expect(store.requests.has('b')).toBe(false);
    const after = await store.settle(rows, 400, settled('a', 150));
    expect(after.map((p) => [p.reservedMicroUsd, p.spentMicroUsd])).toEqual([
      [0, 150],
      [0, 150],
    ]);
    expect(await store.settle(rows, 400, settled('a', 150))).toEqual([]); // idempotent
    await store.reserve(rows, req('c', 1));
    expect((await store.reserve(rows, req('d', 1))).ok).toBe(false); // call cap 2 per day
    expect((await store.pools(rows)).map((p) => p.calls)).toEqual([2, 2]);
    expect(await store.pools([{ pool: 'demo', period: 'day', periodStart: '2026-09-25' }])).toEqual(
      [],
    );
  });

  it('AIS-09 alerts fire once at each of 50, 80 and 100 % of a global cap; budgetLeft is the smallest remainder', () => {
    const row = (spent: number): PoolState => ({
      pool: 'global',
      period: 'semester',
      periodStart: '2026-08-01',
      limitMicroUsd: 1000,
      callLimit: null,
      reservedMicroUsd: 0,
      spentMicroUsd: spent,
      calls: 1,
    });
    expect(crossedAlerts([row(400)], 100)).toEqual([]);
    expect(crossedAlerts([row(500)], 100).map((a) => a.threshold)).toEqual([0.5]);
    expect(crossedAlerts([row(1000)], 600).map((a) => a.threshold)).toEqual([0.5, 0.8, 1]);
    expect(crossedAlerts([{ ...row(1000), pool: 'uid:1' }], 600)).toEqual([]);
    const rows = chargedRows({ uid: 1, kind: 'user' }, CLOCK, LIMITS);
    expect(budgetLeft(rows, [])).toBe(2_000_000);
    expect(
      budgetLeft(rows, [
        {
          ...(rows[2] as BudgetRow),
          reservedMicroUsd: 500_000,
          spentMicroUsd: 1_000_000,
          calls: 3,
        },
      ]),
    ).toBe(500_000);
    expect(budgetLeft([], [])).toBe(0);
  });
});
