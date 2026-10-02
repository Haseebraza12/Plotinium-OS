/**
 * The remote swap store, tier 2 (spec §9.2 MEM-04, MEM-05; backend-api.md §3.11, SRV-11, INV-SRV-5;
 * memory-and-paging.md §3.11; database.md §3.18). Routes (server/src/swap/routes.ts) parse the
 * transport and call these methods with the SESSION uid as owner.
 *
 * Authorisation by owner: the owner must equal os_sessions.owner_uid of the page's OS session,
 * otherwise 403 EACCES, for root too (process memory is private to its owner). Lookups and
 * listings go by owner_uid, so a NEW browser session of the same user lists and pages in the
 * pages of an older OS session (MEM-04).
 *
 * PUT: pre-checks (owner, generation, quota by Content-Length) -> the compressed body streams into
 *   FsBlobStore through the gunzip verifier (checksum and size of the UNCOMPRESSED page, 422 EIO
 *   'checksum' on mismatch, nothing kept) -> ONE short transaction locks the owner's users row,
 *   re-checks PLOTINIUM_SWAP_MAX_BYTES and upserts the row (413 EDQUOT otherwise: the row and the
 *   object are removed and the page stays local only). Re-uploading the same checksum is a no-op.
 *   Uploads of one page are serialised in-process (one server process, SRV-01), so the stored
 *   object and its row always describe the same generation.
 * GET streams the compressed bytes; the client decompresses and verifies before use (MEM-03).
 * DELETE removes rows first, storage objects after the commit.
 */
import { Readable } from 'node:stream';

import { ErrnoError } from '../../errno.ts';
import { HttpError } from '../../http/errors.ts';
import {
  blobKeyPath,
  SHA256_HEX_RE,
  type BlobKey,
  type BlobStore,
} from '../../storage/blobstore.ts';
import { gunzipVerifier, verifyIdentityPage } from './checksum.ts';
import type { ListCursor, ListFilter, SwapDb, SwapKey, SwapList, SwapPage } from './types.ts';

export const LIST_LIMIT_MAX = 1000;
export const RETENTION_DAYS = 30;
/** gzip of incompressible data grows by ~5 bytes per 16 KiB block plus a header and trailer. */
export function maxStoredBytes(maxRaw: number): number {
  return maxRaw + Math.ceil(maxRaw / 16_384) * 5 + 1024;
}

export interface SwapPutArgs extends SwapKey {
  /** memory-and-paging.md §4.5 `?gen=`; null when the client sends none. */
  readonly gen: number | null;
  readonly body: Readable;
  readonly contentLength: number;
  readonly checksum: string;
  readonly rawSize: number;
  readonly encoding: 'gzip' | 'identity';
}

export interface SwapPutResult {
  /** backend-api.md §3.11 reply {stored, checksum} ... */
  readonly stored: true;
  readonly checksum: string;
  /** ... and memory-and-paging.md §4.5 reply {sha256, size, gen}. */
  readonly sha256: string;
  readonly size: number;
  readonly storedSize: number;
  readonly gen: number;
  /** The same content was already stored: nothing was written (the route drains the body). */
  readonly unchanged: boolean;
}

export interface SwapGetResult {
  readonly stream: Readable;
  readonly page: SwapPage;
  /** Stored pages are always gzip. */
  readonly encoding: 'gzip';
}

export interface SwapServiceDeps {
  readonly db: SwapDb;
  readonly blobs: BlobStore;
  /** PLOTINIUM_SWAP_MAX_BYTES: per-owner cap on stored (compressed) bytes. */
  readonly quotaBytes: number;
  /** SWAP_PAGE_MAX_RAW_BYTES: largest uncompressed page. */
  readonly maxRawBytes: number;
}

const forbidden = (): HttpError => new HttpError(403, 'EACCES', 'not your swap', {});
const notFound = (): HttpError => new HttpError(404, 'ENOENT', 'no such swap page', {});
const badRequest = (msg: string, field: string): HttpError =>
  new HttpError(400, 'EINVAL', msg, { field });
const quotaError = (): HttpError =>
  new HttpError(413, 'EDQUOT', 'remote swap quota exceeded; the page stays local only', {});

