/**
 * Tier-1 swap on the origin private file system (specs/03-kernel/memory-and-paging.md §3.10.1,
 * KMM-08, MEM-03). Runs in the blkio worker: `FileSystemSyncAccessHandle` exists only in
 * dedicated workers.
 *
 * Layout:  /swap/u<uid>/<osSessionId>/<pid>/p<pageId>-g<gen>.pg   (verified page: header + body)
 *                                          /p<pageId>-g<gen>.tmp  (only during a write)
 *
 * Write: `.tmp` → truncate, write header at 0 and body at 64, flush → read back into a fresh
 * buffer → close (a sync access handle holds an exclusive lock) → compare the 64 header bytes and
 * verify the read-back SHA-256 → rename to the generation's final name → delete the previous
 * generation. A mismatch rewrites once; a second one is EIO. The final name carries the
 * generation, so `move()` never overwrites an existing file. A crash between steps leaves at worst
 * a `.tmp` file or two generations, which the boot sweep repairs.
 *
 * Pipelining (§3.9.3): the source hash was computed once by the executor; blkio's synchronous work
 * per page is write, flush, read back; the read-back digest is an asynchronous `crypto.subtle`
 * call that overlaps with the next page's write, and results are acknowledged in submission order.
 *
 * Written against minimal structural interfaces of the File System API, so the unit tests run it
 * on an in-memory fake; the worker entry passes `navigator.storage.getDirectory()`.
 */
import { HEADER_LEN, headersEqual, parseHeader } from '../core/mm/codec.ts';
import { pageFileName, parsePageFileName, swapKeyId, tmpFileName } from '../core/mm/swap.ts';
import type {
  ProgressFn,
  SwapDevice,
  SwapKey,
  SwapReadResult,
  SwapWriteResult,
} from '../core/mm/swap.ts';

/** The subset of FileSystemSyncAccessHandle that blkio uses. */
export interface SyncAccessHandleLike {
  read(buffer: Uint8Array<ArrayBuffer>, options?: { at?: number }): number;
  write(buffer: Uint8Array<ArrayBuffer>, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

/** The subset of FileSystemFileHandle that blkio uses (`move` is the OPFS rename). */
export interface FileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  createSyncAccessHandle(): Promise<SyncAccessHandleLike>;
  getFile(): Promise<{ size: number; lastModified: number }>;
  move(newName: string): Promise<void>;
}

/** The subset of FileSystemDirectoryHandle that blkio uses. */
export interface DirHandleLike {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, FileHandleLike | DirHandleLike]>;
}

