/**
 * WordPiece-compatible token counter (rag-semantic-search.md §3.2.4).
 *
 * The normative counter is the embedding model's uncased BERT WordPiece tokenizer loaded with
 * `AutoTokenizer` from the self-hosted tokenizer.json. @huggingface/transformers is not installed
 * yet (Phase 4), so this module ships a documented APPROXIMATION behind the same interface:
 *
 * - BERT's basic tokenizer splits on whitespace, emits every punctuation or symbol character as
 *   its own token and every CJK ideograph as its own token; we do the same.
 * - WordPiece then splits a word into subwords. Common English words of up to 7 characters are
 *   one vocabulary entry; longer words are charged one extra token per 4 characters, and digit
 *   runs one token per 3 digits. This OVER-estimates real WordPiece counts on English prose and
 *   code, so the chunker's `[CLS] + header + chunk + [SEP] <= 512` invariant stays safe.
 *
 * TODO(Phase 4): inject the real tokenizer (same `TokenCounter` interface) and keep this one as
 * the fallback used by unit tests.
 */
export interface TokenCounter {
  count(text: string): number;
}

const PIECE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{M}]+|\p{N}+|[^\s\p{L}\p{M}\p{N}]/gu;

function wordTokens(word: string): number {
  const n = [...word].length;
  if (/^\p{N}+$/u.test(word)) return Math.ceil(n / 3);
  if (n <= 7) return 1;
  return 1 + Math.ceil((n - 7) / 4);
}

export const approxWordPiece: TokenCounter = {
  count(text: string): number {
    let total = 0;
    for (const m of text.matchAll(PIECE)) total += wordTokens(m[0]);
    return total;
  },
};

/** The embedder's hard input limit, including [CLS] and [SEP] (I-A7). */
export const MAX_MODEL_TOKENS = 512;
