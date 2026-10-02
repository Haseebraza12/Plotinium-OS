/**
 * The lease SQL against PostgreSQL 18 (database.md §3.17, §4.11.16; offline-and-sync.md §3.14).
 * DB-gated: runs only when DATABASE_URL points at a DISPOSABLE, freshly migrated database
 * (db/migrations), connected as the owner role, for example:
 *   DATABASE_URL=postgres://plotinium_owner:<pw>@127.0.0.1:55432/plotinium_test \
 *     pnpm exec vitest run --project server server/src/engine
 * Every row it creates uses uids 3101-3103 and is removed afterwards.
 */
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../../db/client.ts';
import { toErrno } from '../../db/errors.ts';
import type { DB } from '../../db/types.gen.ts';
import { uuidv7 } from '../../util/uuidv7.ts';
import { KyselyLockStore } from './store.ts';
import { scratchDatabaseUrl } from '../../../tests/scratch-db.ts';

/** A per-file clone of DATABASE_URL's database (server/tests/scratch-db.ts). */
const URL_ = await scratchDatabaseUrl('locks');
const ROOT = '00000000-0000-7000-8000-000000000001';
const A = 3101;
const B = 3102;
const C = 3103;

let database: Database;
let db: Kysely<DB>;
let store: KyselyLockStore;
const ids = {
  file: uuidv7(),
  file2: uuidv7(),
  dir: uuidv7(),
  hidden: uuidv7(),
  osA: uuidv7(),
  osA2: uuidv7(),
  osB: uuidv7(),
  osC: uuidv7(),
  dev: uuidv7(),
  devOther: uuidv7(),
};
const AUTH_A = 'lockstoretestauthaaaa';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function cleanup(): Promise<void> {
  const uids = [A, B, C];
  await sql`DELETE FROM locks WHERE holder_uid = ANY(${uids}::int[])`.execute(db);
  await sql`DELETE FROM dentries WHERE owner_uid = ANY(${uids}::int[])`.execute(db);
  await sql`DELETE FROM inodes WHERE uid = ANY(${uids}::int[])`.execute(db);
  await sql`DELETE FROM os_sessions WHERE owner_uid = ANY(${uids}::int[])`.execute(db);
  await sql`DELETE FROM auth_sessions WHERE uid = ANY(${uids}::int[])`.execute(db);
  await sql`DELETE FROM users WHERE uid = ANY(${uids}::int[])`.execute(db);
}

