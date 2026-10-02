/**
 * Our own BM25 inverted index (rag-semantic-search.md §5.4), the keyword path of RAG-06.
 *
 * - Tokenizer: Unicode `[\p{L}\p{N}_]+`, lower-cased, camelCase and snake_case split
 *   (`getUserName` → get user name), terms of 1–64 characters, no stemming in v1.
 * - Fields: `body` (chunk text; postings exist only for files the caller owns, I-A3) and `name`
 *   (basename tokens of the CURRENT name, read from the live tree at query time, weight 2.0), so a
 *   rename is free.
 * - `score = Σ IDF(t) · tf·(k1+1) / (tf + k1·(1 − b + b·len/avgLen))`, k1 = 1.2, b = 0.75,
 *   `IDF = ln(1 + (N − n_t + 0.5)/(n_t + 0.5))`, with N and n_t over the rows the caller can read.
 * - The readable bitset is applied BEFORE scoring, exactly as for vectors (I-A1).
 */
import { type Bitset, hasBit } from './bits.ts';

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const NAME_WEIGHT = 2.0;
export const TERM_MAX_CHARS = 64;
/** `IndexChunk.terms` carries at most 512 postings per chunk (protocol/ai/rag.ts). */
export const TERMS_PER_CHUNK_MAX = 512;

const WORD = /[\p{L}\p{N}_]+/gu;
// Splits `getUserName` and `HTTPServer` at case changes and letter/digit boundaries.
const CAMEL = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{N}+|[\p{L}\p{N}]+/gu;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WORD)) {
    for (const part of m[0].split('_')) {
      if (part === '') continue;
      for (const piece of part.matchAll(CAMEL)) {
        const term = piece[0].toLowerCase();
        if (term.length >= 1 && term.length <= TERM_MAX_CHARS) out.push(term);
      }
    }
  }
  return out;
}

/** Term frequencies of a chunk, most frequent first (ties by term), at most 512 entries. */
export function termFrequencies(text: string, max = TERMS_PER_CHUNK_MAX): Array<[string, number]> {
  const tf = new Map<string, number>();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  return [...tf.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, max);
}

export function idf(n: number, nt: number): number {
  return Math.log(1 + (n - nt + 0.5) / (nt + 0.5));
}

function termScore(tf: number, len: number, avgLen: number, weight: number): number {
  const norm = avgLen > 0 ? len / avgLen : 1;
  return (weight * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * norm));
}

interface RowInfo {
  fileIdx: number;
  seq: number;
  len: number;
  terms: string[];
}

export interface Bm25Hit {
  fileIdx: number;
  /** The best-matching row of the file, absent for a name-only match. */
  row?: number;
  seq?: number;
  score: number;
}

export interface Bm25Query {
  q: string;
  readable: Bitset;
  /** Number of slots in the file table. */
  files: number;
  /** Current basename of a file from the live tree (undefined when it has none). */
  nameOf(fileIdx: number): string | undefined;
  limit: number;
}

export class Bm25Index {
  private readonly rows = new Map<number, RowInfo>();
  private readonly postings = new Map<string, Map<number, number>>();

  get size(): number {
    return this.rows.size;
  }

  /** Add (or replace) the body postings of one row. */
  put(
    row: number,
    fileIdx: number,
    seq: number,
    terms: ReadonlyArray<readonly [string, number]>,
  ): void {
    this.remove(row);
    let len = 0;
    const names: string[] = [];
    for (const [term, tf] of terms) {
      if (tf <= 0 || term.length === 0 || term.length > TERM_MAX_CHARS) continue;
      let list = this.postings.get(term);
      if (list === undefined) {
        list = new Map();
        this.postings.set(term, list);
      }
      list.set(row, tf);
      len += tf;
      names.push(term);
    }
    this.rows.set(row, { fileIdx, seq, len, terms: names });
  }

  remove(row: number): boolean {
    const info = this.rows.get(row);
    if (info === undefined) return false;
    for (const term of info.terms) {
      const list = this.postings.get(term);
      list?.delete(row);
      if (list?.size === 0) this.postings.delete(term);
    }
    this.rows.delete(row);
    return true;
  }

  /** Rows of files in R ranked by body + 2.0 × name score; name-only files are hits too. */
  search(query: Bm25Query): Bm25Hit[] {
    const terms = [...new Set(tokenize(query.q))];
    if (terms.length === 0) return [];
    const body = this.bodyScores(terms, query.readable);
    const name = nameScores(terms, query);
    const best = new Map<number, Bm25Hit>();
    for (const [row, score] of body) {
      const info = this.rows.get(row);
      if (info === undefined) continue;
      const total = score + (name.get(info.fileIdx) ?? 0);
      const cur = best.get(info.fileIdx);
      if (
        cur === undefined ||
        total > cur.score ||
        (total === cur.score && info.seq < (cur.seq ?? 0))
      ) {
        best.set(info.fileIdx, { fileIdx: info.fileIdx, row, seq: info.seq, score: total });
      }
    }
    for (const [fileIdx, score] of name) {
      if (!best.has(fileIdx)) best.set(fileIdx, { fileIdx, score });
    }
    return [...best.values()]
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.fileIdx - b.fileIdx)
      .slice(0, query.limit);
  }

  private bodyScores(terms: readonly string[], readable: Bitset): Map<number, number> {
    let n = 0;
    let totalLen = 0;
    for (const info of this.rows.values()) {
      if (!hasBit(readable, info.fileIdx)) continue;
      n++;
      totalLen += info.len;
    }
    const scores = new Map<number, number>();
    if (n === 0) return scores;
    const avgLen = totalLen / n;
    for (const term of terms) {
      const list = this.postings.get(term);
      if (list === undefined) continue;
      const permitted: Array<[number, number]> = [];
      for (const [row, tf] of list) {
        const info = this.rows.get(row);
        if (info !== undefined && hasBit(readable, info.fileIdx)) permitted.push([row, tf]);
      }
      const w = idf(n, permitted.length);
      for (const [row, tf] of permitted) {
        const len = this.rows.get(row)?.len ?? 0;
        scores.set(row, (scores.get(row) ?? 0) + w * termScore(tf, len, avgLen, 1));
      }
    }
    return scores;
  }
}

/** The `name` field over every readable file, computed from the live tree (O(F·|q|)). */
function nameScores(terms: readonly string[], query: Bm25Query): Map<number, number> {
  const docs: Array<{ fileIdx: number; tf: Map<string, number>; len: number }> = [];
  let totalLen = 0;
  for (let f = 0; f < query.files; f++) {
    if (!hasBit(query.readable, f)) continue;
    const name = query.nameOf(f);
    if (name === undefined) continue;
    const toks = tokenize(name);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    docs.push({ fileIdx: f, tf, len: toks.length });
    totalLen += toks.length;
  }
  const scores = new Map<number, number>();
  if (docs.length === 0) return scores;
  const avgLen = totalLen / docs.length;
  for (const term of terms) {
    const withTerm = docs.filter((d) => d.tf.has(term));
    const w = idf(docs.length, withTerm.length);
    for (const d of withTerm) {
      const s = w * termScore(d.tf.get(term) ?? 0, d.len, avgLen, NAME_WEIGHT);
      scores.set(d.fileIdx, (scores.get(d.fileIdx) ?? 0) + s);
    }
  }
  return scores;
}
