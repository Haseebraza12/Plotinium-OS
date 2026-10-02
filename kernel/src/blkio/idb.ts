/**
 * Tier-1 swap fallback on IndexedDB (specs/03-kernel/memory-and-paging.md §3.10.2, MEM-03).
 *
 * Used automatically when OPFS sync access handles are unavailable at POST (not a secure context,
 * or no support); `bootlog` and `swapctl` show it. Database `plotinium-swap` (C1, C4), separate
 * from `plotinium` so swap can be dropped wholesale without touching the VFS. Object store
 * `pages`, key `[uid, osSession, pid, pageId]`, value `{gen, header, body, sha256, size, createdAt}`.
 *
 * Write: one readwrite transaction with `durability: 'relaxed'` that `put`s the record; after
 * `oncomplete`, a readonly transaction `get`s it and the SHA-256 of the returned body is
 * verified. A `put` replaces the old generation atomically, so no `.tmp` or rename is needed.
 *
 * `IdbSwapDevice` holds the policy and runs on any `SwapRecordStore`; `openIdbSwapStore` is the
 * thin IndexedDB binding, written against a minimal structural subset of the IndexedDB API.
 */
import { HEADER_LEN, headersEqual, parseHeader } from '../core/mm/codec.ts';
import { swapKeyId } from '../core/mm/swap.ts';
import type {
  ProgressFn,
  SwapDevice,
  SwapKey,
  SwapReadResult,
  SwapWriteResult,
} from '../core/mm/swap.ts';
import type { AsyncDigestHex } from './opfs.ts';

export const SWAP_DB_NAME = 'plotinium-swap';
export const SWAP_DB_VERSION = 1;
export const SWAP_STORE = 'pages';

export type SwapRecordKey = [uid: number, osSession: string, pid: number, pageId: number];

export interface SwapRecord {
  gen: number;
  header: ArrayBuffer;
  body: ArrayBuffer;
  sha256: string;
  size: number;
  createdAt: number;
}

export interface SwapRecordMeta {
  key: SwapRecordKey;
  gen: number;
  size: number;
  createdAt: number;
}

/** The storage operations the IndexedDB back end needs; each is one transaction. */
export interface SwapRecordStore {
  /** One readwrite transaction (durability relaxed); resolves on `oncomplete`. */
  put(key: SwapRecordKey, rec: SwapRecord): Promise<void>;
  /** One readonly transaction. */
  get(key: SwapRecordKey): Promise<SwapRecord | undefined>;
  delete(key: SwapRecordKey): Promise<void>;
  /** Metadata of every record (a cursor walk). */
  list(): Promise<SwapRecordMeta[]>;
  /** Delete every record whose key matches, in one transaction. */
  deleteWhere(match: (key: SwapRecordKey) => boolean): Promise<{ count: number; bytes: number }>;
}

export interface IdbSwapOptions {
  capBytes?: number;
  now?: () => number;
  digestHex: AsyncDigestHex;
}

const toKey = (k: SwapKey): SwapRecordKey => [k.uid, k.osSession, k.pid, k.pageId];

function errName(e: unknown): string {
  return typeof e === 'object' && e !== null && 'name' in e ? String(e.name) : '';
}

/** IndexedDB reports DOMExceptions; keep their name so QuotaExceededError maps to EDQUOT. */
function asError(e: ErrorLike | null, fallback: string): Error {
  const err = new Error(e?.message ?? fallback);
  err.name = e?.name ?? 'Error';
  return err;
}

export class IdbSwapDevice implements SwapDevice {
  readonly kind = 'idb' as const;
  private readonly store: SwapRecordStore;
  private readonly capBytes: number;
  private readonly now: () => number;
  private readonly digestHex: AsyncDigestHex;
  private readonly sizes = new Map<string, number>();

  constructor(store: SwapRecordStore, opts: IdbSwapOptions) {
    this.store = store;
    this.capBytes = opts.capBytes ?? Number.POSITIVE_INFINITY;
    this.now = opts.now ?? (() => Date.now());
    this.digestHex = opts.digestHex;
  }

  /** Rebuild the usage index from the stored records. */
  async init(): Promise<void> {
    this.sizes.clear();
    for (const m of await this.store.list()) {
      this.sizes.set(
        swapKeyId({ uid: m.key[0], osSession: m.key[1], pid: m.key[2], pageId: m.key[3] }),
        HEADER_LEN + m.size,
      );
    }
  }

