import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrnoError } from '../errno.ts';
import { blobKeyPath, type BlobKey } from './blobstore.ts';
import { FsBlobStore } from './fs-blobstore.ts';

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const body = (s: string | Buffer, chunk = 7): Readable => {
  const buf = Buffer.isBuffer(s) ? s : Buffer.from(s);
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunk) parts.push(buf.subarray(i, i + chunk));
  return Readable.from(parts);
};
const content = (s: string): BlobKey => ({ kind: 'content', sha256: sha(s) });
const SWAP: BlobKey = {
  kind: 'swap',
  ownerUid: 1001,
  osSessionId: '0192f2a0-0000-7000-8000-0000000000aa',
  pid: 42,
  pageId: 3,
};

async function errnoOf(p: Promise<unknown>): Promise<ErrnoError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ErrnoError) return e;
    throw e;
  }
  throw new Error('expected an ErrnoError');
}

let root: string;
let store: FsBlobStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'plt-blobs-'));
  store = new FsBlobStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const tmpLeft = async (): Promise<string[]> => {
  try {
    return await readdir(join(root, 'tmp'));
  } catch {
    return [];
  }
};

describe('SRV-10 FsBlobStore (backend-api.md §3.10)', () => {
  it('SRV-10 put stores content under blobs/sha256/ab/cd/<sha256> with mode 0440 and get returns the bytes', async () => {
    const data = 'hello plotinium\n'.repeat(1000);
    const r = await store.put(content(data), body(data, 1024), {
      size: Buffer.byteLength(data),
      maxBytes: 1 << 20,
    });
    expect(r).toEqual({ size: Buffer.byteLength(data), sha256: sha(data), existed: false });
    const path = join(root, blobKeyPath(content(data)));
    expect(path).toContain(
      `/blobs/sha256/${sha(data).slice(0, 2)}/${sha(data).slice(2, 4)}/${sha(data)}`,
    );
    expect((await stat(path)).mode & 0o777).toBe(0o440);
    expect(await text(await store.get(content(data)))).toBe(data);
    expect(await store.head(content(data))).toMatchObject({ size: Buffer.byteLength(data) });
    expect(await tmpLeft()).toEqual([]);
  });

  it('SRV-10 a second upload of the same content hashes it in full, discards it and reports existing', async () => {
    const data = 'same bytes';
    await store.put(content(data), body(data), { size: data.length, maxBytes: 100 });
    const again = await store.put(content(data), body(data), { size: data.length, maxBytes: 100 });
    expect(again.existed).toBe(true);
    expect(await tmpLeft()).toEqual([]);
  });

  it('SRV-10 a blob upload with a wrong digest leaves no file and returns EIO checksum', async () => {
    const key: BlobKey = { kind: 'content', sha256: sha('what the client claims') };
    const err = await errnoOf(store.put(key, body('different bytes'), { size: 15, maxBytes: 100 }));
    expect(err.errno).toBe('EIO');
    expect(err.reason).toBe('checksum');
    expect(await store.head(key)).toBeNull();
    expect(await tmpLeft()).toEqual([]);
  });

  it('SRV-10 a body shorter or longer than Content-Length is refused with EINVAL and nothing is kept', async () => {
    const data = 'twelve bytes';
    const short = await errnoOf(store.put(content(data), body(data), { size: 20, maxBytes: 100 }));
    expect(short.errno).toBe('EINVAL');
    const over = await errnoOf(store.put(content(data), body(data), { size: 5, maxBytes: 5 }));
    expect(over.errno).toBe('EINVAL');
    expect(await store.head(content(data))).toBeNull();
    expect(await tmpLeft()).toEqual([]);
  });

  it('SRV-10 a declared size above the limit is refused before the body is read', async () => {
    let read = false;
    const lazy = new Readable({
      read() {
        read = true;
        this.push(null);
      },
    });
    const err = await errnoOf(store.put(content('x'), lazy, { size: 101, maxBytes: 100 }));
    expect(err.errno).toBe('EINVAL');
    expect(read).toBe(false);
  });

  it('SRV-10 a client that disconnects during an upload leaves no file', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('socket hang up'));
      },
    });
    await expect(store.put(content('abc'), failing, { size: 3, maxBytes: 100 })).rejects.toThrow(
      'socket hang up',
    );
    expect(await store.head(content('abc'))).toBeNull();
    expect(await tmpLeft()).toEqual([]);
  });

  it('SRV-10 swap keys are replaced atomically with mode 0640 and checked against an optional digest', async () => {
    await store.put(SWAP, body('page v1'), { size: 7, maxBytes: 100 });
    const r = await store.put(SWAP, body('page v2'), {
      size: 7,
      maxBytes: 100,
      sha256: sha('page v2'),
    });
    expect(r.existed).toBe(false);
    expect(await text(await store.get(SWAP))).toBe('page v2');
    expect(
      (await stat(join(root, 'swap/1001/0192f2a0-0000-7000-8000-0000000000aa/42/3'))).mode & 0o777,
    ).toBe(0o640);
    const bad = await errnoOf(
      store.put(SWAP, body('page v3'), { size: 7, maxBytes: 100, sha256: sha('nope') }),
    );
    expect(bad.reason).toBe('checksum');
    expect(await text(await store.get(SWAP))).toBe('page v2');
  });

  it('SRV-10 get supports an inclusive byte range and refuses an unsatisfiable one', async () => {
    const data = '0123456789';
    await store.put(content(data), body(data), { size: 10, maxBytes: 100 });
    expect(await text(await store.get(content(data), { start: 2, end: 5 }))).toBe('2345');
    expect((await errnoOf(store.get(content(data), { start: 5, end: 10 }))).errno).toBe('EINVAL');
    expect((await errnoOf(store.get(content(data), { start: 6, end: 5 }))).errno).toBe('EINVAL');
  });

  it('SRV-10 get of a missing blob is ENOENT, head is null and delete is idempotent', async () => {
    expect((await errnoOf(store.get(content('missing')))).errno).toBe('ENOENT');
    expect(await store.head(content('missing'))).toBeNull();
    await store.delete(content('missing'));
    const data = 'to delete';
    await store.put(content(data), body(data), { size: data.length, maxBytes: 100 });
    await store.delete(content(data));
    await store.delete(content(data));
    expect(await store.head(content(data))).toBeNull();
  });

  it('SRV-10 keys that could escape the store are refused with EINVAL', () => {
    const bad: BlobKey[] = [
      { kind: 'content', sha256: '../../etc/passwd' },
      { kind: 'content', sha256: 'A'.repeat(64) },
      { ...SWAP, osSessionId: '../../x' },
      { ...SWAP, pid: 0 },
      { ...SWAP, pageId: 65_536 },
      { ...SWAP, ownerUid: -1 },
    ] as BlobKey[];
    for (const key of bad) expect(() => blobKeyPath(key)).toThrow(ErrnoError);
  });

  it('SRV-10 a crash between write and rename leaves only a tmp file that the GC removes after 1 hour', async () => {
    await mkdir(join(root, 'tmp'), { recursive: true });
    const old = join(root, 'tmp', 'old.part');
    const fresh = join(root, 'tmp', 'fresh.part');
    await writeFile(old, 'partial');
    await writeFile(fresh, 'partial');
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 3600_000);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    expect(await store.sweepTmp(now)).toBe(1);
    expect(await tmpLeft()).toEqual(['fresh.part']);
  });

  it('SRV-17 the startup probe passes on a writable store and reports free space', async () => {
    await store.probe();
    const { freeBytes, totalBytes } = await store.diskFree();
    expect(totalBytes).toBeGreaterThan(0);
    expect(freeBytes).toBeGreaterThanOrEqual(0);
    expect(await tmpLeft()).toEqual([]);
  });
});
