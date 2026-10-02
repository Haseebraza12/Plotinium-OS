/**
 * Tier-1 swap back ends (memory-and-paging.md §3.10; MEM-03, KMM-08): the SwapDevice contract on
 * the in-memory device, OPFS, IndexedDB and the kernel-side client over the blkio protocol, then
 * the back-end specific cases (crash between the .tmp write and the rename, pipelined acks,
 * quota errors, device choice at POST).
 */
import { describe, expect, it } from 'vitest';

import { encodeRaw } from '../core/mm/codec.ts';
import { randomBytes } from '../core/mm/fixtures/doubles.ts';
import { MemorySwapDevice, swapKeyId } from '../core/mm/swap.ts';
import type { SwapDevice } from '../core/mm/swap.ts';
import { openDevice, startBlkioWorker } from './blkio.worker.ts';
import type { BlkioEnv } from './blkio.worker.ts';
import { BlkioClient } from './client.ts';
import { subtleSha256Hex } from './compress.ts';
import { KEY, swapDeviceContract } from './fixtures/contract.ts';
import type { DeviceHarness } from './fixtures/contract.ts';
import { FakeFs, FakeIdbFactory } from './fixtures/fakes.ts';
import { IdbSwapDevice, openIdbSwapStore, SWAP_DB_NAME, SWAP_STORE } from './idb.ts';
import { OpfsSwapDevice } from './opfs.ts';
import { transferList } from './protocol.ts';
import type { BlkioEndpoint, BlkioReply, BlkioRequest } from './protocol.ts';
import { serveBlkio } from './server.ts';

/** A connected pair of endpoints; messages are structured-cloned with their transfer lists. */
function portPair<A, B>(): [BlkioEndpoint<B, A>, BlkioEndpoint<A, B>] {
  const left: BlkioEndpoint<B, A> = {
    onmessage: null,
    postMessage(msg: A, transfer: ArrayBuffer[]) {
      const data = structuredClone(msg, { transfer });
      setTimeout(() => right.onmessage?.({ data }), 0);
    },
  };
  const right: BlkioEndpoint<A, B> = {
    onmessage: null,
    postMessage(msg: B, transfer: ArrayBuffer[]) {
      const data = structuredClone(msg, { transfer });
      setTimeout(() => left.onmessage?.({ data }), 0);
    },
  };
  return [left, right];
}

function opfsHarness(capBytes?: number): { h: DeviceHarness; fs: FakeFs; dev: OpfsSwapDevice } {
  const fs = new FakeFs();
  const dev = new OpfsSwapDevice(fs.root, {
    ...(capBytes === undefined ? {} : { capBytes }),
    now: () => fs.now,
    digestHex: subtleSha256Hex,
  });
  const h: DeviceHarness = {
    dev,
    setNow: (t) => {
      fs.now = t;
    },
    corruptNextReadBacks: (n) => {
      fs.faults.corruptReads = n;
    },
    corruptStored: (key, gen) => {
      const node = fs.root.node(
        `swap/u${key.uid}/${key.osSession}/${key.pid}/p${key.pageId}-g${gen}.pg`,
      );
      if (node)
        node.data[node.data.byteLength - 1] = (node.data[node.data.byteLength - 1] ?? 0) ^ 0xff;
      return Promise.resolve();
    },
  };
  return { h, fs, dev };
}

async function idbHarness(
  capBytes?: number,
): Promise<{ h: DeviceHarness; factory: FakeIdbFactory; dev: IdbSwapDevice }> {
  const factory = new FakeIdbFactory();
  let now = 1_000;
  const store = await openIdbSwapStore(factory);
  const dev = new IdbSwapDevice(store, {
    ...(capBytes === undefined ? {} : { capBytes }),
    now: () => now,
    digestHex: subtleSha256Hex,
  });
  await dev.init();
  const h: DeviceHarness = {
    dev,
    keepsPreviousGeneration: false,
    setNow: (t) => {
      now = t;
    },
    corruptNextReadBacks: (n) => {
      factory.faults.corruptGets = n;
    },
    corruptStored: (key) => {
      const row = factory.dbs
        .get(SWAP_DB_NAME)
        ?.get(SWAP_STORE)
        ?.get(JSON.stringify([key.uid, key.osSession, key.pid, key.pageId]));
      const body = (row?.value as { body?: ArrayBuffer } | undefined)?.body;
      if (body) {
        const u8 = new Uint8Array(body);
        u8[0] = (u8[0] ?? 0) ^ 0xff;
      }
      return Promise.resolve();
    },
  };
  return { h, factory, dev };
}

