/**
 * `ai.semsearch` (rag-semantic-search.md §3.5; RAG-03, RAG-04, RAG-05, RAG-06; AIN-A4).
 *
 *  1. focus: pin the model and hold index jobs for the duration of the query;
 *  2. query embedding (prefix, ≤ 512 tokens, 768 → 384) when the model is ready, else the keyword
 *     path with the notice of §3.12 (a missing model is never an error);
 *  3. the readable bitset from the CURRENT tree, BEFORE any row is ranked (I-A1), cached per
 *     (uid, groups, permEpoch, file-table generation, scope);
 *  4. exact scan with the team's `dsa/heap` BoundedTopK (K' = 4k), or BM25 over the caller's own
 *     postings plus the live file-name field, or RRF of both;
 *  5–8. per-file collapse, version check (I-A4), foreign-result verification or hiding, citations
 *     with the caller's own previews;
 *  9. informs the system: the top-3 files are handed to `warm` (inode + first chunk, speculative).
 *
 * The scan runs in the kernel worker here. The spec puts it in the `ai.search` daemon, but the
 * ABI's provisional `SearchJob` has no way to ship vector segments to a user-space process; see
 * ai/README.md "Protocol gaps".
 */
import { BoundedTopKHeap } from '@plotinium/dsa/heap';
import type { SemsearchArgs, SemsearchResult } from '@plotinium/protocol';
import { SEMSEARCH_K_DEFAULT } from '@plotinium/protocol';

import { EMBED_MAX_TOKENS } from '../embed/protocol.ts';
import type { TokenCounter } from '../indexer/tokens.ts';
import { approxWordPiece } from '../indexer/tokens.ts';
import { QUERY_PREFIX } from '../embed/config.ts';
import type { Bitset } from '../search/bits.ts';
import {
  type EffectiveMode,
  FUSION_DEPTH,
  NOTICE_UNAVAILABLE,
  chooseMode,
  reciprocalRankFusion,
} from '../search/hybrid.ts';
import { ReadableCache, readableSet } from '../search/readable.ts';
import { type Candidate, type VerifyItem, assembleResults } from '../search/results.ts';
import { scan } from '../search/vector-index.ts';
import type { TopKFactory } from '../util/deps.ts';
import type { Cred } from '../util/cred.ts';
import { type Result, fail, ok } from '../util/errors.ts';
import type { EmbedService } from './embed-service.ts';
import { type AiFsView, nameOf, resolveDir, resolvePathOf } from './fs-view.ts';
import type { SemanticIndex } from './index-store.ts';

export const NOTICE_QUERY_TRUNCATED = 'query truncated to 512 tokens';
const NOTICE_MAX = 8;
const NOTICE_CHARS = 200;
const WARM_TOP = 3;

export interface SearchServiceDeps {
  readonly index: SemanticIndex;
  /** Null when the model can never load in this build (keyword only). */
  readonly embed: EmbedService | null;
  readonly fs: AiFsView;
  /** Bumped by the kernel on every chmod, chown, rename, unlink or group change (§5.2). */
  permEpoch(): number;
  /** RRF of vector and BM25 rankings (§3.5 step 5; on only if the eval showed a gain). */
  readonly hybrid: boolean;
  online(): boolean;
  /** `POST /api/index/verify`; undefined = timeout or server error (foreign results hidden). */
  readonly verify?: (
    modelKey: string,
    items: ReadonlyArray<{ ino: string; seq: number; inodeVersion: number }>,
  ) => Promise<VerifyItem[] | undefined>;
  /** AIN-A4: warm the top result files (speculative, PRI 39). */
  warm?(inos: readonly string[]): void;
  /** AIN-A4: result directories go to the indexer's `hit` class. */
  hits?(dirs: readonly string[]): void;
  now(): number;
  readonly topK?: TopKFactory;
  readonly counter?: TokenCounter;
}

export const dsaTopK: TopKFactory = (k) => new BoundedTopKHeap(k);

