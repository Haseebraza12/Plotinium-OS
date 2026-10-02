import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pluginApp } from '../../tests/plugin-app.ts';
import {
  CHUNKS_CONTENT_TYPE,
  chunkContentHash,
  decodeFrames,
  encodeFrames,
  IndexService,
  MemoryIndexDb,
} from '../engine/index/index.ts';
import type { ChunkFrame } from '../engine/index/chunks-codec.ts';
import { ROOT, testIno } from '../engine/index/tests/graph.ts';
import { indexPlugin } from './routes.ts';

const MK = 'minilm-l6-v2@q8';
const ALICE = { 'x-test-uid': '1001' };
const BOB = { 'x-test-uid': '1002' };
const TEXT = 'alpha paragraph\n\nbeta paragraph about lru eviction\n';
const SHA = createHash('sha256').update(TEXT).digest('hex');
const [HOME, AH, DIARY] = [1, 2, 3].map(testIno) as [string, string, string];

function unit(seed: number): Float32Array {
  const v = new Float32Array(384);
  let s = 0;
  for (let i = 0; i < 384; i++) {
    v[i] = Math.cos(seed * 3.3 + i * 0.11);
    s += (v[i] ?? 0) ** 2;
  }
  for (let i = 0; i < 384; i++) v[i] = (v[i] ?? 0) / Math.sqrt(s);
  return v;
}

function frame(seq: number, start: number, end: number): ChunkFrame {
  const text = Buffer.from(TEXT).subarray(start, end).toString('utf8');
  const header = `H${seq}`;
  return {
    meta: {
      ino: DIARY,
      inodeVersion: 3,
      seq,
      byteStart: start,
      byteEnd: end,
      lineStart: 1,
      lineEnd: 2,
      header,
      contentHash: chunkContentHash(MK, header, text),
      modelKey: MK,
      text,
    },
    embedding: unit(seq + 1),
  };
}

let app: FastifyInstance;
let db: MemoryIndexDb;

beforeEach(async () => {
  db = new MemoryIndexDb(ROOT);
  const node = (
    ino: string,
    type: 'f' | 'd',
    mode: number,
    uid: number,
    parent: string | null,
    name: string,
  ) => {
    db.inodes.set(ino, {
      ino,
      type,
      mode,
      uid,
      gid: 100,
      version: 3,
      size: type === 'f' ? Buffer.byteLength(TEXT) : 0,
      blobSha256: type === 'f' ? SHA : null,
    });
    if (parent !== null) db.dentries.push({ parentIno: parent, name, ino });
  };
  node(ROOT, 'd', 0o755, 0, null, '');
  node(HOME, 'd', 0o755, 0, ROOT, 'home');
  node(AH, 'd', 0o700, 1001, HOME, 'alice');
  node(DIARY, 'f', 0o644, 1001, AH, 'diary.md');
  const index = new IndexService({
    db,
    blobs: {
      read: (sha) =>
        sha === SHA ? Promise.resolve(Buffer.from(TEXT)) : Promise.reject(new Error('no blob')),
    },
  });
  app = await pluginApp((a) => indexPlugin(a, { index }));
});
afterEach(async () => {
  await app.close();
});

const put = (body: Buffer, headers: Record<string, string> = ALICE, query = '') =>
  app.inject({
    method: 'POST',
    url: `/api/index/put${query}`,
    headers: { ...headers, 'content-type': CHUNKS_CONTENT_TYPE },
    payload: body,
  });