swapDeviceContract('memory', ({ capBytes }) => {
  let now = 1_000;
  const dev = new MemorySwapDevice({
    ...(capBytes === undefined ? {} : { capBytes }),
    now: () => now,
  });
  return Promise.resolve({
    dev,
    setNow: (t: number) => {
      now = t;
    },
    corruptNextReadBacks: (n: number) => dev.corruptNextReadBacks(n),
    corruptStored: (key, gen) => {
      dev.corruptStored(key, gen);
      return Promise.resolve();
    },
  });
});

swapDeviceContract('opfs', ({ capBytes }) => Promise.resolve(opfsHarness(capBytes).h));

swapDeviceContract('idb', async ({ capBytes }) => (await idbHarness(capBytes)).h);

swapDeviceContract('blkio client over opfs', async ({ capBytes }) => {
  const { h } = opfsHarness(capBytes);
  const [kernelSide, workerSide] = portPair<BlkioRequest, BlkioReply>();
  serveBlkio(workerSide, () => Promise.resolve({ device: h.dev, capBytes: capBytes ?? 1 }));
  const client = await BlkioClient.connect(kernelSide, capBytes === undefined ? {} : { capBytes });
  expect(client.kind).toBe('opfs');
  return { ...h, dev: client };
});

describe('OPFS back end (§3.10.1)', () => {
  it('MEM-03 pages live at swap/u<uid>/<osSession>/<pid>/p<pageId>-g<gen>.pg and no .tmp survives a verified write', async () => {
    const { fs, dev } = opfsHarness();
    const pg = encodeRaw(randomBytes(1_000, 1).buffer);
    await dev.write(KEY, 3, pg.header.slice(0), pg.body.slice(0), pg.sha256);
    expect(fs.root.paths()).toEqual([`swap/u1000/${KEY.osSession}/412/p3-g3.pg`]);
  });

  it('MEM-03 a crash between the tmp write and the rename leaves the previous generation valid and the sweep removes the tmp file', async () => {
    const { fs, dev } = opfsHarness();
    const a = encodeRaw(randomBytes(2_000, 1).buffer);
    const b = encodeRaw(randomBytes(2_000, 2).buffer);
    expect((await dev.write(KEY, 1, a.header.slice(0), a.body.slice(0), a.sha256)).ok).toBe(true);
    fs.faults.crashOnMove = 1;
    const w = await dev.write(KEY, 2, b.header.slice(0), b.body.slice(0), b.sha256);
    expect(w).toMatchObject({ ok: false, errno: 'EIO' });
    expect(fs.root.paths()).toEqual([
      `swap/u1000/${KEY.osSession}/412/p3-g1.pg`,
      `swap/u1000/${KEY.osSession}/412/p3-g2.tmp`,
    ]);
    expect((await dev.read(KEY, 1, a.sha256)).ok).toBe(true);
    // Boot: a fresh device rebuilds its index and the sweep repairs the tree.
    const rebooted = new OpfsSwapDevice(fs.root, { now: () => fs.now, digestHex: subtleSha256Hex });
    await rebooted.init();
    expect(await rebooted.usage()).toEqual({ bytes: 2_064, files: 1 });
    const swept = await rebooted.sweep(
      [{ uid: KEY.uid, osSession: KEY.osSession }],
      14 * 86_400_000,
    );
    expect(swept.files).toBe(1);
    expect(fs.root.paths()).toEqual([`swap/u1000/${KEY.osSession}/412/p3-g1.pg`]);
    expect((await rebooted.read(KEY, 1, a.sha256)).ok).toBe(true);
  });

  it('MEM-03 the sweep keeps only the highest generation of a page (two generations after a crash)', async () => {
    const { fs, dev } = opfsHarness();
    const a = encodeRaw(randomBytes(100, 1).buffer);
    await dev.write(KEY, 1, a.header.slice(0), a.body.slice(0), a.sha256);
    // Simulate a crash after the rename but before the old generation was deleted.
    const dir = fs.root.dirs
      .get('swap')
      ?.dirs.get('u1000')
      ?.dirs.get(KEY.osSession)
      ?.dirs.get('412');
    const node = dir?.files.get('p3-g1.pg');
    if (dir && node) dir.files.set('p3-g2.pg', { ...node, data: node.data.slice() });
    dir?.files.set('junk.bin', { data: new Uint8Array(4), mtime: fs.now, locked: false });
    const rebooted = new OpfsSwapDevice(fs.root, { now: () => fs.now, digestHex: subtleSha256Hex });
    await rebooted.init();
    const r = await rebooted.sweep([{ uid: KEY.uid, osSession: KEY.osSession }], 1);
    expect(r.files).toBe(2);
    expect(fs.root.paths()).toEqual([`swap/u1000/${KEY.osSession}/412/p3-g2.pg`]);
  });

  it('KMM-08 bench: page-out pipelining keeps 4 pages in flight and acknowledges them in submission order, hashing each buffer once', async () => {
    const { fs, dev } = opfsHarness();
    let digests = 0;
    const slowDigest = async (b: Uint8Array<ArrayBuffer>): Promise<string> => {
      digests++;
      // The first digest is the slowest: later pages must still be acknowledged after it.
      await new Promise<void>((r) => setTimeout(r, digests === 1 ? 20 : 1));
      return subtleSha256Hex(b);
    };
    const piped = new OpfsSwapDevice(fs.root, { now: () => fs.now, digestHex: slowDigest });
    const pages = [1, 2, 3, 4].map((i) => encodeRaw(randomBytes(50_000, i).buffer));
    const order: number[] = [];
    const writes = pages.map((p, i) =>
      piped
        .write({ ...KEY, pageId: i }, 1, p.header.slice(0), p.body.slice(0), p.sha256)
        .then((r) => {
          order.push(i);
          return r;
        }),
    );
    // All four were written before the first digest finished (the writes overlap the hashing).
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(fs.writes).toBe(8);
    const results = await Promise.all(writes);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(digests).toBe(4);
    void dev;
  });

  it('MEM-03 QuotaExceededError maps to EDQUOT; a header that does not match its hash is EIO; a truncated file is EIO', async () => {
    const { fs, dev } = opfsHarness();
    const pg = encodeRaw(randomBytes(500, 1).buffer);
    fs.faults.quotaWrites = 1;
    expect(await dev.write(KEY, 1, pg.header.slice(0), pg.body.slice(0), pg.sha256)).toMatchObject({
      ok: false,
      errno: 'EDQUOT',
    });
    expect(
      await dev.write(KEY, 1, pg.header.slice(0), pg.body.slice(0), '0'.repeat(64)),
    ).toMatchObject({ ok: false, errno: 'EIO' });
    expect(await dev.write(KEY, 1, new ArrayBuffer(10), pg.body.slice(0), pg.sha256)).toMatchObject(
      { ok: false, errno: 'EIO' },
    );
    expect((await dev.write(KEY, 1, pg.header.slice(0), pg.body.slice(0), pg.sha256)).ok).toBe(
      true,
    );
    const node = fs.root.node(`swap/u1000/${KEY.osSession}/412/p3-g1.pg`);
    if (node) node.data = node.data.slice(0, 100);
    expect(await dev.read(KEY, 1, pg.sha256)).toMatchObject({ ok: false, errno: 'EIO' });
    if (node) node.data = new Uint8Array(100);
    expect(await dev.read(KEY, 1, pg.sha256)).toMatchObject({ ok: false, errno: 'EIO' });
    // A locked file (another handle open) is an I/O error, not a crash.
    if (node) node.locked = true;
    expect(await dev.read(KEY, 1, pg.sha256)).toMatchObject({ ok: false, errno: 'EIO' });
    // An empty page is valid.
    const empty = encodeRaw(new ArrayBuffer(0));
    await dev.write(
      { ...KEY, pageId: 9 },
      1,
      empty.header.slice(0),
      empty.body.slice(0),
      empty.sha256,
    );
    expect((await dev.read({ ...KEY, pageId: 9 }, 1, empty.sha256)).ok).toBe(true);
    // Deleting in an unknown directory is harmless; so is a sweep of an empty root.
    await dev.delete({ ...KEY, pid: 5 });
    expect(
      await new OpfsSwapDevice(new FakeFs().root, { digestHex: subtleSha256Hex }).sweep([], 0),
    ).toEqual({ files: 0, bytes: 0 });
  });
});

