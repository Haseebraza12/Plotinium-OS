/**
 * storage/: /api/blobs (backend-api.md §3.6.3, §3.10; database.md §3.19; SRV-10, VFS-04, VFS-06).
 * Primary owner R1, secondary reviewer R2.
 *
 * PUT  /api/blobs/{sha256}   64 lowercase hex (400); Content-Length required (411 EINVAL) and at
 *      most BLOB_MAX_BYTES (413 EINVAL); before the body is read, Content-Length is compared with
 *      the principal's remaining byte quota (413 EDQUOT; root exempt; the authoritative check is in
 *      the op's vfsTxn). The body streams into FsBlobStore, which hashes it; a digest or length
 *      mismatch is 422 EIO `checksum` and nothing is kept. Existing content is still hashed in full
 *      (proof of possession): 200 {sha256, size, existing: true}; new content 201 {…, stored: true}.
 *      The `blobs` row (refcount 0) is recorded after the upload, under the blob's advisory lock.
 * GET  /api/blobs/{sha256}?ino=   r on `ino`, x on its ancestors, and `sha256` must be the inode's
 *      CURRENT content (403 EACCES / 404 ENOENT). Without `ino`, any readable inode holding it.
 *      A single `Range: bytes=a-b` gives 206 (416 EINVAL when unsatisfiable).
 * HEAD /api/blobs/{sha256}[?ino=]  200 with Content-Length only when the principal can read some
 *      inode (or the given one) whose current content is `sha256`; 404 otherwise, even when the
 *      blob exists, so the endpoint never confirms that someone else holds a content hash.
 */
import type { Readable } from 'node:stream';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as v from 'valibot';

import { may, R, X } from '@plotinium/vfs/perm';

import { ErrnoError } from '../errno.ts';
import type { Principal } from '../http/context.ts';
import { HttpError } from '../http/errors.ts';
import { parseInput } from '../http/validate.ts';
import type { Metrics } from '../obs/metrics.ts';
import type { RateLimiter } from '../ratelimit/limiter.ts';
import { credOf } from '../sync/routes.ts';
import type { BlobDb, BlobHolder } from './blob-db.ts';
import { blobKeyPath, type BlobStore } from './blobstore.ts';

const BUSY_RETRY_MS = 1_000;
/** HEAD/GET without ?ino= look at this many holders of a content hash. */
const HOLDERS_SCANNED = 32;

const Sha256Params = v.object({ sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)) });
const InoQuery = v.object({
  ino: v.optional(
    v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)),
  ),
});

export interface BlobsPluginOptions {
  /** null: no blob store or no database; every route answers 503 EIO 'server'. */
  readonly store: BlobStore | null;
  readonly db: BlobDb | null;
  readonly maxBytes: number;
  readonly limiter: RateLimiter;
  readonly metrics?: Metrics;
}

