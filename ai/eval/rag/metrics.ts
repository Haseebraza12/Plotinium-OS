/**
 * RAG-04 metrics over distinct files (rag-semantic-search.md §5.5; ai-safety-and-evaluation.md
 * §3.7, §5.1).
 *
 * - Recall@5 = mean over queries of |relevant ∩ top 5| / |relevant| (the ≥ 0.80 gate);
 * - MRR = mean of 1 / rank of the first relevant file in the top 10, 0 if none;
 * - nDCG@10 with graded relevance (relevant = 2, partial = 1, gain 2^g − 1), reported, not gated;
 * - 95 % bootstrap confidence intervals, 1,000 resamples by query, reported, not gated.
 *
 * Recall@5 and the reciprocal rank are the ai/src definitions (`recallAt`, `reciprocalRank`), so
 * the harness and the product agree by construction.
 */
import { tokenize } from '../../src/search/bm25.ts';
import { recallAt, reciprocalRank } from '../../src/search/metrics.ts';
import { type RandomSource, seededRandom } from '../../src/util/rng.ts';
import type { QueryKind } from './schema.ts';

export const RECALL_TARGET = 0.8;
export const RECALL_K = 5;
export const RANK_DEPTH = 10;
export const BOOTSTRAP_RESAMPLES = 1_000;
export const BOOTSTRAP_SEED = 0x5eed_0004;

export interface JudgedRun {
  id: string;
  kind: QueryKind;
  /** Grade 2. */
  relevant: readonly string[];
  /** Grade 1. */
  partial: readonly string[];
  /** Returned files, best first. Repeats are collapsed to their first occurrence. */
  returned: readonly string[];
}

export interface QueryScore {
  id: string;
  kind: QueryKind;
  recallAt5: number;
  reciprocalRank: number;
  ndcg10: number;
  /** 1-based rank of the first relevant file among distinct files, or null if not returned. */
  firstRelevantRank: number | null;
  /** Relevant files missing from the top 5. */
  missedAt5: string[];
}

export function distinctFiles(list: readonly string[]): string[] {
  return [...new Set(list)];
}

/** nDCG@k with gains 2^grade − 1 and the log2(rank + 1) discount; 0 when nothing is relevant. */
export function ndcgAt(
  returned: readonly string[],
  grades: ReadonlyMap<string, number>,
  k = RANK_DEPTH,
): number {
  const gain = (g: number): number => 2 ** g - 1;
  const dcg = distinctFiles(returned)
    .slice(0, k)
    .reduce((s, file, i) => s + gain(grades.get(file) ?? 0) / Math.log2(i + 2), 0);
  const ideal = [...grades.values()]
    .filter((g) => g > 0)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((s, g, i) => s + gain(g) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export function scoreQuery(run: JudgedRun): QueryScore {
  const ranked = { relevant: run.relevant, returned: run.returned };
  const grades = new Map<string, number>();
  for (const f of run.partial) grades.set(f, 1);
  for (const f of run.relevant) grades.set(f, 2);
  const files = distinctFiles(run.returned);
  const rel = new Set(run.relevant);
  const first = files.slice(0, RANK_DEPTH).findIndex((f) => rel.has(f));
  const top = new Set(files.slice(0, RECALL_K));
  return {
    id: run.id,
    kind: run.kind,
    recallAt5: recallAt(ranked, RECALL_K),
    reciprocalRank: reciprocalRank(ranked, RANK_DEPTH),
    ndcg10: ndcgAt(files, grades, RANK_DEPTH),
    firstRelevantRank: first < 0 ? null : first + 1,
    missedAt5: distinctFiles(run.relevant).filter((f) => !top.has(f)),
  };
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Percentile bootstrap of the mean: resample the per-query values with replacement `resamples`
 * times and take the 2.5th and 97.5th percentiles of the resampled means. Deterministic for a
 * given random source.
 */
export function bootstrapCi95(
  values: readonly number[],
  random: RandomSource,
  resamples = BOOTSTRAP_RESAMPLES,
): [number, number] {
  if (values.length === 0) return [0, 0];
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[random() % values.length] ?? 0;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * resamples)] ?? 0;
  const hi = means[Math.min(resamples - 1, Math.ceil(0.975 * resamples) - 1)] ?? 0;
  return [lo, hi];
}

export interface MetricSummary {
  value: number;
  ci95: [number, number];
}

export interface Aggregate {
  queries: number;
  recallAt5: MetricSummary;
  mrr: MetricSummary;
  ndcg10: MetricSummary;
  /** Queries with every relevant file in the top 5. */
  fullRecallAt5: number;
  /** Queries with no relevant file in the top 10. */
  zeroHitAt10: number;
  byKind: Partial<Record<QueryKind, { queries: number; recallAt5: number; mrr: number }>>;
}

export function aggregate(scores: readonly QueryScore[], seed = BOOTSTRAP_SEED): Aggregate {
  const random = seededRandom(seed);
  const summary = (values: number[]): MetricSummary => ({
    value: mean(values),
    ci95: bootstrapCi95(values, random),
  });
  const byKind: Aggregate['byKind'] = {};
  for (const kind of new Set(scores.map((s) => s.kind))) {
    const of = scores.filter((s) => s.kind === kind);
    byKind[kind] = {
      queries: of.length,
      recallAt5: mean(of.map((s) => s.recallAt5)),
      mrr: mean(of.map((s) => s.reciprocalRank)),
    };
  }
  return {
    queries: scores.length,
    recallAt5: summary(scores.map((s) => s.recallAt5)),
    mrr: summary(scores.map((s) => s.reciprocalRank)),
    ndcg10: summary(scores.map((s) => s.ndcg10)),
    fullRecallAt5: scores.filter((s) => s.recallAt5 === 1).length,
    zeroHitAt10: scores.filter((s) => s.firstRelevantRank === null).length,
    byKind,
  };
}

/** English function words ignored by `lexicalOverlap` (tokens as the BM25 tokenizer emits them). */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being ' +
    'below between both but by can could d did do does doing don down during each few for from ' +
    'further had has have having he her here hers him his how i if in into is it its just ll me ' +
    'more most my no nor not now of off on once only or other our ours out over own re s same she ' +
    'should so some such t than that the their theirs them then there these they this those ' +
    'through to too under until up us very was we were what when where which while who whom why ' +
    'will with would you your yours'
  ).split(' '),
);

/**
 * Share of the query's distinct content words (BM25 tokenizer, no stemming, stop words removed)
 * that occur anywhere in the document. 0 means a pure paraphrase, 1 means every query word is
 * in the document. Used to show that the queries are not copied from the documents' wording.
 */
export function lexicalOverlap(query: string, document: string): number {
  const terms = new Set(tokenize(query).filter((t) => !STOPWORDS.has(t)));
  if (terms.size === 0) return 0;
  const doc = new Set(tokenize(document));
  let shared = 0;
  for (const t of terms) if (doc.has(t)) shared++;
  return shared / terms.size;
}

export interface Leak {
  user: string;
  queryId: string;
  path: string;
}

export interface Gate {
  id: string;
  target: string;
  pass: boolean;
}

export function gates(agg: Aggregate, leaks: readonly Leak[]): Gate[] {
  return [
    {
      id: 'RAG-04',
      target: `Recall@${RECALL_K} ≥ ${RECALL_TARGET.toFixed(2)}`,
      pass: agg.recallAt5.value >= RECALL_TARGET,
    },
    {
      id: 'RAG-03',
      target: 'no result the querying user cannot read (0 leaks)',
      pass: leaks.length === 0,
    },
  ];
}
