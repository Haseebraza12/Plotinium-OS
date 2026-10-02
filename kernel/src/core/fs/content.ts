/**
 * File content for descriptors (virtual-file-system.md §3.9.3, §3.13.4).
 *
 * Content is content-addressed: an inode names a blob (the SHA-256 of the whole file), a blob lists
 * its 1 MiB chunks, and chunk bytes live in `blob_chunks`. Descriptors read from a snapshot taken at
 * `open`, through the synchronous `ChunkSource` of the vfs `WriteSession`, so the chunks of a
 * snapshot are loaded (asynchronously, read-only) before a read or write touches them.
 *
 * `ContentCache` keeps recently used chunks by hash, bounded in bytes (oldest evicted first). A
 * caller gets its own array of chunk views, so an eviction never pulls bytes out from under an open
 * description. Chunks written by a commit are remembered at once (no store read after a write).
 */
import type { BlobRec, ChunkRec, Plan, ReadStore, Sha256Hex, Store } from '@plotinium/vfs';
import { CHUNK_SIZE, contentOf, EMPTY_BLOB, VfsError } from '@plotinium/vfs';
import type { ChunkSource } from '@plotinium/vfs';

/**
 * Fetch the bytes of blob `sha` from the server (`GET /api/blobs/{sha}`, VFS §3.13.4): content
 * that arrived by sync as a hash only. Null when the server does not give it (offline, 404, 403).
 */
export type BlobFetch = (sha: Sha256Hex) => Promise<Uint8Array | null>;

/** Default bound of cached chunk bytes. */
export const CONTENT_CACHE_BYTES = 64 * 1_048_576;

export class ContentCache {
  private readonly store: ReadStore & Partial<Pick<Store, 'tx'>>;
  private readonly cap: number;
  private readonly fetchBlob: BlobFetch | undefined;
  private readonly chunks = new Map<Sha256Hex, Uint8Array>();
  private readonly blobs = new Map<Sha256Hex, readonly Sha256Hex[] | null>();
  private readonly fetching = new Map<Sha256Hex, Promise<Uint8Array[]>>();
  private bytes = 0;

  constructor(
    store: ReadStore & Partial<Pick<Store, 'tx'>>,
    capBytes = CONTENT_CACHE_BYTES,
    fetchBlob?: BlobFetch,
  ) {
    this.store = store;
    this.cap = capBytes;
    this.fetchBlob = fetchBlob;
  }

  /** Bytes currently cached. */
  get size(): number {
    return this.bytes;
  }

  private put(sha: Sha256Hex, bytes: Uint8Array): void {
    if (this.chunks.has(sha)) return;
    this.chunks.set(sha, bytes);
    this.bytes += bytes.byteLength;
    for (const [k, v] of this.chunks) {
      if (this.bytes <= this.cap) break;
      if (k === sha) continue;
      this.chunks.delete(k);
      this.bytes -= v.byteLength;
    }
  }

  /** Remember what a committed plan wrote (its new blobs' chunk lists and chunk bytes). */
  remember(plan: Pick<Plan, 'chunks' | 'blobs'>): void {
    for (const u of plan.blobs) {
      if (u.record !== undefined && !this.blobs.has(u.sha)) this.blobs.set(u.sha, u.record.chunks);
    }
    for (const c of plan.chunks) this.put(c.sha, new Uint8Array(c.bytes));
  }

  /** Remember content that was never stored (a synthesised file's snapshot). */
  rememberBytes(
    sha: Sha256Hex,
    parts: readonly Uint8Array[],
    chunkShas: readonly Sha256Hex[],
  ): void {
    this.blobs.set(sha, chunkShas);
    parts.forEach((p, i) => {
      const s = chunkShas[i];
      if (s !== undefined) this.put(s, p);
    });
  }

