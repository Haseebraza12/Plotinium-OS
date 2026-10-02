import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { seededRandom } from '../../src/util/rng.ts';
import {
  aggregate,
  bootstrapCi95,
  gates,
  lexicalOverlap,
  mean,
  ndcgAt,
  scoreQuery,
  type JudgedRun,
  type QueryScore,
} from './metrics.ts';
import { markdownTable } from './report.ts';

const run = (over: Partial<JudgedRun> & Pick<JudgedRun, 'relevant' | 'returned'>): JudgedRun => ({
  id: 'Q',
  kind: 'paraphrase',
  partial: [],
  ...over,
});

describe('RAG-04 per-query metrics', () => {
  it('RAG-04 Recall@5 counts distinct relevant files in the top five only', () => {
    const s = scoreQuery(
      run({
        relevant: ['a', 'b'],
        // 'a' twice (two chunks of one file) must not push 'b' out of the top five
        returned: ['x', 'a', 'a', 'y', 'z', 'w', 'b'],
      }),
    );
    expect(s.recallAt5).toBe(0.5);
    expect(s.missedAt5).toEqual(['b']);
    const all = scoreQuery(run({ relevant: ['a', 'b'], returned: ['a', 'a', 'b'] }));
    expect(all.recallAt5).toBe(1);
    expect(all.missedAt5).toEqual([]);
  });

  it('RAG-04 the reciprocal rank uses the first relevant file within the top ten and is 0 beyond it', () => {
    expect(scoreQuery(run({ relevant: ['b'], returned: ['a', 'b'] })).reciprocalRank).toBe(0.5);
    expect(scoreQuery(run({ relevant: ['b'], returned: ['a', 'b'] })).firstRelevantRank).toBe(2);
    const deep = [...'abcdefghij'].concat('k');
    const s = scoreQuery(run({ relevant: ['k'], returned: deep }));
    expect(s.reciprocalRank).toBe(0);
    expect(s.firstRelevantRank).toBeNull();
    expect(scoreQuery(run({ relevant: ['q'], returned: [] })).reciprocalRank).toBe(0);
  });

  it('RAG-04 nDCG@10 is 1 for the ideal graded order, lower for a worse order and 0 without hits', () => {
    const grades = new Map([
      ['r', 2],
      ['p', 1],
    ]);
    expect(ndcgAt(['r', 'p', 'x'], grades)).toBeCloseTo(1, 12);
    const swapped = ndcgAt(['p', 'r'], grades);
    expect(swapped).toBeLessThan(1);
    // DCG = 1/log2(2) + 3/log2(3); IDCG = 3/log2(2) + 1/log2(3)
    expect(swapped).toBeCloseTo((1 + 3 / Math.log2(3)) / (3 + 1 / Math.log2(3)), 12);
    expect(ndcgAt(['x', 'y'], grades)).toBe(0);
    expect(ndcgAt(['x'], new Map())).toBe(0);
    // partial files count in nDCG but not in Recall@5 or MRR
    const s = scoreQuery(run({ relevant: ['r'], partial: ['p'], returned: ['p', 'x'] }));
    expect(s.recallAt5).toBe(0);
    expect(s.reciprocalRank).toBe(0);
    expect(s.ndcg10).toBeGreaterThan(0);
  });

  it('RAG-04 every per-query metric stays in [0, 1] and a perfect ranking scores 1', () => {
    const file = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l');
    fc.assert(
      fc.property(
        fc.uniqueArray(file, { minLength: 1, maxLength: 3 }),
        fc.array(file, { maxLength: 15 }),
        (relevant, returned) => {
          const s = scoreQuery(run({ relevant, returned }));
          for (const v of [s.recallAt5, s.reciprocalRank, s.ndcg10]) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1 + 1e-12);
          }
          const perfect = scoreQuery(run({ relevant, returned: [...relevant, ...returned] }));
          expect(perfect.recallAt5).toBe(1);
          expect(perfect.reciprocalRank).toBe(1);
          expect(perfect.ndcg10).toBeCloseTo(1, 12);
        },
      ),
    );
  });
});

