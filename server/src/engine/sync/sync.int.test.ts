/**
 * The sync engine's SQL against PostgreSQL 18: vfsTxn + the capturing feed statement + the
 * content-write handler, the feed reader, the directory context, the OS-session registry and the
 * runtime wiring (database.md §3.13, §3.15, §3.16, §4.11.15; offline-and-sync.md §3.8, §3.10, §3.12).
 * DB-gated: runs only when DATABASE_URL points at a DISPOSABLE, freshly migrated database
 * connected as the owner role. Rows use uids 3201-3202 and are removed afterwards.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveIno, INO } from '@plotinium/protocol';

import { createDatabase, type Database } from '../../db/client.ts';
import type { DB } from '../../db/types.gen.ts';
import { createHome } from '../../gateway/homes.ts';
import { uuidv7 } from '../../util/uuidv7.ts';
import { CancelRegistry } from '../../vfs/cancel.ts';
import { kyselySteps } from '../../vfs/steps.ts';
import { KyselyLockStore } from '../locks/store.ts';
import { testHeapFactory } from '../locks/tests/test-heap.ts';
import { ContentWriteHandler } from './content-write.ts';
import { SyncEngine, type OpOrigin } from './engine.ts';
import { KyselyFeedReader, KyselyOsSessionStore } from './feed-reader.ts';
import { kyselyFeedSql } from './feed-steps.ts';
import { kyselyContentSql } from './kysely-content.ts';
import { isoDate } from './names.ts';
import { createSyncRuntime } from './runtime.ts';
import { sha, writeOp } from './tests/fake-db.ts';
import { scratchDatabaseUrl } from '../../../tests/scratch-db.ts';

/** A per-file clone of DATABASE_URL's database (server/tests/scratch-db.ts). */
const URL_ = await scratchDatabaseUrl('sync');
const ALICE = 3201;
const BOB = 3202;
const TZ = 'Asia/Karachi';

let database: Database;
let db: Kysely<DB>;
let engine: SyncEngine<Transaction<DB>>;
const sessions = (): KyselyOsSessionStore => new KyselyOsSessionStore(db);
const ids = {
  shared: uuidv7(),
  ro: uuidv7(),
  report: uuidv7(),
  plan: uuidv7(),
  notes: uuidv7(),
  osA: uuidv7(),
  osB: uuidv7(),
  dev: uuidv7(),
};
let aliceHome = '';
const blobs: string[] = [];

const origin = (uid: number, deviceId: string | null = null): OpOrigin => ({
  connId: `c-${uid}`,
  uid,
  deviceId,
  mayActAs: (p) => p === uid,
  gidsOf: () => [100],
});

async function blob(n: number, size: number, refcount = 0): Promise<string> {
  const s = sha(0x5000 + n);
  blobs.push(s);
  await sql`INSERT INTO blobs (sha256, size, storage_key, refcount, zero_since, first_ref_at)
            VALUES (decode(${s}, 'hex'), ${size}, ${`blobs/sha256/${s}`}, ${refcount},
                    ${refcount === 0 ? sql`now()` : sql`NULL`}, ${refcount === 0 ? sql`NULL` : sql`now()`})
            ON CONFLICT (sha256) DO NOTHING`.execute(db);
  return s;
}

async function fileRow(ino: string) {
  const r = await sql<{
    version: number;
    size: number;
    uid: number;
    mode: number;
    blob: string | null;
  }>`
    SELECT i.version, i.size, i.uid, i.mode, encode(b.sha256, 'hex') AS blob
    FROM inodes i LEFT JOIN blobs b USING (blob_id) WHERE i.ino = ${ino}`.execute(db);
  return r.rows[0];
}