/** Keep the query within 512 tokens including the prefix, [CLS] and [SEP]. */
export function fitQuery(q: string, counter: TokenCounter): { text: string; truncated: boolean } {
  const budget = EMBED_MAX_TOKENS - 2 - counter.count(QUERY_PREFIX);
  if (counter.count(q) <= budget) return { text: q, truncated: false };
  const words = q.split(/\s+/);
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (counter.count(words.slice(0, mid).join(' ')) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return { text: words.slice(0, lo).join(' '), truncated: true };
}

export class SearchService {
  private readonly deps: SearchServiceDeps;
  private readonly cache = new ReadableCache();
  private readonly topK: TopKFactory;
  private readonly counter: TokenCounter;

  constructor(deps: SearchServiceDeps) {
    this.deps = deps;
    this.topK = deps.topK ?? dsaTopK;
    this.counter = deps.counter ?? approxWordPiece;
  }

  private readable(cred: Cred, scopeIno: string | undefined): Bitset {
    const { index, fs } = this.deps;
    const key = ReadableCache.key(cred, this.deps.permEpoch(), index.generation, scopeIno);
    return this.cache.getOrCompute(key, () => {
      const input = { cred, fileTable: index.fileTable, tree: fs, oracle: fs.oracle };
      return readableSet(scopeIno === undefined ? input : { ...input, scopeIno });
    });
  }

  private lexical(cred: Cred, q: string, readable: Bitset): Candidate[] {
    const { index, fs } = this.deps;
    return index
      .lexOf(cred.uid)
      .search({
        q,
        readable,
        files: index.fileTable.length,
        nameOf: (fileIdx) => {
          const slot = index.fileTable[fileIdx];
          return slot === undefined ? undefined : nameOf(fs, slot.ino);
        },
        limit: FUSION_DEPTH,
      })
      .map((h) =>
        h.seq === undefined
          ? { fileIdx: h.fileIdx, score: h.score }
          : { fileIdx: h.fileIdx, seq: h.seq, score: h.score },
      );
  }

  private vector(qvec: Float32Array, k: number, readable: Bitset): Result<Candidate[]> {
    const { index } = this.deps;
    const res = scan(index.vectorIndex, {
      modelKey: index.modelKey,
      qvec,
      readable,
      kPrime: Math.max(4 * k, FUSION_DEPTH),
      topK: this.topK,
      tieKey: (fileIdx) => index.fileTable[fileIdx]?.ino ?? '',
    });
    if (!res.ok) return res;
    return ok(res.value.hits.map((h) => ({ fileIdx: h.fileIdx, seq: h.seq, score: h.score })));
  }

  /** The whole query path as the caller. Errors: ENOENT / ENOTDIR / EACCES for `scope`. */
  async semsearch(cred: Cred, cwd: string, args: SemsearchArgs): Promise<Result<SemsearchResult>> {
    const { embed, index, fs } = this.deps;
    const t0 = this.deps.now();
    const k = args.k ?? SEMSEARCH_K_DEFAULT;
    let scopeIno: string | undefined;
    if (args.scope !== undefined) {
      const r = resolveDir(fs, cred, args.scope, cwd);
      if (!r.ok) return fail(r.errno);
      scopeIno = r.ino;
    }
    embed?.focus(true);
    try {
      const availability = embed === null ? 'unavailable' : embed.availability();
      const decision = chooseMode(args.mode ?? 'auto', availability, this.deps.hybrid);
      const notices = [...decision.notices];
      let mode: EffectiveMode = decision.mode;

      let qvec: Float32Array | undefined;
      const tEmbed = this.deps.now();
      if (decision.embed && embed !== null) {
        const fitted = fitQuery(args.q, this.counter);
        if (fitted.truncated) notices.push(NOTICE_QUERY_TRUNCATED);
        const v = await embed.embed('query', '', fitted.text);
        if (v.ok) qvec = v.value;
        else {
          mode = 'keyword';
          notices.push(NOTICE_UNAVAILABLE);
        }
      }
      const embedMs = this.deps.now() - tEmbed;

      const tFilter = this.deps.now();
      const readable = this.readable(cred, scopeIno);
      const filterMs = this.deps.now() - tFilter;

      const tScan = this.deps.now();
      let candidates: Candidate[];
      if (mode === 'keyword' || qvec === undefined) {
        mode = 'keyword';
        candidates = this.lexical(cred, args.q, readable);
      } else {
        const vec = this.vector(qvec, k, readable);
        if (!vec.ok) return vec;
        if (mode === 'hybrid') {
          const lex = this.lexical(cred, args.q, readable);
          const keyOf = (c: Candidate): string => `${String(c.fileIdx)}:${String(c.seq ?? '')}`;
          const byKey = new Map<string, Candidate>();
          for (const c of [...vec.value, ...lex]) if (!byKey.has(keyOf(c))) byKey.set(keyOf(c), c);
          candidates = reciprocalRankFusion([vec.value.map(keyOf), lex.map(keyOf)]).flatMap((f) => {
            const c = byKey.get(f.key);
            return c === undefined ? [] : [{ ...c, score: f.score }];
          });
        } else candidates = vec.value;
      }
      const scanMs = this.deps.now() - tScan;

      const tVerify = this.deps.now();
      const verify = this.deps.verify;
      const assembled = await assembleResults({
        cred,
        candidates,
        k,
        chunks: args.chunks ?? false,
        fileTable: index.fileTable,
        tree: fs,
        resolvePath: (ino) => resolvePathOf(fs, cred, ino),
        chunkMeta: (ino, seq) => index.chunkMeta(ino, seq),
        ownSnippet: (ino, seq) =>
          seq === undefined ? undefined : index.preview(cred.uid, ino, seq),
        online: this.deps.online(),
        ...(verify === undefined
          ? {}
          : {
              verify: (items: ReadonlyArray<{ ino: string; seq: number; inodeVersion: number }>) =>
                verify(index.modelKey, items),
            }),
      });
      const verifyMs = this.deps.now() - tVerify;
      notices.push(...assembled.notices);

      // AIN-A4: a result is usually opened next.
      const top = assembled.results.slice(0, WARM_TOP);
      if (top.length > 0) {
        this.deps.warm?.(top.map((r) => r.ino));
        const dirs = new Set<string>();
        for (const r of top) {
          const link = fs.links(r.ino)[0];
          if (link !== undefined) dirs.add(link.parent);
        }
        this.deps.hits?.([...dirs]);
      }

      const state = embed === null ? 'unavailable' : embed.availability();
      return ok({
        mode,
        model: { key: index.modelKey, state },
        results: assembled.results.map((r) => ({
          ...r,
          score: Number.isFinite(r.score) ? r.score : 0,
        })),
        notices: [...new Set(notices)].slice(0, NOTICE_MAX).map((n) => n.slice(0, NOTICE_CHARS)),
        timings: { embedMs, filterMs, scanMs, verifyMs, totalMs: this.deps.now() - t0 },
      });
    } finally {
      embed?.focus(false);
    }
  }
}
