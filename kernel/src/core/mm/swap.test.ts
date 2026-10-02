/**
 * The in-memory swap device and the swap naming helpers (memory-and-paging.md §3.10, §4.4;
 * MEM-03). The OPFS and IndexedDB back ends run the same contract tests in kernel/src/blkio.
 */
import { describe, expect, it } from 'vitest';

import { bytesEqual, encodeRaw } from './codec.ts';
import { randomBytes } from './fixtures/doubles.ts';
import {
  MemorySwapDevice,
  pageFileName,
  parsePageFileName,
  swapKeyId,
  tmpFileName,
} from './swap.ts';
import type { SwapKey } from './swap.ts';

const key: SwapKey = {
  uid: 1000,
  osSession: '0190c2d4-aaaa-7bbb-8ccc-000000000001',
  pid: 412,
  pageId: 3,
};

function page(n: number, seed = 1): ReturnType<typeof encodeRaw> {
  return encodeRaw(randomBytes(n, seed).buffer);
}

describe('swap naming (§3.10.1)', () => {
  it('MEM-03 page files carry the generation and parse back; foreign names are ignored', () => {
    expect(pageFileName(3, 7)).toBe('p3-g7.pg');
    expect(tmpFileName(3, 7)).toBe('p3-g7.tmp');
    expect(parsePageFileName('p3-g7.pg')).toEqual({ pageId: 3, gen: 7, tmp: false });
    expect(parsePageFileName('p12-g0.tmp')).toEqual({ pageId: 12, gen: 0, tmp: true });
    expect(parsePageFileName('notes.txt')).toBeUndefined();
    expect(swapKeyId(key)).toBe('1000/0190c2d4-aaaa-7bbb-8ccc-000000000001/412/3');
  });
});

describe('MemorySwapDevice', () => {
  it('MEM-03 a written page reads back byte-identical and verified', async () => {
    let now = 10;
    const dev = new MemorySwapDevice({ now: () => now });
    const pg = page(5_000);
    const w = await dev.write(key, 1, pg.header, pg.body, pg.sha256);
    expect(w.ok).toBe(true);
    now = 30;
    const progress: Array<[number, number]> = [];
    const r = await dev.read(key, 1, pg.sha256, (d, t) => progress.push([d, t]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bytesEqual(r.body, pg.body)).toBe(true);
    expect(bytesEqual(r.header, pg.header)).toBe(true);
    expect(progress.at(-1)).toEqual([5_000, 5_000]);
    expect(await dev.usage()).toEqual({ bytes: 64 + 5_000, files: 1 });
    expect(dev.has(key, 1)).toBe(true);
    expect(dev.writes).toBe(1);
    expect(dev.reads).toBe(1);
  });

  it('MEM-03 a corrupted read-back is rewritten once; a second mismatch is EIO and the body comes back', async () => {
    const dev = new MemorySwapDevice();
    const pg = page(1_000);
    dev.corruptNextReadBacks(1);
    expect((await dev.write(key, 1, pg.header, pg.body, pg.sha256)).ok).toBe(true);
    dev.corruptNextReadBacks(2);
    const w = await dev.write(key, 2, pg.header, pg.body, pg.sha256);
    expect(w).toMatchObject({ ok: false, errno: 'EIO' });
    expect(w.body).toBe(pg.body);
    // The previous generation is still valid.
    expect((await dev.read(key, 1, pg.sha256)).ok).toBe(true);
    // An empty page corrupts the header copy instead.
    const empty = encodeRaw(new ArrayBuffer(0));
    dev.corruptNextReadBacks(2);
    expect(
      (await dev.write({ ...key, pageId: 9 }, 1, empty.header, empty.body, empty.sha256)).ok,
    ).toBe(false);
  });

  it('MEM-03 bit rot is detected on read (EIO checksum) and a missing generation is ENOENT', async () => {
    const dev = new MemorySwapDevice();
    const pg = page(100);
    await dev.write(key, 1, pg.header, pg.body, pg.sha256);
    expect(await dev.read(key, 2, pg.sha256)).toEqual({ ok: false, errno: 'ENOENT' });
    expect(await dev.read(key, 1, '0'.repeat(64))).toEqual({
      ok: false,
      errno: 'EIO',
      reason: 'checksum',
    });
    expect(dev.corruptStored(key, 1)).toBe(true);
    expect(dev.corruptStored(key, 5)).toBe(false);
    expect(await dev.read(key, 1, pg.sha256)).toEqual({
      ok: false,
      errno: 'EIO',
      reason: 'checksum',
    });
  });

  it('MEM-03 a newer generation replaces the older one; capacity overflow answers EDQUOT', async () => {
    const dev = new MemorySwapDevice({ capBytes: 64 * 2 + 250 });
    const a = page(100, 1);
    const b = page(100, 2);
    await dev.write(key, 1, a.header, a.body, a.sha256);
    await dev.write(key, 2, b.header, b.body, b.sha256);
    expect(dev.has(key, 1)).toBe(false);
    expect(dev.has(key, 2)).toBe(true);
    const big = page(200, 3);
    expect(
      await dev.write({ ...key, pageId: 4 }, 1, big.header, big.body, big.sha256),
    ).toMatchObject({ ok: false, errno: 'EDQUOT' });
    dev.failNextWrites(1, 'EIO');
    expect(await dev.write({ ...key, pageId: 5 }, 1, a.header, a.body, a.sha256)).toMatchObject({
      ok: false,
      errno: 'EIO',
    });
    dev.failNextWrites(1);
    expect((await dev.write({ ...key, pageId: 5 }, 1, a.header, a.body, a.sha256)).ok).toBe(false);
  });

  it('MEM-03 delete, deleteSession and the boot sweep keep only what is referenced', async () => {
    let now = 0;
    const dev = new MemorySwapDevice({ now: () => now });
    const pg = page(10);
    const other: SwapKey = { ...key, osSession: 'old-session' };
    await dev.write(key, 1, pg.header, pg.body, pg.sha256);
    await dev.write({ ...key, pageId: 4 }, 1, pg.header, pg.body, pg.sha256);
    await dev.write(other, 1, pg.header, pg.body, pg.sha256);
    now = 20 * 86_400_000;
    const swept = await dev.sweep([{ uid: 1000, osSession: key.osSession }], 14 * 86_400_000);
    expect(swept).toEqual({ files: 1, bytes: 74 });
    expect(dev.has(other, 1)).toBe(false);
    expect(dev.has(key, 1)).toBe(true);
    await dev.delete(key, [7]);
    expect(dev.has(key, 1)).toBe(true);
    await dev.delete(key, [1]);
    expect(dev.has(key, 1)).toBe(false);
    await dev.delete(key);
    await dev.deleteSession(1000, key.osSession);
    expect(await dev.usage()).toEqual({ bytes: 0, files: 0 });
  });
});
