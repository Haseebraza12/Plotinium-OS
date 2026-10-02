/**
 * Schema-level integration checks against the Compose database (skipped without DATABASE_URL):
 * a freshly migrated database is sound, seeding keeps it sound, and the acyclicity trigger refuses
 * a directory move into its own subtree (DB-03).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INO } from '../../protocol/src/wellknown.ts';
import { seedAccount, seedDir, seedTree, USERS_GID } from '../fault-injection/seed.ts';
import { runProbes, serverSnapshot } from '../fault-injection/server.ts';
import { moveDir } from '../fault-injection/ops.ts';
import { tree1000 } from '../fixtures/trees.ts';
import { createTestDatabase, type TestDatabase } from '../support/db-template.ts';
import { databaseUrl } from '../support/env.ts';
import { inTransaction, isPgError } from '../support/sql.ts';

const url = databaseUrl();
let db: TestDatabase;

describe.skipIf(url === undefined)('integration: schema (PostgreSQL)', () => {
  beforeAll(async () => {
    db = await createTestDatabase(url as string, import.meta.url);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('VFS-11 every integrity probe returns zero rows on a freshly migrated database', async () => {
    expect(await runProbes(db.pool)).toEqual([]);
    const root = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM inodes WHERE ino = $1`,
      [INO.ROOT],
    );
    expect(root.rows[0]?.n).toBe(1);
  });

  it('DB-02 seeding a 1,000-node tree keeps quota, nlink and refcounts exact', async () => {
    const home = await seedAccount(db.pool, 1000, 'alice');
    const scope = await seedDir(db.pool, home, 'fixtures', { uid: 1000, gid: USERS_GID });
    await seedTree(db.pool, tree1000(), scope, { uid: 1000, gid: USERS_GID });
    const snap = await serverSnapshot(db.pool, scope);
    expect(snap.probes).toEqual([]);
    expect(snap.orphans).toEqual([]);
    expect(snap.nlinkMismatches).toEqual([]);
    expect(snap.quota[1000]?.usedInodes).toBe(1002);
  });

  it('DB-03 moving a directory into its own subtree fails with the acyclicity error and changes nothing', async () => {
    const home = (
      await db.pool.query<{ ino: string }>(
        `SELECT ino::text FROM dentries WHERE parent_ino = $1 AND name = 'alice'`,
        [INO.HOME],
      )
    ).rows[0]?.ino;
    if (home === undefined) throw new Error('alice has no home; the previous test seeds it');
    const fixtures = (
      await db.pool.query<{ ino: string }>(
        `SELECT ino::text FROM dentries WHERE parent_ino = $1 AND name = 'fixtures'`,
        [home],
      )
    ).rows[0]?.ino;
    const inner = (
      await db.pool.query<{ ino: string }>(
        `SELECT d.ino::text FROM dentries d JOIN dentries t ON t.ino = d.parent_ino WHERE t.name = 'tree1000' AND d.name = 's1'`,
      )
    ).rows[0]?.ino;
    if (fixtures === undefined || inner === undefined) throw new Error('fixture tree missing');
    const before = await serverSnapshot(db.pool, home);
    let caught: unknown;
    try {
      await inTransaction(db.pool, (c) => moveDir(fixtures, 'tree1000', inner, 'tree1000')(c));
    } catch (err) {
      caught = err;
    }
    expect(isPgError(caught) ? caught.code : caught).toBe('PTC01');
    const after = await serverSnapshot(db.pool, home);
    expect(after.checksum).toBe(before.checksum);
    expect(after.probes).toEqual([]);
  });
});
