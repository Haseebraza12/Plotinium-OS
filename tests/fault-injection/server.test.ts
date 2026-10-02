/**
 * DB-02 server fault-injection matrix (spec §3.6.4, §3.6.6; database.md §3.14). Needs the Compose
 * database: `docker compose -f compose.yaml -f compose.test.yaml up -d --wait db` and DATABASE_URL
 * pointing at it as the owner role. Skipped (never verified, T-3) without DATABASE_URL.
 *
 * For every bulk op and fault point: seed the fixture once, snapshot, run the op with the fault
 * armed, expect SQLSTATE P0001 naming node k, snapshot again and require the oracle unchanged
 * (checksum, orphans, parentless, refcounts, nlink, quota, probes). Armed beyond the last node op,
 * the op commits, the trigger counted exactly M node ops, and the probes stay clean.
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { flat1000, flat500, tree1000, treeById } from '../fixtures/trees.ts';
import { createTestDatabase, type TestDatabase } from '../support/db-template.ts';
import { databaseUrl } from '../support/env.ts';
import { sameState } from '../support/oracle.ts';
import { isPgError } from '../support/sql.ts';

import { faultCaseArb } from '../property/arbitraries.ts';
import { fcParamsHeavy } from '../property/profile.ts';

import {
  faultMessage,
  faultPoints,
  MATRIX,
  nodeOps,
  type BulkOp,
  type MatrixRow,
} from './matrix.ts';
import { chmodR, chownR, cpR, moveBatch, moveDir, rmR, runWithFault, type OpBody } from './ops.ts';
import { seedAccount, seedDir, seedTree, USERS_GID } from './seed.ts';
import { serverSnapshot } from './server.ts';

const url = databaseUrl();
const ALICE = { uid: 1000, gid: USERS_GID };
const BOB_UID = 1001;

interface Prepared {
  /** Directory holding this op's fixture; the checksum subtree. */
  scope: string;
  body: OpBody;
}

let db: TestDatabase;
let home: string;

async function prepare(op: BulkOp, scopeName: string = op): Promise<Prepared> {
  const scope = await seedDir(db.pool, home, scopeName, ALICE);
  switch (op) {
    case 'rm-r':
      await seedTree(db.pool, tree1000(), scope, ALICE);
      return { scope, body: rmR(scope, 'tree1000') };
    case 'cp-r':
      await seedTree(db.pool, tree1000(), scope, ALICE);
      return { scope, body: cpR(scope, 'tree1000', scope, 'tree1000-copy', ALICE.uid, ALICE.gid) };
    case 'chmod-r':
      await seedTree(db.pool, tree1000(), scope, ALICE);
      return { scope, body: chmodR(scope, 'tree1000', 0o007, 0) };
    case 'chown-r':
      await seedTree(db.pool, tree1000(), scope, ALICE);
      return { scope, body: chownR(scope, 'tree1000', BOB_UID, null) };
    case 'mv-dir': {
      await seedTree(db.pool, tree1000(), scope, ALICE);
      const dst = await seedDir(db.pool, scope, 'dst', ALICE);
      return { scope, body: moveDir(scope, 'tree1000', dst, 'tree1000') };
    }
    case 'mv-batch': {
      const src = await seedTree(db.pool, flat1000(), scope, ALICE);
      const dst = await seedDir(db.pool, scope, 'dst', ALICE);
      const names = flat1000()
        .nodes.slice(1)
        .map((n) => n.path.slice(n.path.lastIndexOf('/') + 1));
      return {
        scope,
        body: moveBatch(names.map((n) => ({ sp: src.root, sn: n, dp: dst, dn: n }))),
      };
    }
    case 'rename-batch': {
      const dir = await seedTree(db.pool, flat500(), scope, ALICE);
      const names = flat500()
        .nodes.slice(1)
        .map((n) => n.path.slice(n.path.lastIndexOf('/') + 1));
      return {
        scope,
        body: moveBatch(
          names.map((n) => ({
            sp: dir.root,
            sn: n,
            dp: dir.root,
            dn: n.replace('file-', 'renamed-'),
          })),
        ),
      };
    }
  }
}

