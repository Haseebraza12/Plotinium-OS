import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { bitsetFor, clearBit, countBits, hasBit, setBit } from '../src/search/bits.ts';
import { Bm25Index, idf, termFrequencies, tokenize } from '../src/search/bm25.ts';
import { DIMS, SEGMENT_ROWS, VectorIndex, isUnit, scan } from '../src/search/vector-index.ts';
import {
  chooseMode,
  NOTICE_LOADING,
  NOTICE_UNAVAILABLE,
  reciprocalRankFusion,
} from '../src/search/hybrid.ts';
import { evaluateRetrieval, recallAt, reciprocalRank } from '../src/search/metrics.ts';
import {
  truncateRenormalise,
  modelKey,
  PRIMARY,
  FALLBACK,
  ortThreads,
} from '../src/embed/config.ts';
import { sortedTopK, unitVector } from './doubles.ts';

const KEY = 'MongoDB/mdbr-leaf-ir@4262131b-q8-d384-chunker-v1';

function allReadable(n: number): Uint32Array {
  const b = bitsetFor(n);
  for (let i = 0; i < n; i++) setBit(b, i);
  return b;
}

describe('bitsets', () => {
  it('RAG-03 bits set, clear and count exactly and out-of-range indexes read as unset', () => {
    const b = bitsetFor(70);
    setBit(b, 0);
    setBit(b, 69);
    setBit(b, 33);
    clearBit(b, 33);
    expect(countBits(b)).toBe(2);
    expect(hasBit(b, 69)).toBe(true);
    expect(hasBit(b, -1)).toBe(false);
    expect(hasBit(b, 10_000)).toBe(false);
  });
});