/** Serialises async work per key (single process, SRV-01). */
class KeyedMutex {
  readonly #tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.#tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

function blobKey(k: SwapKey): BlobKey & { kind: 'swap' } {
  return {
    kind: 'swap',
    ownerUid: k.ownerUid,
    osSessionId: k.osSessionId,
    pid: k.pid,
    pageId: k.pageId,
  };
}

/** Validates the address (EINVAL 400) and returns the FsBlobStore storage key. */
function storageKeyOf(k: SwapKey): string {
  try {
    return blobKeyPath(blobKey(k));
  } catch (e) {
    if (e instanceof ErrnoError) {
      const field = typeof e.detail['field'] === 'string' ? e.detail['field'] : 'key';
      throw badRequest('invalid swap page address', field);
    }
    throw e;
  }
}

export function encodeCursor(c: ListCursor): string {
  return Buffer.from(JSON.stringify([c.osSessionId, c.pid, c.pageId]), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(s: string): ListCursor {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(v) &&
      v.length === 3 &&
      typeof v[0] === 'string' &&
      /^[0-9a-f-]{36}$/.test(v[0]) &&
      Number.isSafeInteger(v[1]) &&
      Number.isSafeInteger(v[2])
    ) {
      return { osSessionId: v[0], pid: v[1] as number, pageId: v[2] as number };
    }
  } catch {
    // fall through
  }
  throw badRequest('invalid cursor', 'after');
}

export class SwapService {
  readonly #db: SwapDb;
  readonly #blobs: BlobStore;
  readonly #quota: number;
  readonly #maxRaw: number;
  readonly #mutex = new KeyedMutex();

  constructor(deps: SwapServiceDeps) {
    this.#db = deps.db;
    this.#blobs = deps.blobs;
    this.#quota = deps.quotaBytes;
    this.#maxRaw = deps.maxRawBytes;
  }

  async #authorize(ownerUid: number, osSessionId: string): Promise<void> {
    const owner = await this.#db.sessionOwner(osSessionId);
    if (owner !== ownerUid) throw forbidden(); // another user's session, or none: 403 either way
  }

