import { beforeAll, describe, expect, it } from 'vitest';

import { QUERY_PREFIX } from '../../src/embed/config.ts';
import { NOTICE_UNAVAILABLE } from '../../src/search/hybrid.ts';
import { l2Norm } from '../../src/search/vector-index.ts';
import { type EvalCorpus, type EvalTree, buildEvalTree, loadCorpus, sha256Hex } from './corpus.ts';
import { hashingEmbedder, parseRecordedVectors, recordedEmbedder } from './embedders.ts';
import { evaluateRag } from './evaluate.ts';
import { nodeHost, ragDir } from './host.ts';
import { EVAL_K, EvalSearchIndex } from './pipeline.ts';
import { type RunMeta, renderMarkdown, toEvalReport } from './report.ts';

let corpus: EvalCorpus;
let tree: EvalTree;

beforeAll(async () => {
  corpus = await loadCorpus(nodeHost(), ragDir());
  tree = buildEvalTree(corpus);
});

/** `semsearch -k` accepts at most 50 (rag-semantic-search.md §3.5). */
const SEMSEARCH_MAX_K = 50;

const META: RunMeta = { version: 'test', date: '2026-09-25', machine: 'ci', command: 'test' };

describe('RAG-06 keyword fallback through the ai/src query path', () => {
  it('RAG-06 with no embedder a query takes the keyword path with the unavailable notice and path:line citations', async () => {
    const index = await EvalSearchIndex.build(corpus, tree);
    const out = await index.search(tree.cred('alice'), 'Belady anomaly FIFO');
    expect(out.mode).toBe('keyword');
    expect(out.notices).toContain(NOTICE_UNAVAILABLE);
    const top = out.results[0];
    expect(top?.path).toBe('/home/alice/notes/os/page-replacement.md');
    expect(top?.lineStart).toBeGreaterThan(0);
    expect(top?.lineEnd).toBeGreaterThanOrEqual(top?.lineStart ?? 0);
    expect(top?.snippet.length).toBeGreaterThan(0);
    expect(top?.snippet.length).toBeLessThanOrEqual(240);
    expect(top?.verified).toBe('own');
    expect(index.stats.skipped).toEqual([]);
    expect(index.stats.embedded).toBe(0);
  });
});

describe('RAG-04 BM25 baseline run', () => {
  it('RAG-04 the baseline run is deterministic and returns at most ten distinct files per query', async () => {
    const a = await evaluateRag(corpus);
    const b = await evaluateRag(corpus);
    expect(a.aggregate).toEqual(b.aggregate);
    expect(a.runs.map((r) => r.returned)).toEqual(b.runs.map((r) => r.returned));
    expect(a.modes).toEqual({ keyword: corpus.queries.queries.length });
    for (const r of a.runs) {
      expect(new Set(r.returned).size, r.id).toBe(r.returned.length);
      expect(r.returned.length, r.id).toBeLessThanOrEqual(EVAL_K);
    }
    // keyword queries that reuse the document's own terms find it first
    expect(a.runs.find((r) => r.id === 'RQ28')?.firstRelevantRank).toBe(1);
    expect(a.aggregate.recallAt5.value).toBeGreaterThan(0);
    expect(a.aggregate.recallAt5.value).toBeLessThan(1);
  });

  it('RAG-04 the evaluation report follows the EvalReport shape and the Markdown report is reproducible', async () => {
    const ev = await evaluateRag(corpus);
    const report = toEvalReport(ev, META);
    expect(report.suite).toBe('rag');
    expect(report.fixtures).toMatch(/^rag-corpus@\d+-\d+\+rag-perm@v1$/);
    expect(report.model).toBeUndefined();
    expect(report.gates.map((g) => g.id)).toEqual(['RAG-04', 'RAG-03']);
    const recall = report.metrics['recallAt5'];
    expect(recall?.value).toBeGreaterThanOrEqual(0);
    expect(recall?.ci95?.[0]).toBeLessThanOrEqual(recall?.value ?? -1);
    expect(recall?.ci95?.[1]).toBeGreaterThanOrEqual(recall?.value ?? 2);
    expect(report.metrics['leaks']?.value).toBe(0);
    expect(report.cases).toHaveLength(corpus.queries.queries.length + tree.userNames.length);
    const md = renderMarkdown(ev, corpus, META);
    expect(renderMarkdown(await evaluateRag(corpus), corpus, META)).toBe(md);
    expect(md).toContain('# RAG-04 evaluation: BM25 baseline');
    expect(md).toContain('Phase 4');
    for (const q of corpus.queries.queries) expect(md).toContain(`| ${q.id} `);
  });
});