describe('IndexedDB back end (§3.10.2)', () => {
  it('MEM-03 the IndexedDB swap back end passes the same byte-identity and verify tests (plotinium-swap, key [uid, osSession, pid, pageId])', async () => {
    const { factory, dev } = await idbHarness();
    const pg = encodeRaw(randomBytes(10_000, 3).buffer);
    expect((await dev.write(KEY, 1, pg.header.slice(0), pg.body.slice(0), pg.sha256)).ok).toBe(
      true,
    );
    const table = factory.dbs.get(SWAP_DB_NAME)?.get(SWAP_STORE);
    expect([...(table?.keys() ?? [])]).toEqual([JSON.stringify([1000, KEY.osSession, 412, 3])]);
    // Re-opening finds the store and the usage.
    const again = new IdbSwapDevice(await openIdbSwapStore(factory), {
      digestHex: subtleSha256Hex,
    });
    await again.init();
    expect(await again.usage()).toEqual({ bytes: 10_064, files: 1 });
    expect(swapKeyId(KEY)).toContain('412');
  });

  it('MEM-03 QuotaExceededError maps to EDQUOT; bad headers are EIO; open failures reject', async () => {
    const { factory, dev } = await idbHarness();
    const pg = encodeRaw(randomBytes(100, 3).buffer);
    factory.faults.quota = 1;
    expect(await dev.write(KEY, 1, pg.header.slice(0), pg.body.slice(0), pg.sha256)).toMatchObject({
      ok: false,
      errno: 'EDQUOT',
    });
    expect(await dev.write(KEY, 1, new ArrayBuffer(3), pg.body.slice(0), pg.sha256)).toMatchObject({
      ok: false,
      errno: 'EIO',
    });
    expect(
      await dev.write(KEY, 1, pg.header.slice(0), pg.body.slice(0), '1'.repeat(64)),
    ).toMatchObject({ ok: false, errno: 'EIO' });
    expect((await dev.write(KEY, 1, pg.header.slice(0), pg.body.slice(0), pg.sha256)).ok).toBe(
      true,
    );
    await dev.delete(KEY, [7]);
    expect((await dev.read(KEY, 1, pg.sha256)).ok).toBe(true);
    const broken = new FakeIdbFactory();
    broken.faults.failOpen = true;
    await expect(openIdbSwapStore(broken)).rejects.toMatchObject({ name: 'UnknownError' });
  });
});