async function expectFault(row: MatrixRow, p: Prepared, failAt: number): Promise<void> {
  const before = await serverSnapshot(db.pool, p.scope);
  expect(before.probes, 'probes must be clean before arming').toEqual([]);
  let caught: unknown;
  try {
    await runWithFault(db.pool, row.on, failAt, p.body);
  } catch (err) {
    caught = err;
  }
  expect(isPgError(caught) && caught.code, 'the op must fail with the injected fault').toBe(
    'P0001',
  );
  expect((caught as Error).message).toBe(faultMessage(failAt, row.on));
  const after = await serverSnapshot(db.pool, p.scope);
  expect(sameState(before, after)).toEqual({ ok: true, diffs: [] });
  expect(after.probes).toEqual([]);
}

describe.skipIf(url === undefined)('DB-02 server fault-injection matrix (PostgreSQL)', () => {
  beforeAll(async () => {
    db = await createTestDatabase(url as string, import.meta.url);
    home = await seedAccount(db.pool, ALICE.uid, 'alice');
    await seedAccount(db.pool, BOB_UID, 'bob');
  });

  afterAll(async () => {
    await db?.drop();
  });

  for (const row of MATRIX) {
    describe(`DB-02 ${row.label} on ${treeById(row.tree).id}`, () => {
      let prepared: Prepared;
      beforeAll(async () => {
        prepared = await prepare(row.op);
      });

      for (const k of faultPoints(row)) {
        it(`DB-02 ${row.label} with a server fault at node ${k} rolls back with zero orphans and unchanged checksum and quota`, async () => {
          await expectFault(row, prepared, k);
        });
      }

      it(`DB-02 ${row.label} armed beyond its last node op commits after exactly ${nodeOps(row)} node ops with clean probes`, async () => {
        const before = await serverSnapshot(db.pool, prepared.scope);
        const counted = await runWithFault(db.pool, row.on, nodeOps(row) + 1, prepared.body);
        expect(counted).toBe(nodeOps(row));
        const after = await serverSnapshot(db.pool, prepared.scope);
        expect(after.checksum).not.toBe(before.checksum);
        expect(after.probes).toEqual([]);
        expect(after.orphans).toEqual([]);
        expect(after.nlinkMismatches).toEqual([]);
        expect(after.refcountMismatches).toEqual([]);
      });
    });
  }

  it('DB-02 a random bulk op with a random fault point always leaves the oracle unchanged', async () => {
    // Each op's fixture is seeded once: every run rolls back, so the tree is reused unchanged.
    const prepared = new Map<BulkOp, Prepared>();
    for (const row of MATRIX) prepared.set(row.op, await prepare(row.op, `${row.op}-property`));
    await fc.assert(
      fc.asyncProperty(faultCaseArb, async ({ row, failAt }) => {
        await expectFault(row, prepared.get(row.op) as Prepared, failAt);
      }),
      fcParamsHeavy(Number(process.env['PLT_FAULT_PROP_RUNS'] ?? 25)),
    );
  });

  it('TST-08 the fault trigger is inert when plotinium.fault_after is unset', async () => {
    const scope = await seedDir(db.pool, home, 'inert', ALICE);
    await seedTree(db.pool, flat500(), scope, ALICE);
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('plotinium.fault_on', 'inodes', true)`);
      await chmodR(scope, 'flat500', 0o077, 0)(c);
      const n = await c.query<{ n: string | null }>(
        `SELECT current_setting('plotinium.fault_count', true) AS n`,
      );
      expect(n.rows[0]?.n ?? '').toBe('');
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const after = await serverSnapshot(db.pool, scope);
    expect(after.probes).toEqual([]);
  });
});
