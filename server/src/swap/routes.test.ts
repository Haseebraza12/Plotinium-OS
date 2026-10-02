import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pluginApp } from '../../tests/plugin-app.ts';
import { MemorySwapDb, SwapService } from '../engine/swap/index.ts';
import { FsBlobStore } from '../storage/fs-blobstore.ts';
import { swapPlugin } from './routes.ts';

const ALICE = { 'x-test-uid': '1001' };
const BOB = { 'x-test-uid': '1002' };
const S1 = '0192f2a0-0000-7000-8000-0000000000a1';
const SB = '0192f2a0-0000-7000-8000-0000000000b1';
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

let dir: string;
let app: FastifyInstance;
let db: MemorySwapDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plt-swap-routes-'));
  db = new MemorySwapDb();
  db.sessions.set(S1, 1001);
  db.sessions.set(SB, 1002);
  const swap = new SwapService({
    db,
    blobs: new FsBlobStore(dir),
    quotaBytes: 1024 * 1024,
    maxRawBytes: 64 * 1024,
  });
  app = await pluginApp((a) => swapPlugin(a, { swap }));
});
afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

function putPage(url: string, raw: Buffer, headers: Record<string, string> = ALICE) {
  return app.inject({
    method: 'PUT',
    url,
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-plotinium-checksum': sha(raw),
      'x-plotinium-raw-size': String(raw.length),
    },
    payload: gzipSync(raw),
  });
}

describe('MEM-03 /api/swap routes (backend-api.md §3.11; memory-and-paging.md §4.5)', () => {
  it('MEM-03 a page round-trips gzip with its checksum headers, lists, and re-uploading the same bytes is unchanged', async () => {
    const raw = randomBytes(4096);
    const put = await putPage(`/api/swap/${S1}/7/1?gen=1`, raw);
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({
      stored: true,
      checksum: sha(raw),
      gen: 1,
      unchanged: false,
    });
    const again = await putPage(`/api/swap/${S1}/7/1?gen=1`, raw);
    expect(again.json()).toMatchObject({ unchanged: true });

    const got = await app.inject({ method: 'GET', url: `/api/swap/${S1}/7/1`, headers: ALICE });
    expect(got.statusCode).toBe(200);
    expect(got.headers['x-plotinium-checksum']).toBe(sha(raw));
    expect(got.headers['x-plotinium-raw-size']).toBe(String(raw.length));
    expect(gunzipSync(got.rawPayload).equals(raw)).toBe(true);

    await putPage(`/api/swap/${S1}/7/2`, randomBytes(100));
    const list = await app.inject({
      method: 'GET',
      url: `/api/swap?osSession=${S1}&limit=1`,
      headers: ALICE,
    });
    const body = list.json<{ pages: { pageId: number }[]; next?: string }>();
    expect(body.pages).toHaveLength(1);
    expect(body.next).toBeDefined();
    const rest = await app.inject({
      method: 'GET',
      url: `/api/swap?osSession=${S1}&after=${encodeURIComponent(body.next ?? '')}`,
      headers: ALICE,
    });
    expect(rest.json<{ pages: unknown[] }>().pages).toHaveLength(1);
  });

  it('MEM-05 swap is private to the session uid: another user gets 403, even for a page that exists', async () => {
    await putPage(`/api/swap/${S1}/7/1`, randomBytes(64));
    const foreign = await app.inject({ method: 'GET', url: `/api/swap/${S1}/7/1`, headers: BOB });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ errno: 'EACCES' });
    expect((await putPage(`/api/swap/${S1}/7/9`, randomBytes(64), BOB)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/swap' })).statusCode).toBe(401);
  });

  it('MEM-04 DELETE removes one page, one process or a whole OS session with 204', async () => {
    for (const [pid, page] of [
      [7, 1],
      [7, 2],
      [8, 1],
    ] as const)
      await putPage(`/api/swap/${S1}/${pid}/${page}`, randomBytes(32));
    const del = (url: string) => app.inject({ method: 'DELETE', url, headers: ALICE });
    expect((await del(`/api/swap/${S1}/7/1`)).statusCode).toBe(204);
    expect(db.pages.size).toBe(2);
    expect((await del(`/api/swap/${S1}/7`)).statusCode).toBe(204);
    expect(db.pages.size).toBe(1);
    expect((await del(`/api/swap/${S1}`)).statusCode).toBe(204);
    expect(db.pages.size).toBe(0);
    const gone = await app.inject({ method: 'GET', url: `/api/swap/${S1}/8/1`, headers: ALICE });
    expect(gone.statusCode).toBe(404);
  });

  it('SRV-05 bad transport is refused before the store: checksum mismatch 422, bad headers 400, bad path 400, wrong type 415', async () => {
    const raw = randomBytes(256);
    const mismatch = await app.inject({
      method: 'PUT',
      url: `/api/swap/${S1}/7/1`,
      headers: {
        ...ALICE,
        'content-type': 'application/octet-stream',
        'x-plotinium-checksum': 'f'.repeat(64),
        'x-plotinium-raw-size': String(raw.length),
      },
      payload: gzipSync(raw),
    });
    expect(mismatch.statusCode).toBe(422);
    expect(db.pages.size).toBe(0);
    const noChecksum = await app.inject({
      method: 'PUT',
      url: `/api/swap/${S1}/7/1`,
      headers: {
        ...ALICE,
        'content-type': 'application/octet-stream',
        'x-plotinium-raw-size': '1',
      },
      payload: gzipSync(raw),
    });
    expect(noChecksum.statusCode).toBe(400);
    const badPath = await app.inject({ method: 'GET', url: `/api/swap/nope/7/1`, headers: ALICE });
    expect(badPath.statusCode).toBe(400);
    const json = await app.inject({
      method: 'PUT',
      url: `/api/swap/${S1}/7/1`,
      headers: {
        ...ALICE,
        'x-plotinium-checksum': sha(raw),
        'x-plotinium-raw-size': String(raw.length),
      },
      payload: { page: 'json' },
    });
    expect(json.statusCode).toBe(415);
  });

  it('SRV-04 without a database every swap route answers 503 EIO server', async () => {
    const none = await pluginApp((a) => swapPlugin(a, { swap: null }));
    const res = await none.inject({ method: 'GET', url: '/api/swap', headers: ALICE });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errno: 'EIO', reason: 'server' });
    await none.close();
  });
});
