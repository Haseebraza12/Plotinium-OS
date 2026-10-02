import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it } from 'vitest';

import { HttpError } from '../../http/errors.ts';
import { FsBlobStore } from '../../storage/fs-blobstore.ts';
import { MemoryIndexDb, snippetOf, type MemoryInode } from './memory-db.ts';
import { parseVector, vectorLiteral } from './readable.sql.ts';
import { blobReaderFrom, chunkContentHash, IndexService, type BlobReader } from './service.ts';
import { ROOT, testIno } from './tests/graph.ts';
import type { ChunkIn, Requester } from './types.ts';

const MK = 'mdbr-leaf-ir-q8@4262131b-384';
const alice: Requester = { uid: 1001, gids: [100, 500] };
const bob: Requester = { uid: 1002, gids: [100, 500] };
const carol: Requester = { uid: 1003, gids: [100] };
const TEXT = 'alpha paragraph\n\nbeta paragraph about lru eviction\n';
const SHA = createHash('sha256').update(TEXT).digest('hex');

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

function chunk(
  seq: number,
  start: number,
  end: number,
  emb: Float32Array | null,
  header = `H${seq}`,
): ChunkIn {
  const text = Buffer.from(TEXT).subarray(start, end).toString('utf8');
  return {
    seq,
    byteStart: start,
    byteEnd: end,
    lineStart: 1,
    lineEnd: 2,
    header,
    text,
    contentHash: chunkContentHash(MK, header, text),
    embedding: emb,
  };
}

const blobs: BlobReader = {
  read: (sha) =>
    sha === SHA ? Promise.resolve(Buffer.from(TEXT)) : Promise.reject(new Error('no blob')),
};

/** /home (0755) / alice (0700: diary 0644) and /team (0750 group 500: plan 0640), all alice's. */
function setup() {
  const db = new MemoryIndexDb(ROOT);
  const add = (
    ino: string,
    type: 'f' | 'd',
    mode: number,
    gid: number,
    parent: string,
    name: string,
    extra = {},
  ) => {
    db.inodes.set(ino, {
      ino,
      type,
      mode,
      uid: type === 'd' && ino === HOME ? 0 : 1001,
      gid,
      version: 3,
      size: type === 'f' ? Buffer.byteLength(TEXT) : 0,
      blobSha256: type === 'f' ? SHA : null,
      ...extra,
    });
    db.dentries.push({ parentIno: parent, name, ino });
  };
  db.inodes.set(ROOT, {
    ino: ROOT,
    type: 'd',
    mode: 0o755,
    uid: 0,
    gid: 0,
    version: 1,
    size: 0,
    blobSha256: null,
  });
  add(HOME, 'd', 0o755, 0, ROOT, 'home');
  add(AH, 'd', 0o700, 100, HOME, 'alice');
  add(DIARY, 'f', 0o644, 100, AH, 'diary.md');
  add(TEAM, 'd', 0o750, 500, ROOT, 'team');
  add(PLAN, 'f', 0o640, 500, TEAM, 'plan.md');
  add(EMPTY, 'f', 0o644, 500, TEAM, 'empty.md', { size: 0, blobSha256: null });
  return { db, service: new IndexService({ db, blobs }) };
}
const [HOME, AH, DIARY, TEAM, PLAN, EMPTY] = [1, 2, 3, 4, 5, 6].map(testIno) as [
  string,
  string,
  string,
  string,
  string,
  string,
];

function patch(db: MemoryIndexDb, ino: string, over: Partial<MemoryInode>): void {
  const n = db.inodes.get(ino);
  if (n === undefined) throw new Error(`no inode ${ino}`);
  db.inodes.set(ino, { ...n, ...over });
}

async function err(p: Promise<unknown>): Promise<HttpError> {
  const e = await p.catch((x: unknown) => x);
  if (e instanceof HttpError) return e;
  throw new Error(`expected an HttpError, got ${String(e)}`);
}

