/**
 * Pluggable embedders for the RAG evaluation (rag-semantic-search.md §3.2.5, §3.7).
 *
 * The harness never loads a model itself. An `EvalEmbedder` receives the exact model input that
 * the `ai.embed` worker would receive (`embedInput`: the chunk header and text for documents, the
 * retrieval prefix plus the query for queries) and returns a 384-d unit vector.
 *
 * - no embedder: the model is unavailable, so the pipeline answers from BM25 (RAG-06). This is the
 *   baseline recorded in REPORT.md.
 * - `recordedEmbedder`: vectors recorded offline with the real model (Phase 4), keyed by
 *   `(modelKey, sha256(model input))` as ai-safety-and-evaluation.md §3.6 requires, so CI runs are
 *   deterministic and need no model. A missing vector is an error, never a silent fallback.
 * - `hashingEmbedder`: a lexical feature-hashing stand-in. It is NOT a semantic model; it exists
 *   to exercise the vector and hybrid code paths (plumbing tests, leak checks) end to end.
 */
import { QUERY_PREFIX } from '../../src/embed/config.ts';
import { tokenize } from '../../src/search/bm25.ts';
import { DIMS, isUnit } from '../../src/search/vector-index.ts';
import { utf8 } from '../../src/util/bytes.ts';
import { sha256Hex } from './corpus.ts';
import { STOPWORDS } from './metrics.ts';
import { EvalDataError } from './schema.ts';

export interface EvalEmbedder {
  /** Shown in reports. */
  readonly name: string;
  /** The model space of every vector this embedder returns (I-A5). */
  readonly modelKey: string;
  /** One model input in, one 384-d unit vector out (batch size 1, I-A7). */
  embed(input: string): Promise<Float32Array>;
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Feature hashing of the BM25 tokens (function words dropped) into 384 signed buckets with
 * sublinear term frequency (1 + ln tf), L2-normalised. Plumbing only: it has no notion of meaning.
 */
export function hashingEmbedder(): EvalEmbedder {
  return {
    name: 'hashing (lexical plumbing stand-in, not a model)',
    modelKey: 'plumbing/hashing-embedder@v2-d384',
    embed(input: string): Promise<Float32Array> {
      const text = input.startsWith(QUERY_PREFIX) ? input.slice(QUERY_PREFIX.length) : input;
      const tf = new Map<string, number>();
      for (const token of tokenize(text))
        if (!STOPWORDS.has(token)) tf.set(token, (tf.get(token) ?? 0) + 1);
      const v = new Float32Array(DIMS);
      for (const [token, n] of tf) {
        const h = fnv1a(token);
        v[h % DIMS] = (v[h % DIMS] ?? 0) + (h >>> 31 === 1 ? 1 : -1) * (1 + Math.log(n));
      }
      let norm = 0;
      for (const x of v) norm += x * x;
      if (norm === 0) {
        v[0] = 1;
        return Promise.resolve(v);
      }
      const n = Math.sqrt(norm);
      for (let i = 0; i < DIMS; i++) v[i] = (v[i] ?? 0) / n;
      return Promise.resolve(v);
    },
  };
}

/** Vectors recorded with the real model, looked up by the SHA-256 of the model input. */
export function recordedEmbedder(
  modelKey: string,
  vectors: ReadonlyMap<string, Float32Array>,
): EvalEmbedder {
  return {
    name: `recorded ${modelKey}`,
    modelKey,
    async embed(input: string): Promise<Float32Array> {
      const key = await sha256Hex(utf8(input));
      const v = vectors.get(key);
      if (v === undefined)
        throw new EvalDataError(
          `no recorded embedding for model input sha256 ${key} (${modelKey}); re-record the vectors`,
        );
      return v;
    },
  };
}

/**
 * Parse `vectors.jsonl`: one line per model input, `{"sha256": "<hex>", "vector": [384 floats]}`.
 * Every vector must be 384-d and unit length (|‖v‖ − 1| < 1e-3), the same rule the server applies.
 */
export function parseRecordedVectors(
  text: string,
  source = 'vectors.jsonl',
): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const where = `${source}:${i + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new EvalDataError(`${where}: not valid JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null)
      throw new EvalDataError(`${where}: not an object`);
    const { sha256, vector } = parsed as { sha256?: unknown; vector?: unknown };
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
      throw new EvalDataError(`${where}: "sha256" must be 64 hex digits`);
    if (!Array.isArray(vector) || !vector.every((x): x is number => typeof x === 'number'))
      throw new EvalDataError(`${where}: "vector" must be an array of numbers`);
    const v = Float32Array.from(vector);
    if (!isUnit(v)) throw new EvalDataError(`${where}: vector must be ${DIMS}-d and unit length`);
    out.set(sha256, v);
  });
  return out;
}
