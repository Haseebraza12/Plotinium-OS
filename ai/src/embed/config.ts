/**
 * Embedding model configuration (rag-semantic-search.md §3.7, canonical C12).
 *
 * The model key names the model, revision, quantisation, stored dimensions and chunker version, so
 * any change triggers a background re-index and vectors of different models are never compared
 * (I-A5). rag-semantic-search.md writes it with `:` separators, but protocol's `ModelKey` schema
 * allows only `[A-Za-z0-9._@/-]`, so the separator here is `-` (reported as a cross-spec issue).
 */
import { EMBED_DIMS } from '@plotinium/protocol';

import { CHUNKER_VERSION } from '../indexer/hash.ts';

export interface ModelConfig {
  readonly id: string;
  readonly revision: string;
  readonly dtype: 'q8';
  readonly nativeDims: number;
  readonly storeDims: number;
  readonly queryPrefix: string;
}

export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

export const PRIMARY: ModelConfig = {
  id: 'MongoDB/mdbr-leaf-ir',
  revision: '4262131b32c3182bd06e67e92ae69d7bd66e0c5c',
  dtype: 'q8',
  nativeDims: 768,
  storeDims: EMBED_DIMS,
  queryPrefix: QUERY_PREFIX,
};

export const FALLBACK: ModelConfig = {
  id: 'Xenova/bge-small-en-v1.5',
  revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  dtype: 'q8',
  nativeDims: 384,
  storeDims: EMBED_DIMS,
  queryPrefix: QUERY_PREFIX,
};

/**
 * The lock id of a model: the first 8 hex digits of its pinned revision. The self-hosted files live
 * under `/models/<lock-id>/<model id>/…`, so a new revision is a new URL and Caddy can serve the
 * whole tree `immutable` for a year (Caddyfile, security-model.md §3.9).
 */
export function modelLockId(m: ModelConfig): string {
  return m.revision.slice(0, 8);
}

/**
 * The onnxruntime-web build the WASM files come from: the version @huggingface/transformers 4.3.0
 * resolves in pnpm-lock.yaml. The files live under `/ort/<version>/`; ai/scripts/fetch-models.ts
 * refuses to copy a different version, so a lock update that moves ORT fails loudly until this
 * constant follows it.
 */
export const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';

/** The ORT files named in `env.backends.onnx.wasm.wasmPaths` (§3.7): the asyncify SIMD build. */
export const ORT_FILES = {
  wasm: 'ort-wasm-simd-threaded.asyncify.wasm',
  mjs: 'ort-wasm-simd-threaded.asyncify.mjs',
} as const;

export function modelKey(m: ModelConfig): string {
  return `${m.id}@${m.revision.slice(0, 8)}-${m.dtype}-d${m.storeDims}-${CHUNKER_VERSION}`;
}

/** ORT threads: 2 only when cross-origin isolated on a machine with at least 8 cores. */
export function ortThreads(crossOriginIsolated: boolean, hardwareConcurrency: number): number {
  return crossOriginIsolated && hardwareConcurrency >= 8 ? 2 : 1;
}

/** MRL truncation: keep the first `dims` components and L2-renormalise (§3.2.5). */
export function truncateRenormalise(v: Float32Array, dims = EMBED_DIMS): Float32Array {
  const out = v.slice(0, dims);
  let s = 0;
  for (const x of out) s += x * x;
  const norm = Math.sqrt(s);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}
