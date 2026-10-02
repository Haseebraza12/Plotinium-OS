/**
 * The RAG query path of rag-semantic-search.md §3.5, assembled from the ai/src building blocks so
 * the evaluation measures the code that ships, not a re-implementation:
 *
 *   ingestion   extractText → chunkText (chunker-v1) → termFrequencies into the OWNER's BM25
 *               postings (I-A3: `ai_lex` is per uid) and, when an embedder is plugged in,
 *               embedInput('doc', header, text) → VectorIndex.append (one model space, I-A5)
 *   query       chooseMode (RAG-06 fallback) → readableSet from the live tree BEFORE ranking
 *               (RAG-03, I-A1) → Bm25Index.search and/or scan (top-K' with dsa/heap
 *               BoundedTopKHeap) → reciprocalRankFusion in hybrid mode → assembleResults
 *               (per-file collapse, version check, foreign-result verification, citations)
 *
 * The kernel-side pieces the harness stands in for: the file table and live tree come from the
 * fixture tree, and `POST /api/index/verify` is answered by the independent readability oracle,
 * as the server would answer from its own tree (always online here).
 */
import { BoundedTopKHeap } from '@plotinium/dsa/heap';

import { embedInput } from '../../src/embed/embedder.ts';
import { chunkText } from '../../src/indexer/chunker.ts';
import { extractText } from '../../src/indexer/extract.ts';
import { type TokenCounter, approxWordPiece } from '../../src/indexer/tokens.ts';
import { type Bitset, bitsetFor, setBit } from '../../src/search/bits.ts';
import { Bm25Index, termFrequencies } from '../../src/search/bm25.ts';
import {
  type EffectiveMode,
  FUSION_DEPTH,
  type RequestedMode,
  chooseMode,
  reciprocalRankFusion,
} from '../../src/search/hybrid.ts';
import { type FileSlot, type LiveNode, readableSet } from '../../src/search/readable.ts';
import {
  type Candidate,
  type ResolvedPath,
  type ResultRow,
  type VerifyItem,
  assembleResults,
} from '../../src/search/results.ts';
import { VectorIndex, scan } from '../../src/search/vector-index.ts';
import type { Cred } from '../../src/util/cred.ts';
import type { TopKFactory } from '../../src/util/deps.ts';
import { posixOracle } from '../fixtures/perm.ts';
import type { EvalCorpus, EvalTree } from './corpus.ts';
import type { EvalEmbedder } from './embedders.ts';

/** Files returned per query: MRR looks at the top 10, Recall@5 at the top 5. */
export const EVAL_K = 10;

export interface PipelineOptions {
  /** Absent: the model is unavailable and every query takes the keyword path (RAG-06). */
  embedder?: EvalEmbedder;
  /** Fuse vector and BM25 rankings with RRF when the model is available (§3.5 step 5). */
  hybrid?: boolean;
  counter?: TokenCounter;
  topK?: TopKFactory;
}

export interface SearchOptions {
  k?: number;
  requested?: RequestedMode;
}

export interface SearchOutcome {
  mode: EffectiveMode;
  notices: string[];
  results: ResultRow[];
  /** Result paths, best first (distinct files). */
  paths: string[];
}

export interface IndexStats {
  files: number;
  chunks: number;
  embedded: number;
  skipped: Array<{ path: string; reason: string }>;
}

interface ChunkRec {
  fileIdx: number;
  seq: number;
  lineStart: number;
  lineEnd: number;
  text: string;
}

const chunkKey = (ino: string, seq: number): string => `${ino}#${seq}`;

export const dsaTopK: TopKFactory = (k) => new BoundedTopKHeap(k);