describe('blkio worker (§3.10)', () => {
  function env(over: Partial<BlkioEnv> = {}): BlkioEnv {
    const fs = new FakeFs();
    return {
      opfs: true,
      getDirectory: () => Promise.resolve(fs.root),
      indexedDB: new FakeIdbFactory(),
      estimate: () => Promise.resolve({ quota: 10 * 1_073_741_824, usage: 0 }),
      digestHex: subtleSha256Hex,
      now: () => 0,
      ...over,
    };
  }

  it('MEM-03 POST chooses OPFS when sync access handles exist, else the IndexedDB plotinium-swap fallback', async () => {
    const opfs = await openDevice({ t: 'init', id: 1 }, env());
    expect(opfs.device.kind).toBe('opfs');
    expect(opfs.capBytes).toBe(2 * 1_073_741_824);
    expect(opfs.fallback).toBeUndefined();
    const idb = await openDevice(
      { t: 'init', id: 1 },
      env({ opfs: false, estimate: () => Promise.reject(new Error('no')) }),
    );
    expect(idb.device.kind).toBe('idb');
    expect(idb.fallback).toBe('no OPFS sync access handles');
    expect(idb.capBytes).toBe(2 * 1_073_741_824);
    const requested = await openDevice({ t: 'init', id: 1, prefer: 'idb', capBytes: 5 }, env());
    expect(requested.device.kind).toBe('idb');
    expect(requested.capBytes).toBe(5);
    const failing = await openDevice(
      { t: 'init', id: 1 },
      env({ getDirectory: () => Promise.reject(new Error('SecurityError')) }),
    );
    expect(failing.fallback).toContain('opfs failed');
    await expect(
      openDevice({ t: 'init', id: 1 }, env({ opfs: false, indexedDB: null })),
    ).rejects.toThrow('no swap device');
  });

  it('MEM-03 the worker serves the protocol, streams progress and reports device errors as EIO', async () => {
    const [kernelSide, workerSide] = portPair<BlkioRequest, BlkioReply>();
    let t = 0;
    const stop = startBlkioWorker(workerSide, env({ opfs: false, now: () => t }));
    const client = await BlkioClient.connect(kernelSide);
    expect(client.kind).toBe('idb');
    expect(client.fallback).toBe('no OPFS sync access handles');
    const pg = encodeRaw(randomBytes(300_000, 1).buffer);
    expect((await client.write(KEY, 1, pg.header.slice(0), pg.body.slice(0), pg.sha256)).ok).toBe(
      true,
    );
    const seen: number[] = [];
    expect((await client.read(KEY, 1, pg.sha256, (d) => seen.push(d))).ok).toBe(true);
    expect(seen.at(-1)).toBe(300_000);
    expect(await client.usage()).toEqual({ bytes: 300_064, files: 1 });
    t = 100;
    expect(await client.sweep([], 1)).toEqual({ files: 1, bytes: 300_064 });
    stop();
    expect(workerSide.onmessage).toBeNull();

    // A device that throws: the client gets EIO answers, never a hang.
    const [k2, w2] = portPair<BlkioRequest, BlkioReply>();
    const throwing: SwapDevice = {
      kind: 'memory',
      write: () => Promise.reject(new Error('disk gone')),
      read: () => Promise.reject(new Error('disk gone')),
      delete: () => Promise.reject(new Error('disk gone')),
      deleteSession: () => Promise.resolve(),
      sweep: () => Promise.reject(new Error('disk gone')),
      usage: () => Promise.reject(new Error('disk gone')),
    };
    serveBlkio(w2, () => Promise.resolve({ device: throwing, capBytes: 0 }));
    const c2 = new BlkioClient(k2); // no init: the server opens its device on first use
    expect(await c2.write(KEY, 1, new ArrayBuffer(64), new ArrayBuffer(0), 'x')).toMatchObject({
      ok: false,
      errno: 'EIO',
    });
    expect(await c2.read(KEY, 1, 'x')).toMatchObject({ ok: false, errno: 'EIO' });
    expect(await c2.sweep([], 0)).toEqual({ files: 0, bytes: 0 });
    expect(await c2.usage()).toEqual({ bytes: 0, files: 0 });
    await c2.delete(KEY, [1]);
    await c2.deleteSession(1, 's');
    const [k3, w3] = portPair<BlkioRequest, BlkioReply>();
    serveBlkio(w3, () => Promise.reject(new Error('no device')));
    await expect(BlkioClient.connect(k3)).rejects.toThrow('no device');
  });

  it('MEM-03 transfer lists carry every page buffer', () => {
    const header = new ArrayBuffer(64);
    const body = new ArrayBuffer(8);
    expect(transferList({ t: 'write', id: 1, key: KEY, gen: 1, header, body, sha256: '' })).toEqual(
      [header, body],
    );
    expect(transferList({ t: 'written', id: 1, result: { ok: true, body, ms: 0 } })).toEqual([
      body,
    ]);
    expect(
      transferList({ t: 'readDone', id: 1, result: { ok: true, body, header, ms: 0 } }),
    ).toEqual([header, body]);
    expect(transferList({ t: 'readDone', id: 1, result: { ok: false, errno: 'ENOENT' } })).toEqual(
      [],
    );
    expect(transferList({ t: 'usage', id: 1 })).toEqual([]);
  });
});
