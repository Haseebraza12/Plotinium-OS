/**
 * Evaluation outputs: the `EvalReport` JSON of ai-safety-and-evaluation.md §4.1 and the Markdown
 * report (REPORT.md). Both are pure functions of the evaluation and the run metadata, so a re-run
 * on the same corpus and date produces the same bytes. Tables are padded the way Prettier pads
 * them, so the generated Markdown passes `pnpm format:check` as written.
 */
import { displayPath } from '../../src/search/citations.ts';
import type { EvalCorpus } from './corpus.ts';
import type { RagEvaluation } from './evaluate.ts';
import { RECALL_K, RECALL_TARGET, mean } from './metrics.ts';
import { QUERY_KINDS } from './schema.ts';

/** ai-safety-and-evaluation.md §4.1. */
export interface EvalReport {
  suite: 'rag';
  version: string;
  date: string;
  machine: string;
  fixtures: string;
  model?: { requested: string; served: string[]; mode: 'replay' | 'live' };
  runs: number;
  metrics: Record<string, { value: number; ci95?: [number, number] }>;
  gates: Array<{ id: string; target: string; pass: boolean }>;
  cases?: Array<{ id: string; pass: boolean; detail?: unknown }>;
}

export interface RunMeta {
  version: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  machine: string;
  /** The command that produced the report, quoted in REPORT.md. */
  command: string;
  /** Other runs of the same corpus to compare with (`--compare LABEL=FILE`, EvalReport JSON). */
  comparison?: ReadonlyArray<ComparedRun>;
}

/** One row of the embedder comparison: a label and the metrics of its EvalReport JSON. */
export interface ComparedRun {
  readonly label: string;
  readonly file: string;
  readonly recallAt5: { value: number; ci95?: readonly number[] | undefined };
  readonly mrr: { value: number; ci95?: readonly number[] | undefined };
  readonly ndcg10?: { value: number } | undefined;
  readonly rag04: boolean;
}

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function metricOf(
  metrics: Record<string, unknown>,
  key: string,
): { value: number; ci95?: number[] } | undefined {
  const m = metrics[key];
  if (typeof m !== 'object' || m === null) return undefined;
  const value = num((m as { value?: unknown }).value);
  if (value === undefined) return undefined;
  const ci = (m as { ci95?: unknown }).ci95;
  return Array.isArray(ci) && ci.every((x) => typeof x === 'number')
    ? { value, ci95: ci }
    : { value };
}

/** Read the metrics of an EvalReport JSON written by `--json` (for `--compare`). */
export function comparedRun(label: string, file: string, json: unknown): ComparedRun {
  if (typeof json !== 'object' || json === null) throw new Error(`${file}: not an EvalReport`);
  const r = json as { metrics?: unknown; gates?: unknown };
  const metrics =
    typeof r.metrics === 'object' && r.metrics !== null
      ? (r.metrics as Record<string, unknown>)
      : {};
  const recallAt5 = metricOf(metrics, 'recallAt5');
  const mrr = metricOf(metrics, 'mrr');
  if (recallAt5 === undefined || mrr === undefined)
    throw new Error(`${file}: no recallAt5/mrr metrics`);
  const gates = Array.isArray(r.gates) ? (r.gates as Array<{ id?: unknown; pass?: unknown }>) : [];
  return {
    label,
    file,
    recallAt5,
    mrr,
    ndcg10: metricOf(metrics, 'ndcg10'),
    rag04: gates.some((g) => g.id === 'RAG-04' && g.pass === true),
  };
}

const round = (x: number): number => Math.round(x * 1e4) / 1e4;

