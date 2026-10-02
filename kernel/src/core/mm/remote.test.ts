/**
 * Tier-2 client and the write-behind queue (memory-and-paging.md §3.11, §4.5; MEM-04, MEM-05,
 * KMM-09). A fake /api/swap server stores gzip bodies and checks the checksum over the
 * uncompressed bytes, as backend-api.md §3.11 requires.
 */
import { describe, expect, it } from 'vitest';

import { gunzipAll, streamGzip, streamOf, subtleSha256Hex } from '../../blkio/compress.ts';
import { bytesEqual, encodeRaw, joinPageFile, sha256Hex } from './codec.ts';
import { ManualClock, randomBytes } from './fixtures/doubles.ts';
import { HttpRemoteSwap, SWAP_HEADERS } from './remote.ts';
import type { ByteStream, FetchLike, HttpRequestInit, HttpResponseLike } from './remote.ts';
import type { RemoteSwap, SwapKey } from './swap.ts';
import { WriteBehindQueue } from './writebehind.ts';

const key: SwapKey = { uid: 1000, osSession: 'sess-1', pid: 601, pageId: 2 };

function response(
  status: number,
  body: unknown,
  stream?: ByteStream,
  headers: Record<string, string> = {},
): HttpResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => headers[n] ?? null },
    body: stream ?? null,
    json: () => (body === undefined ? Promise.reject(new Error('no json')) : Promise.resolve(body)),
  };
}

/** A fake /api/swap: owner check, gzip storage, checksum over the uncompressed bytes. */
class FakeSwapServer {
  readonly store = new Map<string, { gz: ArrayBuffer; raw: number; checksum: string }>();
  readonly requests: Array<{ url: string; init: HttpRequestInit }> = [];
  owner = 1000;
  sessionUid = 1000;
  mode: 'ok' | 'wrong-hash' | '500' | '401' | '429' | 'throw' | 'bad-json' = 'ok';

  readonly fetch: FetchLike = async (url, init) => {
    this.requests.push({ url, init });
    if (this.mode === 'throw') throw new Error('network down');
    const path = url.split('?')[0] ?? url;
    if (this.sessionUid !== this.owner) return response(403, { errno: 'EACCES' });
    if (init.method === 'PUT') {
      if (this.mode === '500') return response(500, { errno: 'EIO' });
      if (this.mode === '401') return response(401, {});
      if (this.mode === '429') return response(429, { retryAfterMs: 3_000 });
      const gz = init.body ?? new ArrayBuffer(0);
      const raw = await gunzipAll(gz);
      const checksum = sha256Hex(raw);
      if (checksum !== init.headers?.[SWAP_HEADERS.checksum])
        return response(422, { errno: 'EIO', reason: 'checksum' });
      this.store.set(path, { gz, raw: raw.byteLength, checksum });
      if (this.mode === 'bad-json') return response(200, undefined);
      return response(201, {
        stored: true,
        checksum: this.mode === 'wrong-hash' ? '0'.repeat(64) : checksum,
      });
    }
    if (init.method === 'GET') {
      const rec = this.store.get(path);
      if (!rec) return response(404, {});
      return response(200, undefined, streamOf(rec.gz), {
        [SWAP_HEADERS.rawSize]: String(rec.raw),
        [SWAP_HEADERS.encoding]: 'gzip',
      });
    }
    this.store.delete(path);
    return response(204, undefined);
  };
}

function pageFile(
  n = 300_000,
  seed = 3,
): { file: ArrayBuffer; sha: string; header: ArrayBuffer; body: ArrayBuffer } {
  const enc = encodeRaw(randomBytes(n, seed).buffer);
  return {
    file: joinPageFile(enc.header, enc.body),
    sha: enc.sha256,
    header: enc.header,
    body: enc.body,
  };
}