describe('The index API logic (backend-api.md §3.12; rag-semantic-search.md §3.6)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('RAG-03 index put from a uid without w on the file is refused with 403 EACCES (r is required too)', async () => {
    expect(
      (
        await err(
          s.service.put(bob, {
            ino: PLAN,
            inodeVersion: 3,
            modelKey: MK,
            chunks: [chunk(0, 0, 15, unit(1))],
          }),
        )
      ).status,
    ).toBe(403);
    patch(s.db, PLAN, { mode: 0o620 }); // group write-only
    expect(
      (await err(s.service.put(bob, { ino: PLAN, inodeVersion: 3, modelKey: MK, chunks: [] })))
        .errno,
    ).toBe('EACCES');
  });

  it('RAG-03 index put with text that is not the blob slice, a wrong hash or offsets outside the file is refused with 422 EINVAL', async () => {
    const good = chunk(0, 0, 15, unit(1));
    const cases: ChunkIn[] = [
      {
        ...good,
        text: 'alpha paragrapX',
        contentHash: chunkContentHash(MK, 'H0', 'alpha paragrapX'),
      },
      { ...good, contentHash: 'f'.repeat(64) },
      { ...chunk(0, 0, 15, unit(1)), byteEnd: 900 },
    ];
    for (const c of cases) {
      const e = await err(
        s.service.put(alice, { ino: PLAN, inodeVersion: 3, modelKey: MK, chunks: [c] }),
      );
      expect([e.status, e.errno]).toEqual([422, 'EINVAL']);
    }
    expect(s.db.chunks).toHaveLength(0);
  });

  it('RAG-02 the put validates shape before touching storage: model key, version, seq, offsets, vectors, NUL', async () => {
    const put = (over: Partial<Parameters<IndexService['put']>[1]>, c: Partial<ChunkIn> = {}) =>
      err(
        s.service.put(alice, {
          ino: PLAN,
          inodeVersion: 3,
          modelKey: MK,
          chunks: [{ ...chunk(0, 0, 15, unit(1)), ...c }],
          ...over,
        }),
      );
    expect((await put({ modelKey: 'Upper Case' })).detail['field']).toBe('modelKey');
    expect((await put({ ino: 'nope' })).detail['field']).toBe('ino');
    expect((await put({ inodeVersion: 0 })).detail['field']).toBe('inodeVersion');
    expect((await put({}, { byteEnd: 0 })).detail['field']).toBe('chunks[0].byteEnd');
    expect((await put({}, { lineStart: 0 })).detail['field']).toBe('chunks[0].lineEnd');
    expect((await put({}, { seq: -1 })).detail['field']).toBe('chunks[0]');
    expect((await put({}, { header: 'h'.repeat(513) })).detail['field']).toBe('chunks[0].header');
    expect((await put({}, { text: 'a\u0000b' })).detail['field']).toBe('chunks[0].text');
    expect((await put({}, { contentHash: 'XYZ' })).detail['field']).toBe('chunks[0].contentHash');
    expect((await put({}, { embedding: new Float32Array(10) })).detail['field']).toBe(
      'chunks[0].embedding',
    );
    expect((await put({}, { embedding: new Float32Array(384).fill(1) })).message).toMatch(
      /unit length/,
    );
    const nan = unit(1);
    nan[3] = Number.NaN;
    expect((await put({}, { embedding: nan })).message).toMatch(/finite/);
    expect(
      (
        await err(
          s.service.put(alice, {
            ino: PLAN,
            inodeVersion: 3,
            modelKey: MK,
            chunks: [chunk(0, 0, 15, unit(1)), chunk(0, 17, 50, unit(2))],
          }),
        )
      ).message,
    ).toMatch(/duplicate seq/);
    expect(
      (
        await err(
          s.service.put(alice, {
            ino: PLAN,
            inodeVersion: 3,
            modelKey: MK,
            chunks: Array.from({ length: 4097 }, (_, i) => chunk(i, 0, 1, unit(1))),
          }),
        )
      ).detail['field'],
    ).toBe('chunks');
  });

  it('RAG-02 a stale version is 409 EAGAIN, a missing file 404, a directory or empty file 422', async () => {
    expect(
      await err(s.service.put(alice, { ino: PLAN, inodeVersion: 2, modelKey: MK, chunks: [] })),
    ).toMatchObject({ status: 409, errno: 'EAGAIN', reason: 'stale-version' });
    expect(
      (
        await err(
          s.service.put(alice, { ino: testIno(99), inodeVersion: 1, modelKey: MK, chunks: [] }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await err(s.service.put(alice, { ino: TEAM, inodeVersion: 3, modelKey: MK, chunks: [] })))
        .status,
    ).toBe(422);
    expect(
      (
        await err(
          s.service.put(alice, {
            ino: EMPTY,
            inodeVersion: 3,
            modelKey: MK,
            chunks: [chunk(0, 0, 1, unit(1))],
          }),
        )
      ).message,
    ).toMatch(/empty/);
    patch(s.db, PLAN, { size: 3 * 1024 * 1024 });
    expect(
      (
        await err(
          s.service.put(alice, {
            ino: PLAN,
            inodeVersion: 3,
            modelKey: MK,
            chunks: [chunk(0, 0, 1, unit(1))],
          }),
        )
      ).message,
    ).toMatch(/too large/);
  });

  it('RAG-02 a put replaces the whole set, reuses stored vectors by content hash, is idempotent, and an empty put clears the set', async () => {
    expect(
      await s.service.put(alice, {
        ino: PLAN,
        inodeVersion: 3,
        modelKey: MK,
        chunks: [chunk(0, 0, 15, unit(1)), chunk(1, 17, 50, unit(2))],
      }),
    ).toEqual({ applied: true, rows: 2 });
    expect(
      await s.service.put(alice, { ino: PLAN, inodeVersion: 3, modelKey: MK, chunks: [] }),
    ).toEqual({ duplicate: true });
    patch(s.db, PLAN, { version: 4 });
    expect(
      await s.service.put(alice, {
        ino: PLAN,
        inodeVersion: 4,
        modelKey: MK,
        chunks: [chunk(0, 17, 50, null, 'H1')],
      }),
    ).toEqual({ applied: true, rows: 1 });
    expect(s.db.chunks.map((c) => [c.seq, c.inodeVersion, c.embedding[0]])).toEqual([
      [0, 4, unit(2)[0]],
    ]);
    patch(s.db, PLAN, { version: 5 });
    expect(
      await err(
        s.service.put(alice, {
          ino: PLAN,
          inodeVersion: 5,
          modelKey: MK,
          chunks: [chunk(0, 0, 15, null)],
        }),
      ),
    ).toMatchObject({ status: 422 });
    expect(s.db.chunks).toHaveLength(1); // the failed put changed nothing
    expect(
      await s.service.put(alice, { ino: PLAN, inodeVersion: 5, modelKey: MK, chunks: [] }),
    ).toEqual({ applied: true, rows: 0 });
    expect(s.db.chunks).toHaveLength(0);
    // a version race between the checks and the transaction is still 409
    const racing = new IndexService({
      db: Object.assign(Object.create(s.db) as MemoryIndexDb, {
        replaceChunks: () => Promise.resolve({ ok: false, reason: 'stale-version' }),
      }),
      blobs,
    });
    expect(
      (await err(racing.put(alice, { ino: PLAN, inodeVersion: 5, modelKey: 'other', chunks: [] })))
        .status,
    ).toBe(409);
  });

  it('RAG-03 index pull never returns chunks of unreadable inodes and never returns text of files the requester does not own', async () => {
    await s.service.put(alice, {
      ino: DIARY,
      inodeVersion: 3,
      modelKey: MK,
      chunks: [chunk(0, 0, 15, unit(1))],
    });
    await s.service.put(alice, {
      ino: PLAN,
      inodeVersion: 3,
      modelKey: MK,
      chunks: [chunk(0, 0, 15, unit(2)), chunk(1, 17, 50, unit(3))],
    });
    const own = await s.service.pull(alice, { modelKey: MK, after: 0, limit: 2000 });
    expect(own).toMatchObject({ complete: true, manifestFiles: 2 });
    expect(own.chunks.every((c) => c.owned && c.text !== undefined && c.header !== '')).toBe(true);
    const forBob = await s.service.pull(bob, { modelKey: MK, after: 0, limit: 2000 });
    expect(forBob.chunks.map((c) => c.ino)).toEqual([PLAN, PLAN]);
    expect(forBob.chunks.every((c) => !c.owned && c.text === undefined && c.header === '')).toBe(
      true,
    );
    expect(forBob.manifestFiles).toBe(1);
    expect((await s.service.pull(carol, { modelKey: MK, after: 0, limit: 2000 })).chunks).toEqual(
      [],
    );
    const p1 = await s.service.pull(alice, { modelKey: MK, after: 0, limit: 2 });
    expect([p1.chunks.length, p1.complete]).toEqual([2, false]);
    const p2 = await s.service.pull(alice, { modelKey: MK, after: p1.nextAfter, limit: 2 });
    expect([p2.chunks.length, p2.complete, p2.nextAfter]).toEqual([1, true, 3]);
    const p3 = await s.service.pull(alice, { modelKey: MK, after: p2.nextAfter, limit: 2 });
    expect([p3.chunks.length, p3.nextAfter]).toEqual([0, 3]);
    // defence in depth: even a store that leaked text is scrubbed by the service
    const leaky = new IndexService({
      db: Object.assign(Object.create(s.db) as MemoryIndexDb, {
        pull: async () => ({
          rows: (await s.db.pull(alice, { modelKey: MK, after: 0, limit: 10 })).rows.map((c) => ({
            ...c,
            owned: false,
          })),
          manifestFiles: 1,
        }),
      }),
      blobs,
    });
    expect(
      (await leaky.pull(bob, { modelKey: MK, after: 0, limit: 10 })).chunks.every(
        (c) => c.text === undefined && c.header === '',
      ),
    ).toBe(true);
    for (const bad of [{ after: -1 }, { limit: 0 }, { limit: 2001 }, { modelKey: 'X' }]) {
      expect(
        (await err(s.service.pull(alice, { modelKey: MK, after: 0, limit: 10, ...bad }))).status,
      ).toBe(400);
    }
  });

  it('RAG-03 search computes the readable set before ranking: a closer unreadable chunk is never returned', async () => {
    await s.service.put(alice, {
      ino: DIARY,
      inodeVersion: 3,
      modelKey: MK,
      chunks: [chunk(0, 0, 15, unit(1))],
    });
    await s.service.put(alice, {
      ino: PLAN,
      inodeVersion: 3,
      modelKey: MK,
      chunks: [chunk(0, 0, 15, unit(2)), chunk(1, 17, 50, unit(2))],
    });
    const q = unit(1);
    expect((await s.service.search(alice, { modelKey: MK, vector: q, k: 1 }))[0]).toMatchObject({
      ino: DIARY,
      path: '/home/alice/diary.md',
    });
    const forBob = await s.service.search(bob, { modelKey: MK, vector: q, k: 5 });
    expect(forBob.map((h) => [h.ino, h.seq])).toEqual([
      [PLAN, 0],
      [PLAN, 1],
    ]); // equal scores: ties by (ino, seq)
    expect(forBob[0]).toMatchObject({ path: '/team/plan.md', snippet: 'alpha paragraph' });
    expect(
      await s.service.search(alice, { modelKey: MK, vector: q, k: 5, scopeIno: TEAM }),
    ).toHaveLength(2);
    expect(await s.service.search(carol, { modelKey: MK, vector: q, k: 5 })).toEqual([]);
    expect(await s.service.search(alice, { modelKey: 'other-model', vector: q, k: 5 })).toEqual([]); // I-A5
    for (const bad of [{ k: 0 }, { k: 51 }, { vector: new Float32Array(3) }, { scopeIno: 'x' }]) {
      expect(
        (await err(s.service.search(alice, { modelKey: MK, vector: q, k: 5, ...bad }))).status,
      ).toBe(400);
    }
  });

  it('RAG-03 verify reports current readability, path, version and snippet; unreadable items reveal nothing', async () => {
    await s.service.put(alice, {
      ino: PLAN,
      inodeVersion: 3,
      modelKey: MK,
      chunks: [chunk(0, 0, 15, unit(2))],
    });
    expect(
      await s.service.verify(bob, MK, [
        { ino: PLAN, seq: 0, inodeVersion: 3 },
        { ino: DIARY, seq: 0, inodeVersion: 3 },
      ]),
    ).toEqual([
      {
        ino: PLAN,
        seq: 0,
        readable: true,
        path: '/team/plan.md',
        inodeVersion: 3,
        snippet: 'alpha paragraph',
      },
      { ino: DIARY, seq: 0, readable: false },
    ]);
    patch(s.db, PLAN, { mode: 0o600 });
    expect(await s.service.verify(bob, MK, [{ ino: PLAN, seq: 0, inodeVersion: 3 }])).toEqual([
      { ino: PLAN, seq: 0, readable: false },
    ]);
    s.db.unlinkInode(PLAN); // deleted inodes are never readable (I-A9), and the chunks cascade
    expect(await s.service.verify(alice, MK, [{ ino: PLAN, seq: 0, inodeVersion: 3 }])).toEqual([
      { ino: PLAN, seq: 0, readable: false },
    ]);
    expect(s.db.chunks).toEqual([]);
    expect(await s.service.verify(alice, MK, [])).toEqual([]);
    const many = Array.from({ length: 51 }, () => ({ ino: PLAN, seq: 0, inodeVersion: 1 }));
    expect((await err(s.service.verify(alice, MK, many))).status).toBe(400);
    expect(
      (await err(s.service.verify(alice, MK, [{ ino: 'x', seq: 0, inodeVersion: 1 }]))).detail[
        'field'
      ],
    ).toBe('items[0].ino');
    expect(
      (await err(s.service.verify(alice, MK, [{ ino: PLAN, seq: -1, inodeVersion: 1 }]))).detail[
        'field'
      ],
    ).toBe('items[0].seq');
  });

  it('RAG-02 blob reads stream from FsBlobStore and stop at the size cap; vectors round-trip through pgvector text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plt-index-blobs-'));
    try {
      const store = new FsBlobStore(dir);
      await store.put({ kind: 'content', sha256: SHA }, Readable.from([Buffer.from(TEXT)]), {
        size: Buffer.byteLength(TEXT),
        maxBytes: 1024,
      });
      const reader = blobReaderFrom(store);
      expect(Buffer.from(await reader.read(SHA, 1024)).toString()).toBe(TEXT);
      await expect(reader.read(SHA, 10)).rejects.toMatchObject({ errno: 'EINVAL' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const v = unit(7);
    expect(parseVector(vectorLiteral(v))).toEqual(v);
    expect(vectorLiteral([1, 0.5])).toBe('[1,0.5]');
    expect(parseVector('[]')).toHaveLength(0);
    expect(() => vectorLiteral([Number.POSITIVE_INFINITY])).toThrow(RangeError);
    expect(snippetOf('😀'.repeat(300))).toHaveLength(480); // 240 code points = 480 UTF-16 units
  });
});
