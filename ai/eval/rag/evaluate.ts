/**
 * One evaluation run (`pnpm eval:rag`): the RAG-04 queries as the query user, then the RAG-03
 * leak check, in which EVERY fixture user runs every RAG-04 query and every leak probe and each
 * returned file is checked against the independent readability oracle.
 */
import type { EffectiveMode, RequestedMode } from '../../src/search/hybrid.ts';
import { type EvalCorpus, buildEvalTree, corpusLabel } from './corpus.ts';
import {
  type Aggregate,
  type Gate,
  type Leak,
  type QueryScore,
  aggregate,
  gates,
  lexicalOverlap,
  mean,
  scoreQuery,
} from './metrics.ts';
import { EvalSearchIndex, type IndexStats, type PipelineOptions } from './pipeline.ts';

export interface EvaluateOptions extends PipelineOptions {
  requested?: RequestedMode;
}

export interface QueryRun extends QueryScore {
  query: string;
  mode: EffectiveMode;
  returned: string[];
  notices: string[];
  /** Mean lexical overlap between the query and its relevant files' names and bodies (0 = pure paraphrase). */
  overlap: number;
}

export interface LeakCheck {
  user: string;
  uid: number;
  searches: number;
  results: number;
  leaks: Leak[];
}

export interface RagEvaluation {
  fixtures: string;
  documents: number;
  queryUser: string;
  embedder: { name: string; modelKey: string } | undefined;
  hybrid: boolean;
  index: IndexStats;
  runs: QueryRun[];
  aggregate: Aggregate;
  modes: Partial<Record<EffectiveMode, number>>;
  notices: string[];
  leakChecks: LeakCheck[];
  leaks: Leak[];
  gates: Gate[];
}

export async function evaluateRag(
  corpus: EvalCorpus,
  options: EvaluateOptions = {},
): Promise<RagEvaluation> {
  const tree = buildEvalTree(corpus);
  const index = await EvalSearchIndex.build(corpus, tree, options);
  const search = { requested: options.requested ?? 'auto' } as const;
  // BM25 also scores the file name, so the overlap measure sees the name and the body.
  const text = new Map(
    corpus.docs.map((d) => [d.path, `${d.path.slice(d.path.lastIndexOf('/') + 1)}\n${d.text}`]),
  );

  const queryUser = corpus.queries.user;
  const cred = tree.cred(queryUser);
  const runs: QueryRun[] = [];
  const modes: Partial<Record<EffectiveMode, number>> = {};
  const notices = new Set<string>();
  for (const q of corpus.queries.queries) {
    const outcome = await index.search(cred, q.query, search);
    modes[outcome.mode] = (modes[outcome.mode] ?? 0) + 1;
    for (const n of outcome.notices) notices.add(n);
    runs.push({
      ...scoreQuery({ ...q, returned: outcome.paths }),
      query: q.query,
      mode: outcome.mode,
      returned: outcome.paths,
      notices: outcome.notices,
      overlap: mean(q.relevant.map((p) => lexicalOverlap(q.query, text.get(p) ?? ''))),
    });
  }

  const probes = [
    ...corpus.queries.queries.map((q) => ({ id: q.id, query: q.query })),
    ...corpus.perms.probes.map((p) => ({ id: p.id, query: p.query })),
  ];
  const leakChecks: LeakCheck[] = [];
  for (const user of tree.userNames) {
    const c = tree.cred(user);
    const check: LeakCheck = { user, uid: c.uid, searches: 0, results: 0, leaks: [] };
    for (const p of probes) {
      const outcome = await index.search(c, p.query, search);
      check.searches++;
      check.results += outcome.paths.length;
      for (const path of outcome.paths)
        if (!tree.canRead(c, path)) check.leaks.push({ user, queryId: p.id, path });
    }
    leakChecks.push(check);
  }
  const leaks = leakChecks.flatMap((c) => c.leaks);
  const agg = aggregate(runs);
  return {
    fixtures: `${corpusLabel(corpus)}+${corpus.perms.set}`,
    documents: corpus.docs.length,
    queryUser,
    embedder:
      options.embedder === undefined
        ? undefined
        : { name: options.embedder.name, modelKey: options.embedder.modelKey },
    hybrid: options.hybrid ?? false,
    index: index.stats,
    runs,
    aggregate: agg,
    modes,
    notices: [...notices],
    leakChecks,
    leaks,
    gates: gates(agg, leaks),
  };
}
