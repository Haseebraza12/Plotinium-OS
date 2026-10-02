/**
 * Swap devices (specs/03-kernel/memory-and-paging.md §4.4, §3.10, §3.11).
 *
 * Tier 1 is a `SwapDevice`: the OPFS or IndexedDB back end in the blkio worker (reached through
 * kernel/src/blkio/client.ts), or `MemorySwapDevice` below for the Node loopback host and unit
 * tests. Tier 2 is a `RemoteSwap` (./remote.ts, fetch to /api/swap). Both are interfaces, so this
 * folder stays thread-agnostic (no browser API here).
 *
 * Plotinium design: `read` also returns the 64-byte header (the write-behind queue re-uploads the
 * whole page file from tier 1, §3.11 step 2).
 */
import { HEADER_LEN, headersEqual, parseHeader, sha256Hex } from './codec.ts';
import type { Digest } from './codec.ts';

export interface SwapKey {
  uid: number;
  osSession: string;
  pid: number;
  pageId: number;
}

export type SwapDeviceKind = 'opfs' | 'idb' | 'memory';

export type SwapWriteResult =
  | { ok: true; body: ArrayBuffer; ms: number }
  | { ok: false; errno: 'EIO' | 'EDQUOT'; body: ArrayBuffer };

export type SwapReadResult =
  | { ok: true; body: ArrayBuffer; header: ArrayBuffer; ms: number }
  | { ok: false; errno: 'EIO' | 'ENOENT'; reason?: 'checksum' };

export type ProgressFn = (done: number, total: number) => void;

export interface SwapDevice {
  readonly kind: SwapDeviceKind;
  /**
   * Write generation `gen` of a page: write, flush, read back, verify the SHA-256, then make it the
   * current copy. The body is always handed back (it was transferred in).
   */
  write(
    key: SwapKey,
    gen: number,
    header: ArrayBuffer,
    body: ArrayBuffer,
    sha256: string,
  ): Promise<SwapWriteResult>;
  /** Read and verify generation `gen`; `onProgress` gets real byte counts. */
  read(key: SwapKey, gen: number, sha256: string, onProgress?: ProgressFn): Promise<SwapReadResult>;
  /** Delete every generation of a page, or only the listed ones. */
  delete(key: SwapKey, gens?: number[]): Promise<void>;
  deleteSession(uid: number, osSession: string): Promise<void>;
  /**
   * Boot sweep (§3.10.3): delete `.tmp` files, keep only the highest generation of each page, and
   * delete sessions not in `keep` whose newest file is older than `olderThanMs`.
   */
  sweep(
    keep: Array<{ uid: number; osSession: string }>,
    olderThanMs: number,
  ): Promise<{ files: number; bytes: number }>;
  usage(): Promise<{ bytes: number; files: number }>;
}

export type RemoteGetResult =
  | { ok: true; body: ArrayBuffer; header: ArrayBuffer }
  | { ok: false; errno: 'EIO' | 'EACCES' | 'ENOENT' };

export interface RemotePutResult {
  ok: boolean;
  status: number;
  /** Milliseconds the server asked us to wait (HTTP 429). */
  retryAfterMs?: number;
}

export interface RemoteSwap {
  /** Upload a whole page file (header + body); `sha256` is the body hash of the PTE. */
  put(key: SwapKey, gen: number, pageFile: ArrayBuffer, sha256: string): Promise<RemotePutResult>;
  get(key: SwapKey, gen: number, sha256: string, onProgress?: ProgressFn): Promise<RemoteGetResult>;
  delete(key: SwapKey): Promise<void>;
  deleteSession(osSession: string): Promise<void>;
}

/** Stable string form of a swap key, used as a map key. */
export function swapKeyId(key: SwapKey): string {
  return `${key.uid}/${key.osSession}/${key.pid}/${key.pageId}`;
}

/** Tier-1 OPFS file name of a verified page (§3.10.1). */
export function pageFileName(pageId: number, gen: number): string {
  return `p${pageId}-g${gen}.pg`;
}

/** Tier-1 OPFS temporary file name during a write (§3.10.1). */
export function tmpFileName(pageId: number, gen: number): string {
  return `p${pageId}-g${gen}.tmp`;
}