describe('HttpRemoteSwap (tier 2)', () => {
  it('MEM-04 put uploads gzip with the checksum of the uncompressed bytes and get restores a verified page', async () => {
    const server = new FakeSwapServer();
    const remote = new HttpRemoteSwap({
      fetch: server.fetch,
      gzip: streamGzip,
      digestHex: subtleSha256Hex,
    });
    const pg = pageFile();
    const put = await remote.put(key, 3, pg.file, pg.sha);
    expect(put).toEqual({ ok: true, status: 201 });
    const req = server.requests[0];
    expect(req?.url).toBe('/api/swap/sess-1/601/2?gen=3');
    expect(req?.init.headers?.[SWAP_HEADERS.encoding]).toBe('gzip');
    expect(req?.init.headers?.[SWAP_HEADERS.rawSize]).toBe(String(pg.file.byteLength));
    expect(req?.init.headers?.[SWAP_HEADERS.checksum]).toBe(sha256Hex(pg.file));
    const progress: number[] = [];
    const got = await remote.get(key, 3, pg.sha, (d) => progress.push(d));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(bytesEqual(got.body, pg.body)).toBe(true);
    expect(progress.at(-1)).toBe(pg.file.byteLength);
  });

  it('MEM-04 an acknowledgement with a different hash is not acked (INV-M6); failures report their status', async () => {
    const server = new FakeSwapServer();
    const remote = new HttpRemoteSwap({
      fetch: server.fetch,
      gzip: streamGzip,
      baseUrl: '/api/swap/',
    });
    const pg = pageFile(1_000);
    server.mode = 'wrong-hash';
    expect(await remote.put(key, 1, pg.file, pg.sha)).toEqual({ ok: false, status: 422 });
    server.mode = 'bad-json';
    expect((await remote.put(key, 1, pg.file, pg.sha)).ok).toBe(false);
    server.mode = '500';
    expect(await remote.put(key, 1, pg.file, pg.sha)).toEqual({ ok: false, status: 500 });
    server.mode = '429';
    expect(await remote.put(key, 1, pg.file, pg.sha)).toEqual({
      ok: false,
      status: 429,
      retryAfterMs: 3_000,
    });
  });

  it("MEM-04 another user's swap page answers 403 and the fault reports EACCES; a missing page is ENOENT", async () => {
    const server = new FakeSwapServer();
    const remote = new HttpRemoteSwap({ fetch: server.fetch, gzip: streamGzip });
    const pg = pageFile(1_000);
    await remote.put(key, 1, pg.file, pg.sha);
    expect(await remote.get({ ...key, pageId: 9 }, 1, pg.sha)).toEqual({
      ok: false,
      errno: 'ENOENT',
    });
    server.sessionUid = 2000;
    expect(await remote.get(key, 1, pg.sha)).toEqual({ ok: false, errno: 'EACCES' });
    server.sessionUid = 1000;
    expect(await remote.get(key, 1, 'f'.repeat(64))).toEqual({ ok: false, errno: 'EIO' });
    server.mode = 'throw';
    expect(await remote.get(key, 1, pg.sha)).toEqual({ ok: false, errno: 'EIO' });
    await remote.delete(key);
    await remote.deleteSession('sess-1');
    server.mode = 'ok';
    await remote.delete(key);
    expect(server.store.size).toBe(0);
    await remote.deleteSession('sess-1');
    expect(server.requests.at(-1)?.url).toBe('/api/swap/sess-1');
  });

  it('MEM-05 get handles identity encoding, non-ok answers and Retry-After headers', async () => {
    const pg = pageFile(2_000);
    const identity: FetchLike = (_url, init) =>
      Promise.resolve(
        init.method === 'GET'
          ? response(200, undefined, streamOf(pg.file), { [SWAP_HEADERS.encoding]: 'identity' })
          : response(503, undefined, undefined, { 'Retry-After': '2' }),
      );
    const remote = new HttpRemoteSwap({ fetch: identity, gzip: streamGzip });
    const got = await remote.get(key, 1, pg.sha);
    expect(got.ok).toBe(true);
    expect(await remote.put(key, 1, pg.file, pg.sha)).toEqual({
      ok: false,
      status: 503,
      retryAfterMs: 2_000,
    });
    const broken: FetchLike = () => Promise.resolve(response(500, {}));
    expect(
      await new HttpRemoteSwap({ fetch: broken, gzip: streamGzip }).get(key, 1, pg.sha),
    ).toEqual({ ok: false, errno: 'EIO' });
    const short: FetchLike = () =>
      Promise.resolve(response(200, undefined, streamOf(new Uint8Array(10))));
    expect(
      await new HttpRemoteSwap({ fetch: short, gzip: { ...streamGzip, gunzip: (s) => s } }).get(
        key,
        1,
        pg.sha,
      ),
    ).toEqual({ ok: false, errno: 'EIO' });
  });
});