describe.runIf(URL_ !== undefined)(
  'VFS-09 lease SQL against PostgreSQL (database.md §4.11.16)',
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
      store = new KyselyLockStore(db);
      await cleanup();
      for (const [uid, name] of [
        [A, 'lkalice'],
        [B, 'lkbob'],
        [C, 'lkcarol'],
      ] as const) {
        await sql`INSERT INTO users (uid, username, password_hash, primary_gid, quota_bytes, quota_inodes)
                VALUES (${uid}, ${name}, '!', 100, 1000000, 1000)`.execute(db);
      }
      await sql`INSERT INTO auth_sessions (id, secret_hash, uid, expires_at, absolute_expires_at)
              VALUES (${AUTH_A}, ${Buffer.alloc(32, 1)}, ${A}, now() + interval '1 day', now() + interval '2 days')`.execute(
        db,
      );
      const sessions: [string, number, string | null, string, number][] = [
        [ids.osA, A, AUTH_A, ids.dev, 3],
        [ids.osA2, A, AUTH_A, ids.dev, 4],
        [ids.osB, B, null, ids.devOther, 1],
        [ids.osC, C, null, ids.dev, 1],
      ];
      for (const [os, uid, auth, dev, epoch] of sessions) {
        await sql`INSERT INTO os_sessions (os_session_id, owner_uid, auth_session_id, device_id, kernel_epoch)
                VALUES (${os}, ${uid}, ${auth}, ${dev}, ${epoch})`.execute(db);
      }
      const mk = async (
        ino: string,
        parent: string,
        name: string,
        type: 'f' | 'd',
        mode: number,
        uid: number,
      ) => {
        await sql`INSERT INTO inodes (ino, type, mode, uid, gid, nlink) VALUES (${ino}, ${type}, ${mode}, ${uid}, 100, ${type === 'd' ? 2 : 1})`.execute(
          db,
        );
        await sql`INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) VALUES (${parent}, ${name}, ${ino}, ${type}, ${uid})`.execute(
          db,
        );
      };
      await mk(ids.file, ROOT, `lk-file-${ids.file}`, 'f', 0o666, A);
      await mk(ids.file2, ROOT, `lk-file2-${ids.file2}`, 'f', 0o640, A);
      await mk(ids.dir, ROOT, `lk-dir-${ids.dir}`, 'd', 0o700, A);
      await mk(ids.hidden, ids.dir, 'inside', 'f', 0o666, A);
    });

    afterAll(async () => {
      await cleanup();
      await database.close();
    });

    it('VFS-09 X is granted with a fence stamped on the inode; a second X or an S of another session is busy with the holder named', async () => {
      const g = await store.acquire({
        ino: ids.file,
        osSessionId: ids.osA,
        holderUid: A,
        mode: 'X',
        ttlMs: 30_000,
      });
      expect(g.kind).toBe('granted');
      if (g.kind !== 'granted') return;
      expect(g.lease).toMatchObject({
        ino: ids.file,
        osSessionId: ids.osA,
        holderUid: A,
        mode: 'X',
      });
      expect(g.lease.expiresAt).toBeGreaterThan(Date.now() + 20_000);
      const fence = await sql<{
        lock_fence: number;
      }>`SELECT lock_fence FROM inodes WHERE ino = ${ids.file}`.execute(db);
      expect(fence.rows[0]?.lock_fence).toBe(g.lease.fence);
      const busy = await store.acquire({
        ino: ids.file,
        osSessionId: ids.osB,
        holderUid: B,
        mode: 'X',
        ttlMs: 30_000,
      });
      expect(busy).toMatchObject({ kind: 'busy', holder: { username: 'lkalice', mode: 'X' } });
      const busyS = await store.acquire({
        ino: ids.file,
        osSessionId: ids.osB,
        holderUid: B,
        mode: 'S',
        ttlMs: 30_000,
      });
      expect(busyS.kind).toBe('busy');
      expect(await store.release(g.lease.leaseId, ids.osA)).toMatchObject({
        leaseId: g.lease.leaseId,
      });
      expect(await store.release(g.lease.leaseId, ids.osA)).toBeNull();
    });

    it('VFS-09 many S coexist; a sole S holder upgrades to X as a new grant; the EXCLUDE constraint refuses S next to X', async () => {
      const s1 = await store.acquire({
        ino: ids.file,
        osSessionId: ids.osA,
        holderUid: A,
        mode: 'S',
        ttlMs: 30_000,
      });
      const s2 = await store.acquire({
        ino: ids.file,
        osSessionId: ids.osB,
        holderUid: B,
        mode: 'S',
        ttlMs: 30_000,
      });
      expect([s1.kind, s2.kind]).toEqual(['granted', 'granted']);
      expect(
        (
          await store.acquire({
            ino: ids.file,
            osSessionId: ids.osA,
            holderUid: A,
            mode: 'X',
            ttlMs: 30_000,
          })
        ).kind,
      ).toBe('busy');
      await store.releaseSessions([ids.osB]);
      const up = await store.acquire({
        ino: ids.file,
        osSessionId: ids.osA,
        holderUid: A,
        mode: 'X',
        ttlMs: 30_000,
      });
      expect(up.kind).toBe('granted');
      if (up.kind !== 'granted' || s1.kind !== 'granted') return;
      expect(up.replaced?.leaseId).toBe(s1.lease.leaseId);
      expect(up.lease.leaseId).not.toBe(s1.lease.leaseId);
      expect(up.lease.fence).toBeGreaterThan(s1.lease.fence);
      // The database is the authority: a raw S insert next to the X fails with 23P01 -> EBUSY lease.
      let errno: string | undefined;
      try {
        await sql`INSERT INTO locks (ino, os_session_id, holder_uid, mode, fence, lease_expires_at)
                VALUES (${ids.file}, ${ids.osB}, ${B}, 'S', nextval('lock_fence_seq'), clock_timestamp() + interval '30 s')`.execute(
          db,
        );
      } catch (e) {
        errno = toErrno(e, { cancelled: false }).errno;
      }
      expect(errno).toBe('EBUSY');
      await store.releaseSessions([ids.osA]);
    });

    it('VFS-09 directories, missing inodes and files without permission (or without x on an ancestor) are refused', async () => {
      expect(
        await store.acquire({
          ino: ids.dir,
          osSessionId: ids.osA,
          holderUid: A,
          mode: 'S',
          ttlMs: 30_000,
        }),
      ).toMatchObject({ kind: 'denied', errno: 'EISDIR' });
      expect(
        await store.acquire({
          ino: uuidv7(),
          osSessionId: ids.osA,
          holderUid: A,
          mode: 'S',
          ttlMs: 30_000,
        }),
      ).toMatchObject({ kind: 'denied', errno: 'ENOENT' });
      expect(
        await store.acquire({
          ino: ids.file2,
          osSessionId: ids.osB,
          holderUid: B,
          mode: 'X',
          ttlMs: 30_000,
        }),
      ).toMatchObject({ kind: 'denied', errno: 'EACCES' });
      expect(
        await store.acquire({
          ino: ids.hidden,
          osSessionId: ids.osB,
          holderUid: B,
          mode: 'S',
          ttlMs: 30_000,
        }),
      ).toMatchObject({ kind: 'denied', errno: 'EACCES' });
      expect(
        await store.acquire({
          ino: ids.file,
          osSessionId: ids.osA,
          holderUid: 999_999,
          mode: 'S',
          ttlMs: 30_000,
        }),
      ).toMatchObject({ kind: 'denied', errno: 'EACCES' });
      const ok = await store.acquire({
        ino: ids.hidden,
        osSessionId: ids.osA,
        holderUid: A,
        mode: 'X',
        ttlMs: 30_000,
      });
      expect(ok.kind).toBe('granted');
      await store.releaseSessions([ids.osA]);
    });

    it('VFS-09 an expired lease stops blocking at once: the acquire deletes and returns it; the sweeper DELETE expires only due rows', async () => {
      const short = await store.acquire({
        ino: ids.file,
        osSessionId: ids.osA,
        holderUid: A,
        mode: 'X',
        ttlMs: 100,
      });
      expect(short.kind).toBe('granted');
      await sleep(150);
      const next = await store.acquire({
        ino: ids.file,
        osSessionId: ids.osB,
        holderUid: B,
        mode: 'X',
        ttlMs: 30_000,
      });
      expect(next.kind).toBe('granted');
      expect(next.expired.map((r) => r.osSessionId)).toEqual([ids.osA]);
      if (next.kind !== 'granted') return;
      const soon = await store.acquire({
        ino: ids.file2,
        osSessionId: ids.osA,
        holderUid: A,
        mode: 'S',
        ttlMs: 100,
      });
      if (soon.kind !== 'granted') throw new Error('expected a grant');
      expect(await store.expire([soon.lease.leaseId, next.lease.leaseId])).toEqual([]);
      await sleep(150);
      expect(
        (await store.expire([soon.lease.leaseId, next.lease.leaseId])).map((r) => r.leaseId),
      ).toEqual([soon.lease.leaseId]);
      expect((await store.get([next.lease.leaseId])).map((r) => r.leaseId)).toEqual([
        next.lease.leaseId,
      ]);
      expect((await store.loadAll()).some((r) => r.leaseId === next.lease.leaseId)).toBe(true);
      await store.releaseSessions([ids.osB]);
    });

    it('VFS-09 heartbeats renew only live listed leases; hello.heldLeases keeps rows with the same ino and fence', async () => {
      const g = await store.acquire({
        ino: ids.file,
        osSessionId: ids.osA,
        holderUid: A,
        mode: 'S',
        ttlMs: 1_000,
      });
      if (g.kind !== 'granted') throw new Error('expected a grant');
      const renewed = await store.renew(ids.osA, [g.lease.leaseId], 60_000);
      expect(renewed[0]?.expiresAt).toBeGreaterThan(g.lease.expiresAt);
      expect(await store.renew(ids.osA, [], 60_000)).toEqual([]);
      expect((await store.renew(ids.osA, 'all', 60_000)).map((r) => r.leaseId)).toEqual([
        g.lease.leaseId,
      ]);
      expect(await store.renew(ids.osB, [g.lease.leaseId], 60_000)).toEqual([]);
      const kept = await store.verifyHeld(
        ids.osA,
        [{ leaseId: g.lease.leaseId, ino: ids.file, fence: g.lease.fence }],
        60_000,
      );
      expect(kept.map((r) => r.leaseId)).toEqual([g.lease.leaseId]);
      expect(
        await store.verifyHeld(
          ids.osA,
          [{ leaseId: g.lease.leaseId, ino: ids.file, fence: g.lease.fence + 1 }],
          60_000,
        ),
      ).toEqual([]);
      expect(await store.verifyHeld(ids.osA, [], 60_000)).toEqual([]);
      expect(await store.usernameOf(A)).toBe('lkalice');
      expect(await store.usernameOf(999_999)).toBeNull();
      await store.releaseSessions([ids.osA]);
      expect(await store.releaseSessions([])).toEqual([]);
    });

    it('VFS-09 revocation releases the leases of the auth session OS sessions; a newer epoch releases only same-device same-uid predecessors', async () => {
      await store.acquire({
        ino: ids.file,
        osSessionId: ids.osA,
        holderUid: A,
        mode: 'S',
        ttlMs: 30_000,
      });
      await store.acquire({
        ino: ids.file,
        osSessionId: ids.osC,
        holderUid: C,
        mode: 'S',
        ttlMs: 30_000,
      });
      await store.acquire({
        ino: ids.file,
        osSessionId: ids.osB,
        holderUid: B,
        mode: 'S',
        ttlMs: 30_000,
      });
      const pred = await store.releaseDevicePredecessors({
        deviceId: ids.dev,
        uid: A,
        osSessionId: ids.osA2,
        kernelEpoch: 4,
      });
      expect(pred.map((r) => r.osSessionId)).toEqual([ids.osA]); // never carol's (another uid) or bob's (another device)
      await store.acquire({
        ino: ids.file,
        osSessionId: ids.osA2,
        holderUid: A,
        mode: 'S',
        ttlMs: 30_000,
      });
      const revoked = await store.releaseAuthSessions([AUTH_A]);
      expect(revoked.map((r) => r.osSessionId)).toEqual([ids.osA2]);
      expect(await store.releaseAuthSessions([])).toEqual([]);
      await store.releaseSessions([ids.osB, ids.osC]);
    });
  },
);
