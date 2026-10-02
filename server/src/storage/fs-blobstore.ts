/**
 * FsBlobStore: our own content-addressed store on the `blobs` Docker volume.
 *
 * Spec: specs/11-server/backend-api.md §3.10 (SRV-10, INV-SRV-4); database.md §3.18-§3.19; C9.
 * Primary owner R1, secondary reviewer R2.
 *
 * Layout under BLOB_DIR (one file system, so rename is atomic):
 *   blobs/sha256/<2 hex>/<2 hex>/<sha256>            content, mode 0440, immutable
 *   swap/<owner_uid>/<os_session_id>/<pid>/<page_id>   compressed swap page, mode 0640, replaced atomically
 *   tmp/<uuidv7>.part                                  uploads in progress, mode 0600
 *
 * put(): open tmp with O_CREAT|O_EXCL (0600); stream the body through a byte limiter and a SHA-256
 * tee into the file, chunk by chunk, so a 5 MB upload never sits in memory; fsync; size mismatch -> EINVAL, hash mismatch -> EIO
 * 'checksum', nothing kept; content key whose file exists -> discard tmp, `existed: true`;
 * otherwise mkdir -p (0750), rename (atomic), fsync the parent directory.
 * A crash at any step leaves either no final file or a complete one; tmp leftovers older than one
 * hour are removed by sweepTmp() (the hourly GC).
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat, statfs, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';

import { ErrnoError } from '../errno.ts';
import { uuidv7 } from '../util/uuidv7.ts';
import {
  blobKeyPath,
  SHA256_HEX_RE,
  type BlobKey,
  type BlobPutExpect,
  type BlobPutResult,
  type BlobStore,
} from './blobstore.ts';

const CONTENT_MODE = 0o440;
const SWAP_MODE = 0o640;
const TMP_MODE = 0o600;
const DIR_MODE = 0o750;
export const TMP_MAX_AGE_MS = 60 * 60 * 1000;

function isCode(e: unknown, ...codes: string[]): boolean {
  return (
    typeof e === 'object' && e !== null && codes.includes(String((e as { code?: unknown }).code))
  );
}

export class FsBlobStore implements BlobStore {
  readonly root: string;
  readonly #tmpDir: string;

  constructor(root: string) {
    this.root = root;
    this.#tmpDir = join(root, 'tmp');
  }

  async put(key: BlobKey, body: Readable, expect: BlobPutExpect): Promise<BlobPutResult> {
    const rel = blobKeyPath(key);
    if (!Number.isSafeInteger(expect.size) || expect.size < 0) {
      throw new ErrnoError('EINVAL', { field: 'content-length' });
    }
    if (!Number.isSafeInteger(expect.maxBytes) || expect.size > expect.maxBytes) {
      throw new ErrnoError('EINVAL', { field: 'content-length' }, 'body exceeds the size limit');
    }
    if (expect.sha256 !== undefined && !SHA256_HEX_RE.test(expect.sha256)) {
      throw new ErrnoError('EINVAL', { field: 'sha256' });
    }
    if (key.kind === 'content' && expect.sha256 !== undefined && expect.sha256 !== key.sha256) {
      throw new ErrnoError('EINVAL', { field: 'sha256' }, 'expected hash differs from the key');
    }
    const wantSha = key.kind === 'content' ? key.sha256 : expect.sha256;

    await mkdir(this.#tmpDir, { recursive: true, mode: 0o700 });
    const tmp = join(this.#tmpDir, `${uuidv7()}.part`);
    const fh = await open(tmp, 'wx', TMP_MODE);
    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (!closed) {
        closed = true;
        await fh.close();
      }
    };
    try {
      const hash = createHash('sha256');
      let size = 0;
      // Hash and count while streaming; each chunk is written before the next is read, so
      // backpressure holds and a large upload never sits in memory.
      for await (const chunk of body as AsyncIterable<Buffer | string>) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        size += buf.length;
        if (size > expect.maxBytes) {
          throw new ErrnoError(
            'EINVAL',
            { field: 'content-length' },
            'body exceeds the size limit',
          );
        }
        hash.update(buf);
        await writeAll(fh, buf);
      }
      await fh.sync();
      await fh.chmod(key.kind === 'content' ? CONTENT_MODE : SWAP_MODE);
      await closeOnce();

      const sha256 = hash.digest('hex');
      if (size !== expect.size) {
        throw new ErrnoError('EINVAL', { field: 'content-length' }, 'body length differs');
      }
      if (wantSha !== undefined && sha256 !== wantSha) {
        throw new ErrnoError('EIO', { reason: 'checksum' }, 'SHA-256 of the body differs');
      }

      const finalPath = join(this.root, rel);
      if (key.kind === 'content' && (await this.#exists(finalPath))) {
        await rm(tmp, { force: true });
        return { size, sha256, existed: true };
      }
      await mkdir(dirname(finalPath), { recursive: true, mode: DIR_MODE });
      await rename(tmp, finalPath);
      await fsyncDir(dirname(finalPath));
      return { size, sha256, existed: false };
    } catch (e) {
      await closeOnce().catch(() => undefined);
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async get(key: BlobKey, range?: { start: number; end: number }): Promise<Readable> {
    const path = join(this.root, blobKeyPath(key));
    let fh: FileHandle;
    try {
      fh = await open(path, 'r');
    } catch (e) {
      if (isCode(e, 'ENOENT')) throw new ErrnoError('ENOENT');
      throw e;
    }
    try {
      const { size } = await fh.stat();
      if (range !== undefined) {
        const ok =
          Number.isSafeInteger(range.start) &&
          Number.isSafeInteger(range.end) &&
          range.start >= 0 &&
          range.end >= range.start &&
          range.end < size;
        if (!ok) throw new ErrnoError('EINVAL', { field: 'range' }, 'unsatisfiable range');
        return fh.createReadStream({ start: range.start, end: range.end });
      }
      return fh.createReadStream();
    } catch (e) {
      await fh.close();
      throw e;
    }
  }

  async head(key: BlobKey): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const st = await stat(join(this.root, blobKeyPath(key)));
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
    } catch (e) {
      if (isCode(e, 'ENOENT', 'ENOTDIR')) return null;
      throw e;
    }
  }

  async delete(key: BlobKey): Promise<void> {
    await rm(join(this.root, blobKeyPath(key)), { force: true });
  }

  /** Removes upload leftovers (`tmp/*.part`) older than `maxAgeMs`. Returns how many. */
  async sweepTmp(nowMs: number = Date.now(), maxAgeMs: number = TMP_MAX_AGE_MS): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.#tmpDir);
    } catch (e) {
      if (isCode(e, 'ENOENT')) return 0;
      throw e;
    }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.part')) continue;
      const path = join(this.#tmpDir, name);
      try {
        const st = await stat(path);
        if (nowMs - st.mtimeMs > maxAgeMs) {
          await rm(path, { force: true });
          removed++;
        }
      } catch (e) {
        if (!isCode(e, 'ENOENT')) throw e;
      }
    }
    return removed;
  }

  /**
   * Startup probe (SRV-17): the store is writable, fsync and rename work, and tmp/, blobs/ and
   * swap/ are on ONE file system (otherwise rename would not be atomic). Throws EIO.
   */
  async probe(): Promise<void> {
    const dirs = ['tmp', 'blobs', 'swap'].map((d) => join(this.root, d));
    for (const d of dirs)
      await mkdir(d, { recursive: true, mode: d === this.#tmpDir ? 0o700 : DIR_MODE });
    const a = join(this.#tmpDir, `${uuidv7()}.probe`);
    const b = `${a}.renamed`;
    const fh = await open(a, 'wx', TMP_MODE);
    try {
      await fh.writeFile('plotinium blob store probe\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(a, b);
    await fsyncDir(this.#tmpDir);
    await rm(b, { force: true });
    const devs = new Set<number>();
    for (const d of dirs) devs.add((await stat(d)).dev);
    if (devs.size !== 1) {
      throw new ErrnoError(
        'EIO',
        { reason: 'storage' },
        'tmp/, blobs/ and swap/ are on different file systems',
      );
    }
  }

  /** Free space of the volume, for /api/readyz checks.disk and plotinium_disk_free_bytes. */
  async diskFree(): Promise<{ freeBytes: number; totalBytes: number }> {
    const s = await statfs(this.root);
    return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (e) {
      if (isCode(e, 'ENOENT')) return false;
      throw e;
    }
  }
}

async function writeAll(fh: FileHandle, buf: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buf.length) {
    const { bytesWritten } = await fh.write(buf, offset, buf.length - offset);
    offset += bytesWritten;
  }
}

/** fsync a directory so a rename in it is durable. Platforms that cannot do it are ignored. */
async function fsyncDir(path: string): Promise<void> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, 'r');
    await fh.sync();
  } catch (e) {
    if (!isCode(e, 'EISDIR', 'EINVAL', 'EPERM', 'EBADF')) throw e;
  } finally {
    await fh?.close();
  }
}
