/**
 * DB-gated tests of the gateway and the first-start seed against PostgreSQL 18. They run only when
 * DATABASE_URL points at a DISPOSABLE, freshly migrated database as the OWNER role (see
 * db.int.test.ts for the recipe); TEST_APP_DATABASE_URL (role plotinium_app) runs the login flow
 * with the run-time privileges. The seed test creates and drops its own scratch database.
 * Every run uses fresh account names, so the tests can share one database across runs.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type PlotiniumApp } from '../app.ts';
import { parseConfig } from '../config.ts';
import { createDatabase, type Database } from '../db/client.ts';
import { createMetrics } from '../obs/metrics.ts';
import { reissueDemoCredentials, runDemoSeed } from '../seed/demo.ts';
import { hashPassword, verifyPassword } from './argon2.ts';
import { KyselyAuthStore } from './kysely-store.ts';
import type { AuthMe } from './schemas.ts';
import { appRoleUrl, scratchDatabaseUrl } from '../../tests/scratch-db.ts';

/** A per-file clone of DATABASE_URL's database (server/tests/scratch-db.ts). */
const OWNER_URL = await scratchDatabaseUrl('auth');
const APP_URL = appRoleUrl(OWNER_URL);
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ROOT = '00000000-0000-7000-8000-000000000001';
const HOME = '00000000-0000-7000-8000-000000000008';
const SAME = { 'sec-fetch-site': 'same-origin' };

const dbConfig = (url: string) => ({
  url,
  password: undefined,
  poolMax: 4,
  statementTimeoutMs: 60_000,
  lockTimeoutMs: 2_000,
});

/** db/probes/integrity.sql without its psql meta-commands and transaction lines (one source). */
async function probeSql(): Promise<string> {
  const text = await readFile(join(REPO, 'db/probes/integrity.sql'), 'utf8');
  return text
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/^(BEGIN|COMMIT)\b/.test(l))
    .join('\n')
    .replaceAll(":'root'", `'${ROOT}'`)
    .replace(/;\s*$/, '');
}

async function probes(database: Database): Promise<{ probe: string; detail: string }[]> {
  return (await database.pool.query<{ probe: string; detail: string }>(await probeSql())).rows;
}

