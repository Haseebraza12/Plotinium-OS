/**
 * Browser stream and crypto helpers for swap I/O (specs/03-kernel/memory-and-paging.md §3.9.3,
 * §3.11): gzip with CompressionStream, gunzip with DecompressionStream, and an asynchronous
 * SHA-256 with crypto.subtle for pipelined read-back verification. kernel/src/core/mm stays
 * thread-agnostic; the host injects these into HttpRemoteSwap and the blkio back ends.
 *
 * Owner: R1 Kernel. Reviewer: R2 VFS/DB.
 */
import type { ByteStream, GzipCodec } from '../core/mm/remote.ts';

async function collect(stream: ByteStream): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
    total += r.value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out.buffer;
}

/** A one-chunk readable stream over `bytes`. */
export function streamOf(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): ByteStream {
  const chunk = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** gzip / gunzip through the Compression Streams API (available in workers and Node ≥ 18). */
export const streamGzip: GzipCodec = {
  gzip(bytes: ArrayBuffer): Promise<ArrayBuffer> {
    return collect(streamOf(bytes).pipeThrough(new CompressionStream('gzip')));
  },
  gunzip(stream: ByteStream): ByteStream {
    return stream.pipeThrough(new DecompressionStream('gzip'));
  },
};

/** Decompress a whole gzip buffer. */
export function gunzipAll(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  return collect(streamGzip.gunzip(streamOf(bytes)));
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** Asynchronous hex SHA-256 via crypto.subtle (runs off the calling task; pipelined hashing). */
export async function subtleSha256Hex(
  bytes: ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<string> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let s = '';
  for (const b of digest) s += HEX[b] ?? '';
  return s;
}
