import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { gunzipSync, gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpError } from '../../http/errors.ts';
import { blobKeyPath } from '../../storage/blobstore.ts';
import { FsBlobStore } from '../../storage/fs-blobstore.ts';
import { parseSwapPutHeaders, swapGetHeaders } from './headers.ts';
import { MemorySwapDb } from './memory-db.ts';
import {
  decodeCursor,
  encodeCursor,
  maxStoredBytes,
  SwapService,
  type SwapPutArgs,
} from './service.ts';

const ALICE = 1001;
const BOB = 1002;
const S1 = '0192f2a0-0000-7000-8000-0000000000a1'; // alice's older OS session
const S2 = '0192f2a0-0000-7000-8000-0000000000a2'; // alice's new browser session
const SB = '0192f2a0-0000-7000-8000-0000000000b1'; // bob's
const MIB = 1024 * 1024;

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const chunked = (b: Buffer, size = 64 * 1024): Readable => {
  const parts: Buffer[] = [];
  for (let i = 0; i < b.length; i += size) parts.push(b.subarray(i, i + size));
  return Readable.from(parts);
};

let dir: string;
let blobs: FsBlobStore;
let db: MemorySwapDb;
let svc: SwapService;

function page(raw: Buffer, over: Partial<SwapPutArgs> = {}): SwapPutArgs {
  const gz = gzipSync(raw);
  return {
    ownerUid: ALICE,
    osSessionId: S1,
    pid: 42,
    pageId: 3,
    gen: 1,
    body: chunked(gz),
    contentLength: gz.length,
    checksum: sha(raw),
    rawSize: raw.length,
    encoding: 'gzip',
    ...over,
  };
}