  private used(): number {
    let n = 0;
    for (const b of this.sizes.values()) n += b;
    return n;
  }

  private async verified(
    key: SwapRecordKey,
    gen: number,
    header: ArrayBuffer,
    sha256: string,
  ): Promise<boolean> {
    const r = await this.store.get(key);
    if (!r || r.gen !== gen || r.sha256 !== sha256 || !headersEqual(r.header, header)) return false;
    return (await this.digestHex(new Uint8Array(r.body))) === sha256;
  }

  async write(
    key: SwapKey,
    gen: number,
    header: ArrayBuffer,
    body: ArrayBuffer,
    sha256: string,
  ): Promise<SwapWriteResult> {
    const t0 = this.now();
    const id = swapKeyId(key);
    const size = HEADER_LEN + body.byteLength;
    if (this.used() - (this.sizes.get(id) ?? 0) + size > this.capBytes)
      return { ok: false, errno: 'EDQUOT', body };
    try {
      if (parseHeader(header).sha256 !== sha256) return { ok: false, errno: 'EIO', body };
    } catch {
      return { ok: false, errno: 'EIO', body };
    }
    const k = toKey(key);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        // The record is structured-cloned by put; `body` stays ours to hand back.
        await this.store.put(k, {
          gen,
          header,
          body,
          sha256,
          size: body.byteLength,
          createdAt: this.now(),
        });
        if (await this.verified(k, gen, header, sha256)) {
          this.sizes.set(id, size);
          return { ok: true, body, ms: this.now() - t0 };
        }
      }
      // A put replaces the previous generation, which was stale anyway (only dirty pages are
      // rewritten); an unverified record must not linger (INV-M5).
      await this.store.delete(k).catch(() => undefined);
      this.sizes.delete(id);
      return { ok: false, errno: 'EIO', body };
    } catch (e) {
      return { ok: false, errno: errName(e) === 'QuotaExceededError' ? 'EDQUOT' : 'EIO', body };
    }
  }

  async read(
    key: SwapKey,
    gen: number,
    sha256: string,
    onProgress?: ProgressFn,
  ): Promise<SwapReadResult> {
    const t0 = this.now();
    let r: SwapRecord | undefined;
    try {
      r = await this.store.get(toKey(key));
    } catch {
      return { ok: false, errno: 'EIO' };
    }
    if (!r || r.gen !== gen) return { ok: false, errno: 'ENOENT' };
    let headerSha: string;
    try {
      const ph = parseHeader(r.header);
      if (ph.bodyLen !== r.body.byteLength) return { ok: false, errno: 'EIO', reason: 'checksum' };
      headerSha = ph.sha256;
    } catch {
      return { ok: false, errno: 'EIO', reason: 'checksum' };
    }
    if (headerSha !== sha256 || (await this.digestHex(new Uint8Array(r.body))) !== sha256) {
      return { ok: false, errno: 'EIO', reason: 'checksum' };
    }
    onProgress?.(r.body.byteLength, r.body.byteLength);
    return { ok: true, body: r.body, header: r.header, ms: this.now() - t0 };
  }

  async delete(key: SwapKey, gens?: number[]): Promise<void> {
    const k = toKey(key);
    if (gens !== undefined) {
      const r = await this.store.get(k);
      if (!r || !gens.includes(r.gen)) return;
    }
    await this.store.delete(k);
    this.sizes.delete(swapKeyId(key));
  }

  async deleteSession(uid: number, osSession: string): Promise<void> {
    await this.store.deleteWhere((k) => k[0] === uid && k[1] === osSession);
    for (const id of [...this.sizes.keys()])
      if (id.startsWith(`${uid}/${osSession}/`)) this.sizes.delete(id);
  }

  async sweep(
    keep: Array<{ uid: number; osSession: string }>,
    olderThanMs: number,
  ): Promise<{ files: number; bytes: number }> {
    const kept = new Set(keep.map((k) => `${k.uid}/${k.osSession}`));
    const newest = new Map<string, number>();
    for (const m of await this.store.list()) {
      const s = `${m.key[0]}/${m.key[1]}`;
      newest.set(s, Math.max(newest.get(s) ?? 0, m.createdAt));
    }
    const cutoff = this.now() - olderThanMs;
    const drop = new Set(
      [...newest].filter(([s, t]) => !kept.has(s) && t < cutoff).map(([s]) => s),
    );
    const r =
      drop.size === 0
        ? { count: 0, bytes: 0 }
        : await this.store.deleteWhere((k) => drop.has(`${k[0]}/${k[1]}`));
    await this.init();
    return { files: r.count, bytes: r.bytes };
  }

  usage(): Promise<{ bytes: number; files: number }> {
    return Promise.resolve({ bytes: this.used(), files: this.sizes.size });
  }
}