  async put(a: SwapPutArgs): Promise<SwapPutResult> {
    const storageKey = storageKeyOf(a);
    if (!SHA256_HEX_RE.test(a.checksum))
      throw badRequest('checksum must be hex SHA-256', 'x-plotinium-checksum');
    if (!Number.isSafeInteger(a.rawSize) || a.rawSize < 0 || a.rawSize > this.#maxRaw) {
      throw new HttpError(413, 'EINVAL', 'page larger than SWAP_PAGE_MAX_RAW_BYTES', {
        field: 'x-plotinium-raw-size',
      });
    }
    if (!Number.isSafeInteger(a.contentLength) || a.contentLength < 0) {
      throw badRequest('Content-Length required', 'content-length');
    }
    if (a.contentLength > maxStoredBytes(this.#maxRaw)) {
      throw new HttpError(413, 'EINVAL', 'body too large', { field: 'content-length' });
    }
    if (a.encoding === 'identity' && a.contentLength !== a.rawSize) {
      throw badRequest('an identity page has Content-Length = raw size', 'content-length');
    }
    if (a.gen !== null && (!Number.isSafeInteger(a.gen) || a.gen < 0))
      throw badRequest('bad generation', 'gen');

    return this.#mutex.run(storageKey, async () => {
      await this.#authorize(a.ownerUid, a.osSessionId);
      const existing = await this.#db.getPage(a);
      const gen = a.gen ?? (existing === null ? 0 : existing.gen);
      if (existing !== null && gen < existing.gen) {
        throw new HttpError(409, 'EAGAIN', 'a newer generation of this page is stored', {
          reason: 'stale-version',
        });
      }
      const key = blobKey(a);
      if (
        existing !== null &&
        existing.checksum === a.checksum &&
        (await this.#blobs.head(key)) !== null
      ) {
        if (gen !== existing.gen) {
          await this.#upsert({
            ...a,
            gen,
            storageKey,
            size: existing.size,
            storedSize: existing.storedSize,
            checksum: a.checksum,
          });
        }
        return this.#result(a.checksum, existing.size, existing.storedSize, gen, true);
      }
      const used = (await this.#db.usedBytes(a.ownerUid)) - (existing?.storedSize ?? 0);
      if (a.encoding === 'gzip' && used + a.contentLength > this.#quota) throw quotaError();

      let storedSize: number;
      if (a.encoding === 'gzip') {
        const verifier = gunzipVerifier({
          storedSize: a.contentLength,
          rawSize: a.rawSize,
          checksum: a.checksum,
        });
        a.body.on('error', (e) => verifier.destroy(e));
        verifier.on('error', () => undefined); // surfaced through BlobStore.put's read loop
        a.body.pipe(verifier);
        const r = await this.#blobs.put(key, verifier, {
          size: a.contentLength,
          maxBytes: maxStoredBytes(this.#maxRaw),
        });
        storedSize = r.size;
      } else {
        const gz = await verifyIdentityPage(a.body as AsyncIterable<Buffer>, {
          rawSize: a.rawSize,
          checksum: a.checksum,
        });
        if (used + gz.length > this.#quota) throw quotaError();
        const r = await this.#blobs.put(key, Readable.from([gz]), {
          size: gz.length,
          maxBytes: maxStoredBytes(this.#maxRaw),
        });
        storedSize = r.size;
      }

      await this.#upsert({
        ...a,
        gen,
        storageKey,
        size: a.rawSize,
        storedSize,
        checksum: a.checksum,
      });
      return this.#result(a.checksum, a.rawSize, storedSize, gen, false);
    });
  }

  async #upsert(
    row: SwapKey & {
      gen: number;
      storageKey: string;
      size: number;
      storedSize: number;
      checksum: string;
    },
  ): Promise<void> {
    const out = await this.#db.upsertPage(
      {
        ownerUid: row.ownerUid,
        osSessionId: row.osSessionId,
        pid: row.pid,
        pageId: row.pageId,
        gen: row.gen,
        storageKey: row.storageKey,
        size: row.size,
        storedSize: row.storedSize,
        checksum: row.checksum,
      },
      this.#quota,
    );
    if (out.ok) return;
    if (out.reason === 'quota') {
      // The row is already gone (same transaction); the object follows after the commit.
      await this.#blobs.delete(blobKey(row));
      throw quotaError();
    }
    if (out.reason === 'foreign-session') throw forbidden();
    throw new HttpError(409, 'EAGAIN', 'a newer generation of this page is stored', {
      reason: 'stale-version',
    });
  }

  #result(
    checksum: string,
    size: number,
    storedSize: number,
    gen: number,
    unchanged: boolean,
  ): SwapPutResult {
    return { stored: true, checksum, sha256: checksum, size, storedSize, gen, unchanged };
  }

  async get(k: SwapKey, gen: number | null = null): Promise<SwapGetResult> {
    storageKeyOf(k);
    await this.#authorize(k.ownerUid, k.osSessionId);
    const page = await this.#db.getPage(k);
    if (page === null || (gen !== null && page.gen !== gen)) throw notFound();
    let stream: Readable;
    try {
      stream = await this.#blobs.get(blobKey(k));
    } catch (e) {
      if (e instanceof ErrnoError && e.errno === 'ENOENT') throw notFound();
      throw e;
    }
    return { stream, page, encoding: 'gzip' };
  }

  async list(
    ownerUid: number,
    filter: ListFilter = {},
    after: string | null = null,
    limit: number = LIST_LIMIT_MAX,
  ): Promise<SwapList> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
      throw badRequest(`limit must be 1..${LIST_LIMIT_MAX}`, 'limit');
    }
    if (filter.pid !== undefined && (!Number.isSafeInteger(filter.pid) || filter.pid < 1)) {
      throw badRequest('bad pid', 'pid');
    }
    if (filter.osSessionId !== undefined) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(filter.osSessionId)
      ) {
        throw badRequest('bad OS session id', 'osSession');
      }
      await this.#authorize(ownerUid, filter.osSessionId);
    }
    const cursor = after === null ? null : decodeCursor(after);
    const rows = await this.#db.listPages(ownerUid, filter, cursor, limit + 1);
    const pages = rows.slice(0, limit);
    const last = pages[pages.length - 1];
    return rows.length > limit && last !== undefined
      ? {
          pages,
          next: encodeCursor({ osSessionId: last.osSessionId, pid: last.pid, pageId: last.pageId }),
        }
      : { pages };
  }

  /** DELETE of a page, a pid's pages or an OS session's pages: rows first, objects after COMMIT. */
  async delete(
    ownerUid: number,
    osSessionId: string,
    pid?: number,
    pageId?: number,
  ): Promise<number> {
    storageKeyOf({ ownerUid, osSessionId, pid: pid ?? 1, pageId: pageId ?? 0 });
    const owner = await this.#db.sessionOwner(osSessionId);
    if (owner === null) return 0; // nothing there: idempotent 204
    if (owner !== ownerUid) throw forbidden();
    const keys = await this.#db.deletePages(ownerUid, osSessionId, pid, pageId);
    await this.#deleteObjects(keys);
    return keys.length;
  }

  /** Daily retention job: pages of OS sessions not updated for 30 days. */
  async sweepRetention(days: number = RETENTION_DAYS): Promise<number> {
    const keys = await this.#db.deleteExpired(days);
    await this.#deleteObjects(keys);
    return keys.length;
  }

  async #deleteObjects(keys: readonly SwapKey[]): Promise<void> {
    for (const k of keys) await this.#blobs.delete(blobKey(k));
  }
}