describe('exact vector index', () => {
  it('RAG-05 exact scan equals a full sort of the permitted rows truncated to K', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
        (rows, k, seed, readableMask) => {
          const index = new VectorIndex(KEY);
          for (let r = 0; r < rows; r++) index.append(r % 12, r, unitVector(seed + r));
          const readable = bitsetFor(12);
          readableMask.forEach((on, f) => on && setBit(readable, f));
          const q = unitVector(seed ^ 0x5bd1e995);
          const res = scan(index, {
            modelKey: KEY,
            qvec: q,
            readable,
            kPrime: k,
            topK: sortedTopK,
          });
          expect(res.ok).toBe(true);
          if (!res.ok) return;
          const expected: Array<{ row: number; score: number }> = [];
          for (let r = 0; r < rows; r++) {
            if (!readableMask[r % 12]) continue;
            const v = index.vectorOf(r);
            if (v === undefined) continue;
            let s = 0;
            for (let i = 0; i < DIMS; i++) s += (q[i] ?? 0) * (v[i] ?? 0);
            expected.push({ row: r, score: s });
          }
          expected.sort((a, b) => b.score - a.score);
          expect(res.value.hits.map((h) => h.row)).toEqual(expected.slice(0, k).map((e) => e.row));
        },
      ),
      { numRuns: 60 },
    );
  });

  it('RAG-03 rows of unreadable files are never scored (the filter runs before ranking)', () => {
    const index = new VectorIndex(KEY);
    for (let r = 0; r < 50; r++) index.append(r % 5, r, unitVector(r + 1));
    const readable = bitsetFor(5);
    setBit(readable, 1);
    setBit(readable, 3);
    const res = scan(index, {
      modelKey: KEY,
      qvec: unitVector(99),
      readable,
      kPrime: 50,
      topK: sortedTopK,
    });
    expect(res.ok && res.value.scored).toBe(20);
    expect(res.ok && res.value.hits.every((h) => h.fileIdx === 1 || h.fileIdx === 3)).toBe(true);
  });

  it('RAG-03 tombstoned rows are never scored and double tombstones are refused', () => {
    const index = new VectorIndex(KEY);
    const a = index.append(0, 0, unitVector(1));
    index.append(0, 1, unitVector(2));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(index.tombstone(a.value)).toBe(true);
    expect(index.tombstone(a.value)).toBe(false);
    expect(index.tombstone(99_999)).toBe(false);
    expect(index.vectorOf(a.value)).toBeUndefined();
    expect(index.live).toBe(1);
    expect(index.tombstoned).toBe(1);
    const res = scan(index, {
      modelKey: KEY,
      qvec: unitVector(1),
      readable: allReadable(1),
      kPrime: 5,
      topK: sortedTopK,
    });
    expect(res.ok && res.value.hits.map((h) => h.seq)).toEqual([1]);
  });

  it('RAG-04 queries never score rows of a different modelKey during a background re-index', () => {
    const index = new VectorIndex(KEY);
    index.append(0, 0, unitVector(1));
    const res = scan(index, {
      modelKey: 'Xenova/bge-small-en-v1.5@ea104dac-q8-d384-chunker-v1',
      qvec: unitVector(1),
      readable: allReadable(1),
      kPrime: 1,
      topK: sortedTopK,
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.errno).toBe('EINVAL');
  });

  it('RAG-04 ties at the threshold are broken by (ino, seq) ascending, as the server oracle does', () => {
    const index = new VectorIndex(KEY);
    const v = unitVector(7);
    // Five identical vectors: files 4,3,2,1,0 appended in that order.
    for (let f = 4; f >= 0; f--) index.append(f, 0, v);
    const inos = ['e', 'd', 'c', 'b', 'a'];
    const res = scan(index, {
      modelKey: KEY,
      qvec: v,
      readable: allReadable(5),
      kPrime: 2,
      topK: sortedTopK,
      tieKey: (f) => inos[f] ?? '',
    });
    expect(res.ok && res.value.hits.map((h) => h.fileIdx)).toEqual([4, 3]);
  });

  it('RAG-05 segments hold 1,024 rows and a new segment starts when one fills', () => {
    const index = new VectorIndex(KEY);
    const v = unitVector(3);
    for (let r = 0; r < SEGMENT_ROWS + 1; r++) index.append(0, r, v);
    expect(index.segmentCount).toBe(2);
    expect(index.segmentsView()[0]?.vectors.length).toBe(SEGMENT_ROWS * DIMS);
  });

  it('RAG-05 vectors that are not 384-d unit vectors are rejected with EINVAL', () => {
    const index = new VectorIndex(KEY);
    expect(index.append(0, 0, new Float32Array(DIMS)).ok).toBe(false);
    expect(index.append(0, 0, new Float32Array(10)).ok).toBe(false);
    expect(index.append(-1, 0, unitVector(1)).ok).toBe(false);
    expect(isUnit(unitVector(5))).toBe(true);
    const bad = scan(index, {
      modelKey: KEY,
      qvec: new Float32Array(3),
      readable: allReadable(1),
      kPrime: 1,
      topK: sortedTopK,
    });
    expect(bad.ok).toBe(false);
    const badK = scan(index, {
      modelKey: KEY,
      qvec: unitVector(1),
      readable: allReadable(1),
      kPrime: 0,
      topK: sortedTopK,
    });
    expect(badK.ok).toBe(false);
  });
});

describe('embedding configuration', () => {
  it('RAG-05 the 768-d output is MRL-truncated to 384 and renormalised', () => {
    const v = new Float32Array(768).fill(1);
    const out = truncateRenormalise(v);
    expect(out.length).toBe(384);
    expect(isUnit(out)).toBe(true);
    expect(truncateRenormalise(new Float32Array(768)).every((x) => x === 0)).toBe(true);
  });

  it('RAG-04 model keys pass the protocol ModelKey pattern and differ between the two models', () => {
    expect(modelKey(PRIMARY)).toBe(KEY);
    expect(modelKey(FALLBACK)).not.toBe(KEY);
    expect(modelKey(PRIMARY)).toMatch(/^[A-Za-z0-9._@/-]{1,128}$/);
    expect(ortThreads(true, 8)).toBe(2);
    expect(ortThreads(false, 16)).toBe(1);
    expect(ortThreads(true, 4)).toBe(1);
  });
});