describe('RAG-03 permission leaks', () => {
  it('RAG-03 zero leaks on the keyword path: no user ever receives a file they cannot read', async () => {
    const ev = await evaluateRag(corpus);
    expect(ev.leaks).toEqual([]);
    expect(ev.leakChecks.map((c) => c.user).sort()).toEqual(['alice', 'bob', 'carol']);
    const searches = corpus.queries.queries.length + corpus.perms.probes.length;
    for (const c of ev.leakChecks) {
      expect(c.searches).toBe(searches);
      expect(c.results).toBeGreaterThan(0);
    }
  });

  it('RAG-03 zero leaks on the vector and hybrid paths with the hashing plumbing embedder', async () => {
    for (const hybrid of [false, true]) {
      const ev = await evaluateRag(corpus, { embedder: hashingEmbedder(), hybrid });
      expect(ev.leaks, `hybrid=${hybrid}`).toEqual([]);
      expect(ev.modes).toEqual({ [hybrid ? 'hybrid' : 'semantic']: corpus.queries.queries.length });
    }
  });

  it('RAG-03 the probes have teeth: without the readable filter they surface the files the user may not read', async () => {
    // A leak is visible if the file reaches a user who asks for the most results semsearch allows
    // (-k 50). The keyword path must even put every forbidden target in the default top 10.
    const paths = [
      { name: 'keyword', strictTop: EVAL_K, index: await EvalSearchIndex.build(corpus, tree) },
      {
        name: 'semantic',
        strictTop: undefined,
        index: await EvalSearchIndex.build(corpus, tree, { embedder: hashingEmbedder() }),
      },
      {
        name: 'hybrid',
        strictTop: undefined,
        index: await EvalSearchIndex.build(corpus, tree, {
          embedder: hashingEmbedder(),
          hybrid: true,
        }),
      },
    ];
    let forbiddenPairs = 0;
    for (const { name, strictTop, index } of paths) {
      for (const probe of corpus.perms.probes) {
        for (const user of tree.userNames) {
          if (probe.readableBy.includes(user)) continue;
          forbiddenPairs++;
          const cred = tree.cred(user);
          const where = `${name} ${probe.id} as ${user}`;
          const unfiltered = await index.rankUnfiltered(cred, probe.query, SEMSEARCH_MAX_K);
          expect(unfiltered, where).toContain(probe.target);
          if (strictTop !== undefined)
            expect(unfiltered.slice(0, strictTop), where).toContain(probe.target);
          const filtered = await index.search(cred, probe.query, { k: SEMSEARCH_MAX_K });
          expect(filtered.paths, where).not.toContain(probe.target);
        }
      }
    }
    expect(forbiddenPairs).toBeGreaterThanOrEqual(60);
  });

  it('RAG-03 a readable file in a traverse-only directory stays findable by other users and is server-verified', async () => {
    const index = await EvalSearchIndex.build(corpus, tree);
    const probe = corpus.perms.probes.find((p) => p.id === 'LK13');
    if (probe === undefined) throw new Error('LK13 missing');
    for (const user of ['bob', 'carol']) {
      const out = await index.search(tree.cred(user), probe.query);
      const hit = out.results.find((r) => r.path === probe.target);
      expect(hit, user).toBeDefined();
      expect(hit?.verified).toBe('server');
    }
  });
});

describe('RAG-04 pluggable embedders', () => {
  it('RAG-04 the recorded embedder looks vectors up by the SHA-256 of the model input and fails loudly on a miss', async () => {
    const input = `${QUERY_PREFIX}where is the lentil recipe`;
    const vector = await hashingEmbedder().embed(input);
    const key = await sha256Hex(new TextEncoder().encode(input));
    const vectors = parseRecordedVectors(
      `${JSON.stringify({ sha256: key, vector: [...vector] })}\n`,
    );
    const embedder = recordedEmbedder('MongoDB/mdbr-leaf-ir@4262131b-q8-d384-chunker-v1', vectors);
    expect(await embedder.embed(input)).toEqual(vector);
    await expect(embedder.embed('something never recorded')).rejects.toThrow(
      /no recorded embedding/,
    );
    expect(() => parseRecordedVectors(JSON.stringify({ sha256: key, vector: [1, 2] }))).toThrow(
      /unit length/,
    );
    expect(() => parseRecordedVectors('{"sha256":"xyz","vector":[]}')).toThrow(/64 hex/);
  });

  it('RAG-04 the hashing stand-in returns 384-d unit vectors and ignores the retrieval prefix', async () => {
    const e = hashingEmbedder();
    const doc = await e.embed('page replacement and eviction');
    expect(doc).toHaveLength(384);
    expect(l2Norm(doc)).toBeCloseTo(1, 5);
    expect(await e.embed(`${QUERY_PREFIX}page replacement and eviction`)).toEqual(doc);
    expect(l2Norm(await e.embed(''))).toBeCloseTo(1, 5);
  });

  it('RAG-04 a plugged-in embedder embeds every chunk once and hybrid mode fuses both rankings', async () => {
    const ev = await evaluateRag(corpus, { embedder: hashingEmbedder(), hybrid: true });
    expect(ev.index.embedded).toBe(ev.index.chunks);
    expect(ev.embedder?.modelKey).toBe('plumbing/hashing-embedder@v2-d384');
    expect(ev.modes).toEqual({ hybrid: corpus.queries.queries.length });
    expect(ev.notices).toEqual([]);
    expect(toEvalReport(ev, META).model).toEqual({
      requested: 'plumbing/hashing-embedder@v2-d384',
      served: ['plumbing/hashing-embedder@v2-d384'],
      mode: 'replay',
    });
  });
});