/** One `Range: bytes=…` header against a body of `size` bytes (inclusive end), or null for none. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (header === undefined || header === '') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  const bad = (): never => {
    throw new HttpError(416, 'EINVAL', 'unsatisfiable range', { field: 'range' });
  };
  if (m === null) return bad();
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return bad();
  let start: number;
  let end: number;
  if (a === '') {
    const n = Number(b);
    if (n === 0 || size === 0) return bad();
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
    return bad();
  return { start, end };
}

export function blobsPlugin(app: FastifyInstance, opts: BlobsPluginOptions): Promise<void> {
  const ready = (): { store: BlobStore; db: BlobDb } => {
    if (opts.store === null || opts.db === null)
      throw new HttpError(
        503,
        'EIO',
        'blob store unavailable',
        { reason: 'server' },
        BUSY_RETRY_MS,
      );
    return { store: opts.store, db: opts.db };
  };
  const principalOf = (request: FastifyRequest): Principal => {
    const p = request.plt.principal;
    if (p === undefined) throw new HttpError(401, 'EACCES', 'not logged in');
    return p;
  };

  /** The inode (or, without one, some inode) the principal may read whose content is `sha256`. */
  const readableHolder = async (
    db: BlobDb,
    principal: Principal,
    sha256: string,
    ino: string | undefined,
  ): Promise<BlobHolder | 'forbidden' | null> => {
    const cred = credOf(principal);
    const candidates =
      ino === undefined
        ? await db.holdersOf(sha256, HOLDERS_SCANNED)
        : [await db.holder(ino)].filter((h): h is BlobHolder => h !== null);
    if (candidates.length === 0) return null;
    const ctx = await db.context(candidates.map((c) => c.ino));
    // Reading a file needs r on it and x on its parent and every ancestor (first link).
    const traversable = (dir: string | null): boolean => {
      for (let p = dir, depth = 0; p !== null; depth++) {
        const node = ctx.get(p);
        if (depth > 4096 || node === undefined || !may(cred, node.row, X)) return false;
        p = node.parent;
      }
      return true;
    };
    let denied = false;
    for (const c of candidates) {
      if (c.sha256 !== sha256) continue;
      if (traversable(ctx.get(c.ino)?.parent ?? null) && may(cred, c, R)) return c;
      denied = true;
    }
    return ino !== undefined && denied ? 'forbidden' : null;
  };

  app.put(
    '/api/blobs/:sha256',
    { config: { rateClass: 'blob' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { store, db } = ready();
      const principal = principalOf(request);
      const { sha256 } = parseInput(Sha256Params, request.params);
      const cl = request.headers['content-length'];
      if (cl === undefined)
        throw new HttpError(411, 'EINVAL', 'Content-Length required', { field: 'content-length' });
      if (!/^\d{1,16}$/.test(cl))
        throw new HttpError(400, 'EINVAL', 'bad Content-Length', { field: 'content-length' });
      const size = Number(cl);
      if (size > opts.maxBytes)
        throw new HttpError(413, 'EINVAL', 'blob larger than BLOB_MAX_BYTES', {
          field: 'content-length',
        });
      const bytes = opts.limiter.take('blob-bytes', String(principal.uid), Math.max(1, size));
      if (!bytes.ok)
        throw new HttpError(
          429,
          'EAGAIN',
          'upload rate exceeded',
          { reason: 'rate' },
          bytes.retryAfterMs,
        );
      const left = await db.remainingBytes(principal.uid);
      if (left !== null && size > left)
        throw new HttpError(413, 'EDQUOT', 'the upload exceeds the remaining quota', {
          remaining: Math.max(0, left),
        });
      const body = request.body as Readable | undefined;
      if (body === undefined || typeof (body as { pipe?: unknown }).pipe !== 'function')
        throw new HttpError(415, 'EINVAL', 'blob bodies are application/octet-stream');

      const key = { kind: 'content', sha256 } as const;
      let put;
      try {
        put = await store.put(key, body, { size, sha256, maxBytes: opts.maxBytes });
      } catch (e) {
        if (e instanceof ErrnoError && (e.errno === 'EIO' || e.errno === 'EINVAL'))
          throw new HttpError(422, 'EIO', 'checksum or length mismatch', { reason: 'checksum' });
        throw e;
      }
      opts.metrics?.blobBytes.inc({ dir: 'in' }, put.size);
      const recorded = await db.record(
        sha256,
        put.size,
        blobKeyPath(key),
        async () => (await store.head(key)) !== null,
      );
      if (!recorded)
        throw new HttpError(
          503,
          'EAGAIN',
          'blob vanished; upload again',
          { reason: 'blob-missing' },
          BUSY_RETRY_MS,
        );
      return reply
        .code(put.existed ? 200 : 201)
        .send(
          put.existed
            ? { sha256, size: put.size, existing: true }
            : { sha256, size: put.size, stored: true },
        );
    },
  );

  app.get(
    '/api/blobs/:sha256',
    { exposeHeadRoute: false, config: { rateClass: 'blob' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { store, db } = ready();
      const principal = principalOf(request);
      const { sha256 } = parseInput(Sha256Params, request.params);
      const { ino } = parseInput(InoQuery, request.query);
      const holder = await readableHolder(db, principal, sha256, ino);
      if (holder === 'forbidden') throw new HttpError(403, 'EACCES', 'permission denied');
      if (holder === null) throw new HttpError(404, 'ENOENT', 'no such blob');
      const key = { kind: 'content', sha256 } as const;
      const head = await store.head(key);
      if (head === null) throw new HttpError(404, 'ENOENT', 'no such blob');
      const range = parseRange(request.headers.range, head.size);
      let stream: Readable;
      try {
        stream = await store.get(key, range ?? undefined);
      } catch (e) {
        if (e instanceof ErrnoError && e.errno === 'ENOENT')
          throw new HttpError(404, 'ENOENT', 'no such blob');
        throw e;
      }
      const length = range === null ? head.size : range.end - range.start + 1;
      opts.metrics?.blobBytes.inc({ dir: 'out' }, length);
      void reply
        .header('content-type', 'application/octet-stream')
        .header('content-length', String(length))
        .header('etag', `"${sha256}"`)
        .header('accept-ranges', 'bytes')
        .header('cache-control', 'no-store');
      if (range !== null) {
        void reply
          .code(206)
          .header('content-range', `bytes ${range.start}-${range.end}/${head.size}`);
      }
      return reply.send(stream);
    },
  );

  app.head(
    '/api/blobs/:sha256',
    { config: { rateClass: 'blob' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { store, db } = ready();
      const principal = principalOf(request);
      const { sha256 } = parseInput(Sha256Params, request.params);
      const { ino } = parseInput(InoQuery, request.query);
      const holder = await readableHolder(db, principal, sha256, ino);
      const head =
        holder === null || holder === 'forbidden'
          ? null
          : await store.head({ kind: 'content', sha256 });
      if (head === null) return reply.code(404).header('cache-control', 'no-store').send();
      return reply
        .code(200)
        .header('content-length', String(head.size))
        .header('etag', `"${sha256}"`)
        .header('cache-control', 'no-store')
        .send();
    },
  );

  return Promise.resolve();
}