describe('SRV-12 /api/index routes over the readable set (backend-api.md §3.12; rag-semantic-search.md §4.4)', () => {
  it('RAG-02 put stores a file set, pull returns it to a reader with the cursor headers, search ranks it', async () => {
    const res = await put(encodeFrames([frame(0, 0, 16), frame(1, 17, TEXT.length)]));
    expect(res.statusCode, res.body).toBe(200);
    expect(db.chunks).toHaveLength(2);

    const pull = await app.inject({
      method: 'GET',
      url: `/api/index/pull?modelKey=${MK}`,
      headers: ALICE,
    });
    expect(pull.statusCode, pull.body).toBe(200);
    expect(pull.headers['content-type']).toBe(CHUNKS_CONTENT_TYPE);
    expect(Number(pull.headers['x-manifest-files'])).toBe(1);
    expect(pull.headers['x-next-after']).toBeDefined();
    expect(decodeFrames(pull.rawPayload, { maxFrames: 10 })).toHaveLength(2);

    const search = await app.inject({
      method: 'POST',
      url: '/api/index/search',
      headers: ALICE,
      payload: { modelKey: MK, vector: [...unit(2)], k: 2 },
    });
    expect(search.statusCode, search.body).toBe(200);
    const hits = search.json<{ results: { ino: string; seq: number }[] }>().results;
    expect(hits[0]).toMatchObject({ ino: DIARY, seq: 1 });

    const verify = await app.inject({
      method: 'POST',
      url: '/api/index/verify',
      headers: ALICE,
      payload: { modelKey: MK, items: [{ ino: DIARY, seq: 1, inodeVersion: 3 }] },
    });
    expect(verify.statusCode, verify.body).toBe(200);
    expect(verify.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('RAG-03 a user who cannot traverse the directory gets no hits and cannot index the file', async () => {
    await put(encodeFrames([frame(0, 0, 16)]));
    const search = await app.inject({
      method: 'POST',
      url: '/api/index/search',
      headers: BOB,
      payload: { modelKey: MK, vector: [...unit(1)], k: 5 },
    });
    expect(search.json()).toEqual({ results: [] });
    const pull = await app.inject({
      method: 'GET',
      url: `/api/index/pull?modelKey=${MK}`,
      headers: BOB,
    });
    expect(decodeFrames(pull.rawPayload, { maxFrames: 10 })).toHaveLength(0);
    const denied = await put(encodeFrames([frame(0, 0, 16)]), BOB);
    expect([403, 404]).toContain(denied.statusCode);
  });

  it('RAG-02 an empty put clears the set named in the query string once the file changed; a resend of a stored version is a duplicate; without the names it is 400', async () => {
    await put(encodeFrames([frame(0, 0, 16)]));
    expect(db.chunks).toHaveLength(1);
    const same = await put(Buffer.alloc(0), ALICE, `?ino=${DIARY}&inodeVersion=3&modelKey=${MK}`);
    expect(same.json()).toEqual({ duplicate: true });
    expect(db.chunks).toHaveLength(1);
    // The file was emptied (version 4): its chunk set is cleared.
    const n = db.inodes.get(DIARY);
    if (n !== undefined) db.inodes.set(DIARY, { ...n, version: 4, size: 0, blobSha256: null });
    const cleared = await put(
      Buffer.alloc(0),
      ALICE,
      `?ino=${DIARY}&inodeVersion=4&modelKey=${MK}`,
    );
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ applied: true, rows: 0 });
    expect(db.chunks).toHaveLength(0);
    const unnamed = await put(Buffer.alloc(0));
    expect(unnamed.statusCode).toBe(400);
  });

  it('SRV-05 wrong content type is 415, a bad vector 400, a model key the database would refuse 400, no session 401', async () => {
    const json = await app.inject({
      method: 'POST',
      url: '/api/index/put',
      headers: ALICE,
      payload: {},
    });
    expect(json.statusCode).toBe(415);
    const short = await app.inject({
      method: 'POST',
      url: '/api/index/search',
      headers: ALICE,
      payload: { modelKey: MK, vector: [1, 2, 3] },
    });
    expect(short.statusCode).toBe(400);
    const upper = await app.inject({
      method: 'GET',
      url: '/api/index/pull?modelKey=Xenova/MiniLM',
      headers: ALICE,
    });
    expect(upper.statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: `/api/index/pull?modelKey=${MK}` })).statusCode,
    ).toBe(401);
    const none = await pluginApp((a) => indexPlugin(a, { index: null }));
    expect(
      (await none.inject({ method: 'GET', url: `/api/index/pull?modelKey=${MK}`, headers: ALICE }))
        .statusCode,
    ).toBe(503);
    await none.close();
  });
});