/** Parse a tier-1 file name; undefined for names that are not ours. */
export function parsePageFileName(
  name: string,
): { pageId: number; gen: number; tmp: boolean } | undefined {
  const m = /^p(\d+)-g(\d+)\.(pg|tmp)$/.exec(name);
  if (!m) return undefined;
  return { pageId: Number(m[1]), gen: Number(m[2]), tmp: m[3] === 'tmp' };
}

// ---------------------------------------------------------------------------------------------
// In-memory device (Node loopback host and unit tests)
// ---------------------------------------------------------------------------------------------

interface MemRecord {
  gen: number;
  header: ArrayBuffer;
  body: ArrayBuffer;
  sha256: string;
  createdAt: number;
}

export interface MemorySwapOptions {
  /** Capacity in bytes (LOCAL_SWAP_CAP); a write beyond it answers EDQUOT. */
  capBytes?: number;
  now?: () => number;
  digest?: Digest;
}

/**
 * A SwapDevice kept in a Map, with the same verify-before-ack contract as the blkio back ends
 * and fault injection for the MEM-03 tests. Bytes are copied in and out, so a caller can never
 * alias the stored copy.
 */
export class MemorySwapDevice implements SwapDevice {
  readonly kind = 'memory' as const;
  private readonly pages = new Map<string, { key: SwapKey; gens: Map<number, MemRecord> }>();
  private readonly capBytes: number;
  private readonly now: () => number;
  private readonly digest: Digest | undefined;
  private corruptWrites = 0;
  private failWrites: { n: number; errno: 'EIO' | 'EDQUOT' } = { n: 0, errno: 'EIO' };
  /** Number of successful writes and reads, for the "dropped without any write" tests. */
  writes = 0;
  reads = 0;

  constructor(opts: MemorySwapOptions = {}) {
    this.capBytes = opts.capBytes ?? Number.POSITIVE_INFINITY;
    this.now = opts.now ?? (() => 0);
    this.digest = opts.digest;
  }

  /** The next `n` writes read back corrupted bytes (verify fails; each write retries once). */
  corruptNextReadBacks(n: number): void {
    this.corruptWrites = n;
  }

  /** The next `n` writes fail outright with `errno`. */
  failNextWrites(n: number, errno: 'EIO' | 'EDQUOT' = 'EIO'): void {
    this.failWrites = { n, errno };
  }

  /** Flip one byte of a stored body (bit rot); a later read reports EIO `checksum`. */
  corruptStored(key: SwapKey, gen: number): boolean {
    const rec = this.pages.get(swapKeyId(key))?.gens.get(gen);
    if (!rec || rec.body.byteLength === 0) return false;
    const u8 = new Uint8Array(rec.body);
    u8[0] = (u8[0] ?? 0) ^ 0xff;
    return true;
  }

  has(key: SwapKey, gen: number): boolean {
    return this.pages.get(swapKeyId(key))?.gens.has(gen) ?? false;
  }

  private usedBytes(): number {
    let n = 0;
    for (const p of this.pages.values())
      for (const r of p.gens.values()) n += HEADER_LEN + r.body.byteLength;
    return n;
  }

