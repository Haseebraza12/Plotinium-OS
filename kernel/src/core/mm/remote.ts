/**
 * Tier-2 remote swap client over HTTPS (specs/03-kernel/memory-and-paging.md §3.11, §4.5;
 * server side: specs/11-server/backend-api.md §3.11, MEM-04, MEM-05).
 *
 * Runs in the kernel worker. Thread-agnostic: `fetch`, gzip (CompressionStream) and gunzip
 * (DecompressionStream) are injected by the host (kernel/src/blkio/compress.ts provides them), so
 * the client is unit-tested in Node with a fake server.
 *
 * Wire (backend-api.md is authoritative for the server; see integration notes for the header
 * reconciliation with memory-and-paging.md §4.5):
 *   PUT    /api/swap/{osSession}/{pid}/{pageId}?gen=g   body: gzip(page file)
 *          X-Plotinium-Checksum: hex SHA-256 of the UNCOMPRESSED page file (header + body)
 *          X-Plotinium-Raw-Size: uncompressed bytes · X-Plotinium-Encoding: gzip
 *          X-Plotinium-Gen: g
 *          → 200/201 {checksum | sha256}: `ok` only when the returned hash matches (INV-M6)
 *   GET    same path → gzip stream; decompressed, split, then the body is verified against the PTE
 *   DELETE /api/swap/{osSession}[/{pid}/{pageId}] → 204 (403 and 404 ignored)
 */
import { splitPageFile, verifyPage } from './codec.ts';
import { sha256Hex } from './codec.ts';
import type { ProgressFn, RemoteGetResult, RemotePutResult, RemoteSwap, SwapKey } from './swap.ts';

export const SWAP_HEADERS = Object.freeze({
  checksum: 'X-Plotinium-Checksum',
  rawSize: 'X-Plotinium-Raw-Size',
  encoding: 'X-Plotinium-Encoding',
  gen: 'X-Plotinium-Gen',
});

/** A stream of bytes backed by plain ArrayBuffers (what fetch and the Compression Streams produce). */
export type ByteStream = ReadableStream<Uint8Array<ArrayBuffer>>;

export interface HttpResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body: ByteStream | null;
  json(): Promise<unknown>;
}

export interface HttpRequestInit {
  method: 'GET' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: ArrayBuffer;
  credentials?: 'same-origin' | 'include';
}

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

export interface GzipCodec {
  gzip(bytes: ArrayBuffer): Promise<ArrayBuffer>;
  gunzip(stream: ByteStream): ByteStream;
}

/** Hex SHA-256; the host passes a crypto.subtle version, the default is the synchronous one. */
export type DigestHex = (bytes: ArrayBuffer) => Promise<string>;

export interface HttpRemoteSwapOptions {
  fetch: FetchLike;
  gzip: GzipCodec;
  baseUrl?: string;
  digestHex?: DigestHex;
}

function retryAfter(res: HttpResponseLike, body: unknown): number | undefined {
  if (body !== null && typeof body === 'object' && 'retryAfterMs' in body) {
    const v = body.retryAfterMs;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  const h = res.headers.get('Retry-After');
  const s = h === null ? Number.NaN : Number(h);
  return Number.isFinite(s) ? s * 1_000 : undefined;
}

function returnedHash(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  const v = rec.checksum ?? rec.sha256;
  return typeof v === 'string' ? v.toLowerCase() : undefined;
}

async function readAll(
  stream: ByteStream,
  total: number,
  onProgress?: ProgressFn,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    done += r.value.byteLength;
    onProgress?.(done, Math.max(total, done));
  }
  const out = new Uint8Array(done);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

export class HttpRemoteSwap implements RemoteSwap {
  private readonly fetch: FetchLike;
  private readonly gzip: GzipCodec;
  private readonly base: string;
  private readonly digestHex: DigestHex;

  constructor(opts: HttpRemoteSwapOptions) {
    this.fetch = opts.fetch;
    this.gzip = opts.gzip;
    this.base = (opts.baseUrl ?? '/api/swap').replace(/\/$/, '');
    this.digestHex = opts.digestHex ?? ((b) => Promise.resolve(sha256Hex(b)));
  }

  pageUrl(key: SwapKey): string {
    return `${this.base}/${encodeURIComponent(key.osSession)}/${key.pid}/${key.pageId}`;
  }

  async put(
    key: SwapKey,
    gen: number,
    pageFile: ArrayBuffer,
    _sha256: string,
  ): Promise<RemotePutResult> {
    const fileSha = await this.digestHex(pageFile);
    const gz = await this.gzip.gzip(pageFile);
    const res = await this.fetch(`${this.pageUrl(key)}?gen=${gen}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/octet-stream',
        [SWAP_HEADERS.checksum]: fileSha,
        [SWAP_HEADERS.rawSize]: String(pageFile.byteLength),
        [SWAP_HEADERS.encoding]: 'gzip',
        [SWAP_HEADERS.gen]: String(gen),
      },
      body: gz,
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status === 200 || res.status === 201) {
      // INV-M6: acknowledged only when the server hashed the same uncompressed bytes.
      const ok = returnedHash(body) === fileSha;
      return { ok, status: ok ? res.status : 422 };
    }
    const after = retryAfter(res, body);
    return after === undefined
      ? { ok: false, status: res.status }
      : { ok: false, status: res.status, retryAfterMs: after };
  }

  async get(
    key: SwapKey,
    gen: number,
    sha256: string,
    onProgress?: ProgressFn,
  ): Promise<RemoteGetResult> {
    let res: HttpResponseLike;
    try {
      res = await this.fetch(`${this.pageUrl(key)}?gen=${gen}`, {
        method: 'GET',
        credentials: 'same-origin',
      });
    } catch {
      return { ok: false, errno: 'EIO' };
    }
    if (res.status === 403 || res.status === 401) return { ok: false, errno: 'EACCES' };
    if (res.status === 404) return { ok: false, errno: 'ENOENT' };
    if (!res.ok || res.body === null) return { ok: false, errno: 'EIO' };
    const total = Number(res.headers.get(SWAP_HEADERS.rawSize) ?? '0') || 0;
    const encoding = (res.headers.get(SWAP_HEADERS.encoding) ?? 'gzip').toLowerCase();
    const stream = encoding === 'identity' ? res.body : this.gzip.gunzip(res.body);
    try {
      const file = await readAll(stream, total, onProgress);
      const { header, body } = splitPageFile(file);
      verifyPage(header, body, sha256);
      return { ok: true, header, body };
    } catch {
      // A short file or a checksum mismatch (MmError EIO) is an I/O error for the fault.
      return { ok: false, errno: 'EIO' };
    }
  }

  async delete(key: SwapKey): Promise<void> {
    await this.fetch(this.pageUrl(key), { method: 'DELETE', credentials: 'same-origin' }).catch(
      () => undefined,
    );
  }

  async deleteSession(osSession: string): Promise<void> {
    await this.fetch(`${this.base}/${encodeURIComponent(osSession)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    }).catch(() => undefined);
  }
}
