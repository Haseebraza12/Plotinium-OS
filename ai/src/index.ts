/**
 * @plotinium/ai: the three AI subsystems as ordinary OS processes (C12).
 *
 * A. RAG semantic search: chunker-v1, extraction, content hashing, incremental bookkeeping, the
 *    exact vector index, the readable set, BM25, hybrid fallback and citations
 *    (specs/10-ai/rag-semantic-search.md).
 * B. Agentic shell: envelope and datamarking, tool catalogue, strict schemas, intent binding, the
 *    validator and dry run, the confirmation predicate, plan tokens, audit, undo, root drop, the
 *    observation loop and cassettes (specs/10-ai/agentic-shell.md).
 * C. Predictive pre-fetch: telemetry, the Witten-Bell Markov-2 model, baselines, the evaluator
 *    and the pre-fetch policy (specs/10-ai/predictive-prefetch.md).
 *
 * Primary owner: R4 AI. ai/ imports only protocol, dsa and @plotinium/kernel/hooks; everything it
 * needs from the kernel (permissions, the tree, quota, TTY, the model gateway, dsa structures) is
 * injected.
 */
export const PACKAGE_NAME = '@plotinium/ai';

// A. Semantic search
export * from './indexer/chunker.ts';
export * from './indexer/extract.ts';
export * from './indexer/hash.ts';
export * from './indexer/tokens.ts';
export * from './indexer/bookkeeping.ts';
export * from './indexer/queue.ts';
export * from './embed/config.ts';
export * from './embed/protocol.ts';
export * from './embed/embedder.ts';
export * from './search/bits.ts';
export * from './search/vector-index.ts';
export * from './search/readable.ts';
export * from './search/bm25.ts';
export * from './search/hybrid.ts';
export * from './search/citations.ts';
export * from './search/results.ts';
export * from './search/metrics.ts';

// B. Agentic shell
export * from './agent/envelope.ts';
export * from './agent/observe.ts';
export * from './agent/catalogue.ts';
export * from './agent/strict-schema.ts';
export * from './agent/intent.ts';
export * from './agent/reltime.ts';
export * from './agent/glob.ts';
export * from './agent/fsview.ts';
export * from './agent/select.ts';
export * from './agent/apply.ts';
export * from './agent/validator.ts';
export * from './agent/confirm.ts';
export * from './agent/token.ts';
export * from './agent/submit.ts';
export * from './agent/undo.ts';
export * from './agent/audit.ts';
export * from './agent/root-drop.ts';
export * from './agent/model.ts';
export * from './agent/decode.ts';
export * from './agent/loop.ts';
export * from './agent/cassette.ts';

// C. Predictive pre-fetch
export * from './predictor/telemetry.ts';
export * from './predictor/markov.ts';
export * from './predictor/baselines.ts';
export * from './predictor/evaluate.ts';
export * from './predictor/prefetch.ts';

// Kernel seams
export * from './hooks.ts';

// Shared
export type { Cred, PermBit, PermOracle, PermSubject } from './util/cred.ts';
export type {
  BloomFilter,
  BoundedTopK,
  IndexedMinHeap,
  MinHeapFactory,
  Ring,
  RingFactory,
  TopKFactory,
} from './util/deps.ts';
export type { AiError, Result } from './util/errors.ts';
export { cryptoRandom, seededRandom, type RandomSource } from './util/rng.ts';
export { canonicalHash, canonicalJson } from './util/canonical.ts';