describe('RAG-04 aggregation', () => {
  const scores = (values: Array<[string, 'paraphrase' | 'code', number, number]>): QueryScore[] =>
    values.map(([id, kind, recallAt5, reciprocalRank]) => ({
      id,
      kind,
      recallAt5,
      reciprocalRank,
      ndcg10: recallAt5,
      firstRelevantRank: reciprocalRank === 0 ? null : Math.round(1 / reciprocalRank),
      missedAt5: [],
    }));

  it('RAG-04 Recall@5 and MRR are means over queries, with per-kind means and hit counts', () => {
    const agg = aggregate(
      scores([
        ['a', 'paraphrase', 1, 1],
        ['b', 'paraphrase', 0, 0],
        ['c', 'code', 0.5, 0.5],
        ['d', 'code', 1, 0.25],
      ]),
    );
    expect(agg.queries).toBe(4);
    expect(agg.recallAt5.value).toBeCloseTo(0.625, 12);
    expect(agg.mrr.value).toBeCloseTo(0.4375, 12);
    expect(agg.byKind.paraphrase).toEqual({ queries: 2, recallAt5: 0.5, mrr: 0.5 });
    expect(agg.byKind.code).toEqual({ queries: 2, recallAt5: 0.75, mrr: 0.375 });
    expect(agg.byKind.question).toBeUndefined();
    expect(agg.fullRecallAt5).toBe(2);
    expect(agg.zeroHitAt10).toBe(1);
    expect(aggregate([]).recallAt5.value).toBe(0);
  });

  it('RAG-04 bootstrap intervals are deterministic, bracket the mean and collapse for constant values', () => {
    const values = [0, 1, 1, 0.5, 1, 0, 1, 1, 0.5, 1];
    const a = bootstrapCi95(values, seededRandom(7));
    const b = bootstrapCi95(values, seededRandom(7));
    expect(a).toEqual(b);
    expect(a[0]).toBeLessThanOrEqual(mean(values));
    expect(a[1]).toBeGreaterThanOrEqual(mean(values));
    expect(a[0]).toBeGreaterThanOrEqual(0);
    expect(a[1]).toBeLessThanOrEqual(1);
    const flat = bootstrapCi95([0.8, 0.8, 0.8], seededRandom(1));
    expect(flat[0]).toBeCloseTo(0.8, 12);
    expect(flat[1]).toBeCloseTo(0.8, 12);
    expect(bootstrapCi95([], seededRandom(1))).toEqual([0, 0]);
    // the aggregate uses a fixed seed, so reports are reproducible byte for byte
    const s = scores([
      ['a', 'code', 1, 1],
      ['b', 'code', 0, 0],
    ]);
    expect(aggregate(s).recallAt5.ci95).toEqual(aggregate(s).recallAt5.ci95);
  });

  it('RAG-04 the gate passes at Recall@5 0.80 and fails just below; RAG-03 fails on any leak', () => {
    const agg = (r: number) =>
      aggregate(
        scores([
          ['a', 'code', r, 1],
          ['b', 'code', r, 1],
        ]),
      );
    expect(gates(agg(0.8), []).map((g) => [g.id, g.pass])).toEqual([
      ['RAG-04', true],
      ['RAG-03', true],
    ]);
    expect(gates(agg(0.79), [])[0]?.pass).toBe(false);
    expect(
      gates(agg(1), [{ user: 'bob', queryId: 'LK01', path: '/home/alice/private/x' }])[1]?.pass,
    ).toBe(false);
  });
});

describe('RAG-04 lexical overlap', () => {
  it('RAG-04 lexical overlap is 0 for a pure paraphrase, 1 for copied wording and ignores function words', () => {
    const doc =
      'Nani’s masoor daal: boil the split red lentils with haldi, then pour the tarka over.';
    expect(lexicalOverlap("my grandmother's recipe for the lentil soup", doc)).toBe(0);
    expect(lexicalOverlap('masoor daal tarka', doc)).toBe(1);
    expect(lexicalOverlap('the daal and the soup', doc)).toBe(0.5);
    expect(lexicalOverlap('the and of', doc)).toBe(0);
  });
});

describe('RAG-04 report tables', () => {
  it('RAG-04 Markdown tables are padded like Prettier and escape pipes', () => {
    expect(
      markdownTable(
        ['Id', 'Query'],
        [
          ['RQ1', 'a | b'],
          ['RQ10', '≥ 0.80'],
        ],
      ),
    ).toBe(
      ['| Id   | Query  |', '| ---- | ------ |', '| RQ1  | a \\| b |', '| RQ10 | ≥ 0.80 |'].join(
        '\n',
      ),
    );
  });
});
