/**
 * The BlobStore interface: content-addressed file content and remote swap pages.
 *
 * Spec: specs/11-server/backend-api.md §3.10 (SRV-10), §3.11 (SRV-11); C4 (swap tier 2), C9
 * (FsBlobStore; blobs are uploaded BEFORE the database transaction that references them).
 * Implementations: FsBlobStore (production and tests). Garage v2.4.1 could implement it later
 * (the reversal option in the coherence object-storage decision).
 * Primary owner R1, secondary reviewer R2.
 */
import type { Readable } from 'node:stream';

import { ErrnoError } from '../errno.ts';

export type BlobKey =
  /** blobs/sha256/<2 hex>/<2 hex>/<sha256>; immutable, mode 0440. */
  | { readonly kind: 'content'; readonly sha256: string }
  /** swap/<owner_uid>/<os_session_id>/<pid>/<page_id>; replaced atomically, mode 0640. */
  | {
      readonly kind: 'swap';
      readonly ownerUid: number;
      readonly osSessionId: string;
      readonly pid: number;
      readonly pageId: number;
    };

export interface BlobPutExpect {
  /** Content-Length of the upload. A different byte count -> EINVAL, nothing kept. */
  readonly size: number;
  /** Hex SHA-256 the stored bytes must have (content keys are always checked against the key). */
  readonly sha256?: string;
  /** Hard limit; exceeding it aborts the stream with EINVAL, nothing kept. */
  readonly maxBytes: number;
}

export interface BlobPutResult {
  readonly size: number;
  readonly sha256: string;
  /** A content key whose file already existed: the upload was hashed in full and discarded. */
  readonly existed: boolean;
}

export interface BlobStore {
  /** Streams `body` to a temporary file, verifies size and SHA-256, then renames it atomically. */
  put(key: BlobKey, body: Readable, expect: BlobPutExpect): Promise<BlobPutResult>;
  /** ENOENT if absent. `range` is inclusive on both ends, like HTTP `Range: bytes=a-b`. */
  get(key: BlobKey, range?: { readonly start: number; readonly end: number }): Promise<Readable>;
  head(key: BlobKey): Promise<{ readonly size: number; readonly mtimeMs: number } | null>;
  /** Idempotent. */
  delete(key: BlobKey): Promise<void>;
}

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PID = 2_147_483_647;
const MAX_PAGE_ID = 65_535;

/**
 * The store-relative path of a key. Every field is validated first, so no key can escape the
 * store root (path traversal) or collide with the `tmp/` area. Throws EINVAL.
 */
export function blobKeyPath(key: BlobKey): string {
  if (key.kind === 'content') {
    if (!SHA256_HEX_RE.test(key.sha256)) {
      throw new ErrnoError('EINVAL', { field: 'sha256' }, 'sha256 must be 64 lowercase hex digits');
    }
    return `blobs/sha256/${key.sha256.slice(0, 2)}/${key.sha256.slice(2, 4)}/${key.sha256}`;
  }
  if (!Number.isInteger(key.ownerUid) || key.ownerUid < 0 || key.ownerUid > MAX_PID) {
    throw new ErrnoError('EINVAL', { field: 'ownerUid' });
  }
  if (!UUID_RE.test(key.osSessionId)) throw new ErrnoError('EINVAL', { field: 'osSessionId' });
  if (!Number.isInteger(key.pid) || key.pid < 1 || key.pid > MAX_PID) {
    throw new ErrnoError('EINVAL', { field: 'pid' });
  }
  if (!Number.isInteger(key.pageId) || key.pageId < 0 || key.pageId > MAX_PAGE_ID) {
    throw new ErrnoError('EINVAL', { field: 'pageId' });
  }
  return `swap/${key.ownerUid}/${key.osSessionId}/${key.pid}/${key.pageId}`;
}
