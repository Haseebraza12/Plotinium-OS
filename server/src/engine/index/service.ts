/**
 * The index API logic behind /api/index/* (backend-api.md §3.12, SRV-12; rag-semantic-search.md
 * §3.6, §4.4; database.md §3.20; RAG-02, RAG-03). Routes (server/src/index/routes.ts) parse the
 * transport, take the principal from the request context and call these methods.
 *
 * put     w (and r, see below) on the file -> 403 EACCES; `inodeVersion` must be current
 *         -> 409 EAGAIN 'stale-version'; every chunk's text must be the UTF-8 slice
 *         [byteStart, byteEnd) of the file's CURRENT blob and its contentHash must recompute
 *         -> 422 EINVAL (no index poisoning with text that is not in the file); vectors are
 *         384-d, finite and unit length. All of that runs BEFORE the transaction; the file's
 *         chunk set for the model is then replaced in one short transaction. Idempotency key
 *         (ino, inodeVersion, modelKey): a repeat answers {duplicate: true}.
 *         Hardening beyond the spec's "w on the file": r is required too, because the
 *         text-equals-blob check would otherwise let a write-only user confirm guesses of the
 *         file's content.
 * pull    only chunks of files in the readable set; text and heading trail only for files the
 *         requester owns (I-A3); keyset cursor on chunk_id.
 * search  the exact oracle: readable set first, then rank (I-A1); k <= 50; ties by (ino, seq).
 * verify  <= 50 items; readable from the current tree (upward, per link), current path,
 *         current version and snippet only when readable.
 */
import { createHash } from 'node:crypto';

import { EMBED_DIMS, Ino } from '@plotinium/protocol';
import { may, R, W } from '@plotinium/vfs/perm';
import * as v from 'valibot';

import { ErrnoError } from '../../errno.ts';
import { HttpError } from '../../http/errors.ts';
import type { BlobStore } from '../../storage/blobstore.ts';
import { credOf } from './reference.ts';
import {
  MODEL_KEY_RE,
  PULL_LIMIT_MAX,
  PUT_BLOB_MAX_BYTES,
  PUT_MAX_CHUNKS,
  SEARCH_K_MAX,
  UNIT_NORM_TOLERANCE,
  VERIFY_MAX_ITEMS,
  type ChunkIn,
  type IndexDb,
  type IndexPutInput,
  type IndexPutResult,
  type PullPage,
  type PullQuery,
  type Requester,
  type SearchHit,
  type SearchQuery,
  type VerifyItem,
  type VerifyResult,
} from './types.ts';

/** Reads a content blob (FsBlobStore) in full, at most `maxBytes`. */
export interface BlobReader {
  read(sha256: string, maxBytes: number): Promise<Uint8Array>;
}

export function blobReaderFrom(store: BlobStore): BlobReader {
  return {
    async read(sha256, maxBytes) {
      const stream = await store.get({ kind: 'content', sha256 });
      const parts: Buffer[] = [];
      let n = 0;
      for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        n += b.length;
        if (n > maxBytes) {
          stream.destroy();
          throw new ErrnoError('EINVAL', { field: 'ino' }, 'file too large to index');
        }
        parts.push(b);
      }
      return Buffer.concat(parts);
    },
  };
}

/** SHA-256(modelKey ‖ 0x00 ‖ header ‖ 0x00 ‖ text), hex (rag-semantic-search.md §3.2.4). */
export function chunkContentHash(modelKey: string, header: string, text: string): string {
  return createHash('sha256')
    .update(modelKey, 'utf8')
    .update(Buffer.of(0))
    .update(header, 'utf8')
    .update(Buffer.of(0))
    .update(text, 'utf8')
    .digest('hex');
}

const invalid = (msg: string, field: string): HttpError =>
  new HttpError(422, 'EINVAL', msg, { field });
const badRequest = (msg: string, field: string): HttpError =>
  new HttpError(400, 'EINVAL', msg, { field });

