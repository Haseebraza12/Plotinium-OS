/**
 * DB-03 concurrency torture (spec §3.6.7): 2 and 8 clients, each on its own pool connection,
 * repeatedly move overlapping directories into each other. Afterwards the tree is acyclic, every
 * inode is reachable from / and every probe is empty; every failed move failed with the
 * acyclicity error (EINVAL) or a retryable lock error. Seeded (mulberry32, seed 42): 1,000 moves on
 * pull requests, `PLT_DB03_MOVES=20000` nightly. Skipped without DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { moveDir } from '../fault-injection/ops.ts';
import { seedAccount, seedDir, USERS_GID } from '../fault-injection/seed.ts';
import { runProbes } from '../fault-injection/server.ts';
import { intIn, mulberry32, type Rng } from '../fixtures/rng.ts';
import { createTestDatabase, type TestDatabase } from '../support/db-template.ts';
import { databaseUrl } from '../support/env.ts';
import { inTransaction, isPgError, type Pool } from '../support/sql.ts';

const url = databaseUrl();
const MOVES = Number(process.env['PLT_DB03_MOVES'] ?? 1000);
const DIRS = 12;
/** EINVAL from the acyclicity trigger; deadlock, lock timeout and serialisation are retryable. */
const EXPECTED = new Set(['PTC01', '40P01', '55P03', '40001']);

let db: TestDatabase;
let alice = { home: '', dirs: [] as string[] };

/** 'moved', or the SQLSTATE the move failed with. */
async function moveOnce(pool: Pool, dir: string, target: string, dirName: string): Promise<string> {
  try {
    await inTransaction(pool, async (c) => {
      await c.query(`SET LOCAL lock_timeout = '2s'`);
      const cur = await c.query<{ parent: string }>(
        `SELECT parent_ino::text AS parent FROM dentries WHERE ino = $1 FOR UPDATE`,
        [dir],
      );
      const parent = cur.rows[0]?.parent;
      if (parent === undefined) throw new Error(`directory ${dir} lost its name`);
      if (parent === target) return;
      await moveDir(parent, dirName, target, dirName)(c);
    });
    return 'moved';
  } catch (err) {
    if (isPgError(err) && err.code !== undefined) return err.code;
    throw err;
  }
}

async function torture(clients: number, moves: number, rng: Rng): Promise<Map<string, number>> {
  const outcomes = new Map<string, number>();
  const targets = [alice.home, ...alice.dirs];
  const perClient = Math.ceil(moves / clients);
  await Promise.all(
    Array.from({ length: clients }, async () => {
      for (let i = 0; i < perClient; i++) {
        const d = intIn(rng, 0, DIRS - 1);
        const t = targets[intIn(rng, 0, targets.length - 1)] as string;
        const out = await moveOnce(db.pool, alice.dirs[d] as string, t, `d${d}`);
        outcomes.set(out, (outcomes.get(out) ?? 0) + 1);
      }
    }),
  );
  return outcomes;
}

describe.skipIf(url === undefined)('DB-03 concurrency torture (PostgreSQL)', () => {
  beforeAll(async () => {
    db = await createTestDatabase(url as string, import.meta.url);
    const home = await seedAccount(db.pool, 1000, 'alice');
    const dirs: string[] = [];
    for (let i = 0; i < DIRS; i++)
      dirs.push(await seedDir(db.pool, home, `d${i}`, { uid: 1000, gid: USERS_GID }));
    alice = { home, dirs };
  });
  afterAll(async () => {
    await db?.drop();
  });

  for (const clients of [2, 8]) {
    it(`DB-03 ${clients} clients moving overlapping subtrees leave an acyclic tree with every inode reachable`, async () => {
      const outcomes = await torture(clients, MOVES, mulberry32(42 + clients));
      for (const code of outcomes.keys()) {
        if (code !== 'moved') expect(EXPECTED.has(code), `unexpected SQLSTATE ${code}`).toBe(true);
      }
      expect(outcomes.get('moved') ?? 0).toBeGreaterThan(0);
      expect(await runProbes(db.pool)).toEqual([]);
    });
  }
});
