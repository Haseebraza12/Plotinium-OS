/**
 * RAG-04 in CI: replay the vectors recorded with the REAL pinned models (ai/eval/rag/
 * model-embedder.ts, onnxruntime-node) through the unchanged ai/src query path. No model is loaded
 * here; a missing or changed vector is an error, never a silent fallback.
 */
import { describe, expect, it } from 'vitest';

import { loadCorpus } from '../eval/rag/corpus.ts';
import { parseRecordedVectors, recordedEmbedder } from '../eval/rag/embedders.ts';
import { evaluateRag } from '../eval/rag/evaluate.ts';
import { nodeHost, ragDir } from '../eval/rag/host.ts';
import { FALLBACK, PRIMARY, modelKey } from '../src/embed/config.ts';

async function replay(key: string, hybrid = false) {
  const host = nodeHost();
  const dir = ragDir();
  const corpus = await loadCorpus(host, dir);
  const file = host.join(dir, '..', 'embeddings', key, 'vectors.jsonl');
  const embedder = recordedEmbedder(key, parseRecordedVectors(host.readText(file), file));
  return evaluateRag(corpus, { embedder, hybrid, requested: 'auto' });
}

describe('RAG evaluation with recorded real-model vectors', () => {
  it('RAG-04 MongoDB/mdbr-leaf-ir reaches Recall@5 ≥ 0.80 with MRR reported, and RAG-03 holds (0 leaks)', async () => {
    const ev = await replay(modelKey(PRIMARY));
    expect(ev.modes).toEqual({ semantic: 40 });
    expect(ev.aggregate.recallAt5.value).toBeGreaterThanOrEqual(0.8);
    expect(ev.aggregate.mrr.value).toBeGreaterThan(0.7);
    expect(ev.leaks).toEqual([]);
    expect(ev.gates.every((g) => g.pass)).toBe(true);
  });

  it('RAG-04 the switch rule keeps leaf-ir: it is not more than 0.03 below the bge-small fallback, and hybrid does not beat it', async () => {
    const leaf = await replay(modelKey(PRIMARY));
    const bge = await replay(modelKey(FALLBACK));
    const hybrid = await replay(modelKey(PRIMARY), true);
    expect(bge.aggregate.recallAt5.value).toBeGreaterThanOrEqual(0.8);
    expect(leaf.aggregate.recallAt5.value).toBeGreaterThanOrEqual(
      bge.aggregate.recallAt5.value - 0.03,
    );
    // RRF is enabled only if it helps (§3.5 step 5); on this set it does not, so installAi's
    // default `hybrid: false` stands.
    expect(hybrid.aggregate.recallAt5.value).toBeLessThanOrEqual(leaf.aggregate.recallAt5.value);
  });
});
