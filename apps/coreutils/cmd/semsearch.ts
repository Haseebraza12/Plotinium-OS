/**
 * `semsearch [-k N] [-l] [--json] [--chunks] [--keyword] [--dir PATH] QUERY`
 * (rag-semantic-search.md §3.5): `path:lineStart-lineEnd  score  snippet` per result, notices on
 * stderr. A missing model is not an error: keyword results plus a notice (RAG-06).
 */
import type { SemsearchResult } from '@plotinium/protocol';
import { SEMSEARCH_K_MAX } from '@plotinium/protocol';

import { aiError } from '../lib/ai.ts';
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { escapeName } from '../lib/format.ts';

export interface SemsearchOpts {
  readonly k: number;
  readonly paths: boolean;
  readonly json: boolean;
  readonly chunks: boolean;
  readonly keyword: boolean;
  readonly dir: string | null;
  readonly query: string;
}

/** `/home/alice/x` → `~/x`. */
export function tildePath(path: string, home: string | undefined): string {
  if (home === undefined || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function resultLines(
  res: SemsearchResult,
  opts: SemsearchOpts,
  home: string | undefined,
  tty: boolean,
): string[] {
  if (opts.json) return res.results.map((r) => JSON.stringify(r));
  if (opts.paths) return [...new Set(res.results.map((r) => escapeName(r.path, tty)))];
  return res.results.map(
    (r) =>
      `${escapeName(tildePath(r.path, home), tty)}:${r.lineStart}-${r.lineEnd}  ${r.score.toFixed(2)}  ${escapeName(r.snippet, tty)}`,
  );
}

const MODEL_STATE: Readonly<Record<SemsearchResult['model']['state'], string>> = {
  ready: 'model ready',
  loading: 'model still loading',
  unavailable: 'model unavailable',
};

/** The notice for an empty result: the query, the search mode and the model's state. */
export function noResultsText(
  res: SemsearchResult,
  opts: Pick<SemsearchOpts, 'query' | 'dir'>,
): string {
  const where = opts.dir === null ? '' : ` in ${opts.dir}`;
  return `no results for '${opts.query}'${where} (${res.mode} search, ${MODEL_STATE[res.model.state]})`;
}

export default defineCommand<SemsearchOpts>({
  name: 'semsearch',
  parse(args) {
    const p = parseFor('semsearch', args);
    const k = Number(p.value('k') ?? '5');
    if (!Number.isInteger(k) || k < 1 || k > SEMSEARCH_K_MAX)
      throw new UsageError(`invalid -k '${p.value('k') ?? ''}' (1 to ${SEMSEARCH_K_MAX})`);
    if (p.operands.length === 0) throw new UsageError('missing QUERY');
    return {
      k,
      paths: p.has('l'),
      json: p.has('json'),
      chunks: p.has('chunks'),
      keyword: p.has('keyword'),
      dir: p.value('dir') ?? null,
      query: p.operands.join(' '),
    };
  },
  *run(io, opts) {
    try {
      const res = yield* io.sys.call('ai.semsearch', {
        q: opts.query,
        k: opts.k,
        ...(opts.dir === null ? {} : { scope: opts.dir }),
        ...(opts.keyword ? { mode: 'keyword' as const } : {}),
        ...(opts.chunks ? { chunks: true } : {}),
      });
      yield* io.lines(resultLines(res, opts, io.env('HOME'), yield* io.isTty(1)));
      for (const notice of res.notices) yield* io.error(notice);
      if (res.results.length > 0) return 0;
      // Nothing matched: say so on stderr (stdout stays empty, so `--json` output is still valid
      // JSON lines), with how the search ran, so an empty index can be told from no match (UI-124).
      yield* io.error(noResultsText(res, opts));
      return 1;
    } catch (e) {
      yield* io.error(aiError(e));
      return 2;
    }
  },
});