async function httpErr(p: Promise<unknown>): Promise<HttpError> {
  const e = await p.catch((x: unknown) => x);
  if (e instanceof HttpError) return e;
  throw new Error(`expected an HttpError, got ${String(e)}`);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'plt-swap-'));
  blobs = new FsBlobStore(dir);
  let t = Date.UTC(2026, 8, 25);
  db = new MemorySwapDb(() => (t += 1000));
  db.sessions.set(S1, ALICE);
  db.sessions.set(S2, ALICE);
  db.sessions.set(SB, BOB);
  svc = new SwapService({ db, blobs, quotaBytes: 64 * MIB, maxRawBytes: 16 * MIB });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Remote swap, tier 2 (backend-api.md §3.11; memory-and-paging.md §3.11)', () => {
  it('MEM-03 a 5 MB incompressible page round-trips byte for byte: stored compressed, checksum of the uncompressed bytes', async () => {
    const raw = randomBytes(5 * MIB);
    const r = await svc.put(page(raw));
    expect(r).toMatchObject({
      stored: true,
      checksum: sha(raw),
      sha256: sha(raw),
      size: raw.length,
      gen: 1,
      unchanged: false,
    });
    expect(r.storedSize).toBe(gzipSync(raw).length);
    const got = await svc.get({ ownerUid: ALICE, osSessionId: S1, pid: 42, pageId: 3 }, 1);
    const stored = await buffer(got.stream);
    expect(stored.length).toBe(r.storedSize);
    const back = gunzipSync(stored);
    expect(back.equals(raw)).toBe(true);
    expect(sha(back)).toBe(got.page.checksum);
    expect(got.encoding).toBe('gzip');
    expect(swapGetHeaders(got.page)).toMatchObject({
      'x-plotinium-checksum': sha(raw),
      'plt-sha256': sha(raw),
      'x-plotinium-raw-size': String(raw.length),
      'plt-size': String(raw.length),
      'x-plotinium-encoding': 'gzip',
      'x-plotinium-gen': '1',
      'content-length': String(r.storedSize),
      'cache-control': 'no-store',
    });
    // the object sits at swap/<owner_uid>/<os_session_id>/<pid>/<page_id>
    const onDisk = await readFile(
      join(
        dir,
        blobKeyPath({ kind: 'swap', ownerUid: ALICE, osSessionId: S1, pid: 42, pageId: 3 }),
      ),
    );
    expect(onDisk.equals(stored)).toBe(true);
  });

  it('MEM-04 a page uploaded by one OS session is listed and paged in by a new OS session of the same user', async () => {
    const raw = Buffer.from('window state of pid 42 '.repeat(1000));
    await svc.put(page(raw));
    // the new browser session (S2) lists by owner, newest session first, and pages in S1's page
    const list = await svc.list(ALICE);
    expect(list.pages.map((p) => [p.osSessionId, p.pid, p.pageId, p.size, p.checksum])).toEqual([
      [S1, 42, 3, raw.length, sha(raw)],
    ]);
    const got = await svc.get({ ownerUid: ALICE, osSessionId: S1, pid: 42, pageId: 3 });
    expect(gunzipSync(await buffer(got.stream)).equals(raw)).toBe(true);
  });

  it('MEM-04 a swap page of another user is refused with 403 EACCES even for root', async () => {
    await svc.put(page(Buffer.from('alice only')));
    const key = { osSessionId: S1, pid: 42, pageId: 3 };
    expect((await httpErr(svc.get({ ownerUid: BOB, ...key }))).status).toBe(403);
    expect((await httpErr(svc.get({ ownerUid: 0, ...key }))).errno).toBe('EACCES');
    expect((await httpErr(svc.put(page(Buffer.from('x'), { ownerUid: BOB })))).status).toBe(403); // bob into alice's session
    expect((await httpErr(svc.list(BOB, { osSessionId: S1 }))).status).toBe(403);
    expect((await httpErr(svc.delete(BOB, S1))).status).toBe(403);
    expect(
      (
        await httpErr(
          svc.put(page(Buffer.from('x'), { osSessionId: '0192f2a0-0000-7000-8000-00000000dead' })),
        )
      ).status,
    ).toBe(403); // unknown session
    expect((await svc.list(BOB)).pages).toEqual([]);
  });

  it('MEM-03 a swap page whose uncompressed checksum does not match is refused with 422 and not stored; the previous generation survives', async () => {
    const v1 = Buffer.from('generation one '.repeat(100));
    await svc.put(page(v1));
    const v2 = Buffer.from('generation two '.repeat(100));
    const e = await httpErr(
      svc.put(page(v2, { gen: 2, checksum: sha(Buffer.from('something else')) })),
    );
    expect([e.status, e.errno, e.reason]).toEqual([422, 'EIO', 'checksum']);
    const got = await svc.get({ ownerUid: ALICE, osSessionId: S1, pid: 42, pageId: 3 });
    expect(gunzipSync(await buffer(got.stream)).equals(v1)).toBe(true);
    expect(got.page.gen).toBe(1);
  });

  it('MEM-03 wrong sizes, invalid gzip and a gzip bomb are refused with 422 EIO checksum and leave nothing', async () => {
    const raw = Buffer.from('abc'.repeat(1000));
    const cases: Partial<SwapPutArgs>[] = [
      { rawSize: raw.length - 1 }, // decompresses to more than declared
      { rawSize: raw.length + 1 }, // fewer bytes than declared
      { body: Readable.from([Buffer.from('not gzip at all')]), contentLength: 15 },
      { contentLength: gzipSync(raw).length + 5 }, // body shorter than Content-Length
    ];
    for (const c of cases) {
      const e = await httpErr(svc.put(page(raw, c)));
      expect([e.status, e.errno, e.reason]).toEqual([422, 'EIO', 'checksum']);
    }
    const bomb = Buffer.alloc(8 * MIB); // compresses to a few KB
    const e = await httpErr(
      svc.put(page(bomb, { rawSize: 1024, checksum: sha(bomb.subarray(0, 1024)) })),
    );
    expect(e.reason).toBe('checksum');
    const longer = await httpErr(svc.put(page(raw, { contentLength: 10 })));
    expect([longer.status, longer.errno]).toEqual([413, 'EINVAL']);
    expect(db.pages.size).toBe(0);
    expect(
      await blobs.head({ kind: 'swap', ownerUid: ALICE, osSessionId: S1, pid: 42, pageId: 3 }),
    ).toBeNull();
  });

  it('MEM-04 re-uploading the same checksum is a no-op, and an older generation never replaces a newer one', async () => {
    const raw = Buffer.from('same bytes');
    expect((await svc.put(page(raw))).unchanged).toBe(false);
    expect((await svc.put(page(raw))).unchanged).toBe(true);
    expect((await svc.put(page(raw, { gen: 5 }))).gen).toBe(5); // same content, newer generation: row only
    expect((await svc.list(ALICE)).pages[0]?.gen).toBe(5);
    const stale = await httpErr(svc.put(page(Buffer.from('older'), { gen: 4 })));
    expect([stale.status, stale.errno, stale.reason]).toEqual([409, 'EAGAIN', 'stale-version']);
    expect((await svc.put(page(Buffer.from('no gen given'), { gen: null }))).gen).toBe(5);
    expect(
      await httpErr(svc.get({ ownerUid: ALICE, osSessionId: S1, pid: 42, pageId: 3 }, 4)),
    ).toMatchObject({ status: 404 });
  });

  it('MEM-04 the per-user cap on stored bytes is enforced: early by Content-Length, and in the upsert transaction', async () => {
    const small = new SwapService({ db, blobs, quotaBytes: 4096, maxRawBytes: 16 * MIB });
    const raw = randomBytes(3000);
    await small.put(page(raw, { pageId: 1 }));
    const early = await httpErr(small.put(page(randomBytes(3000), { pageId: 2 })));
    expect([early.status, early.errno]).toEqual([413, 'EDQUOT']);
    // replacing a page counts only the difference
    expect(
      (await small.put(page(randomBytes(3500), { pageId: 1, gen: 2 }))).storedSize,
    ).toBeGreaterThan(3000);
    // the in-transaction check (a concurrent upload won the race): row and object are removed
    const racing = new SwapService({
      db: Object.assign(Object.create(db) as MemorySwapDb, { usedBytes: () => Promise.resolve(0) }),
      blobs,
      quotaBytes: 4096,
      maxRawBytes: 16 * MIB,
    });
    const e = await httpErr(racing.put(page(randomBytes(3000), { pageId: 7 })));
    expect([e.status, e.errno]).toEqual([413, 'EDQUOT']);
    expect(
      await blobs.head({ kind: 'swap', ownerUid: ALICE, osSessionId: S1, pid: 42, pageId: 7 }),
    ).toBeNull();
    expect((await svc.list(ALICE)).pages.map((p) => p.pageId)).toEqual([1]);
  });

  it('MEM-04 an identity upload is verified and stored gzip-compressed like every other page', async () => {
    const raw = Buffer.from('identity page '.repeat(50));
    const r = await svc.put({
      ...page(raw),
      body: chunked(raw, 100),
      contentLength: raw.length,
      encoding: 'identity',
    });
    expect(r.storedSize).toBeLessThan(raw.length);
    const got = await svc.get({ ownerUid: ALICE, osSessionId: S1, pid: 42, pageId: 3 });
    expect(gunzipSync(await buffer(got.stream)).equals(raw)).toBe(true);
    const bad = await httpErr(
      svc.put({
        ...page(raw),
        body: chunked(raw),
        contentLength: raw.length,
        encoding: 'identity',
        checksum: sha(Buffer.from('x')),
      }),
    );
    expect(bad.reason).toBe('checksum');
    const tooLong = await httpErr(
      svc.put({
        ...page(raw, { pageId: 4 }),
        body: chunked(Buffer.concat([raw, raw])),
        contentLength: raw.length,
        encoding: 'identity',
      }),
    );
    expect(tooLong.reason).toBe('checksum');
    const short = await httpErr(
      svc.put({
        ...page(raw, { pageId: 4 }),
        body: chunked(raw.subarray(1)),
        contentLength: raw.length,
        encoding: 'identity',
      }),
    );
    expect(short.reason).toBe('checksum');
    expect(
      (await httpErr(svc.put({ ...page(raw), contentLength: 5, encoding: 'identity' }))).status,
    ).toBe(400);
    const tiny = new SwapService({ db, blobs, quotaBytes: 10, maxRawBytes: 16 * MIB });
    expect(
      (
        await httpErr(
          tiny.put({
            ...page(raw, { pageId: 9 }),
            body: chunked(raw),
            contentLength: raw.length,
            encoding: 'identity',
          }),
        )
      ).errno,
    ).toBe('EDQUOT');
  });

  it('MEM-04 addresses and headers are validated before any byte is read', async () => {
    const raw = Buffer.from('x');
    const bad: Partial<SwapPutArgs>[] = [
      { osSessionId: 'not-a-uuid' },
      { pid: 0 },
      { pageId: 70_000 },
      { checksum: 'XYZ' },
      { contentLength: -1 },
      { gen: -1 },
    ];
    for (const b of bad) expect((await httpErr(svc.put(page(raw, b)))).status).toBe(400);
    expect((await httpErr(svc.put(page(raw, { rawSize: 17 * MIB })))).status).toBe(413);
    expect(
      (await httpErr(svc.put(page(raw, { contentLength: maxStoredBytes(16 * MIB) + 1 })))).status,
    ).toBe(413);
    expect(
      (await httpErr(svc.get({ ownerUid: ALICE, osSessionId: S1, pid: 1, pageId: 1 }))).status,
    ).toBe(404);
  });

  it('MEM-04 the listing is newest session first with a keyset cursor, filters by session and pid, and deletes remove rows then objects', async () => {
    for (const [s, pid, pageId] of [
      [S1, 1, 0],
      [S1, 1, 1],
      [S1, 2, 0],
      [S2, 1, 0],
      [S2, 7, 5],
    ] as const) {
      await svc.put(page(Buffer.from(`${s}-${pid}-${pageId}`), { osSessionId: s, pid, pageId }));
    }
    const p1 = await svc.list(ALICE, {}, null, 2);
    expect(p1.pages.map((p) => [p.osSessionId, p.pid, p.pageId])).toEqual([
      [S2, 1, 0],
      [S2, 7, 5],
    ]);
    const p2 = await svc.list(ALICE, {}, p1.next ?? null, 2);
    expect(p2.pages.map((p) => [p.osSessionId, p.pid, p.pageId])).toEqual([
      [S1, 1, 0],
      [S1, 1, 1],
    ]);
    const p3 = await svc.list(ALICE, {}, p2.next ?? null, 2);
    expect(p3.pages.map((p) => [p.pid, p.pageId])).toEqual([[2, 0]]);
    expect(p3.next).toBeUndefined();
    expect((await svc.list(ALICE, { osSessionId: S1, pid: 1 })).pages).toHaveLength(2);
    expect(decodeCursor(encodeCursor({ osSessionId: S1, pid: 2, pageId: 9 }))).toEqual({
      osSessionId: S1,
      pid: 2,
      pageId: 9,
    });
    expect((await httpErr(svc.list(ALICE, {}, 'garbage'))).status).toBe(400);
    expect((await httpErr(svc.list(ALICE, {}, null, 1001))).status).toBe(400);
    expect((await httpErr(svc.list(ALICE, { pid: 0 }))).status).toBe(400);
    expect((await httpErr(svc.list(ALICE, { osSessionId: 'x' }))).status).toBe(400);

    expect(await svc.delete(ALICE, S1, 1, 1)).toBe(1);
    expect(await svc.delete(ALICE, S1, 1)).toBe(1);
    expect(await svc.delete(ALICE, S2)).toBe(2);
    expect(await svc.delete(ALICE, '0192f2a0-0000-7000-8000-00000000beef')).toBe(0); // idempotent 204
    expect((await svc.list(ALICE)).pages.map((p) => [p.pid, p.pageId])).toEqual([[2, 0]]);
    expect(
      await blobs.head({ kind: 'swap', ownerUid: ALICE, osSessionId: S2, pid: 7, pageId: 5 }),
    ).toBeNull();
  });

  it('MEM-04 retention removes pages of OS sessions not updated for 30 days, rows first, objects after', async () => {
    let now = Date.UTC(2026, 8, 1);
    const clockDb = new MemorySwapDb(() => now);
    clockDb.sessions.set(S1, ALICE);
    clockDb.sessions.set(S2, ALICE);
    const s = new SwapService({ db: clockDb, blobs, quotaBytes: MIB, maxRawBytes: MIB });
    await s.put(page(Buffer.from('old'), { osSessionId: S1 }));
    now += 29 * 86_400_000;
    await s.put(page(Buffer.from('recent'), { osSessionId: S2 }));
    now += 2 * 86_400_000;
    expect(await s.sweepRetention()).toBe(1);
    expect((await s.list(ALICE)).pages.map((p) => p.osSessionId)).toEqual([S2]);
    expect(
      await blobs.head({ kind: 'swap', ownerUid: ALICE, osSessionId: S1, pid: 42, pageId: 3 }),
    ).toBeNull();
  });

  it('MEM-04 upload headers are accepted in both dialects (backend-api.md and memory-and-paging.md)', () => {
    const c = 'c'.repeat(64);
    expect(
      parseSwapPutHeaders({
        'content-length': '10',
        'x-plotinium-checksum': c,
        'x-plotinium-raw-size': '20',
        'x-plotinium-encoding': 'identity',
      }),
    ).toEqual({
      contentLength: 10,
      checksum: c,
      rawSize: 20,
      encoding: 'identity',
      gen: null,
    });
    expect(
      parseSwapPutHeaders(
        { 'content-length': '10', 'plt-sha256': c.toUpperCase(), 'plt-size': ['20'] },
        { gen: '7' },
      ),
    ).toEqual({
      contentLength: 10,
      checksum: c,
      rawSize: 20,
      encoding: 'gzip',
      gen: 7,
    });
    const status = (h: Record<string, string>, q = {}) => {
      try {
        parseSwapPutHeaders(h, q);
        return 0;
      } catch (e) {
        return (e as HttpError).status;
      }
    };
    expect(status({})).toBe(411);
    expect(status({ 'content-length': 'x' })).toBe(400);
    expect(status({ 'content-length': '1' })).toBe(400);
    expect(status({ 'content-length': '1', 'plt-sha256': c })).toBe(400);
    expect(
      status({
        'content-length': '1',
        'plt-sha256': c,
        'plt-size': '1',
        'x-plotinium-encoding': 'br',
      }),
    ).toBe(400);
    expect(status({ 'content-length': '1', 'plt-sha256': c, 'plt-size': '1' }, { gen: '-1' })).toBe(
      400,
    );
  });
});
