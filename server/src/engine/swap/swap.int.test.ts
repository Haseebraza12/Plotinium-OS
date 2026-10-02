/**
 * DB-gated (DATABASE_URL, a disposable migrated database; see server/src/db/db.int.test.ts):
 * KyselySwapDb and SwapService against PostgreSQL 18 with a real FsBlobStore. Test users use
 * ids 915xx and everything is removed afterwards.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { gunzipSync, gzipSync } from 'node:zlib';

import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../../db/client.ts';
import type { DB } from '../../db/types.gen.ts';
import { FsBlobStore } from '../../storage/fs-blobstore.ts';
import { uuidv7 } from '../../util/uuidv7.ts';
import { KyselySwapDb } from './kysely-db.ts';
import { SwapService } from './service.ts';
import { scratchDatabaseUrl } from '../../../tests/scratch-db.ts';

/** A per-file clone of DATABASE_URL's database (server/tests/scratch-db.ts). */
const URL_ = await scratchDatabaseUrl('swap');
const ALICE = 91_511;
const BOB = 91_512;
const GID = 91_510;
const S1 = uuidv7(Date.UTC(2026, 8, 1));
const S2 = uuidv7(Date.UTC(2026, 8, 20));
const SB = uuidv7(Date.UTC(2026, 8, 21));

let database: Database;
let db: Kysely<DB>;
let dir: string;
let swapDb: KyselySwapDb;
let svc: SwapService;

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const put = (
  s: SwapService,
  raw: Buffer,
  key: { owner?: number; session?: string; pid?: number; pageId?: number; gen?: number } = {},
) => {
  const gz = gzipSync(raw);
  return s.put({
    ownerUid: key.owner ?? ALICE,
    osSessionId: key.session ?? S1,
    pid: key.pid ?? 42,
    pageId: key.pageId ?? 0,
    gen: key.gen ?? 1,
    body: Readable.from([gz]),
    contentLength: gz.length,
    checksum: sha(raw),
    rawSize: raw.length,
    encoding: 'gzip',
  });
};