function checkModelKey(modelKey: string, status: 400 | 422): void {
  if (!MODEL_KEY_RE.test(modelKey)) {
    throw new HttpError(status, 'EINVAL', 'invalid model key', { field: 'modelKey' });
  }
}

function checkVector(v: Float32Array, field: string, unit: boolean, status: 400 | 422): void {
  if (v.length !== EMBED_DIMS)
    throw new HttpError(status, 'EINVAL', `vectors have ${EMBED_DIMS} dimensions`, { field });
  let sq = 0;
  for (const x of v) {
    if (!Number.isFinite(x))
      throw new HttpError(status, 'EINVAL', 'vector component is not finite', { field });
    sq += x * x;
  }
  if (unit && Math.abs(Math.sqrt(sq) - 1) >= UNIT_NORM_TOLERANCE) {
    throw new HttpError(status, 'EINVAL', 'vectors must be unit length', { field });
  }
}

function checkChunkShape(c: ChunkIn, i: number): void {
  const f = `chunks[${i}]`;
  const ints = [c.seq, c.byteStart, c.byteEnd, c.lineStart, c.lineEnd];
  if (!ints.every((n) => Number.isSafeInteger(n) && n >= 0))
    throw invalid('offsets must be integers', f);
  if (c.byteEnd <= c.byteStart) throw invalid('byteEnd must follow byteStart', `${f}.byteEnd`);
  if (c.lineStart < 1 || c.lineEnd < c.lineStart) throw invalid('bad line range', `${f}.lineEnd`);
  if (Buffer.byteLength(c.header, 'utf8') > 512) throw invalid('header too long', `${f}.header`);
  if (c.text.includes('\u0000') || c.header.includes('\u0000'))
    throw invalid('NUL in chunk text', `${f}.text`);
  if (!/^[0-9a-f]{64}$/.test(c.contentHash))
    throw invalid('contentHash must be hex SHA-256', `${f}.contentHash`);
  if (c.embedding !== null) checkVector(c.embedding, `${f}.embedding`, true, 422);
}

export interface IndexServiceDeps {
  readonly db: IndexDb;
  readonly blobs: BlobReader;
}

export class IndexService {
  readonly #db: IndexDb;
  readonly #blobs: BlobReader;

  constructor(deps: IndexServiceDeps) {
    this.#db = deps.db;
    this.#blobs = deps.blobs;
  }