export function toEvalReport(ev: RagEvaluation, meta: RunMeta): EvalReport {
  const metrics: EvalReport['metrics'] = {
    recallAt5: {
      value: round(ev.aggregate.recallAt5.value),
      ci95: roundPair(ev.aggregate.recallAt5.ci95),
    },
    mrr: { value: round(ev.aggregate.mrr.value), ci95: roundPair(ev.aggregate.mrr.ci95) },
    ndcg10: { value: round(ev.aggregate.ndcg10.value), ci95: roundPair(ev.aggregate.ndcg10.ci95) },
    fullRecallAt5: { value: ev.aggregate.fullRecallAt5 },
    zeroHitAt10: { value: ev.aggregate.zeroHitAt10 },
    documents: { value: ev.documents },
    queries: { value: ev.aggregate.queries },
    chunks: { value: ev.index.chunks },
    leaks: { value: ev.leaks.length },
    meanLexicalOverlap: { value: round(mean(ev.runs.map((r) => r.overlap))) },
  };
  for (const kind of QUERY_KINDS) {
    const k = ev.aggregate.byKind[kind];
    if (k === undefined) continue;
    metrics[`recallAt5.${kind}`] = { value: round(k.recallAt5) };
    metrics[`mrr.${kind}`] = { value: round(k.mrr) };
  }
  const report: EvalReport = {
    suite: 'rag',
    version: meta.version,
    date: meta.date,
    machine: meta.machine,
    fixtures: ev.fixtures,
    runs: 1,
    metrics,
    gates: ev.gates,
    cases: [
      ...ev.runs.map((r) => ({
        id: r.id,
        pass: r.recallAt5 === 1,
        detail: {
          kind: r.kind,
          query: r.query,
          mode: r.mode,
          recallAt5: round(r.recallAt5),
          reciprocalRank: round(r.reciprocalRank),
          ndcg10: round(r.ndcg10),
          firstRelevantRank: r.firstRelevantRank,
          missedAt5: r.missedAt5,
          top5: r.returned.slice(0, RECALL_K),
          lexicalOverlap: round(r.overlap),
        },
      })),
      ...ev.leakChecks.map((c) => ({
        id: `RAG-03/${c.user}`,
        pass: c.leaks.length === 0,
        detail: { uid: c.uid, searches: c.searches, results: c.results, leaks: c.leaks },
      })),
    ],
  };
  if (ev.embedder !== undefined)
    report.model = {
      requested: ev.embedder.modelKey,
      served: [ev.embedder.modelKey],
      mode: 'replay',
    };
  return report;
}

function roundPair(p: [number, number]): [number, number] {
  return [round(p[0]), round(p[1])];
}

const f3 = (x: number): string => x.toFixed(3);