describe.runIf(URL_ !== undefined)(
  'MEM-04 remote swap on PostgreSQL 18 (database.md §3.18)',
  () => {
    beforeAll(async () => {
      database = createDatabase({
        url: URL_ ?? '',
        password: undefined,
        poolMax: 4,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 2_000,
      });
      db = database.db;
      dir = await mkdtemp(join(tmpdir(), 'plt-swap-int-'));
      await sql`INSERT INTO groups (gid, name) VALUES (${GID}, 'swaptest') ON CONFLICT DO NOTHING`.execute(
        db,
      );
      for (const [uid, name] of [
        [ALICE, 'swapalice'],
        [BOB, 'swapbob'],
      ] as const) {
        await sql`INSERT INTO users (uid, username, account_kind, password_hash, primary_gid, quota_bytes, quota_inodes)
                VALUES (${uid}, ${name}, 'user', 'x', ${GID}, 0, 0) ON CONFLICT DO NOTHING`.execute(
          db,
        );
      }
      for (const [s, owner] of [
        [S1, ALICE],
        [S2, ALICE],
        [SB, BOB],
      ] as const) {
        await sql`INSERT INTO os_sessions (os_session_id, owner_uid) VALUES (${s}::uuid, ${owner}) ON CONFLICT DO NOTHING`.execute(
          db,
        );
      }
      swapDb = new KyselySwapDb(db);
      svc = new SwapService({
        db: swapDb,
        blobs: new FsBlobStore(dir),
        quotaBytes: 1024 * 1024,
        maxRawBytes: 1024 * 1024,
      });
    });

    afterAll(async () => {
      await sql`DELETE FROM swap_pages WHERE owner_uid IN (${ALICE}, ${BOB})`.execute(db);
      await sql`DELETE FROM os_sessions WHERE owner_uid IN (${ALICE}, ${BOB})`.execute(db);
      await sql`DELETE FROM users WHERE uid IN (${ALICE}, ${BOB})`.execute(db);
      await sql`DELETE FROM groups WHERE gid = ${GID}`.execute(db);
      await database.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('MEM-04 a page uploaded by one OS session is listed and paged in by a new OS session of the same user', async () => {
      const raw = randomBytes(64 * 1024);
      await put(svc, raw);
      const row = await sql<{
        size: number;
        stored_size: number;
        checksum: string;
        storage_key: string;
        gen: number;
      }>`
      SELECT size, stored_size, encode(checksum, 'hex') AS checksum, storage_key, gen FROM swap_pages
       WHERE owner_uid = ${ALICE} AND os_session_id = ${S1}::uuid AND pid = 42 AND page_id = 0`.execute(
        db,
      );
      expect(row.rows[0]).toEqual({
        size: raw.length,
        stored_size: gzipSync(raw).length,
        checksum: sha(raw),
        storage_key: `swap/${ALICE}/${S1}/42/0`,
        gen: 1,
      });
      const listed = await svc.list(ALICE);
      expect(listed.pages.map((p) => [p.osSessionId, p.pid, p.pageId, p.checksum])).toEqual([
        [S1, 42, 0, sha(raw)],
      ]);
      const got = await svc.get({ ownerUid: ALICE, osSessionId: S1, pid: 42, pageId: 0 }, 1);
      expect(gunzipSync(await buffer(got.stream)).equals(raw)).toBe(true);
      expect(got.page.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('MEM-04 a swap page of another user is refused with 403 EACCES even for root, and the composite key refuses a foreign session', async () => {
      await expect(
        svc.get({ ownerUid: BOB, osSessionId: S1, pid: 42, pageId: 0 }),
      ).rejects.toMatchObject({ status: 403, errno: 'EACCES' });
      await expect(
        svc.get({ ownerUid: 0, osSessionId: S1, pid: 42, pageId: 0 }),
      ).rejects.toMatchObject({ status: 403 });
      // bypassing the service: the FK (os_session_id, owner_uid) itself refuses (23503 -> foreign-session)
      expect(
        await swapDb.upsertPage(
          {
            ownerUid: BOB,
            osSessionId: S1,
            pid: 1,
            pageId: 1,
            gen: 0,
            storageKey: 'k',
            size: 1,
            storedSize: 1,
            checksum: 'a'.repeat(64),
          },
          1 << 30,
        ),
      ).toEqual({ ok: false, reason: 'foreign-session' });
    });

    it('MEM-04 the sum of stored sizes never exceeds the cap; an older generation never replaces a newer one', async () => {
      const tiny = new SwapService({
        db: swapDb,
        blobs: new FsBlobStore(dir),
        quotaBytes: 200_000,
        maxRawBytes: 1024 * 1024,
      });
      await put(tiny, randomBytes(100_000), { session: S2, pageId: 1 });
      await expect(
        put(tiny, randomBytes(100_000), { session: S2, pageId: 2 }),
      ).rejects.toMatchObject({ status: 413, errno: 'EDQUOT' });
      expect(await swapDb.usedBytes(ALICE)).toBeLessThanOrEqual(200_000);
      expect(
        await swapDb.upsertPage(
          {
            ownerUid: ALICE,
            osSessionId: S2,
            pid: 42,
            pageId: 1,
            gen: 5,
            storageKey: 'k',
            size: 1,
            storedSize: 1,
            checksum: 'b'.repeat(64),
          },
          1 << 30,
        ),
      ).toEqual({ ok: true });
      expect(
        await swapDb.upsertPage(
          {
            ownerUid: ALICE,
            osSessionId: S2,
            pid: 42,
            pageId: 1,
            gen: 4,
            storageKey: 'k',
            size: 1,
            storedSize: 1,
            checksum: 'c'.repeat(64),
          },
          1 << 30,
        ),
      ).toEqual({ ok: false, reason: 'stale' });
      // the in-transaction quota check removes the page's row
      const q = await swapDb.upsertPage(
        {
          ownerUid: ALICE,
          osSessionId: S2,
          pid: 42,
          pageId: 1,
          gen: 6,
          storageKey: 'k',
          size: 1,
          storedSize: 10_000_000,
          checksum: 'd'.repeat(64),
        },
        1_000_000,
      );
      expect(q).toMatchObject({ ok: false, reason: 'quota' });
      expect(
        await swapDb.getPage({ ownerUid: ALICE, osSessionId: S2, pid: 42, pageId: 1 }),
      ).toBeNull();
    });

    it('MEM-04 listing is newest session first with a keyset cursor; deletes and retention remove rows', async () => {
      await put(svc, Buffer.from('a'), { session: S2, pid: 7, pageId: 0 });
      await put(svc, Buffer.from('b'), { session: S2, pid: 7, pageId: 1 });
      const p1 = await svc.list(ALICE, {}, null, 2);
      expect(p1.pages.map((p) => [p.osSessionId, p.pid, p.pageId])).toEqual([
        [S2, 7, 0],
        [S2, 7, 1],
      ]);
      const p2 = await svc.list(ALICE, {}, p1.next ?? null, 2);
      expect(p2.pages.map((p) => [p.osSessionId, p.pid, p.pageId])).toEqual([[S1, 42, 0]]);
      expect((await svc.list(ALICE, { osSessionId: S2, pid: 7 })).pages).toHaveLength(2);
      expect(await svc.delete(ALICE, S2, 7, 1)).toBe(1);
      expect(await svc.delete(ALICE, S2)).toBe(1);
      await sql`UPDATE swap_pages SET updated_at = now() - interval '31 days' WHERE owner_uid = ${ALICE} AND os_session_id = ${S1}::uuid`.execute(
        db,
      );
      expect(await svc.sweepRetention(30)).toBeGreaterThanOrEqual(1);
      expect((await svc.list(ALICE)).pages).toEqual([]);
    });
  },
);
