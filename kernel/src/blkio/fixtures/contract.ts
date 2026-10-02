/**
 * TEST-ONLY: the SwapDevice contract (memory-and-paging.md §3.10, §4.4; MEM-03), run against every
 * tier-1 back end: the in-memory device, OPFS (on the fake file system), IndexedDB (on the fake
 * IndexedDB) and the kernel-side BlkioClient talking to a blkio server.
 */
import { describe, expect, it } from 'vitest';

import { bytesEqual, encodeRaw, encodeState } from '../../core/mm/codec.ts';
import { randomBytes } from '../../core/mm/fixtures/doubles.ts';
import type { SwapDevice, SwapKey } from '../../core/mm/swap.ts';

export interface DeviceHarness {
  dev: SwapDevice;
  setNow(t: number): void;
  /** The next `n` write read-backs are corrupted. */
  corruptNextReadBacks(n: number): void;
  /** Flip a byte of the stored body of `key` generation `gen`. */
  corruptStored(key: SwapKey, gen: number): Promise<void>;
  /**
   * False for IndexedDB: a put replaces the previous generation atomically (§3.10.2), so after a
   * failed write there is no older copy (it was stale: only dirty pages are rewritten).
   */
  keepsPreviousGeneration?: boolean;
}

export type MakeDevice = (opts: { capBytes?: number }) => Promise<DeviceHarness>;

export const KEY: SwapKey = {
  uid: 1000,
  osSession: '0190c2d4-aaaa-7bbb-8ccc-000000000001',
  pid: 412,
  pageId: 3,
};

function page(n: number, seed = 1): ReturnType<typeof encodeRaw> {
  return encodeRaw(randomBytes(n, seed).buffer);
}

/** Copies, because a transferring device may detach what it is given. */
function copy(p: ReturnType<typeof encodeRaw>): {
  header: ArrayBuffer;
  body: ArrayBuffer;
  sha: string;
} {
  return { header: p.header.slice(0), body: p.body.slice(0), sha: p.sha256 };
}

