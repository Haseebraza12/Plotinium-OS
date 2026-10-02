/**
 * Content addressing (virtual-file-system.md §3.13.4): a blob is the SHA-256 of the whole content,
 * stored as 1 MiB content-addressed chunks. Hashing happens in phase 1, never inside a transaction
 * (§3.11). The synchronous protocol SHA-256 keeps small writes and tests simple; the kernel may hash
 * large sessions with WebCrypto before calling the planner, since only the resulting `Content` is
 * passed on.
 */
import { sha256, toHex } from '@plotinium/protocol';

import { CHUNK_SIZE, EMPTY_BLOB } from './limits.ts';
import type { BlobRec, ChunkRec, Sha256Hex } from './store/records.ts';

export interface Content {
  readonly sha: Sha256Hex;
  readonly size: number;
  /** Chunk hashes in order (`[]` for the empty blob). */
  readonly chunkShas: readonly Sha256Hex[];
  /** Chunk records to store with the op; empty when the chunks were staged earlier (§3.9.3). */
  readonly chunks: readonly ChunkRec[];
}

export const EMPTY_CONTENT: Content = { sha: EMPTY_BLOB, size: 0, chunkShas: [], chunks: [] };

const encoder = new TextEncoder();

export function contentOfText(text: string, now: number): Content {
  return contentOf(encoder.encode(text), now);
}

export function contentOf(bytes: Uint8Array, now: number): Content {
  if (bytes.length === 0) return EMPTY_CONTENT;
  const chunkShas: string[] = [];
  const chunks: ChunkRec[] = [];
  for (let off = 0; off < bytes.length; off += CHUNK_SIZE) {
    const part = bytes.slice(off, Math.min(bytes.length, off + CHUNK_SIZE));
    const sha = toHex(sha256(part));
    chunkShas.push(sha);
    chunks.push({ sha, bytes: part.buffer, t: now });
  }
  return { sha: toHex(sha256(bytes)), size: bytes.length, chunkShas, chunks };
}

/** The blob record a new content reference creates when the store does not have it yet. */
export function blobRecordOf(c: Content): BlobRec {
  return { sha: c.sha, size: c.size, chunks: [...c.chunkShas], refcount: 0, uploaded: false };
}