/** A Markdown table padded exactly as Prettier formats it (left-aligned columns). */
export function markdownTable(
  header: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
): string {
  const cells = [header, ...rows].map((r) =>
    header.map((_, i) => (r[i] ?? '').replace(/\|/g, '\\|')),
  );
  const width = (s: string): number => [...s].length;
  const widths = header.map((_, i) => Math.max(3, ...cells.map((r) => width(r[i] ?? ''))));
  const line = (r: readonly string[]): string =>
    `| ${r.map((c, i) => c + ' '.repeat((widths[i] ?? 3) - width(c))).join(' | ')} |`;
  const [head, ...body] = cells;
  return [
    line(head ?? []),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...body.map(line),
  ].join('\n');
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

const inline = (pairs: Array<[string, number]>): string =>
  pairs.map(([k, n]) => `${k} ${n}`).join(', ');

/** REPORT.md. */
export function renderMarkdown(ev: RagEvaluation, corpus: EvalCorpus, meta: RunMeta): string {
  const agg = ev.aggregate;
  const home = `/home/${ev.queryUser}`;
  const short = (p: string): string => displayPath(p, home);
  const keyword = ev.embedder === undefined;
  const pass = (ok: boolean): string => (ok ? 'pass' : 'FAIL');
  const kinds = inline(countBy(corpus.queries.queries, (q) => q.kind));
  const rag04 = ev.gates.find((g) => g.id === 'RAG-04');
  const rag03 = ev.gates.find((g) => g.id === 'RAG-03');
  const out: string[] = [];

  out.push(
    keyword
      ? '# RAG-04 evaluation: BM25 baseline'
      : `# RAG-04 evaluation: ${ev.embedder?.name ?? ''}`,
    '',
    `Generated by \`${meta.command}\` on ${meta.date} (${meta.machine}, ${meta.version}). Do not edit by hand: re-run the harness to refresh it.`,
    '',
  );
  if (!keyword) {
    out.push(
      `**Status.** RAG-04 is claimed on this run: Recall@5 ${f3(agg.recallAt5.value)} (95 % CI ${ci(agg.recallAt5.ci95)}) and MRR ${f3(agg.mrr.value)} against the ≥ 0.80 target, with the pinned embedding model (${ev.embedder?.modelKey ?? ''}). The vectors were computed with the same q8 ONNX files and Transformers.js code the browser's \`ai.embed\` worker loads (ai/src/embed/transformers-backend.ts, run in Node on onnxruntime-node), recorded by SHA-256 of each model input, and replayed here, so CI reproduces the numbers without the model. The ai/src query path is unchanged: readable set before ranking, exact scan with the dsa/heap top-K', per-file collapse, citations.`,
      '',
    );
  }
  if (keyword) {
    out.push(
      '**Status.** This is the keyword-only baseline. The harness ran the ai/src query path with the embedding model marked unavailable, which is exactly the RAG-06 fallback that users see when the model is not loaded: BM25 over the query user’s own chunks plus the file-name field, after the permission filter. The semantic run (leaf-ir, with bge-small as the fallback, from recorded embeddings) comes in **Phase 4, once the embedding model is installed**. RAG-04 (Recall@5 ≥ 0.80) is claimed on that run, not on this one. This report is the bar the semantic run has to beat, and it shows how much of the query set keywords alone cannot reach.',
      '',
    );
  }

  out.push('## Setup', '');
  out.push(
    markdownTable(
      ['Item', 'Value'],
      [
        [
          'Corpus',
          `${ev.fixtures}: ${ev.documents} documents, ${ev.index.chunks} chunks (chunker-v1, approximate WordPiece counter)`,
        ],
        ['Queries', `${agg.queries} (${kinds}), graded: relevant = 2, partial = 1`],
        ['Query user', `${ev.queryUser} (uid ${corpus.perms.users[ev.queryUser]?.uid ?? '?'})`],
        [
          'Pipeline',
          keyword
            ? 'keyword: BM25 (k1 1.2, b 0.75) on the body plus the file name (weight 2), readable set applied before ranking, per-file collapse, foreign results verified'
            : `${Object.keys(ev.modes).join(', ')}${ev.hybrid ? ' (RRF k = 60 over vector and BM25 top 50)' : ''}`,
        ],
        [
          'Embedder',
          ev.embedder === undefined
            ? 'none (model unavailable)'
            : `${ev.embedder.name} (${ev.embedder.modelKey})`,
        ],
        ['Cut-offs', `Recall@${RECALL_K} and MRR over distinct files, top 10 returned per query`],
        [
          'Notices shown',
          ev.notices.length === 0 ? 'none' : ev.notices.map((n) => `“${n}”`).join('; '),
        ],
      ],
    ),
    '',
  );

  out.push('## Results', '');
  out.push(
    markdownTable(
      ['Metric', 'Value', '95 % CI (bootstrap, 1,000 resamples by query)', 'Target'],
      [
        [
          `Recall@${RECALL_K}`,
          f3(agg.recallAt5.value),
          ci(agg.recallAt5.ci95),
          `≥ ${RECALL_TARGET.toFixed(2)} (RAG-04 gate)`,
        ],
        [
          'MRR (first relevant file in the top 10)',
          f3(agg.mrr.value),
          ci(agg.mrr.ci95),
          'reported',
        ],
        ['nDCG@10 (graded)', f3(agg.ndcg10.value), ci(agg.ndcg10.ci95), 'reported'],
        [
          'Queries with every relevant file in the top 5',
          `${agg.fullRecallAt5} / ${agg.queries}`,
          '',
          '',
        ],
        [
          'Queries with no relevant file in the top 10',
          `${agg.zeroHitAt10} / ${agg.queries}`,
          '',
          '',
        ],
        [
          'Mean lexical overlap, query vs. relevant files',
          f3(mean(ev.runs.map((r) => r.overlap))),
          '',
          '0 = no shared content words',
        ],
      ],
    ),
    '',
  );

  out.push('## Gates', '');
  out.push(
    markdownTable(
      ['Gate', 'Target', 'Result'],
      [
        [
          'RAG-04',
          rag04?.target ?? '',
          rag04 === undefined
            ? ''
            : pass(rag04.pass) +
              (keyword && !rag04.pass
                ? ' at the baseline (expected; the gate applies to the Phase 4 semantic run)'
                : ''),
        ],
        [
          'RAG-03',
          rag03?.target ?? '',
          rag03 === undefined ? '' : `${pass(rag03.pass)} (${ev.leaks.length} leaks)`,
        ],
      ],
    ),
    '',
  );

  out.push('## By query kind', '');
  out.push(
    markdownTable(
      ['Kind', 'Queries', `Recall@${RECALL_K}`, 'MRR', 'Mean lexical overlap'],
      QUERY_KINDS.flatMap((kind) => {
        const k = agg.byKind[kind];
        if (k === undefined) return [];
        const overlap = mean(ev.runs.filter((r) => r.kind === kind).map((r) => r.overlap));
        return [[kind, String(k.queries), f3(k.recallAt5), f3(k.mrr), f3(overlap)]];
      }),
    ),
    '',
  );

  out.push(
    '## Per query',
    '',
    `R@5 = Recall@5, RR = reciprocal rank, First = rank of the first relevant file (– when not in the top 10), Overlap = share of the query’s content words found in its relevant files. Paths are shown relative to ~ = ${home}.`,
    '',
  );
  out.push(
    markdownTable(
      [
        'Id',
        'Kind',
        'Query',
        'R@5',
        'RR',
        'nDCG@10',
        'First',
        'Overlap',
        'Relevant files missed at 5',
      ],
      ev.runs.map((r) => [
        r.id,
        r.kind,
        r.query,
        f3(r.recallAt5),
        f3(r.reciprocalRank),
        f3(r.ndcg10),
        r.firstRelevantRank === null ? '–' : String(r.firstRelevantRank),
        f3(r.overlap),
        r.missedAt5.length === 0 ? '' : r.missedAt5.map(short).join(', '),
      ]),
    ),
    '',
  );

  out.push(
    '## Permission leak check (RAG-03)',
    '',
    `Every user ran all ${agg.queries} RAG-04 queries and the ${corpus.perms.probes.length} leak probes of permissions.json through the same path. Each returned file was checked against an independent oracle that walks the path from the root (x on every directory, r on the file) instead of reusing the readable set. The probes target private files (600 files, a 700 directory, a 640 group file), near-duplicates of RAG-04 targets owned by another user, and a traverse-only 711 directory as a positive control.`,
    '',
  );
  out.push(
    markdownTable(
      ['User', 'uid', 'Searches', 'Results returned', 'Leaks'],
      ev.leakChecks.map((c) => [
        c.user,
        String(c.uid),
        String(c.searches),
        String(c.results),
        String(c.leaks.length),
      ]),
    ),
    '',
  );

  out.push('## Corpus', '');
  out.push(
    markdownTable(
      ['Breakdown', 'Documents'],
      [
        ['By category', inline(countBy(corpus.docs, (d) => d.meta.category))],
        ['By format', inline(countBy(corpus.docs, (d) => d.meta.format))],
        ['By owner', inline(countBy(corpus.docs, (d) => d.meta.owner))],
        ['By mode', inline(countBy(corpus.docs, (d) => d.meta.mode))],
        [
          'Near-duplicates',
          String(corpus.docs.filter((d) => d.meta.nearDuplicateOf !== undefined).length),
        ],
        [
          'Annotated distractors',
          String(corpus.docs.filter((d) => d.meta.distractorFor !== undefined).length),
        ],
      ],
    ),
    '',
    'All documents are original and licensed as the team’s own work (`LicenseRef-Plotinium-Team`); see README.md for provenance.',
    '',
  );

  const kindLine = (kind: (typeof QUERY_KINDS)[number]): string => {
    const k = agg.byKind[kind];
    const overlap = mean(ev.runs.filter((r) => r.kind === kind).map((r) => r.overlap));
    return k === undefined ? '' : `${f3(k.recallAt5)} for ${kind} queries (overlap ${f3(overlap)})`;
  };
  const byRecall = QUERY_KINDS.filter((k) => agg.byKind[k] !== undefined).sort(
    (a, b) => (agg.byKind[b]?.recallAt5 ?? 0) - (agg.byKind[a]?.recallAt5 ?? 0),
  );
  const zeroHit = ev.runs.filter((r) => r.firstRelevantRank === null).map((r) => r.id);
  out.push(
    keyword ? '## Reading the baseline' : '## Reading the results',
    '',
    `- Recall@5 by kind, best first: ${byRecall.map(kindLine).join('; ')}. Queries that reuse a document’s own identifiers or file name are easy for keywords; paraphrases and questions that share few content words with their targets are where ${keyword ? 'BM25 misses, and that gap is what the embedding model has to close' : 'the model has to carry the ranking'}.`,
    `- ${zeroHit.length} of ${agg.queries} queries have no relevant file in the top 10${zeroHit.length === 0 ? '.' : `: ${zeroHit.join(', ')}.`}`,
    '- The keyword path indexes the body of the query user’s own files only (I-A3: `ai_lex` is per uid); other users’ files match by name. Every grade-2 target is owned by the query user, so this does not lower Recall@5; it does limit grade-1 files owned by bob and carol.',
    '- Token counts use the approximate WordPiece counter until the real tokenizer ships with the model, so Phase 4 chunk boundaries may move slightly.',
    '- The queries and the documents were drafted by the same author (an AI coding agent working for R4), so the AIS-04 rule that queries come from members who did not write the target documents is not met yet: before the Week-11 claim, a member who did not draft the documents must review or rewrite each query without reading its targets (README.md, “Before the Week-11 claim”).',
    '',
  );

  const compared = meta.comparison ?? [];
  if (compared.length > 0) {
    out.push('## Embedder comparison', '');
    out.push(
      markdownTable(
        ['Run', 'Recall@5', '95 % CI', 'MRR', 'nDCG@10', 'RAG-04', 'Source'],
        [
          [
            `**this run** (${ev.embedder?.name ?? 'BM25'}${ev.hybrid ? ', hybrid' : ''})`,
            f3(agg.recallAt5.value),
            ci(agg.recallAt5.ci95),
            f3(agg.mrr.value),
            f3(agg.ndcg10.value),
            rag04 === undefined ? '' : pass(rag04.pass),
            'REPORT.md',
          ],
          ...compared.map((c) => [
            c.label,
            f3(c.recallAt5.value),
            c.recallAt5.ci95 === undefined ? '' : `[${c.recallAt5.ci95.map(f3).join(', ')}]`,
            f3(c.mrr.value),
            c.ndcg10 === undefined ? '' : f3(c.ndcg10.value),
            pass(c.rag04),
            `\`${c.file}\``,
          ]),
        ],
      ),
      '',
    );
  }

  if (!keyword) {
    out.push(
      '## Reproducing',
      '',
      '1. `node ai/scripts/fetch-models.ts --all` puts the pinned model files in web/public/models (SHA-256 checked).',
      '2. `node ai/eval/rag/run.ts --embedder model --record ai/eval/embeddings/<modelKey>/vectors.jsonl` runs the real model in Node and records every vector (use `--embedder model-fallback` for bge-small).',
      '3. `node ai/eval/rag/run.ts --embedder recorded --model-key <modelKey> --vectors ai/eval/embeddings/<modelKey>/vectors.jsonl --gate` replays them (CI; ai/tests/eval.rag-recorded.test.ts runs it on every test run). Add `--hybrid` to measure RRF.',
      '4. The switch rule: use bge-small if leaf’s Recall@5 is below 0.80 or more than 0.03 below bge-small’s. Hybrid ranking is enabled only if it beats vector-only (§3.5 step 5).',
      '',
    );
    return `${out.join('\n').trimEnd()}\n`;
  }

  out.push(
    '## Phase 4: the embedding run',
    '',
    '1. Record vectors for every chunk and query with the pinned model (`onnxruntime-node`, the same ONNX files) into `ai/eval/embeddings/<modelKey>/vectors.jsonl`, one line per model input: `{"sha256": "<hex of the UTF-8 model input>", "vector": [384 floats]}`.',
    '2. Run `node ai/eval/rag/run.ts --embedder recorded --model-key <modelKey> --vectors ai/eval/embeddings/<modelKey>/vectors.jsonl --json docs/evidence/ai-eval/<version>/rag.json --report docs/evidence/ai-eval/<version>/rag.md --gate` for vector-only, and again with `--hybrid` to decide whether RRF earns its place (§3.5 step 5). Keep this BM25 baseline next to it for comparison.',
    '3. Apply the switch rule: use bge-small if leaf’s Recall@5 is below 0.80 or more than 0.03 below bge-small’s.',
    '',
  );
  return `${out.join('\n').trimEnd()}\n`;
}

function ci(p: [number, number]): string {
  return `[${f3(p[0])}, ${f3(p[1])}]`;
}
