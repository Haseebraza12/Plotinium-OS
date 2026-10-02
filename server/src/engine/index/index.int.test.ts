/**
 * DB-gated (DATABASE_URL, a disposable migrated database; see server/src/db/db.int.test.ts):
 * the readable-set SQL against its executable specification (reference.ts) on random permission
 * graphs, and KyselyIndexDb / IndexService against PostgreSQL 18 + pgvector. Test users, groups
 * and inodes use ids 91xxx and are removed afterwards.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import fc from 'fast-check';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../../db/client.ts';
import type { DB } from '../../db/types.gen.ts';
import { HttpError } from '../../http/errors.ts';
import { FsBlobStore } from '../../storage/fs-blobstore.ts';
import { uuidv7 } from '../../util/uuidv7.ts';
import { KyselyIndexDb } from './kysely-db.ts';
import { readableSetSql, verifySql } from './readable.sql.ts';
import {
  ROOT_INO,
  readableTopDown,
  verifyUpward,
  type GraphDentry,
  type GraphInode,
  type PermGraph,
} from './reference.ts';
import { blobReaderFrom, chunkContentHash, IndexService } from './service.ts';
import { GIDS, USERS, buildTree, randomTree, ROOT as BUILDER_ROOT } from './tests/graph.ts';
import type { ChunkIn, Requester } from './types.ts';
import { scratchDatabaseUrl } from '../../../tests/scratch-db.ts';

/** A per-file clone of DATABASE_URL's database (server/tests/scratch-db.ts). */
const URL_ = await scratchDatabaseUrl('index');
const UID_MAP: Readonly<Record<number, number>> = {
  0: 0,
  1001: 91_001,
  1002: 91_002,
  1003: 91_003,
};
const GID_MAP: Readonly<Record<number, number>> = { 0: 0, 100: 91_100, 500: 91_500 };
const MK = 'test-model@1-384';

let database: Database;
let db: Kysely<DB>;
const created: string[] = [];

const req = (uid: number): Requester => ({
  uid: UID_MAP[uid] ?? uid,
  gids: (GIDS[uid] ?? []).map((g) => GID_MAP[g] ?? g),
});

async function insertInode(
  n: GraphInode,
  extra: { blobId?: number | null; size?: number; version?: number } = {},
): Promise<void> {
  await sql`INSERT INTO inodes (ino, type, mode, uid, gid, nlink, blob_id, size, version)
            VALUES (${n.ino}::uuid, ${n.type}, ${n.mode}, ${n.uid}, ${n.gid}, 1, ${extra.blobId ?? null},
                    ${extra.size ?? 0}, ${extra.version ?? 1})`.execute(db);
  created.push(n.ino);
}

async function insertDentry(d: GraphDentry, child: GraphInode): Promise<void> {
  await sql`INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid)
            VALUES (${d.parentIno}::uuid, ${d.name}, ${d.ino}::uuid, ${child.type}, ${child.uid})`.execute(
    db,
  );
}

async function removeAll(inos: readonly string[]): Promise<void> {
  if (inos.length === 0) return;
  await sql`DELETE FROM dentries WHERE ino = ANY(${inos}::uuid[]) OR parent_ino = ANY(${inos}::uuid[])`.execute(
    db,
  );
  await sql`DELETE FROM inodes WHERE ino = ANY(${inos}::uuid[])`.execute(db);
}

function unit(seed: number): Float32Array {
  const v = new Float32Array(384);
  let s = 0;
  for (let i = 0; i < 384; i++) {
    v[i] = Math.sin(seed * 7.1 + i * 0.37);
    s += (v[i] ?? 0) ** 2;
  }
  const n = Math.sqrt(s);
  for (let i = 0; i < 384; i++) v[i] = (v[i] ?? 0) / n;
  return v;
}

