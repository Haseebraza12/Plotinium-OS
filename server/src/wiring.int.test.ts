/**
 * The wired server end to end on PostgreSQL 18 (backend-api.md §3.2-§3.17; offline-and-sync.md
 * §4): buildApp with the real database, LISTENING on a port, and a real WebSocket client on /ws.
 * It proves the plugins are wired to the engines, not only that each engine works alone:
 *
 *   /ws upgrade checks -> hello / hello.ok / resume.done -> op.submit (create, write, unlink) with
 *   op.result and vfs.changed to a second OS session -> leases with fencing, heartbeats, release ->
 *   POST /api/ops/{opId} -> GET /api/sync/snapshot -> /api/blobs -> /api/swap -> /api/telemetry ->
 *   /api/index -> /api/llm without a key -> the fault harness (root su, one-shot arm, EIO injected)
 *   -> su revocation SIGHUP -> logout revocation (bye revoked / 4401) -> drain (bye restart / 1012).
 *
 * DB-gated: runs only with DATABASE_URL (a freshly migrated database used as a template; the file
 * gets its own clone, server/tests/scratch-db.ts). With TEST_APP_DATABASE_URL as well, the server
 * connects as plotinium_app, so the production grants are exercised by every route above.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  deriveIno,
  PROTO,
  type BuildIdentity,
  type OpSubmit,
  type ResumeCursor,
  type VfsOp,
} from '@plotinium/protocol';

import { appRoleUrl, scratchDatabaseUrl } from '../tests/scratch-db.ts';
import { UpgradeRefused, WsTestClient } from '../tests/ws-client.ts';
import { buildApp, type PlotiniumApp } from './app.ts';
import { parseConfig } from './config.ts';
import { createDatabase, type Database } from './db/client.ts';
import { hashPassword } from './gateway/argon2.ts';
import { createHome } from './gateway/homes.ts';
import { createLogger } from './obs/logger.ts';
import { createMetrics } from './obs/metrics.ts';
import { uuidv7 } from './util/uuidv7.ts';

const URL_ = await scratchDatabaseUrl('wiring');
/** With TEST_APP_DATABASE_URL the server runs with the production grants (plotinium_app). */
const APP_URL = appRoleUrl(URL_);
const ORIGIN = 'http://localhost:4717';
const SAME = { 'sec-fetch-site': 'same-origin' } as const;
const ALICE = 4301;
const BOB = 4302;
const PASSWORD = 'wiring-password-1';
const ROOT_PASSWORD = 'wiring-root-password-1';
const CLIENT_BUILD: BuildIdentity = {
  name: 'Plotinium',
  version: '0.1.0',
  build: '0000000',
  date: '1970-01-01',
};

type Res = Awaited<ReturnType<PlotiniumApp['app']['inject']>>;
const cookieOf = (res: Res): string => String(res.headers['set-cookie']).split(';')[0] ?? '';
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** db/probes/integrity.sql without its psql meta-commands and transaction lines (every probe row is a violation). */
async function integrityViolations(
  database: Database,
): Promise<{ probe: string; detail: string }[]> {
  const text = (await readFile(join(REPO, 'db/probes/integrity.sql'), 'utf8'))
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/^(BEGIN|COMMIT)\b/.test(l))
    .join('\n')
    .replaceAll(":'root'", "'00000000-0000-7000-8000-000000000001'")
    .replace(/;\s*$/, '');
  return (await database.pool.query<{ probe: string; detail: string }>(text)).rows;
}

