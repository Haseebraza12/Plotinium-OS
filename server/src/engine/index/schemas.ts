/**
 * Valibot schemas of the /api/index/* JSON bodies and query strings (rag-semantic-search.md §4.4),
 * for the routes' preValidation (SRV-05).
 *
 * TODO(protocol): move to protocol/src/http/index.ts when that module exists (backend-api.md §4
 * puts every HTTP schema under protocol/src/http/); the shapes below follow §4.4 exactly.
 */
import { EMBED_DIMS, Ino } from '@plotinium/protocol';
import * as v from 'valibot';

import { PULL_LIMIT_MAX, SEARCH_K_MAX, VERIFY_MAX_ITEMS } from './types.ts';

const ModelKey = v.pipe(v.string(), v.regex(/^[a-z0-9._@-]{1,64}$/));
const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const DecimalString = (max: number) =>
  v.pipe(v.string(), v.regex(/^\d{1,16}$/), v.transform(Number), v.safeInteger(), v.maxValue(max));

/** POST /api/index/search {modelKey, vector: number[384], k, scope?} (body <= 16 KiB). */
export const SearchBody = v.strictObject({
  modelKey: ModelKey,
  vector: v.pipe(v.array(v.pipe(v.number(), v.finite())), v.length(EMBED_DIMS)),
  k: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(SEARCH_K_MAX)), 5),
  /** A directory ino limiting the search to its subtree. */
  scope: v.optional(Ino),
});
export type SearchBody = v.InferOutput<typeof SearchBody>;

/** POST /api/index/verify {modelKey, items: [{ino, seq, inodeVersion}] <= 50}. */
export const VerifyBody = v.strictObject({
  modelKey: ModelKey,
  items: v.pipe(
    v.array(v.strictObject({ ino: Ino, seq: Count, inodeVersion: v.pipe(Count, v.minValue(1)) })),
    v.maxLength(VERIFY_MAX_ITEMS),
  ),
});
export type VerifyBody = v.InferOutput<typeof VerifyBody>;

/** GET /api/index/pull?modelKey=…&after=<chunk_id>&limit=2000 */
export const PullQueryString = v.strictObject({
  modelKey: ModelKey,
  after: v.optional(DecimalString(Number.MAX_SAFE_INTEGER), '0'),
  limit: v.optional(v.pipe(DecimalString(PULL_LIMIT_MAX), v.minValue(1)), String(PULL_LIMIT_MAX)),
});
export type PullQueryString = v.InferOutput<typeof PullQueryString>;

/** POST /api/index/put?ino=&inodeVersion=&modelKey= — only for an EMPTY body (clears the set). */
export const PutQueryString = v.object({
  ino: v.optional(Ino),
  inodeVersion: v.optional(v.pipe(DecimalString(Number.MAX_SAFE_INTEGER), v.minValue(1))),
  modelKey: v.optional(ModelKey),
});