function parentsOf(path: string): string[] {
  const parts = path.split('/').slice(1, -1);
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`);
}

export class EvalSearchIndex {
  private readonly fileTable: FileSlot[] = [];
  private readonly paths: string[] = [];
  private readonly pathByIno = new Map<string, string>();
  /** BM25 body postings partitioned by the uid that owns the file (I-A3). */
  private readonly lex = new Map<number, Bm25Index>();
  private readonly chunks = new Map<string, ChunkRec>();
  private readonly vectors: VectorIndex | undefined;
  private readonly statsValue: IndexStats = { files: 0, chunks: 0, embedded: 0, skipped: [] };

  private readonly tree: EvalTree;
  private readonly embedder: EvalEmbedder | undefined;
  private readonly hybrid: boolean;
  private readonly topK: TopKFactory;

  private constructor(tree: EvalTree, options: PipelineOptions) {
    this.tree = tree;
    this.embedder = options.embedder;
    this.hybrid = options.hybrid ?? false;
    this.topK = options.topK ?? dsaTopK;
    this.vectors =
      options.embedder === undefined ? undefined : new VectorIndex(options.embedder.modelKey);
  }

  /** Index every corpus document the way `ai.indexer` would (§3.2). */
  static async build(
    corpus: EvalCorpus,
    tree: EvalTree,
    options: PipelineOptions = {},
  ): Promise<EvalSearchIndex> {
    const index = new EvalSearchIndex(tree, options);
    const counter = options.counter ?? approxWordPiece;
    let row = 0;
    for (const doc of corpus.docs) {
      const ino = tree.tree.inoOf(doc.path);
      const node = ino === undefined ? undefined : tree.tree.live.node(ino);
      if (ino === undefined || node === undefined) throw new Error(`${doc.path}: not in the tree`);
      const fileIdx = index.fileTable.length;
      index.fileTable.push({ ino, inodeVersion: node.version });
      index.paths.push(doc.path);
      index.pathByIno.set(ino, doc.path);
      index.statsValue.files++;
      const extracted = extractText(doc.path, 'f', doc.bytes);
      if (!extracted.ok) {
        index.statsValue.skipped.push({ path: doc.path, reason: extracted.reason });
        continue;
      }
      let own = index.lex.get(node.uid);
      if (own === undefined) {
        own = new Bm25Index();
        index.lex.set(node.uid, own);
      }
      for (const draft of chunkText(extracted.text, extracted.kind, counter)) {
        index.chunks.set(chunkKey(ino, draft.seq), {
          fileIdx,
          seq: draft.seq,
          lineStart: draft.lineStart,
          lineEnd: draft.lineEnd,
          text: draft.text,
        });
        own.put(row++, fileIdx, draft.seq, termFrequencies(draft.text));
        index.statsValue.chunks++;
        if (index.vectors !== undefined && options.embedder !== undefined) {
          const vector = await options.embedder.embed(embedInput('doc', draft.header, draft.text));
          const appended = index.vectors.append(fileIdx, draft.seq, vector);
          if (!appended.ok)
            throw new Error(
              `${doc.path} chunk ${draft.seq}: the embedder returned an invalid vector (${appended.error.errno})`,
            );
          index.statsValue.embedded++;
        }
      }
    }
    return index;
  }

  get stats(): IndexStats {
    return this.statsValue;
  }

  get modelKey(): string | undefined {
    return this.embedder?.modelKey;
  }

  /** `ai.semsearch` as the caller: the full §3.5 path, permission filter included. */
  async search(cred: Cred, q: string, options: SearchOptions = {}): Promise<SearchOutcome> {
    const k = options.k ?? EVAL_K;
    const decision = chooseMode(
      options.requested ?? 'auto',
      this.embedder === undefined ? 'unavailable' : 'ready',
      this.hybrid,
    );
    const readable = readableSet({
      cred,
      fileTable: this.fileTable,
      tree: this.tree.tree.live,
      oracle: posixOracle,
    });
    const candidates = await this.rank(cred, q, k, decision.mode, readable);
    const assembled = await assembleResults({
      cred,
      candidates,
      k,
      chunks: false,
      fileTable: this.fileTable,
      tree: this.tree.tree.live,
      resolvePath: (ino) => this.resolve(ino),
      chunkMeta: (ino, seq) => {
        const c = this.chunks.get(chunkKey(ino, seq));
        const slot = c === undefined ? undefined : this.fileTable[c.fileIdx];
        return c === undefined || slot === undefined
          ? undefined
          : { lineStart: c.lineStart, lineEnd: c.lineEnd, inodeVersion: slot.inodeVersion };
      },
      ownSnippet: (ino, seq) =>
        seq === undefined ? undefined : this.chunks.get(chunkKey(ino, seq))?.text,
      online: true,
      verify: (items) => Promise.resolve(this.verify(cred, items)),
    });
    return {
      mode: decision.mode,
      notices: [...decision.notices, ...assembled.notices],
      results: assembled.results,
      paths: assembled.results.map((r) => r.path),
    };
  }

  /**
   * NEGATIVE CONTROL ONLY: the ranking with the readable filter switched off (every file
   * readable, no verification), collapsed per file. The leak tests use it to show that the
   * fixture's private files really are what the probe queries would find without the filter.
   */
  async rankUnfiltered(cred: Cred, q: string, k = EVAL_K): Promise<string[]> {
    const decision = chooseMode(
      'auto',
      this.embedder === undefined ? 'unavailable' : 'ready',
      this.hybrid,
    );
    const everything = bitsetFor(this.fileTable.length);
    for (let i = 0; i < this.fileTable.length; i++) setBit(everything, i);
    const out: string[] = [];
    for (const c of await this.rank(cred, q, k, decision.mode, everything)) {
      const path = this.paths[c.fileIdx];
      if (path !== undefined && !out.includes(path)) out.push(path);
      if (out.length >= k) break;
    }
    return out;
  }

  private async rank(
    cred: Cred,
    q: string,
    k: number,
    mode: EffectiveMode,
    readable: Bitset,
  ): Promise<Candidate[]> {
    switch (mode) {
      case 'keyword':
        return this.lexical(cred, q, readable);
      case 'semantic':
        return this.semantic(q, k, readable);
      case 'hybrid': {
        const vector = await this.semantic(q, k, readable);
        const lexical = this.lexical(cred, q, readable);
        const byKey = new Map<string, Candidate>();
        const keyOf = (c: Candidate): string => `${c.fileIdx}:${c.seq ?? ''}`;
        for (const c of [...vector, ...lexical]) if (!byKey.has(keyOf(c))) byKey.set(keyOf(c), c);
        return reciprocalRankFusion([vector.map(keyOf), lexical.map(keyOf)]).flatMap((f) => {
          const c = byKey.get(f.key);
          return c === undefined ? [] : [{ ...c, score: f.score }];
        });
      }
    }
  }

  private lexical(cred: Cred, q: string, readable: Bitset): Candidate[] {
    const own = this.lex.get(cred.uid) ?? new Bm25Index();
    return own
      .search({
        q,
        readable,
        files: this.fileTable.length,
        nameOf: (fileIdx) => {
          const path = this.paths[fileIdx];
          return path === undefined ? undefined : path.slice(path.lastIndexOf('/') + 1);
        },
        limit: FUSION_DEPTH,
      })
      .map((h) =>
        h.seq === undefined
          ? { fileIdx: h.fileIdx, score: h.score }
          : { fileIdx: h.fileIdx, seq: h.seq, score: h.score },
      );
  }

  private async semantic(q: string, k: number, readable: Bitset): Promise<Candidate[]> {
    if (this.embedder === undefined || this.vectors === undefined) return [];
    const qvec = await this.embedder.embed(embedInput('query', '', q));
    const res = scan(this.vectors, {
      modelKey: this.embedder.modelKey,
      qvec,
      readable,
      kPrime: Math.max(4 * k, FUSION_DEPTH),
      topK: this.topK,
      tieKey: (fileIdx) => this.fileTable[fileIdx]?.ino ?? '',
    });
    if (!res.ok) throw new Error(`vector scan failed: ${res.error.errno}`);
    return res.value.hits.map((h) => ({ fileIdx: h.fileIdx, seq: h.seq, score: h.score }));
  }

  private resolve(ino: string): ResolvedPath | undefined {
    const path = this.pathByIno.get(ino);
    if (path === undefined) return undefined;
    const ancestors: LiveNode[] = [];
    for (const dir of ['/', ...parentsOf(path)]) {
      const dirIno = this.tree.tree.inoOf(dir);
      const node = dirIno === undefined ? undefined : this.tree.tree.live.node(dirIno);
      if (node !== undefined) ancestors.push(node);
    }
    return { path, ancestors };
  }

  /** Stand-in for `POST /api/index/verify`: readable NOW, at the current version, with a snippet. */
  private verify(
    cred: Cred,
    items: ReadonlyArray<{ ino: string; seq: number; inodeVersion: number }>,
  ): VerifyItem[] {
    return items.map((item) => {
      const path = this.pathByIno.get(item.ino);
      const node = this.tree.tree.live.node(item.ino);
      const readable = path !== undefined && node !== undefined && this.tree.canRead(cred, path);
      if (!readable || node === undefined) return { ino: item.ino, seq: item.seq, readable: false };
      const snippet = this.chunks.get(chunkKey(item.ino, item.seq))?.text ?? '';
      return { ino: item.ino, seq: item.seq, readable, path, inodeVersion: node.version, snippet };
    });
  }
}
