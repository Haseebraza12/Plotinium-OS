/**
 * RAG-04 metrics over distinct files (rag-semantic-search.md §5.5):
 * Recall@5 = mean_q |Rel_q ∩ L5_q| / |Rel_q|; MRR = mean_q 1/rank_q, rank_q the rank of the
 * first relevant file in the top 10 (0 when none).
 */
export interface RankedQuery {
  relevant: readonly string[];
  /** Returned files, best first (duplicates are collapsed to their first occurrence). */
  returned: readonly string[];
}

function distinct(list: readonly string[]): string[] {
  return [...new Set(list)];
}

export function recallAt(q: RankedQuery, k: number): number {
  if (q.relevant.length === 0) return 0;
  const top = new Set(distinct(q.returned).slice(0, k));
  const rel = distinct(q.relevant);
  return rel.filter((r) => top.has(r)).length / rel.length;
}

export function reciprocalRank(q: RankedQuery, depth = 10): number {
  const rel = new Set(q.relevant);
  const i = distinct(q.returned)
    .slice(0, depth)
    .findIndex((f) => rel.has(f));
  return i < 0 ? 0 : 1 / (i + 1);
}

export function evaluateRetrieval(queries: readonly RankedQuery[]): {
  recallAt5: number;
  mrr: number;
} {
  if (queries.length === 0) return { recallAt5: 0, mrr: 0 };
  const recall = queries.reduce((s, q) => s + recallAt(q, 5), 0) / queries.length;
  const mrr = queries.reduce((s, q) => s + reciprocalRank(q), 0) / queries.length;
  return { recallAt5: recall, mrr };
}