describe.runIf(OWNER_URL !== undefined)(
  'SRV-08 the gateway on PostgreSQL (backend-api.md §3.6.1, §3.8)',
  () => {
    let owner: Database;
    let runtime: Database;
    let built: PlotiniumApp;
    let blobDir: string;
    const name = `t${randomBytes(4).toString('hex')}`;
    const password = 'integration-password-1';
    let uid = 0;

    beforeAll(async () => {
      owner = createDatabase(dbConfig(OWNER_URL ?? ''));
      runtime = createDatabase(dbConfig(APP_URL ?? OWNER_URL ?? ''));
      blobDir = await mkdtemp(join(tmpdir(), 'plt-auth-int-'));
      const free = await sql<{ uid: number }>`
      SELECT min(g)::int AS uid FROM generate_series(30000, 39999) g WHERE NOT EXISTS (SELECT 1 FROM users WHERE uid = g)`.execute(
        owner.db,
      );
      uid = free.rows[0]?.uid ?? 30_000;
      await sql`INSERT INTO users (uid, username, account_kind, password_hash, primary_gid, quota_bytes, quota_inodes)
              VALUES (${uid}, ${name}, 'user', ${await hashPassword(password)}, 100, 1048576, 100)`.execute(
        owner.db,
      );
      const config = parseConfig(
        { BLOB_DIR: blobDir, LOG_LEVEL: 'silent', GUEST_MAX_ACTIVE: '10000' },
        () => '',
      );
      built = await buildApp(config, {
        database: runtime,
        metrics: createMetrics({ defaultMetrics: false }),
        expectedMigration: null,
      });
    });
    afterAll(async () => {
      await built.app.close();
      await runtime.close();
      await owner.close();
      await rm(blobDir, { recursive: true, force: true });
    });

    it('SRV-08 login, me and logout work against the real tables as the app role and are audited', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: SAME,
        payload: { username: name, password },
      });
      expect(res.statusCode).toBe(200);
      const cookie = String(res.headers['set-cookie']).split(';')[0] ?? '';
      const [id, secret] = (cookie.split('=')[1] ?? '').split('.');
      const row = await sql<{ secret_hash: Buffer; expires_at: Date; absolute_expires_at: Date }>`
      SELECT secret_hash, expires_at, absolute_expires_at FROM auth_sessions WHERE id = ${id}`.execute(
        owner.db,
      );
      expect(row.rows[0]?.secret_hash.length).toBe(32);
      expect(row.rows[0]?.secret_hash.toString('hex')).not.toContain(
        Buffer.from(secret ?? '').toString('hex'),
      );
      const me = await built.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
      });
      expect(me.json<AuthMe>()).toMatchObject({
        uid,
        username: name,
        gid: 100,
        groups: [{ gid: 100, name: 'users' }],
      });
      expect(
        (
          await built.app.inject({
            method: 'POST',
            url: '/api/auth/logout',
            headers: { ...SAME, cookie },
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (await built.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } }))
          .statusCode,
      ).toBe(401);
      const audit = await sql<{
        syscall: string;
      }>`SELECT syscall FROM audit_log WHERE uid = ${uid} ORDER BY id`.execute(owner.db);
      expect(audit.rows.map((r) => r.syscall)).toEqual([
        'login.success',
        'session.revoke',
        'logout',
      ]);
    });

    it('OFF-03 the users table holds only PHC Argon2id strings and a changed password never appears in any table', async () => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: SAME,
        payload: { username: name, password },
      });
      const cookie = String(res.headers['set-cookie']).split(';')[0] ?? '';
      const canary = `canary-${randomBytes(6).toString('hex')}`;
      const change = await built.app.inject({
        method: 'POST',
        url: '/api/auth/password',
        headers: { ...SAME, cookie },
        payload: { current: password, next: canary },
      });
      expect(change.statusCode).toBe(204);
      const bad = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM users
      WHERE password_hash IS NOT NULL AND password_hash <> '!' AND password_hash !~ '^\\$argon2id\\$v=19\\$m=[0-9]+,t=[0-9]+,p=[0-9]+\\$[A-Za-z0-9+/]+\\$[A-Za-z0-9+/]+$'`.execute(
        owner.db,
      );
      expect(bad.rows[0]?.n).toBe(0);
      for (const table of ['users', 'auth_sessions', 'audit_log']) {
        const hit = await owner.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} t WHERE t::text LIKE $1`,
          [`%${canary}%`],
        );
        expect(hit.rows[0]?.n, table).toBe(0);
      }
      const version = await sql<{
        v: number;
      }>`SELECT password_version AS v FROM users WHERE uid = ${uid}`.execute(owner.db);
      expect(version.rows[0]?.v).toBe(2);
      // restore for later tests in this run
      await sql`UPDATE users SET password_hash = ${await hashPassword(password)} WHERE uid = ${uid}`.execute(
        owner.db,
      );
    });

    it('BOOT-14 a guest login creates the user, a 0700 home under /home and a 2-hour session in one transaction, and the probes stay clean', async () => {
      const before = await sql<{
        nlink: number;
      }>`SELECT nlink FROM inodes WHERE ino = ${HOME}`.execute(owner.db);
      const res = await built.app.inject({ method: 'POST', url: '/api/auth/guest', headers: SAME });
      expect(res.statusCode).toBe(201);
      const me = res.json<AuthMe>();
      expect(me.uid).toBeGreaterThanOrEqual(60_000);
      expect(me.uid).toBeLessThanOrEqual(60_999);
      const home = await sql<{ mode: number; uid: number; gid: number; type: string }>`
      SELECT i.mode, i.uid, i.gid, i.type FROM dentries d JOIN inodes i ON i.ino = d.ino
      WHERE d.parent_ino = ${HOME} AND d.name = ${me.username}`.execute(owner.db);
      expect(home.rows[0]).toEqual({ mode: 0o700, uid: me.uid, gid: 60_000, type: 'd' });
      const after = await sql<{
        nlink: number;
      }>`SELECT nlink FROM inodes WHERE ino = ${HOME}`.execute(owner.db);
      expect(after.rows[0]?.nlink).toBe((before.rows[0]?.nlink ?? 0) + 1);
      const q = await sql<{ quota_bytes: number; quota_inodes: number; used_inodes: number }>`
      SELECT quota_bytes, quota_inodes, used_inodes FROM users WHERE uid = ${me.uid}`.execute(
        owner.db,
      );
      expect(q.rows[0]).toEqual({
        quota_bytes: 20 * 1024 * 1024,
        quota_inodes: 500,
        used_inodes: 1,
      });
      expect(await probes(owner)).toEqual([]);
    });

    it('SRV-19 credentials come from the database: primary gid first, then supplementary groups', async () => {
      await sql`INSERT INTO groups (gid, name) VALUES (200, 'team') ON CONFLICT (gid) DO NOTHING`.execute(
        owner.db,
      );
      await sql`INSERT INTO user_groups (uid, gid) VALUES (${uid}, 200) ON CONFLICT DO NOTHING`.execute(
        owner.db,
      );
      const store = new KyselyAuthStore(runtime.db);
      expect(await store.credentials(uid)).toEqual({ uid, gids: [100, 200] });
      expect(await store.credentials(99_999_999)).toBeNull();
      expect(await store.profile(99_999_999)).toBeNull();
      expect(await store.usernameOf(uid)).toBe(name);
      expect(await store.revokeSessions([], new Date())).toEqual([]);
    });
  },
);