export type AsyncDigestHex = (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;

export interface OpfsSwapOptions {
  /** LOCAL_SWAP_CAP; a write beyond it answers EDQUOT. */
  capBytes?: number;
  now?: () => number;
  digestHex: AsyncDigestHex;
  /** Progress granularity of reads (256 KiB). */
  progressStep?: number;
}

const ROOT = 'swap';

function errName(e: unknown): string {
  return typeof e === 'object' && e !== null && 'name' in e ? String(e.name) : '';
}

const ignoreNotFound = (e: unknown): void => {
  if (errName(e) !== 'NotFoundError') throw e;
};

export class OpfsSwapDevice implements SwapDevice {
  readonly kind = 'opfs' as const;
  private readonly root: DirHandleLike;
  private readonly capBytes: number;
  private readonly now: () => number;
  private readonly digestHex: AsyncDigestHex;
  private readonly step: number;
  /** keyId → generation → stored bytes (header + body). */
  private readonly index = new Map<string, { key: SwapKey; gens: Map<number, number> }>();
  private ackChain: Promise<unknown> = Promise.resolve();

  constructor(root: DirHandleLike, opts: OpfsSwapOptions) {
    this.root = root;
    this.capBytes = opts.capBytes ?? Number.POSITIVE_INFINITY;
    this.now = opts.now ?? (() => Date.now());
    this.digestHex = opts.digestHex;
    this.step = opts.progressStep ?? 256 * 1024;
  }

  /** Scan the swap tree to rebuild the usage index (the `mm` service start, before the sweep). */
  async init(): Promise<void> {
    this.index.clear();
    await this.walk(async (key, name, file) => {
      const parsed = parsePageFileName(name);
      if (!parsed || parsed.tmp) return;
      const f = await file.getFile();
      this.remember({ ...key, pageId: parsed.pageId }, parsed.gen, f.size);
    });
  }

  private remember(key: SwapKey, gen: number, bytes: number): void {
    const id = swapKeyId(key);
    const e = this.index.get(id) ?? { key: { ...key }, gens: new Map<number, number>() };
    e.gens.set(gen, bytes);
    this.index.set(id, e);
  }

  private usedBytes(): number {
    let n = 0;
    for (const e of this.index.values()) for (const b of e.gens.values()) n += b;
    return n;
  }

  private async pidDir(
    key: { uid: number; osSession: string; pid: number },
    create: boolean,
  ): Promise<DirHandleLike> {
    const swap = await this.root.getDirectoryHandle(ROOT, { create });
    const user = await swap.getDirectoryHandle(`u${key.uid}`, { create });
    const session = await user.getDirectoryHandle(key.osSession, { create });
    return session.getDirectoryHandle(String(key.pid), { create });
  }

  write(
    key: SwapKey,
    gen: number,
    header: ArrayBuffer,
    body: ArrayBuffer,
    sha256: string,
  ): Promise<SwapWriteResult> {
    const run = this.doWrite(key, gen, header, body, sha256);
    // Acknowledge in submission order while the digests overlap (§3.9.3).
    const acked = this.ackChain.then(() => run);
    this.ackChain = acked.catch(() => undefined);
    return acked;
  }

  private async doWrite(
    key: SwapKey,
    gen: number,
    header: ArrayBuffer,
    body: ArrayBuffer,
    sha256: string,
  ): Promise<SwapWriteResult> {
    const t0 = this.now();
    const size = HEADER_LEN + body.byteLength;
    const old = this.index.get(swapKeyId(key));
    const replaced = old ? [...old.gens.values()].reduce((a, b) => a + b, 0) : 0;
    if (this.usedBytes() - replaced + size > this.capBytes)
      return { ok: false, errno: 'EDQUOT', body };
    let headerSha: string;
    try {
      headerSha = parseHeader(header).sha256;
    } catch {
      return { ok: false, errno: 'EIO', body };
    }
    try {
      const dir = await this.pidDir(key, true);
      for (let attempt = 0; attempt < 2; attempt++) {
        const tmp = tmpFileName(key.pageId, gen);
        const fh = await dir.getFileHandle(tmp, { create: true });
        const h = await fh.createSyncAccessHandle();
        const readBack = new Uint8Array(size);
        try {
          h.truncate(0);
          h.write(new Uint8Array(header), { at: 0 });
          h.write(new Uint8Array(body), { at: HEADER_LEN });
          h.flush();
          h.read(readBack, { at: 0 });
        } finally {
          h.close();
        }
        const okHeader =
          headerSha === sha256 && headersEqual(readBack.subarray(0, HEADER_LEN), header);
        const digest = await this.digestHex(readBack.subarray(HEADER_LEN));
        if (okHeader && digest === sha256) {
          await fh.move(pageFileName(key.pageId, gen));
          for (const g of old ? [...old.gens.keys()] : []) {
            if (g === gen) continue;
            await dir.removeEntry(pageFileName(key.pageId, g)).catch(ignoreNotFound);
            old?.gens.delete(g);
          }
          this.remember(key, gen, size);
          return { ok: true, body, ms: this.now() - t0 };
        }
        await dir.removeEntry(tmp).catch(ignoreNotFound);
      }
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
    let fh: FileHandleLike;
    try {
      const dir = await this.pidDir(key, false);
      fh = await dir.getFileHandle(pageFileName(key.pageId, gen));
    } catch (e) {
      return {
        ok: false,
        errno:
          errName(e) === 'NotFoundError' || errName(e) === 'TypeMismatchError' ? 'ENOENT' : 'EIO',
      };
    }
    let header: Uint8Array<ArrayBuffer>;
    let body: Uint8Array<ArrayBuffer>;
    try {
      const h = await fh.createSyncAccessHandle();
      try {
        header = new Uint8Array(HEADER_LEN);
        h.read(header, { at: 0 });
        let bodyLen: number;
        try {
          const ph = parseHeader(header);
          if (ph.sha256 !== sha256) return { ok: false, errno: 'EIO', reason: 'checksum' };
          bodyLen = ph.bodyLen;
        } catch {
          return { ok: false, errno: 'EIO', reason: 'checksum' };
        }
        if (h.getSize() !== HEADER_LEN + bodyLen)
          return { ok: false, errno: 'EIO', reason: 'checksum' };
        body = new Uint8Array(bodyLen);
        for (let off = 0; off < bodyLen; off += this.step) {
          const n = Math.min(this.step, bodyLen - off);
          h.read(body.subarray(off, off + n), { at: HEADER_LEN + off });
          onProgress?.(off + n, bodyLen);
        }
        if (bodyLen === 0) onProgress?.(0, 0);
      } finally {
        h.close();
      }
    } catch {
      return { ok: false, errno: 'EIO' };
    }
    if ((await this.digestHex(body)) !== sha256)
      return { ok: false, errno: 'EIO', reason: 'checksum' };
    return { ok: true, body: body.buffer, header: header.buffer, ms: this.now() - t0 };
  }

  async delete(key: SwapKey, gens?: number[]): Promise<void> {
    const id = swapKeyId(key);
    const e = this.index.get(id);
    const targets = gens ?? (e ? [...e.gens.keys()] : []);
    let dir: DirHandleLike;
    try {
      dir = await this.pidDir(key, false);
    } catch {
      this.index.delete(id);
      return;
    }
    for (const g of targets) {
      await dir.removeEntry(pageFileName(key.pageId, g)).catch(ignoreNotFound);
      e?.gens.delete(g);
    }
    if (!e || e.gens.size === 0) this.index.delete(id);
  }

  async deleteSession(uid: number, osSession: string): Promise<void> {
    try {
      const swap = await this.root.getDirectoryHandle(ROOT);
      const user = await swap.getDirectoryHandle(`u${uid}`);
      await user.removeEntry(osSession, { recursive: true });
    } catch (e) {
      ignoreNotFound(e);
    }
    for (const [id, e] of this.index)
      if (e.key.uid === uid && e.key.osSession === osSession) this.index.delete(id);
  }

  /** Visit every file below /swap/u<uid>/<session>/<pid>/. */
  private async walk(
    visit: (
      key: { uid: number; osSession: string; pid: number },
      name: string,
      file: FileHandleLike,
      dir: DirHandleLike,
    ) => Promise<void>,
  ): Promise<void> {
    let swap: DirHandleLike;
    try {
      swap = await this.root.getDirectoryHandle(ROOT);
    } catch {
      return;
    }
    for await (const [uName, uDir] of swap.entries()) {
      if (uDir.kind !== 'directory' || !/^u\d+$/.test(uName)) continue;
      const uid = Number(uName.slice(1));
      for await (const [session, sDir] of uDir.entries()) {
        if (sDir.kind !== 'directory') continue;
        for await (const [pidName, pDir] of sDir.entries()) {
          if (pDir.kind !== 'directory' || !/^\d+$/.test(pidName)) continue;
          for await (const [name, f] of pDir.entries()) {
            if (f.kind === 'file')
              await visit({ uid, osSession: session, pid: Number(pidName) }, name, f, pDir);
          }
        }
      }
    }
  }

  async sweep(
    keep: Array<{ uid: number; osSession: string }>,
    olderThanMs: number,
  ): Promise<{ files: number; bytes: number }> {
    const kept = new Set(keep.map((k) => `${k.uid}/${k.osSession}`));
    const files: Array<{
      key: { uid: number; osSession: string; pid: number };
      name: string;
      size: number;
      mtime: number;
      dir: DirHandleLike;
    }> = [];
    await this.walk(async (key, name, file, dir) => {
      const f = await file.getFile();
      files.push({ key, name, size: f.size, mtime: f.lastModified, dir });
    });
    const newest = new Map<string, number>();
    const top = new Map<string, number>();
    for (const f of files) {
      const s = `${f.key.uid}/${f.key.osSession}`;
      newest.set(s, Math.max(newest.get(s) ?? 0, f.mtime));
      const p = parsePageFileName(f.name);
      if (p && !p.tmp) {
        const k = `${s}/${f.key.pid}/${p.pageId}`;
        top.set(k, Math.max(top.get(k) ?? -1, p.gen));
      }
    }
    const cutoff = this.now() - olderThanMs;
    let count = 0;
    let bytes = 0;
    const dropSessions = new Set<string>();
    for (const [s, t] of newest) if (!kept.has(s) && t < cutoff) dropSessions.add(s);
    for (const f of files) {
      const s = `${f.key.uid}/${f.key.osSession}`;
      const p = parsePageFileName(f.name);
      const stale = p !== undefined && !p.tmp && top.get(`${s}/${f.key.pid}/${p.pageId}`) !== p.gen;
      if (dropSessions.has(s) || p === undefined || p.tmp || stale) {
        await f.dir.removeEntry(f.name).catch(ignoreNotFound);
        count++;
        bytes += f.size;
      }
    }
    // Remove the emptied session directories.
    if (dropSessions.size > 0) {
      const swap = await this.root.getDirectoryHandle(ROOT);
      for (const s of dropSessions) {
        const [u, session] = s.split('/');
        const user = await swap.getDirectoryHandle(`u${u ?? ''}`).catch(() => null);
        await user?.removeEntry(session ?? '', { recursive: true }).catch(ignoreNotFound);
      }
    }
    await this.init();
    return { files: count, bytes };
  }

  usage(): Promise<{ bytes: number; files: number }> {
    let files = 0;
    for (const e of this.index.values()) files += e.gens.size;
    return Promise.resolve({ bytes: this.usedBytes(), files });
  }
}