async function cleanup(): Promise<void> {
  const uids = [ALICE, BOB];
  await sql`DELETE FROM feed WHERE owner_uid = ANY(${uids}::int[]) OR op_id IN (SELECT op_id FROM op_log WHERE uid = ANY(${uids}::int[]))`.execute(
    db,
  );
  await sql`DELETE FROM op_log WHERE uid = ANY(${uids}::int[])`.execute(db);
  await sql`DELETE FROM locks WHERE holder_uid = ANY(${uids}::int[])`.execute(db);
  for (let i = 0; i < 4; i++) {
    await sql`DELETE FROM dentries d WHERE d.owner_uid = ANY(${uids}::int[])
              AND NOT EXISTS (SELECT 1 FROM dentries c WHERE c.parent_ino = d.ino)`.execute(db);
  }
  await sql`DELETE FROM inodes WHERE uid = ANY(${uids}::int[])`.execute(db);
  if (blobs.length > 0)
    await sql`DELETE FROM blobs WHERE encode(sha256, 'hex') = ANY(${blobs}::text[])`.execute(db);
  await sql`DELETE FROM os_sessions WHERE owner_uid = ANY(${uids}::int[])`.execute(db);
  await sql`DELETE FROM users WHERE uid = ANY(${uids}::int[])`.execute(db);
}