  write(
    key: SwapKey,
    gen: number,
    header: ArrayBuffer,
    body: ArrayBuffer,
    sha256: string,
  ): Promise<SwapWriteResult> {
    const t0 = this.now();
    if (this.failWrites.n > 0) {
      this.failWrites.n--;
      return Promise.resolve({ ok: false, errno: this.failWrites.errno, body });
    }
    const id = swapKeyId(key);
    const entry = this.pages.get(id);
    const replaced = entry
      ? [...entry.gens.values()].reduce((s, r) => s + HEADER_LEN + r.body.byteLength, 0)
      : 0;
    if (this.usedBytes() - replaced + HEADER_LEN + body.byteLength > this.capBytes) {
      return Promise.resolve({ ok: false, errno: 'EDQUOT', body });
    }
    // Write, read back, verify; rewrite once on a mismatch; a second mismatch is EIO (§3.10.1).
    for (let attempt = 0; attempt < 2; attempt++) {
      const stored = body.slice(0);
      const storedHeader = header.slice(0);
      const readBack = stored.slice(0);
      if (this.corruptWrites > 0) {
        this.corruptWrites--;
        const u8 = new Uint8Array(readBack.byteLength > 0 ? readBack : storedHeader);
        const at = readBack.byteLength > 0 ? 0 : 40;
        u8[at] = (u8[at] ?? 0) ^ 0xff;
      }
      const okHeader =
        headersEqual(storedHeader, header) && parseHeader(storedHeader).sha256 === sha256;
      if (okHeader && sha256Hex(readBack, this.digest) === sha256) {
        const target = entry ?? { key: { ...key }, gens: new Map<number, MemRecord>() };
        target.gens.clear(); // the previous generation is deleted once the new one is verified
        target.gens.set(gen, {
          gen,
          header: storedHeader,
          body: stored,
          sha256,
          createdAt: this.now(),
        });
        this.pages.set(id, target);
        this.writes++;
        return Promise.resolve({ ok: true, body, ms: this.now() - t0 });
      }
    }
    return Promise.resolve({ ok: false, errno: 'EIO', body });
  }

  read(
    key: SwapKey,
    gen: number,
    sha256: string,
    onProgress?: ProgressFn,
  ): Promise<SwapReadResult> {
    const t0 = this.now();
    const rec = this.pages.get(swapKeyId(key))?.gens.get(gen);
    if (!rec) return Promise.resolve({ ok: false, errno: 'ENOENT' });
    const total = rec.body.byteLength;
    const step = 256 * 1024;
    for (let done = Math.min(step, total); ; done = Math.min(done + step, total)) {
      onProgress?.(done, total);
      if (done >= total) break;
    }
    const body = rec.body.slice(0);
    if (rec.sha256 !== sha256 || sha256Hex(body, this.digest) !== sha256) {
      return Promise.resolve({ ok: false, errno: 'EIO', reason: 'checksum' });
    }
    this.reads++;
    return Promise.resolve({ ok: true, body, header: rec.header.slice(0), ms: this.now() - t0 });
  }

  delete(key: SwapKey, gens?: number[]): Promise<void> {
    const id = swapKeyId(key);
    const entry = this.pages.get(id);
    if (!entry) return Promise.resolve();
    if (gens === undefined) this.pages.delete(id);
    else {
      for (const g of gens) entry.gens.delete(g);
      if (entry.gens.size === 0) this.pages.delete(id);
    }
    return Promise.resolve();
  }

  deleteSession(uid: number, osSession: string): Promise<void> {
    for (const [id, p] of this.pages) {
      if (p.key.uid === uid && p.key.osSession === osSession) this.pages.delete(id);
    }
    return Promise.resolve();
  }

  sweep(
    keep: Array<{ uid: number; osSession: string }>,
    olderThanMs: number,
  ): Promise<{ files: number; bytes: number }> {
    const kept = new Set(keep.map((k) => `${k.uid}/${k.osSession}`));
    const newest = new Map<string, number>();
    for (const p of this.pages.values()) {
      const s = `${p.key.uid}/${p.key.osSession}`;
      for (const r of p.gens.values()) newest.set(s, Math.max(newest.get(s) ?? 0, r.createdAt));
    }
    let files = 0;
    let bytes = 0;
    const cutoff = this.now() - olderThanMs;
    for (const [id, p] of this.pages) {
      const s = `${p.key.uid}/${p.key.osSession}`;
      const drop = !kept.has(s) && (newest.get(s) ?? 0) < cutoff;
      const top = Math.max(...p.gens.keys());
      for (const [g, r] of p.gens) {
        if (drop || g !== top) {
          p.gens.delete(g);
          files++;
          bytes += HEADER_LEN + r.body.byteLength;
        }
      }
      if (p.gens.size === 0) this.pages.delete(id);
    }
    return Promise.resolve({ files, bytes });
  }

  usage(): Promise<{ bytes: number; files: number }> {
    let files = 0;
    for (const p of this.pages.values()) files += p.gens.size;
    return Promise.resolve({ bytes: this.usedBytes(), files });
  }
}
