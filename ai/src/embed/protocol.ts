/**
 * The kernel ↔ `ai.embed` worker message protocol (rag-semantic-search.md §3.2.5, §3.7, §3.8).
 *
 * Only the kernel holds the worker's port. One job is in flight at a time (Transformers.js
 * serialises inference) and every job is ONE input of at most 512 tokens (I-A7); a batched call
 * would grow ORT's WebAssembly memory permanently. Vectors come back transferred.
 *
 * Plotinium design: rag-semantic-search.md fixes the behaviour, not the message shapes, so these
 * shapes are ours; the kernel's embed queue (query jobs first) is the only client.
 */
import type { Errno } from '@plotinium/protocol';

export type EmbedKind = 'doc' | 'query';

export type ToEmbedWorker =
  /** Load the model; sent on the first of desktop-interactive + 2 s idle, search focus, semsearch. */
  | { t: 'load'; model: 'primary' | 'fallback'; threads: number }
  | { t: 'embed'; id: number; kind: EmbedKind; header: string; text: string };

export type FromEmbedWorker =
  | { t: 'progress'; loadedBytes: number; totalBytes: number }
  | { t: 'ready'; modelKey: string; threads: number }
  | { t: 'vector'; id: number; vector: Float32Array; truncated: boolean; ms: number }
  | { t: 'error'; id?: number; errno: Extract<Errno, 'EINVAL' | 'EIO'>; message: string };

/** Hard input limit of the embedder, including [CLS] and [SEP] (I-A7). */
export const EMBED_MAX_TOKENS = 512;
