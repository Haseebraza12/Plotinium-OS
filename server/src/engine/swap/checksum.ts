/**
 * Swap page integrity (MEM-03, MEM-04; backend-api.md §3.11; memory-and-paging.md §3.11).
 *
 * The client uploads a page compressed with CompressionStream('gzip') and names the SHA-256 and
 * the byte count of the UNCOMPRESSED page. The server stores the COMPRESSED bytes unchanged while
 * a tee decompresses them into a SHA-256 and a counter; at the end of the stream both must match,
 * otherwise the upload fails with 422 EIO 'checksum' and FsBlobStore keeps nothing (the error
 * surfaces before its atomic rename, so the previous generation of the page stays intact).
 * Decompression stops as soon as the output exceeds the declared size (a gzip bomb cannot
 * exhaust memory or disk), and the compressed byte count must equal Content-Length.
 */
import { createHash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { createGunzip, gzipSync } from 'node:zlib';

import { HttpError } from '../../http/errors.ts';

export const checksumError = (msg: string): HttpError =>
  new HttpError(422, 'EIO', msg, { reason: 'checksum' });

export interface PageExpect {
  /** Content-Length: compressed bytes. */
  readonly storedSize: number;
  /** X-Plotinium-Raw-Size: uncompressed bytes. */
  readonly rawSize: number;
  /** X-Plotinium-Checksum: hex SHA-256 of the uncompressed bytes. */
  readonly checksum: string;
}

/**
 * A pass-through Transform for the compressed body that verifies the decompressed content.
 * Pipe the request body through it into BlobStore.put().
 */
export function gunzipVerifier(expect: PageExpect): Transform {
  const hash = createHash('sha256');
  const gunzip = createGunzip();
  let raw = 0;
  let stored = 0;
  let failure: Error | null = null;
  gunzip.on('data', (chunk: Buffer) => {
    raw += chunk.length;
    if (raw > expect.rawSize) {
      failure ??= checksumError('the page is larger than its declared size');
      gunzip.destroy(); // stop decompressing at once; 'close' settles `ended`
      return;
    }
    hash.update(chunk);
  });
  gunzip.on('error', () => {
    failure ??= checksumError('the page is not valid gzip');
  });
  const ended = new Promise<void>((resolve) => {
    gunzip.on('end', resolve);
    gunzip.on('error', () => resolve());
    gunzip.on('close', resolve);
  });

  return new Transform({
    transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      stored += buf.length;
      if (stored > expect.storedSize) {
        cb(
          new HttpError(413, 'EINVAL', 'body longer than Content-Length', {
            field: 'content-length',
          }),
        );
        return;
      }
      if (failure !== null) {
        cb(failure);
        return;
      }
      gunzip.write(buf);
      cb(null, buf);
    },
    flush(cb: TransformCallback) {
      if (!gunzip.destroyed) gunzip.end();
      void ended.then(() => {
        if (failure !== null) return cb(failure);
        if (stored !== expect.storedSize)
          return cb(checksumError('body length differs from Content-Length'));
        if (raw !== expect.rawSize)
          return cb(checksumError('page size differs from X-Plotinium-Raw-Size'));
        if (hash.digest('hex') !== expect.checksum)
          return cb(checksumError('page checksum mismatch'));
        cb();
      });
    },
  });
}

/**
 * An `identity` upload (the pager always compresses; this is the fallback of backend-api.md
 * §3.11): the page is at most SWAP_PAGE_MAX_RAW_BYTES, so it is verified in memory and stored
 * gzip-compressed, which keeps every stored page in one encoding.
 */
export async function verifyIdentityPage(
  body: AsyncIterable<Buffer | string>,
  expect: { readonly rawSize: number; readonly checksum: string },
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const chunk of body) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    n += b.length;
    if (n > expect.rawSize) throw checksumError('the page is larger than its declared size');
    parts.push(b);
  }
  const raw = Buffer.concat(parts);
  if (raw.length !== expect.rawSize)
    throw checksumError('page size differs from X-Plotinium-Raw-Size');
  if (createHash('sha256').update(raw).digest('hex') !== expect.checksum) {
    throw checksumError('page checksum mismatch');
  }
  return gzipSync(raw);
}
