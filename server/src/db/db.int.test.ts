/**
 * DB-gated integration tests: they run only when DATABASE_URL is set, and it MUST point at a
 * DISPOSABLE, freshly migrated database, connected as the owner role (plotinium_owner), for
 * example the scratch database of the migration round trip or `plotinium_test`:
 *
 *   docker compose -f compose.yaml -f compose.test.yaml up -d --wait db
 *   # create and migrate plotinium_test, then:
 *   DATABASE_URL=postgres://plotinium_owner:<pw>@127.0.0.1:55432/plotinium_test pnpm --filter @plotinium/server test
 *
 * Constraint probes run inside transactions that always roll back; the vfsTxn tests commit and
 * remove what they created afterwards. TEST_APP_DATABASE_URL (the plotinium_app role) enables the
 * grants test.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.ts';
import { parseConfig } from '../config.ts';
import { createLogger } from '../obs/logger.ts';
import { createMetrics } from '../obs/metrics.ts';
import { CancelRegistry } from '../vfs/cancel.ts';
import { kyselySteps } from '../vfs/steps.ts';
import { vfsTxn, type OpHandler } from '../vfs/tx.ts';
import type { OpContext, VfsError } from '../vfs/types.ts';
import { uuidv7 } from '../util/uuidv7.ts';
import { createDatabase, PG_TYPES, type Database } from './client.ts';
import { toErrno } from './errors.ts';
import type { DB } from './types.gen.ts';
import { appRoleUrl, scratchDatabaseUrl } from '../../tests/scratch-db.ts';

/** A per-file clone of DATABASE_URL's database (server/tests/scratch-db.ts). */
const URL_ = await scratchDatabaseUrl('db');
const APP_URL = appRoleUrl(URL_);
const ROOT = '00000000-0000-7000-8000-000000000001';
const SYSTEM = '00000000-0000-7000-8000-000000000003';
const SERVICES = '00000000-0000-7000-8000-000000000004';
const ROOT_HOME = '00000000-0000-7000-8000-000000000007';

let database: Database;
let db: Kysely<DB>;

const ROLLBACK = new Error('rollback');

/** Runs `fn` in a transaction that never commits; returns the errno its error maps to. */
async function errnoIn(fn: (tx: Kysely<DB>) => Promise<unknown>): Promise<VfsError | null> {
  try {
    await db.transaction().execute(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e === ROLLBACK) return null;
    return toErrno(e, { cancelled: false });
  }
  return null;
}

async function mkdirInode(tx: Kysely<DB>, parent: string, name: string, uid = 0): Promise<string> {
  const ino = uuidv7();
  await sql`INSERT INTO inodes (ino, type, mode, uid, gid, nlink) VALUES (${ino}, 'd', 493, ${uid}, 0, 2)`.execute(
    tx,
  );
  await sql`INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) VALUES (${parent}, ${name}, ${ino}, 'd', ${uid})`.execute(
    tx,
  );
  return ino;
}