describe.runIf(URL_ !== undefined)(
  'SRV-07 SYN-01 the wired server over a real socket (backend-api.md §3.7; offline-and-sync.md §4)',
  () => {
    /** The owner connection: fixtures and assertions. */
    let database: Database;
    /** The server's own connection (the app role when available). */
    let runtime: Database;
    let built: PlotiniumApp;
    let blobDir: string;
    let wsUrl = '';
    let aliceHome = '';
    let bobHome = '';
    let alice = ''; // cookie
    let bob = ''; // cookie
    const os = { a1: uuidv7(), a2: uuidv7(), b1: uuidv7() };
    const dev = { a1: uuidv7(), a2: uuidv7(), b1: uuidv7() };
    const sockets: WsTestClient[] = [];
    let a1: WsTestClient;
    let a2: WsTestClient;
    let b1: WsTestClient;
    let cseq = 0;
    const file = { ino: uuidv7(), version: 0 };

    const inject = (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD',
      url: string,
      cookie: string,
      extra: {
        payload?: unknown;
        headers?: Record<string, string>;
      } = {},
    ): Promise<Res> =>
      built.app.inject({
        method,
        url,
        headers: {
          cookie,
          ...(method === 'GET' || method === 'HEAD' ? {} : SAME),
          ...extra.headers,
        },
        ...(extra.payload === undefined ? {} : { payload: extra.payload as string }),
      });

    const submit = (
      osSessionId: string,
      principal: number,
      op: VfsOp,
      base: OpSubmit['base'] = { kind: 'versions', entries: [] },
    ): OpSubmit => {
      cseq++;
      return {
        opId: uuidv7(),
        osSessionId,
        cseq,
        lamport: cseq,
        principal,
        clientTime: new Date().toISOString(),
        op,
        base,
      };
    };

    const open = async (cookie: string): Promise<WsTestClient> => {
      const c = await WsTestClient.connect(wsUrl, { origin: ORIGIN, cookie });
      sockets.push(c);
      return c;
    };

    const hello = (
      c: WsTestClient,
      osSessionId: string,
      deviceId: string,
      resume: ResumeCursor[],
    ): number =>
      c.send('hello', {
        proto: PROTO,
        build: CLIENT_BUILD,
        osSessionId,
        deviceId,
        kernelEpoch: 1,
        lamport: 0,
        outbox: { pending: 0, held: 0 },
        heldLeases: [],
        resume,
      });

    const login = async (username: string, password: string): Promise<string> => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: SAME,
        payload: { username, password },
      });
      expect(res.statusCode, res.body).toBe(200);
      return cookieOf(res);
    };

    beforeAll(async () => {
      const dbConfig = (url: string) => ({
        url,
        password: undefined,
        poolMax: 8,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 2_000,
      });
      database = createDatabase(dbConfig(URL_ ?? ''));
      runtime = APP_URL === undefined ? database : createDatabase(dbConfig(APP_URL));
      const db = database.db;
      const hash = await hashPassword(PASSWORD);
      for (const [uid, name] of [
        [ALICE, 'wialice'],
        [BOB, 'wibob'],
      ] as const) {
        await sql`INSERT INTO users (uid, username, password_hash, primary_gid, quota_bytes, quota_inodes)
                  VALUES (${uid}, ${name}, ${hash}, 100, 10000000, 1000)`.execute(db);
      }
      await sql`UPDATE users SET password_hash = ${await hashPassword(ROOT_PASSWORD)} WHERE uid = 0`.execute(
        db,
      );
      aliceHome = await db
        .transaction()
        .execute((tx) => createHome(tx, { uid: ALICE, username: 'wialice', gid: 100 }));
      bobHome = await db
        .transaction()
        .execute((tx) => createHome(tx, { uid: BOB, username: 'wibob', gid: 100 }));

      blobDir = await mkdtemp(join(tmpdir(), 'plt-wiring-'));
      const config = parseConfig(
        {
          BLOB_DIR: blobDir,
          LOG_LEVEL: 'silent',
          APP_ORIGIN: ORIGIN,
          FAULT_INJECTION: '1',
          LEASE_TTL_MS: '15000',
        },
        () => {
          throw new Error('no secret files in this test');
        },
      );
      built = await buildApp(config, {
        database: runtime,
        logger: createLogger(config),
        metrics: createMetrics({ defaultMetrics: false }),
        expectedMigration: null,
        jobs: false,
      });
      await built.app.listen({ host: '127.0.0.1', port: 0 });
      built.readiness.markReady();
      const { port } = built.app.server.address() as AddressInfo;
      wsUrl = `ws://127.0.0.1:${port}/ws`;
      alice = await login('wialice', PASSWORD);
      bob = await login('wibob', PASSWORD);
    });

    afterAll(async () => {
      for (const s of sockets) s.terminate();
      await built.app.close();
      if (runtime !== database) await runtime.close();
      await database.close();
      await rm(blobDir, { recursive: true, force: true });
    });

    it('SRV-07 the upgrade is refused before it becomes a WebSocket: foreign Origin 403, cross-site 403, no session 401', async () => {
      const refused = async (headers: Record<string, string>): Promise<UpgradeRefused> => {
        try {
          const c = await WsTestClient.connect(wsUrl, headers);
          c.terminate();
        } catch (e) {
          if (e instanceof UpgradeRefused) return e;
          throw e;
        }
        throw new Error('the upgrade was accepted');
      };
      const foreign = await refused({ origin: 'https://evil.example', cookie: alice });
      expect(foreign.statusCode).toBe(403);
      expect(JSON.parse(foreign.body)).toMatchObject({ errno: 'EACCES', reason: 'origin' });
      const cross = await refused({
        origin: ORIGIN,
        cookie: alice,
        'sec-fetch-site': 'cross-site',
      });
      expect(cross.statusCode).toBe(403);
      expect(JSON.parse(cross.body)).toMatchObject({ errno: 'EACCES', reason: 'csrf' });
      const anonymous = await refused({ origin: ORIGIN });
      expect(anonymous.statusCode).toBe(401);
      expect(JSON.parse(anonymous.body)).toMatchObject({ errno: 'EACCES' });
      // A plain GET that passes every check is told to upgrade.
      const plain = await inject('GET', '/ws', alice, { headers: { origin: ORIGIN } });
      expect(plain.statusCode).toBe(426);
    });

    it('SYN-13 hello returns hello.ok with the cookie identity, the limits, the lease timers and a resume plan, then resume.done', async () => {
      a1 = await open(alice);
      hello(a1, os.a1, dev.a1, [{ ownerUid: ALICE, fromSeq: 0 }]);
      const ok = await a1.next('hello.ok');
      expect(ok.body).toMatchObject({
        proto: PROTO,
        osSessionId: os.a1,
        server: { name: 'Plotinium' },
        auth: { uid: ALICE, username: 'wialice', kind: 'user', suGrants: [] },
        limits: { maxPayload: 65_536, opEnvelopeMax: 61_440, maxBatch: 32 },
        timers: { leaseTtlMs: 15_000, hbMs: 5_000 },
        owners: [{ ownerUid: ALICE, fromSeq: 0, mode: 'stream' }],
        keptLeases: [],
        lostLeases: [],
      });
      expect(ok.body.auth.gids).toContain(100);
      await a1.next('resume.done', (b) => b.ownerUid === ALICE);

      a2 = await open(alice);
      hello(a2, os.a2, dev.a2, [{ ownerUid: ALICE, fromSeq: 0 }]);
      await a2.next('hello.ok');
      await a2.next('resume.done');

      b1 = await open(bob);
      hello(b1, os.b1, dev.b1, [{ ownerUid: BOB, fromSeq: 0 }]);
      expect((await b1.next('hello.ok')).body.auth).toMatchObject({ uid: BOB, username: 'wibob' });
      // The OS sessions were registered by the handshake.
      const rows = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM os_sessions WHERE os_session_id = ANY(${[os.a1, os.a2, os.b1]}::uuid[])`.execute(
        database.db,
      );
      expect(rows.rows[0]?.n).toBe(3);
    });

    it('OFF-02 op.submit applies once: op.result applied, vfs.changed reaches the other OS session, and a resend is a duplicate', async () => {
      const create = submit(os.a1, ALICE, {
        kind: 'create',
        parentIno: aliceHome,
        name: 'notes.md',
        ino: file.ino,
        type: 'f',
        mode: 0o644,
        mtime: Date.now(),
      });
      a1.send('op.submit', create);
      const result = await a1.next('op.result', (b) => b.opId === create.opId);
      expect(result.body).toMatchObject({ status: 'applied', duplicate: false });
      file.version = result.body.versions?.find((x) => x.ino === file.ino)?.version ?? 0;
      expect(file.version).toBeGreaterThan(0);

      const changed = await a2.next('vfs.changed', (b) => b.opId === create.opId);
      expect(changed.body).toMatchObject({ ownerUid: ALICE, redacted: false });
      expect(changed.body.changes).toContainEqual(
        expect.objectContaining({
          kind: 'upsert',
          ino: file.ino,
          parentIno: aliceHome,
          name: 'notes.md',
        }),
      );
      // Bob follows only his own feed: alice's private op never reaches him.
      expect(b1.pending().filter((f) => f.t === 'vfs.changed')).toEqual([]);

      a1.send('op.submit', create);
      const again = await a1.next('op.result', (b) => b.opId === create.opId);
      expect(again.body).toMatchObject({ status: 'applied', duplicate: true });
      expect(a1.invalid).toEqual([]);
      expect(a2.invalid).toEqual([]);
    });

    it('SYN-06 op.batch carries several ops in one frame; each gets its own op.result, in submission order, and the other OS session sees every change', async () => {
      const dirs = ['a', 'b', 'c'].map((name) =>
        submit(os.a1, ALICE, {
          kind: 'create',
          parentIno: aliceHome,
          name: `batch-${name}`,
          ino: uuidv7(),
          type: 'd',
          mode: 0o755,
          mtime: Date.now(),
        }),
      );
      a1.send('op.batch', { ops: dirs });
      const results = [];
      for (const d of dirs) results.push(await a1.next('op.result', (b) => b.opId === d.opId));
      expect(results.map((r) => r.body.status)).toEqual(['applied', 'applied', 'applied']);
      // The op lane is ordered: the replies came back in cseq order.
      expect(results.map((r) => r.id)).toEqual([...results.map((r) => r.id)].sort((x, y) => x - y));
      for (const d of dirs) await a2.next('vfs.changed', (b) => b.opId === d.opId);
    });

    it('SRV-10 a blob uploads once with proof of possession, a write op points the file at it, and only a reader can fetch it', async () => {
      const content = Buffer.from('hello plotinium\n'.repeat(64));
      const sha = sha256(content);
      const put = (cookie: string) =>
        inject('PUT', `/api/blobs/${sha}`, cookie, {
          payload: content,
          headers: { 'content-type': 'application/octet-stream' },
        });
      const first = await put(alice);
      expect(first.statusCode, first.body).toBe(201);
      expect(first.json()).toMatchObject({ sha256: sha, size: content.length, stored: true });
      expect((await put(alice)).json()).toMatchObject({ existing: true });
      const bad = await inject('PUT', `/api/blobs/${'0'.repeat(64)}`, alice, {
        payload: content,
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(bad.statusCode).toBe(422);
      expect(bad.json()).toMatchObject({ errno: 'EIO', reason: 'checksum' });

      const write = submit(
        os.a1,
        ALICE,
        { kind: 'write', ino: file.ino, blob: sha, size: content.length, mtime: Date.now() },
        { kind: 'versions', entries: [{ ino: file.ino, version: file.version }] },
      );
      a1.send('op.submit', write);
      const r = await a1.next('op.result', (b) => b.opId === write.opId);
      expect(r.body.status).toBe('applied');
      file.version = r.body.versions?.find((x) => x.ino === file.ino)?.version ?? file.version;

      const got = await inject('GET', `/api/blobs/${sha}?ino=${file.ino}`, alice);
      expect(got.statusCode).toBe(200);
      expect(got.rawPayload.equals(content)).toBe(true);
      const range = await inject('GET', `/api/blobs/${sha}`, alice, {
        headers: { range: 'bytes=0-4' },
      });
      expect(range.statusCode).toBe(206);
      expect(range.body).toBe('hello');
      // Bob cannot traverse alice's 0700 home: the blob is "not found" for him, never confirmed.
      expect((await inject('HEAD', `/api/blobs/${sha}`, bob)).statusCode).toBe(404);
      expect((await inject('GET', `/api/blobs/${sha}?ino=${file.ino}`, bob)).statusCode).toBe(403);
    });

    it('VFS-10 DB-02 cp -r over the socket creates exactly the client-derived inodes (hard links chained), shares blobs, charges quota, keeps the probes clean, and an injected fault rolls it back', async () => {
      const text = Buffer.from('copied content\n');
      const sha = sha256(text);
      const up = await inject('PUT', `/api/blobs/${sha}`, alice, {
        payload: text,
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect([200, 201]).toContain(up.statusCode);
      const ino = { tree: uuidv7(), a: uuidv7(), sub: uuidv7(), b: uuidv7(), ln: uuidv7() };
      const make = [
        {
          kind: 'create',
          parentIno: aliceHome,
          name: 'tree',
          ino: ino.tree,
          type: 'd',
          mode: 0o755,
        },
        {
          kind: 'create',
          parentIno: ino.tree,
          name: 'a.txt',
          ino: ino.a,
          type: 'f',
          mode: 0o644,
          blob: sha,
          size: text.length,
        },
        { kind: 'create', parentIno: ino.tree, name: 'sub', ino: ino.sub, type: 'd', mode: 0o750 },
        { kind: 'create', parentIno: ino.sub, name: 'b.md', ino: ino.b, type: 'f', mode: 0o600 },
        {
          kind: 'create',
          parentIno: ino.tree,
          name: 'ln',
          ino: ino.ln,
          type: 'l',
          mode: 0o777,
          symlinkTarget: 'a.txt',
        },
        { kind: 'link', ino: ino.a, parentIno: ino.sub, name: 'a-again.txt' },
      ] as const;
      for (const m of make) {
        const s = submit(os.a1, ALICE, {
          ...m,
          ...(m.kind === 'create' ? { mtime: Date.now() } : {}),
        } as VfsOp);
        a1.send('op.submit', s);
        const r = await a1.next('op.result', (b) => b.opId === s.opId);
        expect(r.body.status, `${m.kind} ${m.name}`).toBe('applied');
      }
      const usage = async () =>
        (
          await sql<{ used_inodes: number; used_bytes: number }>`
          SELECT used_inodes::int, used_bytes::int FROM users WHERE uid = ${ALICE}`.execute(
            database.db,
          )
        ).rows[0];
      const refcount = async () =>
        (
          await sql<{
            refcount: number;
          }>`SELECT refcount FROM blobs WHERE sha256 = decode(${sha}, 'hex')`.execute(database.db)
        ).rows[0]?.refcount;
      const before = await usage();
      const refsBefore = await refcount();

      const copy = submit(os.a1, ALICE, {
        kind: 'copy',
        srcIno: ino.tree,
        toParentIno: aliceHome,
        toName: 'tree-copy',
        recursive: true,
      });
      a1.send('op.submit', copy);
      const res = await a1.next('op.result', (b) => b.opId === copy.opId);
      expect(res.body.status, JSON.stringify(res.body)).toBe('applied');
      expect(res.body.versions?.[0]?.ino).toBe(aliceHome);

      // Pre-order, code-point order: tree, a.txt, ln, sub, sub/a-again.txt (2nd name of a.txt), sub/b.md.
      const top = deriveIno(copy.opId, ino.tree);
      const aCopy = deriveIno(copy.opId, ino.a);
      const expected = new Map([
        [top, ['tree-copy', aliceHome, 'd', 0o755]],
        [aCopy, ['a.txt', top, 'f', 0o644]],
        [deriveIno(copy.opId, ino.ln), ['ln', top, 'l', 0o777]],
        [deriveIno(copy.opId, ino.sub), ['sub', top, 'd', 0o750]],
        [deriveIno(copy.opId, aCopy), ['a-again.txt', deriveIno(copy.opId, ino.sub), 'f', 0o644]],
        [deriveIno(copy.opId, ino.b), ['b.md', deriveIno(copy.opId, ino.sub), 'f', 0o600]],
      ]);
      const rows = await sql<{
        ino: string;
        name: string;
        parent_ino: string;
        type: string;
        mode: number;
        uid: number;
      }>`
        SELECT i.ino, d.name, d.parent_ino, i.type, i.mode, i.uid FROM inodes i JOIN dentries d ON d.ino = i.ino
        WHERE i.ino = ANY(${[...expected.keys()]}::uuid[])`.execute(database.db);
      expect(
        new Map(rows.rows.map((r) => [r.ino, [r.name, r.parent_ino, r.type, r.mode]])),
      ).toEqual(expected);
      expect(rows.rows.every((r) => r.uid === ALICE)).toBe(true);
      // Hard links became separate files; the blob is shared, not copied.
      expect(await refcount()).toBe((refsBefore ?? 0) + 2);
      const after = await usage();
      expect(after?.used_inodes).toBe((before?.used_inodes ?? 0) + 6);
      expect(after?.used_bytes).toBe((before?.used_bytes ?? 0) + 2 * text.length + 'a.txt'.length);
      const feed = await a2.next('vfs.changed', (b) => b.opId === copy.opId);
      expect(feed.body.changes.filter((c) => c.kind === 'upsert').map((c) => c.ino)).toEqual(
        expect.arrayContaining([...expected.keys()]),
      );
      expect(await integrityViolations(database)).toEqual([]);

      // A resend is a duplicate; copying a directory into itself is EINVAL and persisted.
      a1.send('op.submit', copy);
      expect((await a1.next('op.result', (b) => b.opId === copy.opId)).body.duplicate).toBe(true);
      const inside = submit(os.a1, ALICE, {
        kind: 'copy',
        srcIno: ino.tree,
        toParentIno: ino.sub,
        toName: 'loop',
        recursive: true,
      });
      a1.send('op.submit', inside);
      expect((await a1.next('op.result', (b) => b.opId === inside.opId)).body).toMatchObject({
        status: 'rejected',
        errno: 'EINVAL',
      });

      // DB-02: a fault at node 3 of the next copy rejects it EIO injected with nothing changed.
      built.faults?.arm(os.a1, ALICE, { op: 'copy', target: 'server', failAtNode: 3 });
      const faulty = submit(os.a1, ALICE, {
        kind: 'copy',
        srcIno: ino.tree,
        toParentIno: aliceHome,
        toName: 'tree-copy-2',
        recursive: true,
      });
      a1.send('op.submit', faulty);
      expect((await a1.next('op.result', (b) => b.opId === faulty.opId)).body).toMatchObject({
        status: 'rejected',
        errno: 'EIO',
        reason: 'injected',
      });
      const leftovers = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM inodes WHERE ino = ${deriveIno(faulty.opId, ino.tree)}::uuid`.execute(
        database.db,
      );
      expect(leftovers.rows[0]?.n).toBe(0);
      expect(await usage()).toEqual(after);
      expect(await integrityViolations(database)).toEqual([]);
    });

    it('SYN-01 POST /api/ops/{opId} carries a large op through the live OS session: 200 op.result, 409 on an id mismatch, 403 for a foreign OS session', async () => {
      const mkdir = submit(os.a1, ALICE, {
        kind: 'create',
        parentIno: aliceHome,
        name: 'projects',
        ino: uuidv7(),
        type: 'd',
        mode: 0o755,
        mtime: Date.now(),
      });
      const res = await inject('POST', `/api/ops/${mkdir.opId}`, alice, { payload: mkdir });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ opId: mkdir.opId, status: 'applied' });
      await a2.next('vfs.changed', (b) => b.opId === mkdir.opId);

      const mismatch = await inject('POST', `/api/ops/${uuidv7()}`, alice, { payload: mkdir });
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json()).toMatchObject({ errno: 'EINVAL' });

      const foreign = submit(os.a1, BOB, {
        kind: 'create',
        parentIno: bobHome,
        name: 'x',
        ino: uuidv7(),
        type: 'f',
        mode: 0o644,
        mtime: Date.now(),
      });
      const denied = await inject('POST', `/api/ops/${foreign.opId}`, bob, { payload: foreign });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ errno: 'EACCES', reason: 'principal' });
    });

    it('VFS-10 GET /api/sync/snapshot returns the directory rows to its owner and 403 to a user who cannot list it', async () => {
      const res = await inject('GET', `/api/sync/snapshot?scope=dir&ino=${aliceHome}`, alice);
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<{ rows: { name: string | null; ino: string }[] }>();
      expect(page.rows.map((r) => r.name)).toEqual(
        expect.arrayContaining(['notes.md', 'projects']),
      );
      const owner = await inject('GET', `/api/sync/snapshot?scope=owner&owner=${ALICE}`, alice);
      expect(owner.statusCode).toBe(200);
      const denied = await inject('GET', `/api/sync/snapshot?scope=dir&ino=${aliceHome}`, bob);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ errno: 'EACCES' });
    });

    it('VFS-09 leases: X is granted with a fence, a second OS session is denied EBUSY with the holder, hb renews, release lets the next grant take a higher fence', async () => {
      const req1 = uuidv7();
      a1.send('lock.acquire', {
        reqId: req1,
        ino: file.ino,
        mode: 'X',
        wait: false,
        principal: ALICE,
      });
      const granted = await a1.next('lock.granted', (b) => b.reqId === req1);
      expect(granted.body).toMatchObject({ ino: file.ino, mode: 'X', ttlMs: 15_000 });
      const lease = { leaseId: granted.body.leaseId, ino: file.ino, fence: granted.body.fence };
      expect(lease.fence).toBeGreaterThanOrEqual(1);

      const req2 = uuidv7();
      a2.send('lock.acquire', {
        reqId: req2,
        ino: file.ino,
        mode: 'X',
        wait: false,
        principal: ALICE,
      });
      const denied = await a2.next('lock.denied', (b) => b.reqId === req2);
      expect(denied.body).toMatchObject({
        errno: 'EBUSY',
        holder: { username: 'wialice', mode: 'X' },
      });

      // Bob cannot even read the file: EACCES, not EBUSY (no holder leaks).
      const req3 = uuidv7();
      b1.send('lock.acquire', {
        reqId: req3,
        ino: file.ino,
        mode: 'S',
        wait: false,
        principal: BOB,
      });
      const foreign = await b1.next('lock.denied', (b) => b.reqId === req3);
      expect(foreign.body.errno).toBe('EACCES');
      expect(foreign.body.holder).toBeUndefined();

      a1.send('hb', { t: 1, leases: [lease], lamport: cseq });
      const ack = await a1.next('hb.ack');
      expect(ack.body.renewed).toContain(lease.leaseId);
      expect(ack.body.lost).toEqual([]);

      a1.send('lock.release', { leaseId: lease.leaseId });
      const req4 = uuidv7();
      a2.send('lock.acquire', {
        reqId: req4,
        ino: file.ino,
        mode: 'X',
        wait: false,
        principal: ALICE,
      });
      const next = await a2.next('lock.granted', (b) => b.reqId === req4);
      expect(next.body.fence).toBeGreaterThan(lease.fence);
      a2.send('lock.release', { leaseId: next.body.leaseId });
      const leasesOnFile = async (): Promise<number | undefined> =>
        (
          await sql<{
            n: number;
          }>`SELECT count(*)::int AS n FROM locks WHERE ino = ${file.ino}`.execute(database.db)
        ).rows[0]?.n;
      await expect.poll(leasesOnFile).toBe(0);
    });

    it('SYN-06 a control-frame flood over the real socket is answered with throttle {scope: frames}; the socket is paused, not dropped silently', async () => {
      const c = await open(alice);
      hello(c, uuidv7(), uuidv7(), [{ ownerUid: ALICE, fromSeq: 0 }]);
      await c.next('hello.ok');
      for (let i = 0; i < 260; i++) c.send('ack', { cursors: [{ ownerUid: ALICE, seq: 0 }] });
      const t = await c.next('throttle');
      expect(t.body.scope).toBe('frames');
      expect(t.body.retryAfterMs).toBeGreaterThan(0);
      // Ignoring the throttle ends in bye rate-limited / 4429 (or the socket is still open when the
      // backlog fitted the refilled bucket); either way nothing else was sent in between.
      c.terminate();
      const closed = await c.closed;
      expect([1006, 4429]).toContain(closed.code);
      expect(c.invalid).toEqual([]);
    });

    it('MEM-03 swap pages round-trip for their owner only, by the session uid, and are deleted with 204', async () => {
      const raw = randomBytes(8192);
      const gz = gzipSync(raw);
      const url = `/api/swap/${os.a1}/42/3`;
      const put = await inject('PUT', url, alice, {
        payload: gz,
        headers: {
          'content-type': 'application/octet-stream',
          'x-plotinium-checksum': sha256(raw),
          'x-plotinium-raw-size': String(raw.length),
          'x-plotinium-encoding': 'gzip',
        },
      });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.json()).toMatchObject({ stored: true, checksum: sha256(raw), size: raw.length });

      const got = await inject('GET', url, alice);
      expect(got.statusCode).toBe(200);
      expect(got.headers['x-plotinium-checksum']).toBe(sha256(raw));
      expect(gunzipSync(got.rawPayload).equals(raw)).toBe(true);
      const list = await inject('GET', `/api/swap?osSession=${os.a1}`, alice);
      expect(list.json<{ pages: unknown[] }>().pages).toHaveLength(1);

      // Bob's uid owns no such page (even the path of alice's OS session gives him nothing).
      expect([403, 404]).toContain((await inject('GET', url, bob)).statusCode);
      expect((await inject('DELETE', `/api/swap/${os.a1}`, alice)).statusCode).toBe(204);
      expect((await inject('GET', url, alice)).statusCode).toBe(404);
    });

    it('PRE-05 telemetry is refused until the user opts in, then accepted, listed and deleted', async () => {
      const event = {
        v: 1,
        seq: 1,
        ts: Date.now(),
        tzOffsetMin: 300,
        kind: 'launch',
        app: 'files',
        prev: null,
        hourBucket: 2,
        dow: 3,
        weekend: false,
        sessionPos: 1,
        origin: 'user',
        osSessionId: os.a1,
      };
      const before = await inject('POST', '/api/telemetry', alice, {
        payload: { events: [event] },
      });
      expect(before.statusCode).toBe(403);
      expect(before.json()).toMatchObject({ errno: 'EPERM', reason: 'opt-in' });
      const consent = await inject('PUT', '/api/telemetry/consent', alice, {
        payload: { optIn: true },
      });
      expect(consent.statusCode).toBe(200);
      expect(consent.json()).toMatchObject({ optIn: true });
      const up = await inject('POST', '/api/telemetry', alice, { payload: { events: [event] } });
      expect(up.statusCode, up.body).toBe(202);
      expect(up.json()).toMatchObject({ accepted: 1 });
      const list = await inject('GET', '/api/telemetry', alice);
      expect(list.json<{ events: unknown[] }>().events).toHaveLength(1);
      expect((await inject('DELETE', '/api/telemetry', alice)).statusCode).toBe(204);
    });

    it('SRV-12 SRV-13 with AI=1 the index answers a readable-set search and the LLM gateway without a key is 503 EAIUNAVAIL no-key', async () => {
      const search = await inject('POST', '/api/index/search', alice, {
        payload: { modelKey: 'minilm-l6-v2@q8', vector: new Array<number>(384).fill(0.01), k: 3 },
      });
      expect(search.statusCode, search.body).toBe(200);
      expect(search.json()).toEqual({ results: [] });
      const plan = await inject('POST', '/api/llm/plan', alice, {
        payload: { requestId: uuidv7(), turn: 1, userTurn: 'list my files' },
      });
      expect(plan.statusCode).toBe(503);
      expect(plan.json()).toMatchObject({ errno: 'EAIUNAVAIL' });
      const health = await inject('GET', '/api/llm/health', alice);
      expect(health.json()).toMatchObject({ ok: false, degradedReason: 'no-key' });
    });

    it('DB-02 SRV-14 the fault harness: root arms a one-shot unlink fault for one OS session; that unlink is rejected EIO injected and changes nothing', async () => {
      const su = await inject('POST', '/api/auth/su', alice, {
        payload: { target: 'root', password: ROOT_PASSWORD },
      });
      expect(su.statusCode, su.body).toBe(200);
      const root = { 'x-plotinium-principal': '0', 'x-plotinium-os-session': os.a1 };
      const armed = await inject('POST', '/api/debug/fault', alice, {
        payload: { op: 'unlink', target: 'server', failAtNode: 1 },
        headers: root,
      });
      expect(armed.statusCode, armed.body).toBe(200);
      expect(armed.json()).toMatchObject({ armed: true, osSessionId: os.a1 });
      const listed = await inject('GET', '/api/debug/fault', alice, { headers: root });
      expect(listed.json<{ armed: unknown[] }>().armed).toHaveLength(1);

      const unlink = submit(
        os.a1,
        ALICE,
        { kind: 'unlink', parentIno: aliceHome, name: 'notes.md', ino: file.ino, recursive: false },
        { kind: 'versions', entries: [{ ino: file.ino, version: file.version }] },
      );
      a1.send('op.submit', unlink);
      const r = await a1.next('op.result', (b) => b.opId === unlink.opId);
      expect(r.body).toMatchObject({ status: 'rejected', errno: 'EIO', reason: 'injected' });
      const still = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM dentries WHERE parent_ino = ${aliceHome} AND name = 'notes.md'`.execute(
        database.db,
      );
      expect(still.rows[0]?.n).toBe(1);
      // One-shot: the arm is gone, and the same unlink under a new opId applies.
      expect(
        (await inject('GET', '/api/debug/fault', alice, { headers: root })).json<{
          armed: unknown[];
        }>().armed,
      ).toEqual([]);
      const retry = { ...unlink, opId: uuidv7(), cseq: ++cseq };
      a1.send('op.submit', retry);
      expect((await a1.next('op.result', (b) => b.opId === retry.opId)).body.status).toBe(
        'applied',
      );
    });

    it('SRV-19 ending the su grant sends proc.signal SIGHUP su-revoked to the sockets of that auth session', async () => {
      const res = await inject('DELETE', '/api/auth/su/0', alice);
      expect(res.statusCode).toBe(204);
      const sig = await a1.next('proc.signal');
      expect(sig.body).toEqual({
        target: { kind: 'principal', uid: 0 },
        sig: 'SIGHUP',
        reason: 'su-revoked',
      });
    });

    it('SRV-08 logout revokes the auth session: every socket of it gets bye revoked and close 4401', async () => {
      const res = await inject('POST', '/api/auth/logout', alice);
      expect(res.statusCode).toBe(204);
      for (const c of [a1, a2]) {
        expect((await c.next('bye')).body.reason).toBe('revoked');
        expect((await c.closed).code).toBe(4401);
      }
      expect(b1.readyState).toBe(1); // bob is untouched
    });

    it('SRV-16 draining sends bye restart and close 1012; new upgrades are refused with 503', async () => {
      built.readiness.markDraining();
      await built.drainSockets(1_000);
      expect((await b1.next('bye')).body.reason).toBe('restart');
      expect((await b1.closed).code).toBe(1012);
      try {
        const c = await WsTestClient.connect(wsUrl, { origin: ORIGIN, cookie: bob });
        c.terminate();
        throw new Error('the upgrade was accepted while draining');
      } catch (e) {
        expect(e).toBeInstanceOf(UpgradeRefused);
        expect((e as UpgradeRefused).statusCode).toBe(503);
      }
      const ready = await built.app.inject({ method: 'GET', url: '/api/readyz' });
      expect(ready.statusCode).toBe(503);
    });
  },
);