/** A scripted RemoteSwap for the queue tests. */
class ScriptedRemote implements RemoteSwap {
  readonly puts: Array<{ pageId: number; gen: number }> = [];
  script: Array<{ ok: boolean; status: number; retryAfterMs?: number }> = [];
  put(k: SwapKey, gen: number): Promise<{ ok: boolean; status: number; retryAfterMs?: number }> {
    this.puts.push({ pageId: k.pageId, gen });
    return Promise.resolve(this.script.shift() ?? { ok: true, status: 201 });
  }
  get(): Promise<{ ok: false; errno: 'ENOENT' }> {
    return Promise.resolve({ ok: false, errno: 'ENOENT' });
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  deleteSession(): Promise<void> {
    return Promise.resolve();
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('WriteBehindQueue (§3.11)', () => {
  const params = { uploadConcurrency: 2, uploadBackoffMaxMs: 60_000, uploadMaxAttempts: 5 };
  const pg = pageFile(100);
  const reader = (): Promise<{ header: ArrayBuffer; body: ArrayBuffer }> =>
    Promise.resolve({ header: pg.header, body: pg.body });

  it('MEM-04 write-behind: every queued page is uploaded while online, window checkpoints first', async () => {
    const clock = new ManualClock();
    const remote = new ScriptedRemote();
    const acked: number[] = [];
    const q = new WriteBehindQueue(
      remote,
      reader,
      clock,
      { ...params, uploadConcurrency: 1 },
      {
        acked: (k) => acked.push(k.pageId),
        failed: () => undefined,
      },
    );
    q.enqueue({ ...key, pageId: 1 }, 1, pg.sha);
    q.enqueue({ ...key, pageId: 2 }, 1, pg.sha, { window: true });
    q.enqueue({ ...key, pageId: 1 }, 2, pg.sha); // supersedes the queued generation 1
    q.enqueue({ ...key, pageId: 1 }, 1, pg.sha); // an older generation never replaces a newer one
    expect(q.pending).toBe(2);
    expect(q.isOnline).toBe(false);
    q.setOnline(true);
    await q.drain();
    expect(remote.puts).toEqual([
      { pageId: 2, gen: 1 },
      { pageId: 1, gen: 2 },
    ]);
    expect(acked).toEqual([2, 1]);
    expect(q.bytesUploaded).toBe(2 * pg.file.byteLength);
    expect(q.inflightBytes).toBe(0);
  });

  it('MEM-04 failures back off 1, 2, 4 s, 429 honours retryAfterMs, and 5 failures mark the copy failed', async () => {
    const clock = new ManualClock();
    const remote = new ScriptedRemote();
    const failedPages: number[] = [];
    const attempts: number[] = [];
    const q = new WriteBehindQueue(remote, reader, clock, params, {
      acked: () => undefined,
      failed: (k) => failedPages.push(k.pageId),
      attemptFailed: (_k, _g, _s, n) => attempts.push(n),
    });
    remote.script = [
      { ok: false, status: 429, retryAfterMs: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 0 },
      { ok: false, status: 500 },
      { ok: false, status: 500 },
    ];
    q.setOnline(true);
    q.enqueue(key, 1, pg.sha);
    await flush();
    expect(remote.puts).toHaveLength(1);
    clock.advance(500);
    await flush();
    expect(remote.puts).toHaveLength(2);
    clock.advance(999);
    await flush();
    expect(remote.puts).toHaveLength(2);
    clock.advance(1);
    await flush();
    expect(remote.puts).toHaveLength(3);
    clock.advance(2_000);
    await flush();
    clock.advance(4_000);
    await flush();
    clock.advance(8_000);
    await flush();
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(failedPages).toEqual([2]);
    expect(q.failed).toBe(1);
    expect(q.pending).toBe(0);
  });

  it('MEM-04 a 401 pauses the queue until syncd is LIVE again; offline uploads wait', async () => {
    const clock = new ManualClock();
    const remote = new ScriptedRemote();
    const acked: number[] = [];
    const q = new WriteBehindQueue(remote, reader, clock, params, {
      acked: (k) => acked.push(k.pageId),
      failed: () => undefined,
    });
    remote.script = [{ ok: false, status: 401 }];
    q.setOnline(true);
    q.enqueue(key, 1, pg.sha);
    await flush();
    expect(q.isOnline).toBe(false);
    expect(q.pending).toBe(1);
    q.pump();
    await flush();
    expect(remote.puts).toHaveLength(1);
    q.setOnline(true);
    await q.drain();
    expect(acked).toEqual([2]);
    q.setOnline(false);
    q.enqueue({ ...key, pageId: 5 }, 1, pg.sha);
    q.remove({ ...key, pageId: 5 });
    expect(q.pending).toBe(0);
  });

  it('MEM-04 a page that is gone or unreadable is skipped, and a thrown upload counts as a failure', async () => {
    const clock = new ManualClock();
    const remote = new ScriptedRemote();
    let calls = 0;
    const q = new WriteBehindQueue(
      {
        ...remote,
        put: () => Promise.reject(new Error('boom')),
        get: remote.get.bind(remote),
        delete: remote.delete.bind(remote),
        deleteSession: remote.deleteSession.bind(remote),
      },
      () => {
        calls++;
        return calls === 1
          ? Promise.resolve(null)
          : calls === 2
            ? Promise.reject(new Error('x'))
            : reader();
      },
      clock,
      params,
      { acked: () => undefined, failed: () => undefined },
    );
    q.setOnline(true);
    q.enqueue({ ...key, pageId: 1 }, 1, pg.sha);
    q.enqueue({ ...key, pageId: 2 }, 1, pg.sha);
    q.enqueue({ ...key, pageId: 3 }, 1, pg.sha);
    await flush();
    expect(q.pending).toBe(1); // page 3 failed once and waits for its retry
    expect(clock.pendingTimers).toBe(1);
  });
});