describe.runIf(URL_ !== undefined)(
  'RAG-03 the index API on PostgreSQL 18 + pgvector (backend-api.md §3.12)',
  () => {
    let rootInode: GraphInode;

    beforeAll(async () => {
      database = createDatabase({
        url: URL_ ?? '',
        password: undefined,
        poolMax: 4,
        statementTimeoutMs: 20_000,
        lockTimeoutMs: 2_000,
      });
      db = database.db;
      for (const [name, gid] of [
        ['ragtest-users', 91_100],
        ['ragtest-team', 91_500],
      ] as const) {
        await sql`INSERT INTO groups (gid, name) VALUES (${gid}, ${name}) ON CONFLICT DO NOTHING`.execute(
          db,
        );
      }
      for (const [uid, name] of [
        [91_001, 'ragalice'],
        [91_002, 'ragbob'],
        [91_003, 'ragcarol'],
      ] as const) {
        await sql`INSERT INTO users (uid, username, account_kind, password_hash, primary_gid, quota_bytes, quota_inodes)
                VALUES (${uid}, ${name}, 'user', 'x', 91100, 0, 0) ON CONFLICT DO NOTHING`.execute(
          db,
        );
        for (const gid of uid === 91_003 ? [91_100] : [91_100, 91_500]) {
          await sql`INSERT INTO user_groups (uid, gid) VALUES (${uid}, ${gid}) ON CONFLICT DO NOTHING`.execute(
            db,
          );
        }
      }
      const r = await sql<{
        mode: number;
        uid: number;
        gid: number;
      }>`SELECT mode, uid, gid FROM inodes WHERE ino = ${ROOT_INO}::uuid`.execute(db);
      const row = r.rows[0];
      if (row === undefined) throw new Error('the system tree migration is missing');
      rootInode = { ino: ROOT_INO, type: 'd', mode: row.mode, uid: row.uid, gid: row.gid };
    });

    afterAll(async () => {
      await removeAll(created);
      await sql`DELETE FROM blobs WHERE storage_key LIKE 'ragtest/%'`.execute(db);
      await sql`DELETE FROM user_groups WHERE uid BETWEEN 91001 AND 91003`.execute(db);
      await sql`DELETE FROM users WHERE uid BETWEEN 91001 AND 91003`.execute(db);
      await sql`DELETE FROM groups WHERE gid IN (91100, 91500)`.execute(db);
      await database.close();
    });

    it('RAG-03 the top-down CTE and the upward verify statement agree with the reference on random permission graphs', async () => {
      await fc.assert(
        fc.asyncProperty(randomTree, async (t) => {
          const { g, files } = buildTree(t);
          // Re-key the builder's tree: its root becomes a fresh directory under the real /.
          const ids = new Map<string, string>([[BUILDER_ROOT, uuidv7()]]);
          const id = (ino: string): string => {
            let v = ids.get(ino);
            if (v === undefined) ids.set(ino, (v = uuidv7()));
            return v;
          };
          const inodes = new Map<string, GraphInode>([[ROOT_INO, rootInode]]);
          for (const n of g.inodes.values()) {
            inodes.set(id(n.ino), {
              ino: id(n.ino),
              type: n.type,
              mode: n.mode,
              uid: UID_MAP[n.uid] ?? n.uid,
              gid: GID_MAP[n.gid] ?? n.gid,
            });
          }
          const top = id(BUILDER_ROOT);
          const dentries: GraphDentry[] = [
            { parentIno: ROOT_INO, name: `plt-rag-${top}`, ino: top },
          ];
          for (const d of g.dentries)
            dentries.push({ parentIno: id(d.parentIno), name: d.name, ino: id(d.ino) });
          const graph: PermGraph = { rootIno: ROOT_INO, inodes, dentries };
          const mine = new Set([...ids.values()]);
          try {
            for (const n of inodes.values())
              if (n.ino !== ROOT_INO && n.type === 'd') await insertInode(n);
            for (const n of inodes.values()) if (n.type === 'f') await insertInode(n);
            for (const d of dentries) await insertDentry(d, inodes.get(d.ino) as GraphInode);
            const fileIds = files.map(id);
            for (const uid of USERS) {
              const r = req(uid);
              const expected = readableTopDown(graph, r);
              const rows = (await readableSetSql(r).execute(db)).rows.filter((x) =>
                mine.has(x.ino),
              );
              expect(new Map(rows.map((x) => [x.ino, x.path]))).toEqual(
                new Map([...expected].filter(([ino]) => mine.has(ino))),
              );
              const up = verifyUpward(graph, r, fileIds);
              const v = await verifySql(
                r,
                MK,
                fileIds.map((ino) => ({ ino, seq: 0, inodeVersion: 1 })),
              ).execute(db);
              expect(v.rows.map((x) => [x.ino, x.readable, x.path])).toEqual(
                fileIds.map((ino) => [
                  ino,
                  up.get(ino)?.readable ?? false,
                  up.get(ino)?.path ?? null,
                ]),
              );
            }
          } finally {
            await removeAll([...mine]);
          }
        }),
        { numRuns: 25, seed: 94 },
      );
    }, 120_000);

    describe('KyselyIndexDb and IndexService', () => {
      const alice = req(1001);
      const bob = req(1002);
      const carol = req(1003);
      let home: string;
      let team: string;
      let secretFile: string;
      let planFile: string;
      let blobDir: string;
      let service: IndexService;
      const indexDb = (): KyselyIndexDb => new KyselyIndexDb(db);
      const TEXT = 'alpha paragraph\n\nbeta paragraph about lru eviction\n';

      const chunk = (
        seq: number,
        start: number,
        end: number,
        emb: Float32Array | null,
      ): ChunkIn => {
        const text = Buffer.from(TEXT, 'utf8').subarray(start, end).toString('utf8');
        return {
          seq,
          byteStart: start,
          byteEnd: end,
          lineStart: 1,
          lineEnd: 1,
          header: `H${seq}`,
          text,
          contentHash: chunkContentHash(MK, `H${seq}`, text),
          embedding: emb,
        };
      };

      beforeAll(async () => {
        blobDir = await mkdtemp(join(tmpdir(), 'plt-ragtest-blobs-'));
        const blobs = new FsBlobStore(blobDir);
        const sha = createHash('sha256').update(TEXT).digest('hex');
        await blobs.put({ kind: 'content', sha256: sha }, Readable.from([Buffer.from(TEXT)]), {
          size: Buffer.byteLength(TEXT),
          maxBytes: 1 << 20,
        });
        const b = await sql<{ blob_id: number }>`
        INSERT INTO blobs (sha256, size, storage_key, refcount, first_ref_at, zero_since)
        VALUES (decode(${sha}, 'hex'), ${Buffer.byteLength(TEXT)}, ${`ragtest/${sha}`}, 2, now(), NULL)
        ON CONFLICT ON CONSTRAINT blobs_sha256_key DO UPDATE SET refcount = blobs.refcount RETURNING blob_id`.execute(
          db,
        );
        const blobId = b.rows[0]?.blob_id ?? 0;
        const top = uuidv7();
        home = uuidv7();
        team = uuidv7();
        secretFile = uuidv7();
        planFile = uuidv7();
        const nodes: [GraphInode, string, string][] = [
          [{ ino: top, type: 'd', mode: 0o755, uid: 0, gid: 0 }, ROOT_INO, `plt-ragsvc-${top}`],
          [{ ino: home, type: 'd', mode: 0o700, uid: 91_001, gid: 91_100 }, top, 'alice'],
          [{ ino: team, type: 'd', mode: 0o750, uid: 91_001, gid: 91_500 }, top, 'team'],
        ];
        for (const [n, parent, name] of nodes) {
          await insertInode(n);
          await insertDentry({ parentIno: parent, name, ino: n.ino }, n);
        }
        for (const [ino, parent, name, mode] of [
          [secretFile, home, 'diary.md', 0o644],
          [planFile, team, 'plan.md', 0o640],
        ] as const) {
          const n: GraphInode = { ino, type: 'f', mode, uid: 91_001, gid: 91_500 };
          await insertInode(n, { blobId, size: Buffer.byteLength(TEXT), version: 3 });
          await insertDentry({ parentIno: parent, name, ino }, n);
        }
        service = new IndexService({ db: indexDb(), blobs: blobReaderFrom(blobs) });
      });

      afterAll(async () => {
        await rm(blobDir, { recursive: true, force: true });
      });

      it('RAG-03 index put from a uid without w on the file is refused with 403 EACCES', async () => {
        await expect(
          service.put(bob, {
            ino: planFile,
            inodeVersion: 3,
            modelKey: MK,
            chunks: [chunk(0, 0, 15, unit(1))],
          }),
        ).rejects.toMatchObject({
          status: 403,
          errno: 'EACCES',
        });
      });

      it('RAG-03 index put with text that is not the blob slice is refused with 422 EINVAL, a stale version with 409', async () => {
        const bad = { ...chunk(0, 0, 15, unit(1)), text: 'alpha paragrapX' };
        const e = await service
          .put(alice, {
            ino: planFile,
            inodeVersion: 3,
            modelKey: MK,
            chunks: [{ ...bad, contentHash: chunkContentHash(MK, 'H0', bad.text) }],
          })
          .catch((x: unknown) => x);
        expect(e).toBeInstanceOf(HttpError);
        expect(e).toMatchObject({ status: 422, errno: 'EINVAL' });
        await expect(
          service.put(alice, { ino: planFile, inodeVersion: 2, modelKey: MK, chunks: [] }),
        ).rejects.toMatchObject({ status: 409, reason: 'stale-version' });
      });

      it('RAG-02 put replaces the chunk set in one transaction, reuses stored vectors by content hash, and a repeat is a duplicate', async () => {
        const first = await service.put(alice, {
          ino: planFile,
          inodeVersion: 3,
          modelKey: MK,
          chunks: [chunk(0, 0, 15, unit(1)), chunk(1, 17, 50, unit(2))],
        });
        expect(first).toEqual({ applied: true, rows: 2 });
        expect(
          await service.put(alice, { ino: planFile, inodeVersion: 3, modelKey: MK, chunks: [] }),
        ).toEqual({ duplicate: true });
        // the file changed (version 4): chunk 1 is unchanged and reuses its stored vector
        await sql`UPDATE inodes SET version = 4 WHERE ino = ${planFile}::uuid`.execute(db);
        expect(
          await service.put(alice, {
            ino: planFile,
            inodeVersion: 4,
            modelKey: MK,
            chunks: [chunk(0, 0, 5, unit(3)), chunk(1, 17, 50, null)],
          }),
        ).toEqual({ applied: true, rows: 2 });
        const rows = await sql<{ seq: number; inode_version: number; e: string }>`
        SELECT seq, inode_version, embedding::text AS e FROM file_chunks WHERE ino = ${planFile}::uuid ORDER BY seq`.execute(
          db,
        );
        expect(rows.rows.map((r) => [r.seq, r.inode_version])).toEqual([
          [0, 4],
          [1, 4],
        ]);
        expect(Number(rows.rows[1]?.e.slice(1).split(',')[0])).toBeCloseTo(unit(2)[0] ?? 0, 5);
        // a reuse of a hash that is not stored rolls back and keeps the previous set
        await sql`UPDATE inodes SET version = 5 WHERE ino = ${planFile}::uuid`.execute(db);
        await expect(
          service.put(alice, {
            ino: planFile,
            inodeVersion: 5,
            modelKey: MK,
            chunks: [chunk(0, 0, 9, null)],
          }),
        ).rejects.toMatchObject({ status: 422 });
        expect(await indexDb().storedVersion(planFile, MK)).toBe(4);
        expect(
          await indexDb().replaceChunks({
            ino: planFile,
            inodeVersion: 9,
            modelKey: MK,
            chunks: [],
          }),
        ).toEqual({ ok: false, reason: 'stale-version' });
        await sql`UPDATE inodes SET version = 4 WHERE ino = ${planFile}::uuid`.execute(db);
        await service.put(alice, {
          ino: secretFile,
          inodeVersion: 3,
          modelKey: MK,
          chunks: [chunk(0, 0, 15, unit(4))],
        });
      });

      it('RAG-03 index pull never returns chunks of unreadable inodes and never returns text of files the requester does not own', async () => {
        const own = await service.pull(alice, { modelKey: MK, after: 0, limit: 2000 });
        const mineIno = new Set([planFile, secretFile]);
        const ownRows = own.chunks.filter((c) => mineIno.has(c.ino));
        expect(ownRows).toHaveLength(3);
        expect(
          ownRows.every((c) => c.owned && typeof c.text === 'string' && c.header.startsWith('H')),
        ).toBe(true);
        expect(ownRows[0]?.embedding).toHaveLength(384);
        const forBob = await service.pull(bob, { modelKey: MK, after: 0, limit: 2000 });
        const bobRows = forBob.chunks.filter((c) => mineIno.has(c.ino));
        expect(bobRows.map((c) => c.ino)).toEqual([planFile, planFile]); // the 0700 home is invisible
        expect(bobRows.every((c) => !c.owned && c.text === undefined && c.header === '')).toBe(
          true,
        );
        expect(
          (await service.pull(carol, { modelKey: MK, after: 0, limit: 2000 })).chunks.filter((c) =>
            mineIno.has(c.ino),
          ),
        ).toEqual([]);
        // keyset pages
        const p1 = await service.pull(alice, { modelKey: MK, after: 0, limit: 1 });
        expect(p1.complete).toBe(false);
        expect(p1.manifestFiles).toBeGreaterThanOrEqual(2);
        const p2 = await service.pull(alice, { modelKey: MK, after: p1.nextAfter, limit: 2000 });
        expect(p2.chunks.every((c) => c.chunkId > p1.nextAfter)).toBe(true);
      });

      it('RAG-04 the exact search filters before ranking, orders by score then (ino, seq), and honours the scope', async () => {
        const q = unit(4); // closest to alice's private diary
        const forAlice = (await service.search(alice, { modelKey: MK, vector: q, k: 50 })).filter(
          (h) => h.ino === secretFile || h.ino === planFile,
        );
        expect(forAlice[0]?.ino).toBe(secretFile);
        expect(forAlice[0]?.score).toBeCloseTo(1, 4);
        expect(forAlice[0]?.path).toMatch(/\/alice\/diary\.md$/);
        const forBob = (await service.search(bob, { modelKey: MK, vector: q, k: 50 })).filter(
          (h) => h.ino === secretFile || h.ino === planFile,
        );
        expect(forBob.map((h) => h.ino)).toEqual([planFile, planFile]);
        for (let i = 1; i < forBob.length; i++)
          expect((forBob[i - 1]?.score ?? 0) >= (forBob[i]?.score ?? 0)).toBe(true);
        expect(
          await service.search(alice, { modelKey: MK, vector: q, k: 5, scopeIno: team }),
        ).toSatisfy((hits: readonly { ino: string }[]) => hits.every((h) => h.ino === planFile));
      });

      it('RAG-03 server verify returns readable=false for a file chmodded after indexing, with path, version and snippet otherwise', async () => {
        const before = await service.verify(bob, MK, [
          { ino: planFile, seq: 1, inodeVersion: 4 },
          { ino: secretFile, seq: 0, inodeVersion: 3 },
        ]);
        expect(before[0]).toMatchObject({
          readable: true,
          inodeVersion: 4,
          snippet: 'beta paragraph about lru eviction',
        });
        expect(before[0]?.path).toMatch(/\/team\/plan\.md$/);
        expect(before[1]).toEqual({ ino: secretFile, seq: 0, readable: false });
        await sql`UPDATE inodes SET mode = 384 WHERE ino = ${planFile}::uuid`.execute(db); // 0600
        expect(
          (await service.verify(bob, MK, [{ ino: planFile, seq: 1, inodeVersion: 4 }]))[0],
        ).toEqual({ ino: planFile, seq: 1, readable: false });
        await sql`UPDATE inodes SET mode = 416 WHERE ino = ${planFile}::uuid`.execute(db); // 0640 again
      });

      it('RAG-02 deleting the file removes its chunks in the same statement (ON DELETE CASCADE)', async () => {
        await sql`DELETE FROM dentries WHERE ino = ${secretFile}::uuid`.execute(db);
        await sql`DELETE FROM inodes WHERE ino = ${secretFile}::uuid`.execute(db);
        const n = await sql<{
          n: number;
        }>`SELECT count(*)::int AS n FROM file_chunks WHERE ino = ${secretFile}::uuid`.execute(db);
        expect(n.rows[0]?.n).toBe(0);
        expect(await indexDb().fileMeta(secretFile)).toBeNull();
        expect(await indexDb().fileMeta(planFile)).toMatchObject({
          type: 'f',
          version: 4,
          uid: 91_001,
        });
      });
    });
  },
);