// ---------------------------------------------------------------------------------------------
// The IndexedDB binding
// ---------------------------------------------------------------------------------------------

interface ErrorLike {
  readonly name: string;
  readonly message: string;
}

export interface IdbRequestLike<T> {
  readonly result: T;
  readonly error: ErrorLike | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

export interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: (() => void) | null;
}

export interface IdbCursorLike {
  readonly key: unknown;
  readonly value: unknown;
  continue(): void;
  delete(): IdbRequestLike<undefined>;
}

export interface IdbStoreLike {
  put(value: unknown, key?: unknown): IdbRequestLike<unknown>;
  get(key: unknown): IdbRequestLike<unknown>;
  delete(key: unknown): IdbRequestLike<undefined>;
  openCursor(): IdbRequestLike<IdbCursorLike | null>;
}

export interface IdbTransactionLike {
  objectStore(name: string): IdbStoreLike;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  readonly error: ErrorLike | null;
}

export interface IdbDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(
    names: string,
    mode: 'readonly' | 'readwrite',
    options?: { durability?: 'default' | 'strict' | 'relaxed' },
  ): IdbTransactionLike;
  close(): void;
}

/** The subset of IDBFactory used here; the worker passes `indexedDB`. */
export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike;
}

function isRecord(v: unknown): v is SwapRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.gen === 'number' &&
    r.header instanceof ArrayBuffer &&
    r.body instanceof ArrayBuffer &&
    typeof r.sha256 === 'string'
  );
}

function isKey(v: unknown): v is SwapRecordKey {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'string' &&
    typeof v[2] === 'number' &&
    typeof v[3] === 'number'
  );
}

function done(t: IdbTransactionLike): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(asError(t.error, 'IndexedDB transaction error'));
    t.onabort = () => reject(asError(t.error, 'IndexedDB transaction aborted'));
  });
}

/** Open (and on first use create) the `plotinium-swap` database. */
export function openIdbSwapStore(
  factory: IdbFactoryLike,
  name = SWAP_DB_NAME,
): Promise<SwapRecordStore> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, SWAP_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SWAP_STORE)) db.createObjectStore(SWAP_STORE);
    };
    req.onerror = () => reject(asError(req.error, 'cannot open plotinium-swap'));
    req.onsuccess = () => resolve(bindStore(req.result));
  });
}

function bindStore(db: IdbDatabaseLike): SwapRecordStore {
  return {
    put(key, rec) {
      const t = db.transaction(SWAP_STORE, 'readwrite', { durability: 'relaxed' });
      const finished = done(t);
      t.objectStore(SWAP_STORE).put(rec, key);
      return finished;
    },
    get(key) {
      const t = db.transaction(SWAP_STORE, 'readonly');
      const req = t.objectStore(SWAP_STORE).get(key);
      return done(t).then(() => (isRecord(req.result) ? req.result : undefined));
    },
    delete(key) {
      const t = db.transaction(SWAP_STORE, 'readwrite', { durability: 'relaxed' });
      const finished = done(t);
      t.objectStore(SWAP_STORE).delete(key);
      return finished;
    },
    list() {
      const t = db.transaction(SWAP_STORE, 'readonly');
      const out: SwapRecordMeta[] = [];
      const req = t.objectStore(SWAP_STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (isKey(c.key) && isRecord(c.value))
          out.push({
            key: c.key,
            gen: c.value.gen,
            size: c.value.body.byteLength,
            createdAt: c.value.createdAt,
          });
        c.continue();
      };
      return done(t).then(() => out);
    },
    deleteWhere(match) {
      const t = db.transaction(SWAP_STORE, 'readwrite', { durability: 'relaxed' });
      let count = 0;
      let bytes = 0;
      const req = t.objectStore(SWAP_STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (isKey(c.key) && match(c.key)) {
          count++;
          bytes += HEADER_LEN + (isRecord(c.value) ? c.value.body.byteLength : 0);
          c.delete();
        }
        c.continue();
      };
      return done(t).then(() => ({ count, bytes }));
    },
  };
}