export function swapDeviceContract(name: string, make: MakeDevice): void {
  describe(`SwapDevice contract: ${name}`, () => {
    it('MEM-03 a written page reads back byte-identical, verified, with real byte progress', async () => {
      const h = await make({});
      const pg = page(700_000, 5);
      const c = copy(pg);
      const w = await h.dev.write(KEY, 1, c.header, c.body, c.sha);
      expect(w.ok).toBe(true);
      expect(bytesEqual(w.body, pg.body)).toBe(true);
      const progress: Array<[number, number]> = [];
      const r = await h.dev.read(KEY, 1, pg.sha256, (d, t) => progress.push([d, t]));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(bytesEqual(r.body, pg.body)).toBe(true);
      expect(bytesEqual(r.header, pg.header)).toBe(true);
      expect(progress.at(-1)).toEqual([700_000, 700_000]);
      expect(await h.dev.usage()).toEqual({ bytes: 64 + 700_000, files: 1 });
      // A STATE page round-trips too.
      const st = encodeState({ doc: 'x', seg: new Uint8Array([1, 2, 3]) });
      expect(
        (
          await h.dev.write(
            { ...KEY, pageId: 0 },
            1,
            st.header.slice(0),
            st.body.slice(0),
            st.sha256,
          )
        ).ok,
      ).toBe(true);
      const rs = await h.dev.read({ ...KEY, pageId: 0 }, 1, st.sha256);
      expect(rs.ok && bytesEqual(rs.body, st.body)).toBe(true);
    });

    it('MEM-03 memory is released only after the read-back is verified: one bad read-back is rewritten, two are EIO', async () => {
      const h = await make({});
      const pg = page(4_096, 2);
      h.corruptNextReadBacks(1);
      expect((await h.dev.write(KEY, 1, ...args(pg))).ok).toBe(true);
      expect((await h.dev.read(KEY, 1, pg.sha256)).ok).toBe(true);
      const pg2 = page(4_096, 3);
      h.corruptNextReadBacks(2);
      const w = await h.dev.write(KEY, 2, ...args(pg2));
      expect(w).toMatchObject({ ok: false, errno: 'EIO' });
      expect(bytesEqual(w.body, pg2.body)).toBe(true);
      // Nothing unverified is left behind; OPFS keeps the previous generation valid.
      expect((await h.dev.read(KEY, 2, pg2.sha256)).ok).toBe(false);
      expect((await h.dev.read(KEY, 1, pg.sha256)).ok).toBe(h.keepsPreviousGeneration !== false);
    });

    it('MEM-03 bit rot and wrong hashes are EIO checksum; a missing generation is ENOENT', async () => {
      const h = await make({});
      const pg = page(3_000, 4);
      await h.dev.write(KEY, 1, ...args(pg));
      expect(await h.dev.read(KEY, 2, pg.sha256)).toMatchObject({ ok: false, errno: 'ENOENT' });
      expect(await h.dev.read({ ...KEY, pid: 77 }, 1, pg.sha256)).toMatchObject({
        ok: false,
        errno: 'ENOENT',
      });
      expect(await h.dev.read(KEY, 1, 'f'.repeat(64))).toMatchObject({ ok: false, errno: 'EIO' });
      await h.corruptStored(KEY, 1);
      expect(await h.dev.read(KEY, 1, pg.sha256)).toMatchObject({
        ok: false,
        errno: 'EIO',
        reason: 'checksum',
      });
    });

    it('MEM-03 a newer generation replaces the older one; delete and deleteSession free the space', async () => {
      const h = await make({});
      const a = page(1_000, 6);
      const b = page(1_000, 7);
      await h.dev.write(KEY, 1, ...args(a));
      await h.dev.write(KEY, 2, ...args(b));
      expect(await h.dev.read(KEY, 1, a.sha256)).toMatchObject({ ok: false, errno: 'ENOENT' });
      expect((await h.dev.read(KEY, 2, b.sha256)).ok).toBe(true);
      expect((await h.dev.usage()).files).toBe(1);
      await h.dev.delete(KEY, [1]);
      expect((await h.dev.read(KEY, 2, b.sha256)).ok).toBe(true);
      await h.dev.delete(KEY, [2]);
      expect(await h.dev.read(KEY, 2, b.sha256)).toMatchObject({ ok: false, errno: 'ENOENT' });
      await h.dev.write({ ...KEY, pageId: 8 }, 1, ...args(a));
      await h.dev.write({ ...KEY, pid: 9 }, 1, ...args(a));
      await h.dev.delete({ ...KEY, pageId: 8 });
      await h.dev.delete({ ...KEY, pageId: 99 });
      await h.dev.deleteSession(KEY.uid, KEY.osSession);
      await h.dev.deleteSession(5, 'nothing');
      expect(await h.dev.usage()).toEqual({ bytes: 0, files: 0 });
    });

    it('MEM-03 a write beyond the local swap cap answers EDQUOT and hands the body back', async () => {
      const h = await make({ capBytes: 64 + 2_000 });
      const small = page(2_000, 8);
      expect((await h.dev.write(KEY, 1, ...args(small))).ok).toBe(true);
      expect((await h.dev.write(KEY, 2, ...args(small))).ok).toBe(true); // replacing fits
      const big = page(3_000, 9);
      const w = await h.dev.write({ ...KEY, pageId: 4 }, 1, ...args(big));
      expect(w).toMatchObject({ ok: false, errno: 'EDQUOT' });
      expect(w.body.byteLength).toBe(3_000);
    });

    it('MEM-03 the boot sweep keeps referenced sessions and removes old unreferenced ones', async () => {
      const h = await make({});
      const pg = page(500, 10);
      h.setNow(1_000);
      await h.dev.write(KEY, 1, ...args(pg));
      await h.dev.write({ ...KEY, osSession: 'old-session' }, 1, ...args(pg));
      h.setNow(1_000 + 20 * 86_400_000);
      const r = await h.dev.sweep([{ uid: KEY.uid, osSession: KEY.osSession }], 14 * 86_400_000);
      expect(r).toEqual({ files: 1, bytes: 564 });
      expect((await h.dev.read(KEY, 1, pg.sha256)).ok).toBe(true);
      expect(await h.dev.read({ ...KEY, osSession: 'old-session' }, 1, pg.sha256)).toMatchObject({
        ok: false,
        errno: 'ENOENT',
      });
      expect(await h.dev.sweep([], 30 * 86_400_000)).toEqual({ files: 0, bytes: 0 });
    });
  });
}

function args(p: ReturnType<typeof encodeRaw>): [ArrayBuffer, ArrayBuffer, string] {
  const c = copy(p);
  return [c.header, c.body, c.sha];
}
