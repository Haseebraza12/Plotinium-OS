import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { budget, loadBudgets, miss } from './budgets.ts';
import { BUDGET_ID, validateBudgetFile, weekNumber, type Budget } from './budgets.schema.ts';
import { isKnownMethod, methodOf } from './methods.ts';

/** Every row of testing-and-performance.md §7.1 (compound targets are split into suffixed ids). */
const SPEC_7_1 = [
  'BOOT-10.warm',
  'BOOT-10.cold',
  'BOOT-10.cold-first',
  'BOOT-10.no-large-assets',
  'BOOT-02.throttled',
  'PROC-05.frame',
  'PROC-05.loaf',
  'WM-03.drag-frame',
  'WM-03.drag-loaf',
  'PROC-04.starvation',
  'PROC-09.frame-256',
  'MEM-01.default-budget',
  'MEM-05.local',
  'MEM-05.remote',
  'MEM-06.over-budget',
  'MEM-03.byte-identical',
  'VFS-03.eloop',
  'VFS-08.limits',
  'VFS-09.crash-expiry',
  'SYS-03.trie-p95',
  'DB-02.orphans',
  'DB-05.q1',
  'DB-05.q2',
  'DB-05.q3',
  'DB-05.q4',
  'DB-05.q5',
  'RAG-02.freshness',
  'RAG-03.leaks',
  'RAG-04.recall5',
  'RAG-05.retrieval',
  'AGT-03.threshold',
  'AGT-06.injection',
  'AGT-07.benchmark',
  'PRE-01.predict',
  'PRE-02.top3',
  'PRE-03.latency-cut',
  'PRE-04.frame',
  'OFF-02.exactly-once',
  'OPS-05.bringup',
  'TST-03.coverage',
  'ARC-04.main-thread',
] as const;

const base = (): Budget => structuredClone(budget('WM-03.drag-frame'));
const fileWith = (...budgets: unknown[]): unknown => ({
  schema: 1,
  updated: '2026-09-25',
  budgets,
});

describe('TST-04 budgets.json', () => {
  it('TST-04 budgets.json validates against the budget schema', () => {
    const raw: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL('./budgets.json', import.meta.url)), 'utf8'),
    );
    expect(validateBudgetFile(raw)).toEqual([]);
  });

  it('TST-04 every budget id begins with a requirement ID and every §7.1 spec target has a budget', () => {
    const ids = loadBudgets().budgets.map((b) => b.id);
    for (const id of ids) expect(id).toMatch(BUDGET_ID);
    for (const id of SPEC_7_1) {
      expect(
        ids.some((x) => x === id || x.startsWith(`${id}-`)),
        `missing §7.1 budget ${id}`,
      ).toBe(true);
    }
  });

  it('TST-04 every spec-sourced budget cites its spec section and every method is registered', () => {
    for (const b of loadBudgets().budgets) {
      expect(isKnownMethod(b.method), b.id).toBe(true);
      if (b.source === 'spec') expect(b.specRef, b.id).toBeDefined();
    }
    expect(methodOf('frame-trace')?.browser).toBe(true);
    expect(methodOf('nope')).toBeUndefined();
  });

  it('TST-04 the validator rejects each malformed budget with a reason', () => {
    const cases: Array<[Partial<Budget> & Record<string, unknown>, RegExp]> = [
      [{ id: 'drag-frame' }, /id must be/],
      [{ req: ['WM-99'] }, /own requirement WM-03/],
      [{ req: [] }, /non-empty list/],
      [{ kind: 'hard', hardFrom: undefined }, /needs hardFrom/],
      [{ hardFrom: 'W19' }, /W1\.\.W18/],
      [{ cadence: ['pr'], machine: 'lab-spec' }, /must have machine 'any'/],
      [{ method: 'stopwatch' }, /methods\.ts/],
      [{ owner: 'R3', reviewer: 'R3' }, /must differ/],
      [{ ourSpec: 'window-manager' }, /ourSpec/],
      [{ threshold: Number.NaN }, /threshold/],
      [{ stat: 'mean' as Budget['stat'] }, /bad stat/],
      [{ samples: { runs: 0, aggregate: 'pooled' } }, /bad samples/],
      [{ params: { a: true as unknown as number } }, /params/],
      [{ ratchetPct: -1 }, /ratchetPct/],
    ];
    for (const [patch, reason] of cases) {
      const errors = validateBudgetFile(fileWith({ ...base(), ...patch }));
      expect(errors.join('\n'), JSON.stringify(patch)).toMatch(reason);
    }
  });

  it('TST-04 the validator rejects duplicate ids and a malformed file', () => {
    expect(validateBudgetFile(fileWith(base(), base()))).toEqual([
      'budgets[1]: duplicate id WM-03.drag-frame',
    ]);
    expect(validateBudgetFile(null)).toEqual(['budget file is not an object']);
    expect(validateBudgetFile({ schema: 2, updated: 'today', budgets: {} })).toEqual([
      'schema must be 1',
      'updated must be an ISO date',
      'budgets must be a list',
    ]);
    expect(validateBudgetFile(fileWith(42))).toEqual(['budgets[0]: not an object']);
  });

  it('TST-04 budget lookup throws on an unknown id and explains a miss', () => {
    expect(() => budget('WM-03.nope')).toThrow(RangeError);
    const b = budget('WM-03.drag-frame');
    expect(miss(b, 16.6)).toBeUndefined();
    expect(miss(b, 33.3)).toBe('WM-03.drag-frame: 33.3 ms is not <= 16.7 ms');
    expect(miss({ id: 'X-01.a', op: '>', threshold: 1, unit: 'ratio' }, 1)).toMatch(/is not > 1/);
    expect(miss({ id: 'X-01.a', op: '<', threshold: 1, unit: 'ratio' }, 0.5)).toBeUndefined();
    expect(miss({ id: 'X-01.a', op: '>=', threshold: 1, unit: 'ratio' }, 1)).toBeUndefined();
    expect(miss({ id: 'X-01.a', op: '==', threshold: 0, unit: 'count' }, 1)).toMatch(/is not == 0/);
    expect(weekNumber('W11')).toBe(11);
  });

  it('TST-04 performance tests read thresholds from budgets.json and contain no numeric threshold literals', () => {
    const dir = fileURLToPath(new URL('./', import.meta.url));
    const specs = (readdirSync(dir, { recursive: true }) as string[]).filter((f) =>
      f.endsWith('.spec.ts'),
    );
    expect(specs.length).toBeGreaterThan(0);
    const literal = /\.(toBeLessThan(?:OrEqual)?|toBeGreaterThan(?:OrEqual)?)\(\s*-?\d/;
    for (const f of specs) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(literal);
    }
  });
});