  /**
   * The chunks of blob `sha`, in order. EAGAIN (`content-not-cached`) when the bytes are not on this
   * device (offline, not yet fetched); EIO (`storage`) when the store has no record of the blob.
   */
  async load(sha: Sha256Hex): Promise<Uint8Array[]> {
    if (sha === EMPTY_BLOB) return [];
    let list = this.blobs.get(sha);
    if (list === undefined) {
      const rec = await this.store.get<BlobRec>('blobs', sha);
      if (rec === undefined) throw new VfsError('EIO', 'storage');
      list = rec.chunks;
      if (list !== null) this.blobs.set(sha, list);
    }
    // Known only by its hash (synced from another device): fetch it once (VFS §3.13.4, UI-006).
    if (list === null) return this.fetchOnce(sha);
    const out = new Map<Sha256Hex, Uint8Array>();
    const missing: Sha256Hex[] = [];
    for (const c of list) {
      const hit = this.chunks.get(c);
      if (hit === undefined) missing.push(c);
      else out.set(c, hit);
    }
    if (missing.length > 0) {
      const recs = await this.store.getMany<ChunkRec>('blob_chunks', missing);
      recs.forEach((r, i) => {
        const s = missing[i];
        if (r === undefined || s === undefined) return;
        const bytes = new Uint8Array(r.bytes);
        out.set(s, bytes);
        this.put(s, bytes);
      });
    }
    return list.map((c) => out.get(c) ?? fail());
  }

  private fetchOnce(sha: Sha256Hex): Promise<Uint8Array[]> {
    const fetchBlob = this.fetchBlob;
    if (fetchBlob === undefined)
      return Promise.reject(new VfsError('EAGAIN', 'content-not-cached'));
    let p = this.fetching.get(sha);
    if (p === undefined) {
      p = this.fetchAndKeep(fetchBlob, sha).finally(() => {
        this.fetching.delete(sha);
      });
      this.fetching.set(sha, p);
    }
    return p;
  }

  /** Download, verify the hash (the server is not trusted with integrity), cache and store. */
  private async fetchAndKeep(fetchBlob: BlobFetch, sha: Sha256Hex): Promise<Uint8Array[]> {
    let bytes: Uint8Array | null;
    try {
      bytes = await fetchBlob(sha);
    } catch {
      bytes = null;
    }
    if (bytes === null) throw new VfsError('EAGAIN', 'content-not-cached');
    const c = contentOf(bytes, Date.now());
    // Bytes that do not hash to the name are not this file's content: treat them as unavailable.
    if (c.sha !== sha) throw new VfsError('EIO', 'storage');
    const tx = this.store.tx?.bind(this.store);
    if (tx !== undefined) {
      await tx(
        ['blobs', 'blob_chunks'],
        'relaxed',
        (t) => {
          for (const ch of c.chunks) t.put('blob_chunks', ch);
          t.get<BlobRec>('blobs', sha, undefined, (cur) => {
            if (cur !== undefined && cur.chunks === null)
              t.put('blobs', { ...cur, chunks: [...c.chunkShas] } satisfies BlobRec);
          });
        },
        { label: 'blob fetched' },
      ).catch(() => undefined); // a failed write only means the next read fetches again
    }
    this.blobs.set(sha, c.chunkShas);
    const parts = c.chunks.map((ch) => new Uint8Array(ch.bytes));
    c.chunkShas.forEach((s, i) => {
      const part = parts[i];
      if (part !== undefined) this.put(s, part);
    });
    return parts;
  }

  /** The whole content of blob `sha` as one byte array. */
  async bytesOf(sha: Sha256Hex): Promise<Uint8Array> {
    return concat(await this.load(sha));
  }
}

function fail(): never {
  throw new VfsError('EAGAIN', 'content-not-cached');
}

/** Concatenate chunk views. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0];
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** A `WriteSession` base over loaded chunks; an index past the end reads as empty. */
export function chunkSource(parts: readonly Uint8Array[]): ChunkSource {
  return (i) => parts[i] ?? new Uint8Array(0);
}

/** Split bytes into CHUNK_SIZE views (for content built in memory). */
export function splitChunks(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0; off < bytes.byteLength; off += CHUNK_SIZE) {
    out.push(bytes.subarray(off, Math.min(bytes.byteLength, off + CHUNK_SIZE)));
  }
  return out;
}

/** `bytes` resized to `size`: cut, or zero-extended (a hole reads as zeros, §3.9.3). */
export function resized(bytes: Uint8Array, size: number): Uint8Array {
  if (size <= bytes.byteLength) return bytes.slice(0, size);
  const out = new Uint8Array(size);
  out.set(bytes);
  return out;
}

/** A fresh, exactly sized ArrayBuffer holding `bytes` (the `read` reply is transferred). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
