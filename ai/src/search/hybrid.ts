/**
 * Mode selection, reciprocal rank fusion and the keyword fallback (rag-semantic-search.md §3.5
 * steps 1 and 5, §3.12; RAG-06).
 *
 * A missing, loading or failed model is not an error: the answer comes from BM25 with a clear
 * notice. Hybrid mode fuses the vector top-50 and the BM25 top-50 with RRF, `Σ 1/(60 + rank)`; it
 * is on only when the Week-11 evaluation showed a Recall@5 gain (a configuration flag).
 */
export const RRF_K = 60;
export const FUSION_DEPTH = 50;

export const NOTICE_UNAVAILABLE = 'Semantic search unavailable — showing keyword matches';
export const NOTICE_LOADING = 'semantic model loading — showing keyword matches';
export const NOTICE_VERIFY_FAILED =
  'some shared results hidden (permissions could not be verified)';

export function noticeHiddenOffline(n: number): string {
  return `${n} shared result${n === 1 ? '' : 's'} hidden while offline`;
}

export type RequestedMode = 'auto' | 'semantic' | 'keyword';
export type ModelAvailability = 'ready' | 'loading' | 'unavailable';
export type EffectiveMode = 'semantic' | 'hybrid' | 'keyword';

export interface ModeDecision {
  mode: EffectiveMode;
  /** Whether a query embedding is needed. */
  embed: boolean;
  notices: string[];
}

/** Which path answers this query, with the notice the user sees (§3.12). */
export function chooseMode(
  requested: RequestedMode,
  model: ModelAvailability,
  hybridEnabled: boolean,
): ModeDecision {
  if (requested === 'keyword') return { mode: 'keyword', embed: false, notices: [] };
  if (model === 'loading') return { mode: 'keyword', embed: false, notices: [NOTICE_LOADING] };
  if (model === 'unavailable')
    return { mode: 'keyword', embed: false, notices: [NOTICE_UNAVAILABLE] };
  const mode = requested === 'auto' && hybridEnabled ? 'hybrid' : 'semantic';
  return { mode, embed: true, notices: [] };
}

/** Reciprocal rank fusion of ranked key lists (rank 1 is the best), `Σ 1/(k + rank)`. */
export function reciprocalRankFusion<K>(
  lists: ReadonlyArray<readonly K[]>,
  k = RRF_K,
): Array<{ key: K; score: number }> {
  const scores = new Map<K, number>();
  const firstSeen = new Map<K, number>();
  let order = 0;
  for (const list of lists) {
    list.slice(0, FUSION_DEPTH).forEach((key, i) => {
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1));
      if (!firstSeen.has(key)) firstSeen.set(key, order++);
    });
  }
  return [...scores.entries()]
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score || (firstSeen.get(a.key) ?? 0) - (firstSeen.get(b.key) ?? 0));
}