  async put(req: Requester, input: IndexPutInput): Promise<IndexPutResult> {
    checkModelKey(input.modelKey, 422);
    if (!v.is(Ino, input.ino)) throw invalid('not an inode id', 'ino');
    if (!Number.isSafeInteger(input.inodeVersion) || input.inodeVersion < 1) {
      throw invalid('inodeVersion must be a positive integer', 'inodeVersion');
    }
    if (input.chunks.length > PUT_MAX_CHUNKS) throw invalid('too many chunks', 'chunks');
    const seqs = new Set<number>();
    input.chunks.forEach((c, i) => {
      checkChunkShape(c, i);
      if (seqs.has(c.seq)) throw invalid('duplicate seq', `chunks[${i}].seq`);
      seqs.add(c.seq);
    });

    const meta = await this.#db.fileMeta(input.ino);
    if (meta === null) throw new HttpError(404, 'ENOENT', 'no such file', { field: 'ino' });
    if (meta.type !== 'f') throw invalid('only regular files are indexed', 'ino');
    const cred = credOf(req);
    if (!may(cred, meta, W) || !may(cred, meta, R)) {
      throw new HttpError(403, 'EACCES', 'permission denied', {});
    }
    if (meta.version !== input.inodeVersion) {
      throw new HttpError(409, 'EAGAIN', 'the file changed since it was indexed', {
        reason: 'stale-version',
      });
    }
    if ((await this.#db.storedVersion(input.ino, input.modelKey)) === input.inodeVersion) {
      return { duplicate: true };
    }

    // Before any transaction: the text must be the file's own bytes (no poisoning).
    if (input.chunks.length > 0) {
      if (meta.blobSha256 === null || meta.size === 0) throw invalid('the file is empty', 'chunks');
      if (meta.size > PUT_BLOB_MAX_BYTES) throw invalid('file too large to index', 'ino');
      const blob = await this.#blobs.read(meta.blobSha256, PUT_BLOB_MAX_BYTES);
      input.chunks.forEach((c, i) => {
        if (c.byteEnd > blob.length)
          throw invalid('chunk outside the file', `chunks[${i}].byteEnd`);
        const slice = Buffer.from(
          blob.buffer,
          blob.byteOffset + c.byteStart,
          c.byteEnd - c.byteStart,
        );
        if (!Buffer.from(c.text, 'utf8').equals(slice)) {
          throw invalid('chunk text is not the file content at its offsets', `chunks[${i}].text`);
        }
        if (chunkContentHash(input.modelKey, c.header, c.text) !== c.contentHash) {
          throw invalid('contentHash does not match the chunk', `chunks[${i}].contentHash`);
        }
      });
    }

    const r = await this.#db.replaceChunks(input);
    if (r.ok) return { applied: true, rows: r.rows };
    if (r.reason === 'stale-version') {
      throw new HttpError(409, 'EAGAIN', 'the file changed since it was indexed', {
        reason: 'stale-version',
      });
    }
    throw invalid('no stored vector to reuse for this chunk', `chunks[seq=${r.seq}].embedding`);
  }

  async pull(req: Requester, q: PullQuery): Promise<PullPage> {
    checkModelKey(q.modelKey, 400);
    if (!Number.isSafeInteger(q.after) || q.after < 0) throw badRequest('bad cursor', 'after');
    if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > PULL_LIMIT_MAX) {
      throw badRequest(`limit must be 1..${PULL_LIMIT_MAX}`, 'limit');
    }
    const { rows, manifestFiles } = await this.#db.pull(req, q);
    const chunks = rows.map(
      (c) => (c.owned ? c : { ...c, header: '', text: undefined }), // defence in depth: no foreign text (I-A3)
    );
    const last = chunks[chunks.length - 1];
    return {
      chunks,
      nextAfter: last === undefined ? q.after : last.chunkId,
      complete: chunks.length < q.limit,
      manifestFiles,
    };
  }

  async search(req: Requester, q: SearchQuery): Promise<readonly SearchHit[]> {
    checkModelKey(q.modelKey, 400);
    if (!Number.isSafeInteger(q.k) || q.k < 1 || q.k > SEARCH_K_MAX) {
      throw badRequest(`k must be 1..${SEARCH_K_MAX}`, 'k');
    }
    checkVector(q.vector, 'vector', false, 400);
    if (q.scopeIno !== undefined && q.scopeIno !== null && !v.is(Ino, q.scopeIno)) {
      throw badRequest('scope must be an inode id', 'scope');
    }
    return this.#db.search(req, q);
  }

  async verify(
    req: Requester,
    modelKey: string,
    items: readonly VerifyItem[],
  ): Promise<readonly VerifyResult[]> {
    checkModelKey(modelKey, 400);
    if (items.length > VERIFY_MAX_ITEMS)
      throw badRequest(`at most ${VERIFY_MAX_ITEMS} items`, 'items');
    if (items.length === 0) return [];
    items.forEach((it, i) => {
      if (!v.is(Ino, it.ino)) throw badRequest('not an inode id', `items[${i}].ino`);
      if (!Number.isSafeInteger(it.seq) || it.seq < 0)
        throw badRequest('bad seq', `items[${i}].seq`);
    });
    const got = await this.#db.verify(req, modelKey, items);
    return items.map((it, i) => {
      const r = got[i];
      if (r === undefined || r.ino !== it.ino || !r.readable)
        return { ino: it.ino, seq: it.seq, readable: false };
      return r;
    });
  }
}