/** dbmate's behaviour, enough for a scratch database: schema_migrations, then every up section. */
async function migrate(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version varchar(128) PRIMARY KEY)',
    );
    const dir = join(REPO, 'db/migrations');
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      const text = await readFile(join(dir, file), 'utf8');
      const up = text.split('-- migrate:down')[0]?.split('-- migrate:up')[1] ?? '';
      await client.query('BEGIN');
      await client.query(up);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [
        file.slice(0, 14),
      ]);
      await client.query('COMMIT');
    }
  } finally {
    await client.end();
  }
}

describe.runIf(OWNER_URL !== undefined)(
  'SRV-20 the first-start seed (backend-api.md §3.18.3; database.md §3.27)',
  () => {
    const scratch = `plotinium_seed_${randomBytes(4).toString('hex')}`;
    let admin: pg.Client;
    let database: Database;

    beforeAll(async () => {
      admin = new pg.Client({ connectionString: OWNER_URL });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${scratch}`);
      const url = new URL(OWNER_URL ?? '');
      url.pathname = `/${scratch}`;
      await migrate(url.toString());
      database = createDatabase(dbConfig(url.toString()), {
        applicationName: 'plotinium-seed-test',
      });
    }, 60_000);
    afterAll(async () => {
      await database.close();
      await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
      await admin.end();
    });

    it('SRV-20 a fresh database prints first-start credentials once and never again, with the bench dataset and clean probes', async () => {
      const printed: string[] = [];
      const run = promisify(execFile);
      const benchSql = async () =>
        (
          await run(
            process.execPath,
            [join(REPO, 'db/seed/seed.ts'), '--profile', 'bench10k', '--no-vacuum'],
            { maxBuffer: 1 << 30 },
          )
        ).stdout;
      const first = await runDemoSeed({
        database,
        examiners: 2,
        benchSql,
        print: (t) => printed.push(t),
      });
      expect(first).toEqual({
        seeded: true,
        benchLoaded: true,
        accounts: ['demo', 'alice', 'bob', 'examiner1', 'examiner2'],
      });
      expect(printed).toHaveLength(1);
      const block = printed[0] ?? '';
      expect(block).toContain('FIRST-START CREDENTIALS (shown once)');
      const lines = [...block.matchAll(/^ {2}([a-z0-9]+) +([a-z2-7]{20})\b/gm)];
      expect(lines.map((m) => m[1])).toEqual([
        'root',
        'demo',
        'alice',
        'bob',
        'examiner1',
        'examiner2',
      ]);

      const second = await runDemoSeed({
        database,
        examiners: 2,
        benchSql,
        print: (t) => printed.push(t),
      });
      expect(second.seeded).toBe(false);
      expect(printed).toHaveLength(1);

      const users = await sql<{
        username: string;
        account_kind: string;
        password_hash: string;
        groups: number[];
      }>`
      SELECT u.username, u.account_kind, u.password_hash, array(SELECT gid FROM user_groups g WHERE g.uid = u.uid ORDER BY gid) AS groups
      FROM users u WHERE u.uid IN (0, 1000, 1100, 1101, 1200) ORDER BY u.uid`.execute(database.db);
      expect(users.rows.map((u) => [u.username, u.account_kind, u.groups])).toEqual([
        ['root', 'root', []],
        ['demo', 'demo', []],
        ['alice', 'user', [200]],
        ['bob', 'user', [200]],
        ['examiner1', 'examiner', [300]],
      ]);
      for (const u of users.rows) {
        expect(u.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
        for (const m of lines) expect(u.password_hash).not.toContain(m[2]);
      }
      const count = await sql<{ n: number }>`SELECT count(*)::int AS n FROM inodes`.execute(
        database.db,
      );
      expect(count.rows[0]?.n).toBe(10_000 + 5); // bench10k + five homes
      expect(await probes(database)).toEqual([]);
    }, 120_000);

    it('SRV-20 --reissue-credentials prints new working passwords for the seeded accounts, invalidates the old ones and revokes their sessions', async () => {
      const store = new KyselyAuthStore(database.db);
      const before = await sql<{ uid: number; password_hash: string; password_version: number }>`
        SELECT uid, password_hash, password_version FROM users WHERE uid IN (0, 1000, 1100) ORDER BY uid`.execute(
        database.db,
      );
      const now = Date.now();
      await sql`INSERT INTO auth_sessions (id, secret_hash, uid, expires_at, absolute_expires_at)
                VALUES ('reissue-test-session-0001', ${Buffer.alloc(32)}, 1100,
                        ${new Date(now + 3_600_000)}, ${new Date(now + 7_200_000)})`.execute(
        database.db,
      );

      const printed: string[] = [];
      const names = await reissueDemoCredentials({ database, print: (t) => printed.push(t) });
      expect(names).toEqual(['root', 'demo', 'alice', 'bob', 'examiner1', 'examiner2']);
      const block = printed[0] ?? '';
      expect(block).toContain('RE-ISSUED CREDENTIALS');
      const fresh = new Map(
        [...block.matchAll(/^ {2}([a-z0-9]+) +([a-z2-7]{20})\b/gm)].map((m) => [m[1], m[2]]),
      );
      expect([...fresh.keys()]).toEqual(names);

      const after = await sql<{ uid: number; password_hash: string; password_version: number }>`
        SELECT uid, password_hash, password_version FROM users WHERE uid IN (0, 1000, 1100) ORDER BY uid`.execute(
        database.db,
      );
      for (const [i, row] of after.rows.entries()) {
        expect(row.password_hash).not.toBe(before.rows[i]?.password_hash);
        expect(row.password_version).toBe((before.rows[i]?.password_version ?? 0) + 1);
      }
      // The new password verifies against the stored hash (the login path's own check).
      const alice = await store.findLoginUser('alice');
      expect(await verifyPassword(alice?.passwordHash ?? '', fresh.get('alice') ?? '')).toBe(true);
      const revoked = await sql<{ revoked: boolean }>`
        SELECT revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE id = 'reissue-test-session-0001'`.execute(
        database.db,
      );
      expect(revoked.rows[0]?.revoked).toBe(true);
    });
  },
);
