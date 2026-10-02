/**
 * AI subsystem A, semantic search (syscall-abi.md §4.4.10 A; shapes owned by
 * rag-semantic-search.md §4.1). Absent from the AI-off build (C12), where every name is ENOSYS.
 *
 * Where rag-semantic-search.md and syscall-abi.md differ (for example `ai.index.drop {ino}` against
 * `{inos}`), the ABI's names and shapes win. `SearchJob` and `SearchReply` are not spelled out in
 * either spec; their fields below follow rag-semantic-search.md §3.5 step 4 ("receives {qvec, R,
 * K'} ... returns [(row, fileIdx, seq, score)]") and are marked provisional.
 */
import * as v from 'valibot';

import { Count, Finite, Ino, Path, Sha256Hex } from '../sys/common.ts';

/** Embedding dimensions after MRL truncation (C12). */
export const EMBED_DIMS = 384;
/** `k` 1..50 (default 5) results; the daemon scores K' = 4k candidates (§3.5 step 4). */
export const SEMSEARCH_K_MAX = 50;
export const SEMSEARCH_K_DEFAULT = 5;
export const SEARCH_CANDIDATES_MAX = 4 * SEMSEARCH_K_MAX;

/** A model key such as `mdbr-leaf-ir-q8@4262131b-384` (C12). */
export const ModelKey = v.pipe(v.string(), v.regex(/^[A-Za-z0-9._@/-]{1,128}$/));

const Vector384 = v.pipe(
  v.instance(Float32Array),
  v.check((a) => a.length === EMBED_DIMS),
);

export const SemsearchArgs = v.strictObject({
  /** Plotinium protocol limit (not fixed by the specs): at most 1000 characters. */
  q: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
  k: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(SEMSEARCH_K_MAX)),
    SEMSEARCH_K_DEFAULT,
  ),
  /** Only `--dir` or the Files search box set it; resolved as the caller. */
  scope: v.optional(Path),
  mode: v.optional(v.picklist(['auto', 'semantic', 'keyword'])),
  chunks: v.optional(v.boolean()),
});

export const SemsearchResult = v.strictObject({
  /** A missing model is not an error: `keyword` plus a notice (RAG-06). */
  mode: v.picklist(['semantic', 'hybrid', 'keyword']),
  model: v.strictObject({
    key: ModelKey,
    state: v.picklist(['ready', 'loading', 'unavailable']),
  }),
  results: v.pipe(
    v.array(
      v.strictObject({
        path: Path,
        ino: Ino,
        lineStart: Count,
        lineEnd: Count,
        score: Finite,
        /** At most 240 characters, whitespace-collapsed, rendered as text only. */
        snippet: v.pipe(v.string(), v.maxLength(240)),
        verified: v.picklist(['own', 'server']),
      }),
    ),
    v.maxLength(SEMSEARCH_K_MAX),
  ),
  /** Human-readable, rendered as text. */
  notices: v.pipe(v.array(v.pipe(v.string(), v.maxLength(200))), v.maxLength(8)),
  timings: v.strictObject({
    embedMs: Finite,
    filterMs: Finite,
    scanMs: Finite,
    verifyMs: Finite,
    totalMs: Finite,
  }),
});

export const SearchFocusArgs = v.strictObject({ on: v.boolean() });
export const SearchFocusRet = v.strictObject({});

export const IndexState = v.picklist(['idle', 'indexing', 'paused', 'throttled', 'degraded']);
export const ModelState = v.picklist(['absent', 'loading', 'ready', 'evicted', 'failed']);

export const IndexStatusArgs = v.strictObject({ files: v.optional(v.boolean()) });
export const IndexStatus = v.strictObject({
  state: IndexState,
  pending: Count,
  indexedFiles: Count,
  chunks: Count,
  modelKey: ModelKey,
  modelState: ModelState,
  loadedBytes: v.optional(Count),
  totalBytes: v.optional(Count),
  lastError: v.optional(v.pipe(v.string(), v.maxLength(256))),
  /** Only with `files: true`, which needs the `ai.index` capability. */
  files: v.optional(
    v.array(
      v.strictObject({
        ino: Ino,
        inodeVersion: Count,
        state: v.pipe(v.string(), v.maxLength(32)),
      }),
    ),
  ),
});

export const IndexLookupArgs = v.strictObject({
  hashes: v.pipe(v.array(Sha256Hex), v.maxLength(512)),
});
export const IndexLookupRet = v.strictObject({
  known: v.pipe(v.array(v.boolean()), v.maxLength(512)),
});

export const IndexEmbedArgs = v.strictObject({
  /** At most 16 KiB; more than 512 tokens is EINVAL from the handler. */
  text: v.pipe(v.string(), v.maxBytes(16_384)),
  header: v.pipe(v.string(), v.maxBytes(512)),
  kind: v.literal('doc'),
});
/** A 384-dimensional vector, transferred. */
export const IndexEmbedRet = Vector384;

export const IndexChunk = v.strictObject({
  seq: Count,
  byteStart: Count,
  byteEnd: Count,
  lineStart: Count,
  lineEnd: Count,
  header: v.pipe(v.string(), v.maxBytes(512)),
  contentHash: Sha256Hex,
  vector: v.optional(Vector384),
  /** A content hash already stored: reuse its vector. */
  reuseOf: v.optional(Sha256Hex),
  /** Own files only (the kernel answers EPERM otherwise, I-A3). */
  preview: v.optional(v.pipe(v.string(), v.maxLength(240))),
  /** BM25 postings, own files only. */
  terms: v.optional(
    v.pipe(
      v.array(v.strictTuple([v.pipe(v.string(), v.minLength(1), v.maxLength(64)), Count])),
      v.maxLength(512),
    ),
  ),
});

export const IndexPut = v.strictObject({
  ino: Ino,
  inodeVersion: Count,
  modelKey: ModelKey,
  chunks: v.pipe(v.array(IndexChunk), v.maxLength(4096)),
});
export const IndexPutRet = v.strictObject({ rows: Count });

export const IndexDropArgs = v.strictObject({
  inos: v.pipe(v.array(Ino), v.minLength(1), v.maxLength(1000)),
});
export const IndexDropRet = v.strictObject({ rows: Count });

/** Provisional: one scoring job for the `ai.search` daemon (rag-semantic-search.md §3.5 step 4). */
export const SearchJob = v.strictObject({
  jobId: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(0xffff_ffff)),
  /** The query vector, transferred. */
  qvec: Vector384,
  /** Readable bitset over the kernel's dense file index (RAG-03), transferred. */
  readable: v.instance(ArrayBuffer),
  /** K' = 4k candidates to keep (bounded min-heap, dsa/heap). */
  kPrime: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(SEARCH_CANDIDATES_MAX)),
});

/** Provisional: the daemon's answer to a SearchJob. */
export const SearchReply = v.strictObject({
  jobId: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(0xffff_ffff)),
  hits: v.pipe(
    v.array(v.strictObject({ row: Count, fileIdx: Count, seq: Count, score: Finite })),
    v.maxLength(SEARCH_CANDIDATES_MAX),
  ),
});

export const SearchServeArgs = v.strictObject({});
export const SearchDoneRet = v.strictObject({});

export type SemsearchArgs = v.InferOutput<typeof SemsearchArgs>;
export type SemsearchResult = v.InferOutput<typeof SemsearchResult>;
export type IndexStatus = v.InferOutput<typeof IndexStatus>;
export type IndexPut = v.InferOutput<typeof IndexPut>;
export type SearchJob = v.InferOutput<typeof SearchJob>;
export type SearchReply = v.InferOutput<typeof SearchReply>;