describe('BM25 keyword index', () => {
  it('RAG-06 the tokenizer lower-cases and splits camelCase and snake_case', () => {
    expect(tokenize('getUserName snake_case HTTPServer v2')).toEqual([
      'get',
      'user',
      'name',
      'snake',
      'case',
      'http',
      'server',
      'v',
      '2',
    ]);
    expect(tokenize('')).toEqual([]);
    expect(termFrequencies('a b a', 1)).toEqual([['a', 2]]);
    expect(idf(10, 0)).toBeGreaterThan(idf(10, 5));
  });

  it('RAG-06 BM25 ranks the matching chunk first and adds the current-name field', () => {
    const idx = new Bm25Index();
    idx.put(0, 0, 0, termFrequencies('the lru list keeps pages in recency order'));
    idx.put(1, 1, 0, termFrequencies('a compositor draws windows'));
    idx.put(2, 2, 0, termFrequencies('memory leak in the ui component'));
    const names = ['pager.md', 'wm.ts', 'leak-notes.md', 'leak.bin'];
    const hits = idx.search({
      q: 'memory leak',
      readable: allReadable(4),
      files: 4,
      nameOf: (f) => names[f],
      limit: 10,
    });
    expect(hits[0]?.fileIdx).toBe(2);
    // A name-only match (no body postings) is still found.
    expect(hits.some((h) => h.fileIdx === 3 && h.row === undefined)).toBe(true);
    expect(
      idx.search({
        q: '!!!',
        readable: allReadable(4),
        files: 4,
        nameOf: () => undefined,
        limit: 5,
      }),
    ).toEqual([]);
  });

  it('RAG-03 BM25 never scores rows or names of unreadable files', () => {
    const idx = new Bm25Index();
    idx.put(0, 0, 0, termFrequencies('secret salary numbers'));
    idx.put(1, 1, 0, termFrequencies('public salary policy'));
    const readable = bitsetFor(2);
    setBit(readable, 1);
    const hits = idx.search({
      q: 'salary secret',
      readable,
      files: 2,
      nameOf: () => 'salary.txt',
      limit: 10,
    });
    expect(hits.map((h) => h.fileIdx)).toEqual([1]);
    expect(idx.remove(0)).toBe(true);
    expect(idx.remove(0)).toBe(false);
    expect(idx.size).toBe(1);
  });
});

describe('hybrid and fallback', () => {
  it('RAG-06 an unavailable or loading model falls back to keyword search with a clear notice', () => {
    expect(chooseMode('auto', 'unavailable', true)).toEqual({
      mode: 'keyword',
      embed: false,
      notices: [NOTICE_UNAVAILABLE],
    });
    expect(chooseMode('auto', 'loading', false)).toEqual({
      mode: 'keyword',
      embed: false,
      notices: [NOTICE_LOADING],
    });
    expect(chooseMode('keyword', 'ready', true)).toEqual({
      mode: 'keyword',
      embed: false,
      notices: [],
    });
    expect(chooseMode('auto', 'ready', true).mode).toBe('hybrid');
    expect(chooseMode('auto', 'ready', false).mode).toBe('semantic');
    expect(chooseMode('semantic', 'ready', true).mode).toBe('semantic');
  });

  it('RAG-04 reciprocal rank fusion sums 1/(60 + rank) over the lists', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['c', 'a'],
    ]);
    expect(fused[0]?.key).toBe('a');
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 62);
    expect(fused.map((f) => f.key)).toEqual(['a', 'c', 'b']);
  });

  it('RAG-04 Recall@5 and MRR are computed over distinct files', () => {
    const q = { relevant: ['x', 'y'], returned: ['a', 'x', 'x', 'b', 'c', 'd', 'y'] };
    expect(recallAt(q, 5)).toBe(0.5);
    expect(reciprocalRank(q)).toBe(0.5);
    expect(reciprocalRank({ relevant: ['z'], returned: ['a'] })).toBe(0);
    expect(recallAt({ relevant: [], returned: [] }, 5)).toBe(0);
    expect(evaluateRetrieval([q, { relevant: ['a'], returned: ['a'] }])).toEqual({
      recallAt5: 0.75,
      mrr: 0.75,
    });
    expect(evaluateRetrieval([])).toEqual({ recallAt5: 0, mrr: 0 });
  });
});
