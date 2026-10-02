import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pluginApp } from '../../tests/plugin-app.ts';
import type { DirContext, DirNode } from '../engine/sync/visibility.ts';
import { RateLimiter } from '../ratelimit/limiter.ts';
import type { BlobDb, BlobHolder } from './blob-db.ts';
import { FsBlobStore } from './fs-blobstore.ts';
import { blobsPlugin, parseRange } from './routes.ts';

const ALICE = { 'x-test-uid': '1001' };
const BOB = { 'x-test-uid': '1002' };
const ROOT = 'r0000000-0000-7000-8000-000000000001';
const HOME = 'h0000000-0000-7000-8000-000000001001';
const FILE = '0192f2a0-0000-7000-8000-0000000000f1';
const CONTENT = Buffer.from('the quick brown fox jumps over the lazy dog\n');
const SHA = createHash('sha256').update(CONTENT).digest('hex');

/** An in-memory BlobDb: / (0755) -> alice's home (0700) -> one file holding CONTENT. */
class MemoryBlobDb implements BlobDb {
  readonly recorded = new Map<string, number>();
  remaining: number | null = 1_000_000;
  readonly nodes = new Map<string, DirNode>([
    [ROOT, { row: { type: 'd', mode: 0o755, uid: 0, gid: 0 }, parent: null }],
    [HOME, { row: { type: 'd', mode: 0o700, uid: 1001, gid: 100 }, parent: ROOT }],
    [FILE, { row: { type: 'f', mode: 0o644, uid: 1001, gid: 100 }, parent: HOME }],
  ]);
  readonly holders: BlobHolder[] = [
    { ino: FILE, type: 'f', mode: 0o644, uid: 1001, gid: 100, sha256: SHA, size: CONTENT.length },
  ];

  remainingBytes(): Promise<number | null> {
    return Promise.resolve(this.remaining);
  }
  async record(
    sha256: string,
    size: number,
    _key: string,
    exists: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!(await exists())) return false;
    this.recorded.set(sha256, size);
    return true;
  }
  holder(ino: string): Promise<BlobHolder | null> {
    return Promise.resolve(this.holders.find((h) => h.ino === ino) ?? null);
  }
  holdersOf(sha256: string, limit: number): Promise<readonly BlobHolder[]> {
    return Promise.resolve(this.holders.filter((h) => h.sha256 === sha256).slice(0, limit));
  }
  context(): Promise<DirContext> {
    return Promise.resolve(this.nodes);
  }
}

let dir: string;
let app: FastifyInstance;
let db: MemoryBlobDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plt-blob-routes-'));
  db = new MemoryBlobDb();
  app = await pluginApp((a) =>
    blobsPlugin(a, {
      store: new FsBlobStore(dir),
      db,
      maxBytes: 1024,
      limiter: new RateLimiter(),
    }),
  );
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const put = (body: Buffer, sha = SHA, headers: Record<string, string> = ALICE) =>
  app.inject({
    method: 'PUT',
    url: `/api/blobs/${sha}`,
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    payload: body,
  });

describe('SRV-10 /api/blobs routes (backend-api.md §3.10)', () => {
  it('SRV-10 PUT stores new content once (201), proves possession of existing content (200) and records the row', async () => {
    const first = await put(CONTENT);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toEqual({ sha256: SHA, size: CONTENT.length, stored: true });
    expect(db.recorded.get(SHA)).toBe(CONTENT.length);
    const again = await put(CONTENT);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ sha256: SHA, size: CONTENT.length, existing: true });
  });

  it('SRV-10 PUT refuses a digest mismatch (422 EIO checksum), an oversize body (413), a full quota (413 EDQUOT) and a JSON body (415)', async () => {
    const wrong = await put(CONTENT, 'a'.repeat(64));
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json()).toMatchObject({ errno: 'EIO', reason: 'checksum' });
    expect(db.recorded.size).toBe(0);
    const big = await put(Buffer.alloc(2048, 1), 'b'.repeat(64));
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ errno: 'EINVAL' });
    db.remaining = 10;
    const quota = await put(CONTENT);
    expect(quota.statusCode).toBe(413);
    expect(quota.json()).toMatchObject({ errno: 'EDQUOT' });
    db.remaining = null;
    const json = await app.inject({
      method: 'PUT',
      url: `/api/blobs/${SHA}`,
      headers: ALICE,
      payload: { not: 'bytes' },
    });
    expect(json.statusCode).toBe(415);
    const badSha = await put(CONTENT, 'XYZ');
    expect(badSha.statusCode).toBe(400);
  });

  it('VFS-04 GET needs r on the inode and x on every ancestor; Range gives 206; HEAD never confirms a hash to a non-reader', async () => {
    await put(CONTENT);
    const got = await app.inject({
      method: 'GET',
      url: `/api/blobs/${SHA}?ino=${FILE}`,
      headers: ALICE,
    });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(CONTENT)).toBe(true);
    expect(got.headers['etag']).toBe(`"${SHA}"`);
    const part = await app.inject({
      method: 'GET',
      url: `/api/blobs/${SHA}`,
      headers: { ...ALICE, range: 'bytes=4-8' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('quick');
    expect(part.headers['content-range']).toBe(`bytes 4-8/${CONTENT.length}`);
    const head = await app.inject({ method: 'HEAD', url: `/api/blobs/${SHA}`, headers: ALICE });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(CONTENT.length));

    // bob has no x on alice's 0700 home
    const denied = await app.inject({
      method: 'GET',
      url: `/api/blobs/${SHA}?ino=${FILE}`,
      headers: BOB,
    });
    expect(denied.statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: `/api/blobs/${SHA}`, headers: BOB })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'HEAD', url: `/api/blobs/${SHA}`, headers: BOB })).statusCode,
    ).toBe(404);
    // A hash nobody holds is 404 for everyone.
    const none = await app.inject({
      method: 'GET',
      url: `/api/blobs/${'c'.repeat(64)}`,
      headers: ALICE,
    });
    expect(none.statusCode).toBe(404);
    const unsatisfiable = await app.inject({
      method: 'GET',
      url: `/api/blobs/${SHA}`,
      headers: { ...ALICE, range: 'bytes=999-' },
    });
    expect(unsatisfiable.statusCode).toBe(416);
  });

  it('SRV-10 parseRange handles open, suffix and clamped ranges and rejects the rest', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=2-', 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=0-99', 10)).toEqual({ start: 0, end: 9 });
    for (const bad of ['bytes=-', 'bytes=5-2', 'items=0-1', 'bytes=10-', 'bytes=-0'])
      expect(() => parseRange(bad, 10), bad).toThrow();
  });

  it('SRV-04 without a store every blob route answers 503 EIO server, and 401 without a session', async () => {
    const none = await pluginApp((a) =>
      blobsPlugin(a, { store: null, db: null, maxBytes: 1024, limiter: new RateLimiter() }),
    );
    const res = await none.inject({ method: 'GET', url: `/api/blobs/${SHA}`, headers: ALICE });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errno: 'EIO', reason: 'server' });
    await none.close();
    expect((await app.inject({ method: 'GET', url: `/api/blobs/${SHA}` })).statusCode).toBe(401);
  });
});
