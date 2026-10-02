/**
 * Chunk content hash (rag-semantic-search.md §3.2.4):
 * contentHash = SHA-256(modelKey || 0x00 || header || 0x00 || text), via crypto.subtle.
 * The file name is not part of it, so a rename never changes a hash.
 *
 * `contentHashSync` computes the same digest with protocol's synchronous SHA-256, for executor
 * programs (`ai.indexer`): a program is a generator that may only yield system calls, so it cannot
 * await `crypto.subtle`.
 */
import { sha256 } from '@plotinium/protocol';

import { toHexBytes, utf8 } from '../util/bytes.ts';

export const CHUNKER_VERSION = 'chunker-v1';

function hashInput(modelKey: string, header: string, text: string): Uint8Array<ArrayBuffer> {
  const parts = [utf8(modelKey), utf8(header), utf8(text)];
  const total = parts.reduce((n, p) => n + p.length, 0) + 2;
  const buf = new Uint8Array(total);
  let o = 0;
  parts.forEach((p, i) => {
    buf.set(p, o);
    o += p.length;
    if (i < 2) buf[o++] = 0;
  });
  return buf;
}

export async function contentHash(modelKey: string, header: string, text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', hashInput(modelKey, header, text));
  return toHexBytes(new Uint8Array(digest));
}

/** The same digest, synchronously (for generator programs). */
export function contentHashSync(modelKey: string, header: string, text: string): string {
  return toHexBytes(sha256(hashInput(modelKey, header, text)));
}