describe.runIf(URL_ !== undefined)('OFF-02 VFS-10 sync engine SQL against PostgreSQL', () => {
  beforeAll(async () => {
    database = createDatabase({
      url: URL_ ?? '',
      password: undefined,
      poolMax: 6,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 2_000,
    });
    db = database.db;
    await cleanup();
    for (const [uid, name] of [
      [ALICE, 'syalice'],
      [BOB, 'sybob'],
    ] as const) {
      await sql`INSERT INTO users (uid, username, password_hash, primary_gid, quota_bytes, quota_inodes)
                VALUES (${uid}, ${name}, '!', 100, 1000000, 1000)`.execute(db);
    }
    aliceHome = await db
      .transaction()
      .execute((tx) => createHome(tx, { uid: ALICE, username: 'syalice', gid: 100 }));
    await db
      .transaction()
      .execute((tx) => createHome(tx, { uid: BOB, username: 'sybob', gid: 100 }));
    const dir = async (ino: string, name: string, mode: number) => {
      await sql`INSERT INTO inodes (ino, type, mode, uid, gid, nlink) VALUES (${ino}, 'd', ${mode}, ${BOB}, 100, 2)`.execute(
        db,
      );
      await sql`INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) VALUES (${INO.HOME}, ${name}, ${ino}, 'd', ${BOB})`.execute(
        db,
      );
    };
    await dir(ids.shared, `sy-shared-${ids.shared}`, 0o777);
    await dir(ids.ro, `sy-ro-${ids.ro}`, 0o755);
    const file = async (
      ino: string,
      parent: string,
      name: string,
      mode: number,
      owner: number,
      s: string,
    ) => {
      const b = await sql<{
        blob_id: number;
      }>`SELECT blob_id FROM blobs WHERE sha256 = decode(${s}, 'hex')`.execute(db);
      await sql`INSERT INTO inodes (ino, type, mode, uid, gid, size, nlink, blob_id) VALUES (${ino}, 'f', ${mode}, ${owner}, 100, 10, 1, ${b.rows[0]?.blob_id ?? null})`.execute(
        db,
      );
      await sql`INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) VALUES (${parent}, ${name}, ${ino}, 'f', ${owner})`.execute(
        db,
      );
      await sql`UPDATE users SET used_bytes = used_bytes + 10, used_inodes = used_inodes + 1 WHERE uid = ${owner}`.execute(
        db,
      );
    };
    const initial = await blob(1, 10, 3);
    await file(ids.report, ids.shared, 'report.md', 0o666, BOB, initial);
    await file(ids.plan, ids.ro, 'plan.md', 0o666, BOB, initial);
    await file(ids.notes, aliceHome, 'notes.txt', 0o644, ALICE, initial);
    expect(
      await sessions().register({
        osSessionId: ids.osA,
        ownerUid: ALICE,
        authSessionId: null,
        deviceId: ids.dev,
        kernelEpoch: 1,
      }),
    ).toBe(true);
    expect(
      await sessions().register({
        osSessionId: ids.osB,
        ownerUid: BOB,
        authSessionId: null,
        deviceId: uuidv7(),
        kernelEpoch: 1,
      }),
    ).toBe(true);
    engine = new SyncEngine<Transaction<DB>>({
      steps: kyselySteps(db),
      cancel: new CancelRegistry(),
      lockTimeoutMs: 2_000,
      statementTimeoutMs: 10_000,
      feed: kyselyFeedSql,
      handlerFor: (s) =>
        s.op.kind === 'write'
          ? new ContentWriteHandler(kyselyContentSql, s, { timeZone: TZ })
          : undefined,
      sessions: { ownsOsSession: (o, u, d) => sessions().owns(o, u, d) },
    });
  });

  afterAll(async () => {
    await cleanup();
    await database.close();
  });

  it('OFF-02 a content write applies once: CAS version, blob refcounts, quota delta, one op_log row and one feed row; a resend is a duplicate', async () => {
    const s = await blob(2, 25);
    const op = writeOp({
      opId: uuidv7(),
      osSessionId: ids.osA,
      cseq: 1,
      principal: ALICE,
      ino: ids.notes,
      sha: s,
      size: 25,
      baseVersion: 1,
    });
    const r = await engine.applyOp(origin(ALICE, ids.dev), op);
    expect(r).toMatchObject({
      status: 'applied',
      duplicate: false,
      versions: [{ ino: ids.notes, version: 2 }],
      ownerSeqs: [{ ownerUid: ALICE, seq: 1 }],
    });
    expect(await fileRow(ids.notes)).toMatchObject({ version: 2, size: 25, blob: s });
    const u = await sql<{
      used_bytes: number;
      feed_seq: number;
    }>`SELECT used_bytes, feed_seq FROM users WHERE uid = ${ALICE}`.execute(db);
    expect(u.rows[0]).toMatchObject({ used_bytes: 25, feed_seq: 1 });
    const again = await engine.applyOp(origin(ALICE, ids.dev), op);
    expect(again).toMatchObject({
      status: 'applied',
      duplicate: true,
      versions: r.versions,
      ownerSeqs: r.ownerSeqs,
      lamport: r.lamport,
    });
    const rows = await sql<{
      n: number;
      status: string;
    }>`SELECT count(*)::int AS n, max(status) AS status FROM op_log WHERE op_id = ${op.opId}`.execute(
      db,
    );
    expect(rows.rows[0]).toMatchObject({ n: 1, status: 'applied' });
    const rc = await sql<{
      refcount: number;
    }>`SELECT refcount FROM blobs WHERE sha256 = decode(${s}, 'hex')`.execute(db);
    expect(rc.rows[0]?.refcount).toBe(1);
  });

  it('VFS-10 a stale base keeps both versions: report (conflict from syalice, date).md next to the original, feed rows for both owners', async () => {
    const bobBlob = await blob(3, 30);
    const bobWrite = await engine.applyOp(
      origin(BOB),
      writeOp({
        opId: uuidv7(),
        osSessionId: ids.osB,
        cseq: 1,
        principal: BOB,
        ino: ids.report,
        sha: bobBlob,
        size: 30,
        baseVersion: 1,
      }),
    );
    expect(bobWrite.status).toBe('applied');
    const mine = await blob(4, 40);
    const op = writeOp({
      opId: uuidv7(),
      osSessionId: ids.osA,
      cseq: 2,
      principal: ALICE,
      ino: ids.report,
      sha: mine,
      size: 40,
      baseVersion: 1,
    });
    const r = await engine.applyOp(origin(ALICE, ids.dev), op);
    const name = `report (conflict from syalice, ${isoDate(Date.now(), TZ)}).md`;
    expect(r).toMatchObject({
      status: 'conflict',
      keptAs: { ino: deriveIno(op.opId, ids.report), parentIno: ids.shared, name },
    });
    expect(await fileRow(ids.report)).toMatchObject({ version: 2, size: 30, blob: bobBlob });
    expect(await fileRow(deriveIno(op.opId, ids.report))).toMatchObject({
      uid: ALICE,
      size: 40,
      blob: mine,
      mode: 0o666,
    });
    expect(r.ownerSeqs?.map((c) => c.ownerUid)).toEqual([ALICE, BOB]);
    const second = await engine.applyOp(
      origin(ALICE, ids.dev),
      writeOp({
        opId: uuidv7(),
        osSessionId: ids.osA,
        cseq: 3,
        principal: ALICE,
        ino: ids.report,
        sha: mine,
        size: 40,
        baseVersion: 1,
      }),
    );
    expect(second.keptAs?.name).toBe(name.replace(').md', ') 2.md'));
  });

  it('VFS-10 without w on the parent the conflicted copy goes to ~/lost+found (created 0700)', async () => {
    const bobBlob = await blob(5, 50);
    await engine.applyOp(
      origin(BOB),
      writeOp({
        opId: uuidv7(),
        osSessionId: ids.osB,
        cseq: 2,
        principal: BOB,
        ino: ids.plan,
        sha: bobBlob,
        size: 50,
        baseVersion: 1,
      }),
    );
    const mine = await blob(6, 60);
    const op = writeOp({
      opId: uuidv7(),
      osSessionId: ids.osA,
      cseq: 4,
      principal: ALICE,
      ino: ids.plan,
      sha: mine,
      size: 60,
      baseVersion: 1,
    });
    const r = await engine.applyOp(origin(ALICE, ids.dev), op);
    const lf = deriveIno(op.opId, aliceHome);
    expect(r).toMatchObject({ status: 'conflict', keptAs: { parentIno: lf } });
    const dir = await sql<{ mode: number; uid: number; name: string }>`
      SELECT i.mode, i.uid, d.name FROM inodes i JOIN dentries d USING (ino) WHERE i.ino = ${lf}`.execute(
      db,
    );
    expect(dir.rows[0]).toEqual({ mode: 0o700, uid: ALICE, name: 'lost+found' });
  });

  it('VFS-09 a write under another session X lease is conflict EBUSY lease; a stale fence is conflict EBUSY stale-fence', async () => {
    const locks = new KyselyLockStore(db);
    const g = await locks.acquire({
      ino: ids.report,
      osSessionId: ids.osB,
      holderUid: BOB,
      mode: 'X',
      ttlMs: 30_000,
    });
    expect(g.kind).toBe('granted');
    if (g.kind !== 'granted') return;
    const s = await blob(7, 70);
    const current = (await fileRow(ids.report))?.version ?? 0;
    const busy = await engine.applyOp(
      origin(ALICE, ids.dev),
      writeOp({
        opId: uuidv7(),
        osSessionId: ids.osA,
        cseq: 5,
        principal: ALICE,
        ino: ids.report,
        sha: s,
        size: 70,
        baseVersion: current,
      }),
    );
    expect(busy).toMatchObject({ status: 'conflict', errno: 'EBUSY', reason: 'lease' });
    const zombie = await engine.applyOp(
      origin(ALICE, ids.dev),
      writeOp({
        opId: uuidv7(),
        osSessionId: ids.osA,
        cseq: 6,
        principal: ALICE,
        ino: ids.report,
        sha: s,
        size: 70,
        baseVersion: current,
        fences: [{ ino: ids.report, fence: g.lease.fence - 1 }],
      }),
    );
    expect(zombie).toMatchObject({ status: 'conflict', errno: 'EBUSY', reason: 'stale-fence' });
    const holder = await engine.applyOp(
      origin(BOB),
      writeOp({
        opId: uuidv7(),
        osSessionId: ids.osB,
        cseq: 3,
        principal: BOB,
        ino: ids.report,
        sha: s,
        size: 70,
        baseVersion: current,
        fences: [{ ino: ids.report, fence: g.lease.fence }],
      }),
    );
    expect(holder.status).toBe('applied');
    await locks.releaseSessions([ids.osB]);
  });

  it('OFF-02 a deterministic rejection is recorded before the reply and replayed for a resend; a missing blob persists nothing', async () => {
    const s = await blob(8, 80);
    const op = writeOp({
      opId: uuidv7(),
      osSessionId: ids.osB,
      cseq: 4,
      principal: BOB,
      ino: ids.notes,
      sha: s,
      size: 80,
      baseVersion: 2,
    });
    expect(await engine.applyOp(origin(BOB), op)).toMatchObject({
      status: 'rejected',
      errno: 'EACCES',
    });
    expect(await engine.applyOp(origin(BOB), op)).toMatchObject({
      status: 'rejected',
      errno: 'EACCES',
      duplicate: true,
    });
    const missing = writeOp({
      opId: uuidv7(),
      osSessionId: ids.osA,
      cseq: 7,
      principal: ALICE,
      ino: ids.notes,
      sha: sha(0xdead),
      size: 1,
      baseVersion: 2,
    });
    expect(await engine.applyOp(origin(ALICE, ids.dev), missing)).toMatchObject({
      status: 'retry',
      errno: 'EAGAIN',
      reason: 'blob-missing',
    });
    const n = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM op_log WHERE op_id = ${missing.opId}`.execute(db);
    expect(n.rows[0]?.n).toBe(0);
  });

  it('SYN-05 the feed reader pages per owner with effects and lamport; heads and the directory context come from the same rows', async () => {
    const reader = new KyselyFeedReader(db);
    const heads = await reader.heads([ALICE, BOB, 999_999]);
    expect(heads.get(ALICE)?.feedSeq).toBeGreaterThanOrEqual(3);
    expect(heads.get(ALICE)?.purgedSeq).toBe(0);
    expect(heads.has(999_999)).toBe(false);
    expect(await reader.heads([])).toEqual(new Map());
    const page = await reader.page(ALICE, 0, 2);
    expect(page.map((r) => r.seq)).toEqual([1, 2]);
    expect(page[0]).toMatchObject({ ownerUid: ALICE, purged: false });
    expect(page[0]?.changes[0]).toMatchObject({ kind: 'upsert', ino: ids.notes });
    expect(page[0]?.lamport).toBeGreaterThan(0);
    const ctx = await reader.load([ids.report]);
    expect(ctx.get(ids.report)?.parent).toBe(ids.shared);
    expect(ctx.get(ids.shared)?.parent).toBe(INO.HOME);
    expect(ctx.get(INO.ROOT)?.parent).toBeNull();
    expect(await reader.load([])).toEqual(new Map());
  });

  it('SYN-11 an OS session id belongs to one uid: registration by another uid is refused and ownership is per device', async () => {
    const st = sessions();
    expect(
      await st.register({
        osSessionId: ids.osA,
        ownerUid: BOB,
        authSessionId: null,
        deviceId: ids.dev,
        kernelEpoch: 9,
      }),
    ).toBe(false);
    expect(await st.owns(ids.osA, ALICE, ids.dev)).toBe(true);
    expect(await st.owns(ids.osA, ALICE, null)).toBe(true);
    expect(await st.owns(ids.osA, ALICE, uuidv7())).toBe(false);
    expect(await st.owns(ids.osA, BOB, null)).toBe(false);
  });

  it('OFF-02 the runtime wires the engine, the lease manager and the hub over the same database', async () => {
    const runtime = createSyncRuntime({
      db,
      cancel: new CancelRegistry(),
      build: { name: 'Plotinium', version: '0.3.0', build: 'abc1234', date: '2026-11-14' },
      leaseTtlMs: 15_000,
      lockTimeoutMs: 2_000,
      statementTimeoutMs: 10_000,
      timeZone: TZ,
      validateAuth: () => Promise.resolve(true),
      createHeap: testHeapFactory,
    });
    await runtime.start();
    const s = await blob(9, 90);
    const current = (await fileRow(ids.notes))?.version ?? 0;
    const r = await runtime.engine.applyOp(
      origin(ALICE, ids.dev),
      writeOp({
        opId: uuidv7(),
        osSessionId: ids.osA,
        cseq: 8,
        principal: ALICE,
        ino: ids.notes,
        sha: s,
        size: 90,
        baseVersion: current,
      }),
    );
    expect(r.status).toBe('applied');
    const cred = { uid: ALICE, gid: 100, groups: [100] };
    expect(await runtime.hub.canWatch(cred, ids.shared)).toBe(true);
    expect(await runtime.hub.canWatch(cred, ids.report)).toBe(false); // not a directory
    expect(await runtime.hub.canWatch({ uid: 4242, gid: 4242, groups: [4242] }, aliceHome)).toBe(
      false,
    );
    runtime.hub.cancelBackend(uuidv7());
    await runtime.hub.shutdown(10);
  });
});