describe.runIf(URL_ !== undefined)(
  'DB-04 constraints against PostgreSQL 18 (database.md §6.1)',
  () => {
    beforeAll(() => {
      database = createDatabase({
        url: URL_ ?? '',
        password: undefined,
        poolMax: 4,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 2_000,
      });
      db = database.db;
    });
    afterAll(async () => {
      await database.close();
    });

    it('DB-01 every table of database.md exists and schema_migrations lists every migration', async () => {
      const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(${[
        'users',
        'groups',
        'user_groups',
        'inodes',
        'dentries',
        'blobs',
        'locks',
        'op_log',
        'feed',
        'auth_sessions',
        'os_sessions',
        'swap_pages',
        'file_chunks',
        'telemetry_events',
        'audit_log',
        'llm_requests',
        'llm_usage',
      ]}::text[])`.execute(db);
      expect(r.rows[0]?.n).toBe(17);
      const m = await sql<{ n: number }>`SELECT count(*)::int AS n FROM schema_migrations`.execute(
        db,
      );
      expect(m.rows[0]?.n).toBeGreaterThanOrEqual(6);
    });

    it('DB-04 int8 parses to a safe number, beyond 2^53 throws, and date stays a YYYY-MM-DD string', async () => {
      const r = await sql<{
        big: number;
        d: string;
      }>`SELECT 9007199254740991::int8 AS big, '2026-09-24'::date AS d`.execute(db);
      expect(r.rows[0]).toEqual({ big: Number.MAX_SAFE_INTEGER, d: '2026-09-24' });
      await expect(sql`SELECT 9007199254740993::int8 AS x`.execute(db)).rejects.toThrow(RangeError);
      const client = new pg.Client({ connectionString: URL_, types: PG_TYPES });
      await client.connect();
      try {
        const c = await client.query<{ n: number }>('SELECT count(*) AS n FROM inodes');
        expect(typeof c.rows[0]?.n).toBe('number');
      } finally {
        await client.end();
      }
    });

    it('DB-04 a duplicate name in one directory fails with 23505 dentries_pkey and maps to EEXIST', async () => {
      const e = await errnoIn((tx) => mkdirInode(tx, ROOT, 'bin'));
      expect(e?.errno).toBe('EEXIST');
      expect(e?.detail['constraint']).toBe('dentries_pkey');
    });

    it('DB-04 a hard link to a directory fails on dentries_dir_one_parent and maps to EPERM', async () => {
      const e = await errnoIn((tx) =>
        sql`INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) VALUES (${ROOT}, 'bin2', '00000000-0000-7000-8000-000000000002', 'd', 0)`.execute(
          tx,
        ),
      );
      expect(e?.errno).toBe('EPERM');
    });

    it("DB-04 names '', '.', '..' and 'a/b' map to EINVAL, 256 bytes to ENAMETOOLONG, and 255 bytes is accepted", async () => {
      for (const name of ['', '.', '..', 'a/b'])
        expect((await errnoIn((tx) => mkdirInode(tx, ROOT_HOME, name)))?.errno).toBe('EINVAL');
      expect((await errnoIn((tx) => mkdirInode(tx, ROOT_HOME, 'x'.repeat(256))))?.errno).toBe(
        'ENAMETOOLONG',
      );
      expect(await errnoIn((tx) => mkdirInode(tx, ROOT_HOME, 'x'.repeat(255)))).toBeNull();
    });

    it('DB-04 a 128-character name of 256 bytes (U+00E4 is two bytes) fails because the limit counts bytes', async () => {
      expect((await errnoIn((tx) => mkdirInode(tx, ROOT_HOME, '\u00E4'.repeat(128))))?.errno).toBe(
        'ENAMETOOLONG',
      );
    });

    it('DB-04 an NFD-normalised name fails on dentries_name_nfc', async () => {
      const e = await errnoIn((tx) => mkdirInode(tx, ROOT_HOME, 'A\u0308rger'));
      expect(e?.errno).toBe('EINVAL');
      expect(e?.detail['constraint']).toBe('dentries_name_nfc');
    });

    it("DB-04 inode type 'x' fails on inodes_type_valid, modes 4096 and -1 fail on inodes_mode_range, and 4095 is accepted", async () => {
      const t = await errnoIn((tx) =>
        sql`INSERT INTO inodes (type, mode, uid, gid) VALUES ('x', 493, 0, 0)`.execute(tx),
      );
      expect(t?.detail['constraint']).toBe('inodes_type_valid');
      for (const mode of [4096, -1]) {
        const e = await errnoIn((tx) =>
          sql`INSERT INTO inodes (type, mode, uid, gid, nlink) VALUES ('d', ${mode}, 0, 0, 2)`.execute(
            tx,
          ),
        );
        expect(e?.errno).toBe('EINVAL');
        expect(e?.detail['constraint']).toBe('inodes_mode_range');
      }
      expect(
        await errnoIn((tx) =>
          sql`INSERT INTO inodes (type, mode, uid, gid, nlink) VALUES ('d', 4095, 0, 0, 2)`.execute(
            tx,
          ),
        ),
      ).toBeNull();
    });

    it('DB-04 a file used as a parent and a missing parent fail on dentries_parent_fk and map to ENOENT', async () => {
      const missing = await errnoIn((tx) => mkdirInode(tx, uuidv7(), 'orphan'));
      expect(missing?.errno).toBe('ENOENT');
      const fileParent = await errnoIn(async (tx) => {
        const f = uuidv7();
        await sql`INSERT INTO inodes (ino, type, mode, uid, gid) VALUES (${f}, 'f', 420, 0, 0)`.execute(
          tx,
        );
        await sql`INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) VALUES (${ROOT_HOME}, 'file', ${f}, 'f', 0)`.execute(
          tx,
        );
        await mkdirInode(tx, f, 'child');
      });
      expect(fileParent?.errno).toBe('ENOENT');
      expect(fileParent?.detail['constraint']).toBe('dentries_parent_fk');
    });

    it('DB-04 deleting the inode of a non-empty directory fails on dentries_parent_fk and maps to ENOTEMPTY', async () => {
      const e = await errnoIn(async (tx) => {
        await sql`DELETE FROM dentries WHERE ino = ${SYSTEM}`.execute(tx);
        await sql`DELETE FROM inodes WHERE ino = ${SYSTEM}`.execute(tx);
      });
      expect(e?.errno).toBe('ENOTEMPTY');
    });

    it('DB-03 the acyclicity trigger rejects a cycle with PTC01 even when the application skips the rename lock', async () => {
      const e = await errnoIn((tx) =>
        sql`UPDATE dentries SET parent_ino = ${SERVICES} WHERE ino = ${SYSTEM}`.execute(tx),
      );
      expect(e?.errno).toBe('EINVAL');
      expect(e?.detail['constraint']).toBe('dentries_acyclic');
    });

    it('DB-04 exceeding the byte or inode quota fails with EDQUOT while root is exempt', async () => {
      const over = await errnoIn(async (tx) => {
        await sql`INSERT INTO users (uid, username, password_hash, primary_gid, quota_bytes, quota_inodes) VALUES (3999, 'quotatest', '!', 100, 10, 10)`.execute(
          tx,
        );
        await sql`UPDATE users SET used_bytes = 11 WHERE uid = 3999`.execute(tx);
      });
      expect(over?.errno).toBe('EDQUOT');
      const inodes = await errnoIn(async (tx) => {
        await sql`INSERT INTO users (uid, username, password_hash, primary_gid, quota_bytes, quota_inodes) VALUES (3999, 'quotatest', '!', 100, 10, 10)`.execute(
          tx,
        );
        await sql`UPDATE users SET used_inodes = 11 WHERE uid = 3999`.execute(tx);
      });
      expect(inodes?.errno).toBe('EDQUOT');
      expect(
        await errnoIn((tx) =>
          sql`UPDATE users SET used_bytes = used_bytes + 1000000000000 WHERE uid = 0`.execute(tx),
        ),
      ).toBeNull();
    });

    it('DB-04 a non-guest user without a password hash and a blob hash that is not 32 bytes are rejected', async () => {
      const nopw = await errnoIn((tx) =>
        sql`INSERT INTO users (uid, username, primary_gid, quota_bytes, quota_inodes) VALUES (3998, 'nopw', 100, 1, 1)`.execute(
          tx,
        ),
      );
      expect(nopw?.detail['constraint']).toBe('users_password_required');
      const blob = await errnoIn((tx) =>
        sql`INSERT INTO blobs (sha256, size, storage_key) VALUES ('\\x00'::bytea, 1, 'x')`.execute(
          tx,
        ),
      );
      expect(blob?.detail['constraint']).toBe('blobs_sha256_len');
    });

    it('DB-04 S and X leases cannot coexist and a second X lease fails on locks_one_writer', async () => {
      const setup = async (tx: Kysely<DB>): Promise<[string, string]> => {
        const a = uuidv7();
        const b = uuidv7();
        await sql`INSERT INTO os_sessions (os_session_id, owner_uid) VALUES (${a}, 0), (${b}, 0)`.execute(
          tx,
        );
        return [a, b];
      };
      const lock = (tx: Kysely<DB>, s: string, mode: string) =>
        sql`INSERT INTO locks (ino, os_session_id, holder_uid, mode, fence, lease_expires_at)
          VALUES (${ROOT_HOME}, ${s}, 0, ${mode}, nextval('lock_fence_seq'), clock_timestamp() + interval '30 seconds')`.execute(
          tx,
        );
      const sx = await errnoIn(async (tx) => {
        const [a, b] = await setup(tx);
        await lock(tx, a, 'S');
        await lock(tx, b, 'X');
      });
      expect(sx).toMatchObject({ errno: 'EBUSY' });
      expect(sx?.reason).toBe('lease');
      const ss = await errnoIn(async (tx) => {
        const [a, b] = await setup(tx);
        await lock(tx, a, 'S');
        await lock(tx, b, 'S');
      });
      expect(ss).toBeNull();
      const xx = await errnoIn(async (tx) => {
        const [a, b] = await setup(tx);
        await lock(tx, a, 'X');
        await lock(tx, b, 'X');
      });
      expect(xx?.errno).toBe('EBUSY');
    });

    it("DB-04 a swap page filed under another user's OS session fails on swap_pages_session_fk and maps to EACCES", async () => {
      const e = await errnoIn(async (tx) => {
        const s = uuidv7();
        await sql`INSERT INTO users (uid, username, password_hash, primary_gid, quota_bytes, quota_inodes) VALUES (3997, 'swaptest', '!', 100, 1, 1)`.execute(
          tx,
        );
        await sql`INSERT INTO os_sessions (os_session_id, owner_uid) VALUES (${s}, 0)`.execute(tx);
        await sql`INSERT INTO swap_pages (owner_uid, os_session_id, pid, page_id, storage_key, size, stored_size, checksum)
                VALUES (3997, ${s}, 1, 0, 'k', 1, 1, ${Buffer.alloc(32)})`.execute(tx);
      });
      expect(e?.errno).toBe('EACCES');
    });

    it('DB-04 a file chunk on a directory fails on file_chunks_ino_fk and an agent audit row without prompt_id fails', async () => {
      const chunk = await errnoIn((tx) =>
        sql`INSERT INTO file_chunks (ino, inode_version, model_key, seq, byte_start, byte_end, line_start, line_end, text, content_hash, embedding)
          VALUES (${ROOT_HOME}, 1, 'mdbr-leaf-ir', 0, 0, 1, 1, 1, 'x', ${Buffer.alloc(32)}, ${`[${new Array(384).fill(0).join(',')}]`}::vector)`.execute(
          tx,
        ),
      );
      expect(chunk?.detail['constraint']).toBe('file_chunks_ino_fk');
      const audit = await errnoIn((tx) =>
        sql`INSERT INTO audit_log (uid, real_uid, actor, syscall, outcome) VALUES (0, 0, 'agent', 'unlink', 'ok')`.execute(
          tx,
        ),
      );
      expect(audit?.detail['constraint']).toBe('audit_agent_has_prompt');
    });

    it.runIf(APP_URL !== undefined)(
      'DB-04 the app role gets 42501 for UPDATE or DELETE on audit_log, DELETE on op_log, TRUNCATE and DDL',
      async () => {
        const client = new pg.Client({ connectionString: APP_URL, types: PG_TYPES });
        await client.connect();
        try {
          for (const stmt of [
            'UPDATE audit_log SET syscall = syscall',
            'DELETE FROM audit_log',
            'DELETE FROM op_log',
            'TRUNCATE inodes',
            'CREATE TABLE t (x int)',
          ]) {
            await expect(client.query(stmt)).rejects.toMatchObject({ code: '42501' });
          }
        } finally {
          await client.end();
        }
      },
    );
  },
);

describe.runIf(URL_ !== undefined)(
  'DB-02 vfsTxn end to end with the Kysely steps (database.md §3.9)',
  () => {
    const created: { opIds: string[]; names: string[] } = { opIds: [], names: [] };

    beforeAll(() => {
      database = createDatabase({
        url: URL_ ?? '',
        password: undefined,
        poolMax: 4,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 2_000,
      });
      db = database.db;
    });
    afterAll(async () => {
      // Remove what the committed tests created, restoring the counters they advanced.
      await db.transaction().execute(async (tx) => {
        const feed = await sql<{
          n: number;
        }>`DELETE FROM feed WHERE op_id = ANY(${created.opIds}::uuid[]) RETURNING 1 AS n`.execute(
          tx,
        );
        await sql`UPDATE users SET feed_seq = feed_seq - ${feed.rows.length} WHERE uid = 0`.execute(
          tx,
        );
        await sql`DELETE FROM op_log WHERE op_id = ANY(${created.opIds}::uuid[])`.execute(tx);
        const gone = await sql<{ ino: string }>`
        DELETE FROM dentries WHERE parent_ino = ${ROOT_HOME} AND name = ANY(${created.names}::text[]) RETURNING ino`.execute(
          tx,
        );
        if (gone.rows.length > 0) {
          await sql`DELETE FROM inodes WHERE ino = ANY(${gone.rows.map((r) => r.ino)}::uuid[])`.execute(
            tx,
          );
          await sql`UPDATE inodes SET nlink = nlink - ${gone.rows.length} WHERE ino = ${ROOT_HOME}`.execute(
            tx,
          );
          await sql`UPDATE users SET used_inodes = used_inodes - ${gone.rows.length} WHERE uid = 0`.execute(
            tx,
          );
        }
      });
      await database.close();
    });

    const steps = () => kyselySteps(db);
    const deps = () => ({
      steps: steps(),
      cancel: new CancelRegistry(),
      lockTimeoutMs: 2_000,
      statementTimeoutMs: 10_000,
    });

    function op(name: string, fault?: OpContext['fault']): OpContext {
      const opId = uuidv7();
      created.opIds.push(opId);
      created.names.push(name);
      return {
        opId,
        principal: { uid: 0, realUid: 0, gids: [0] },
        osSessionId: uuidv7(),
        cseq: 1,
        lamport: 1,
        call: 'mkdir',
        args: { parent: ROOT_HOME, name },
        signal: new AbortController().signal,
        ...(fault === undefined ? {} : { fault }),
      };
    }

    /** mkdir in /root as root: the statements of database.md §4.11.14. */
    function mkdir(name: string): OpHandler<Transaction<DB>, { ino: string }> {
      return {
        plan: () =>
          Promise.resolve({
            owners: [0],
            renameLock: false,
            dirs: [ROOT_HOME],
            files: [],
            subtreeRoots: [],
          }),
        recheck: () => Promise.resolve(),
        body: async (tx) => {
          const ino = uuidv7();
          await sql`INSERT INTO inodes (ino, type, mode, uid, gid, size, nlink) VALUES (${ino}, 'd', 448, 0, 0, 0, 2)`.execute(
            tx,
          );
          await sql`INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) VALUES (${ROOT_HOME}, ${name}, ${ino}, 'd', 0)`.execute(
            tx,
          );
          await sql`UPDATE inodes SET modified_at = now(), changed_at = now(), version = version + 1, nlink = nlink + 1 WHERE ino = ${ROOT_HOME}`.execute(
            tx,
          );
          await sql`UPDATE users SET used_bytes = used_bytes + 0, used_inodes = used_inodes + 1 WHERE uid = 0`.execute(
            tx,
          );
          return { status: 'applied', result: { ino }, effects: { mkdir: ino }, owners: [0] };
        },
      };
    }

    const checksum = async (): Promise<string> =>
      (await sql<{ c: string }>`SELECT plt_tree_checksum(${ROOT}::uuid) AS c`.execute(db)).rows[0]
        ?.c ?? '';

    it('OFF-02 a committed op writes one op_log row and one gap-free feed row, and a duplicate returns the stored result', async () => {
      const before = await sql<{
        s: number;
      }>`SELECT feed_seq AS s FROM users WHERE uid = 0`.execute(db);
      const o = op(`t-${Date.now()}-a`);
      const out = await vfsTxn(deps(), o, mkdir((o.args as { name: string }).name));
      expect(out.kind).toBe('applied');
      const row = await sql<{ status: string; n: number }>`
      SELECT status, (SELECT count(*)::int FROM feed WHERE op_id = ${o.opId}) AS n FROM op_log WHERE op_id = ${o.opId}`.execute(
        db,
      );
      expect(row.rows[0]).toEqual({ status: 'applied', n: 1 });
      const after = await sql<{ s: number }>`SELECT feed_seq AS s FROM users WHERE uid = 0`.execute(
        db,
      );
      expect(after.rows[0]?.s).toBe((before.rows[0]?.s ?? 0) + 1);

      const again = await vfsTxn(deps(), o, mkdir('never-created'));
      expect(again.kind).toBe('duplicate');
      if (again.kind === 'duplicate')
        expect(again.result).toEqual(out.kind === 'applied' ? out.result : null);
    });

    it('DB-02 a fault at node 1 rolls back with EIO injected, leaves the checksum unchanged, and a resend returns the recorded EIO', async () => {
      const before = await checksum();
      const o = op(`t-${Date.now()}-f`, { after: 0, on: 'inodes' });
      const handler = mkdir((o.args as { name: string }).name);
      await expect(vfsTxn(deps(), o, handler)).rejects.toMatchObject({
        errno: 'EIO',
        detail: { reason: 'injected' },
      });
      expect(await checksum()).toBe(before);
      const stored = await sql<{
        status: string;
        errno: string;
      }>`SELECT status, errno FROM op_log WHERE op_id = ${o.opId}`.execute(db);
      expect(stored.rows[0]).toEqual({ status: 'rejected', errno: 'EIO' });
      const { fault: _fault, ...resend } = o;
      const again = await vfsTxn(deps(), resend, handler);
      expect(again).toMatchObject({ kind: 'duplicate', status: 'rejected', errno: 'EIO' });
    });

    it('DB-04 an EEXIST inside vfsTxn is recorded as a deterministic rejection', async () => {
      const o = op('bin-duplicate');
      const handler: ReturnType<typeof mkdir> = {
        ...mkdir('x'),
        body: async (tx) => {
          await sql`INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) VALUES (${ROOT}, 'bin', '00000000-0000-7000-8000-000000000002', 'd', 0)`.execute(
            tx,
          );
          return { status: 'applied', result: { ino: '' }, effects: {}, owners: [0] };
        },
      };
      await expect(vfsTxn(deps(), o, handler)).rejects.toMatchObject({ errno: 'EEXIST' });
      const stored = await sql<{
        status: string;
        errno: string;
      }>`SELECT status, errno FROM op_log WHERE op_id = ${o.opId}`.execute(db);
      expect(stored.rows[0]).toEqual({ status: 'rejected', errno: 'EEXIST' });
    });

    it('SRV-17 readyz reports the database and the applied migration version', async () => {
      const config = parseConfig({ LOG_LEVEL: 'silent', BLOB_DIR: '/tmp/plt-int-blobs' }, () => '');
      const newest = await sql<{
        v: string;
      }>`SELECT max(version) AS v FROM schema_migrations`.execute(db);
      const built = await buildApp(config, {
        database,
        logger: createLogger(config),
        metrics: createMetrics({ defaultMetrics: false }),
        expectedMigration: newest.rows[0]?.v ?? null,
      });
      built.readiness.markReady();
      const res = await built.app.inject({ method: 'GET', url: '/api/readyz' });
      expect(res.json()).toMatchObject({
        status: 'ready',
        checks: { db: 'ok', migrations: 'ok' },
        migrations: { version: newest.rows[0]?.v },
      });
      await built.app.close();
    });
  },
);
