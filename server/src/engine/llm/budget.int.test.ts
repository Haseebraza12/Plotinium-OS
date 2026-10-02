/**
 * DB-gated (DATABASE_URL, a disposable migrated database; see server/src/db/db.int.test.ts):
 * KyselyBudgetStore against PostgreSQL 18. Rows use period_start 2099-xx so real budgets are
 * never touched, and everything created is removed afterwards.
 */
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../../db/client.ts';
import type { DB } from '../../db/types.gen.ts';
import { uuidv7 } from '../../util/uuidv7.ts';
import type { BudgetRow, NewLlmRequest, Settlement } from './budget.ts';
import { KyselyBudgetStore } from './kysely-budget.ts';
import { scratchDatabaseUrl } from '../../../tests/scratch-db.ts';

/** A per-file clone of DATABASE_URL's database (server/tests/scratch-db.ts). */
const URL_ = await scratchDatabaseUrl('llm');
const UID = 91_501;
const GID = 91_501;

let database: Database;
let db: Kysely<DB>;

const rowsFor = (day: string, dayLimit: number, callLimit: number | null = null): BudgetRow[] => [
  {
    pool: 'global',
    period: 'month',
    periodStart: '2099-01-01',
    limitMicroUsd: 10_000_000,
    callLimit: null,
  },
  { pool: `uid:${UID}`, period: 'day', periodStart: day, limitMicroUsd: dayLimit, callLimit },
];

const request = (reserved: number): NewLlmRequest => ({
  requestId: uuidv7(),
  uid: UID,
  osSessionId: null,
  pid: 3,
  promptId: uuidv7(),
  turn: 2,
  purpose: 'plan',
  requestedModel: 'claude-opus-5-5',
  effort: 'medium',
  pricingVersion: '2026-09-24',
  reservedMicroUsd: reserved,
});

const settlement = (requestId: string, cost: number): Settlement => ({
  requestId,
  status: 'ok',
  servedModel: 'claude-opus-5',
  stopReason: 'tool_use',
  refusalCategory: null,
  providerRequestId: 'req_01',
  tokens: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 },
  costMicroUsd: cost,
  latencyMs: 1234.4,
  error: null,
});

describe.runIf(URL_ !== undefined)(
  'AIS-09 KyselyBudgetStore on PostgreSQL (database.md §4.11.17)',
  () => {
    beforeAll(async () => {
      database = createDatabase({
        url: URL_ ?? '',
        password: undefined,
        poolMax: 8,
        statementTimeoutMs: 10_000,
        lockTimeoutMs: 2_000,
      });
      db = database.db;
      await sql`INSERT INTO groups (gid, name) VALUES (${GID}, 'llmbudgettest') ON CONFLICT DO NOTHING`.execute(
        db,
      );
      await sql`INSERT INTO users (uid, username, account_kind, password_hash, primary_gid, quota_bytes, quota_inodes)
              VALUES (${UID}, 'llmbudgettest', 'user', 'x', ${GID}, 0, 0) ON CONFLICT DO NOTHING`.execute(
        db,
      );
    });
    afterAll(async () => {
      await sql`DELETE FROM llm_requests WHERE uid = ${UID}`.execute(db);
      await sql`DELETE FROM llm_usage WHERE period_start >= '2099-01-01'`.execute(db);
      await sql`DELETE FROM users WHERE uid = ${UID}`.execute(db);
      await sql`DELETE FROM groups WHERE gid = ${GID}`.execute(db);
      await database.close();
    });

    it('AIS-09 every provider call writes exactly one llm_requests row, reserved then settled, and the pools return to zero reserved', async () => {
      const store = new KyselyBudgetStore(db);
      const rows = rowsFor('2099-01-02', 1_000_000);
      const req = request(300_000);
      expect(await store.reserve(rows, req)).toEqual({ ok: true });
      const r1 = await sql<{ status: string; charged_keys: string[]; settled_at: Date | null }>`
      SELECT status, charged_keys, settled_at FROM llm_requests WHERE request_id = ${req.requestId}::uuid`.execute(
        db,
      );
      expect(r1.rows[0]).toEqual({
        status: 'reserved',
        charged_keys: ['global/month/2099-01-01', `uid:${UID}/day/2099-01-02`],
        settled_at: null,
      });
      const after = await store.settle(rows, 300_000, settlement(req.requestId, 120_000));
      expect(after.map((p) => [p.pool, p.reservedMicroUsd, p.spentMicroUsd, p.calls])).toEqual(
        expect.arrayContaining([
          ['global', 0, 120_000, 1],
          [`uid:${UID}`, 0, 120_000, 1],
        ]),
      );
      const r2 = await sql<Record<string, unknown>>`
      SELECT status, served_model, requested_model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
             cost_microusd, reserved_microusd, latency_ms, provider_request_id, pricing_version, turn, settled_at IS NOT NULL AS settled
        FROM llm_requests WHERE request_id = ${req.requestId}::uuid`.execute(db);
      expect(r2.rows[0]).toEqual({
        status: 'ok',
        served_model: 'claude-opus-5',
        requested_model: 'claude-opus-5-5',
        input_tokens: 10,
        cache_read_tokens: 20,
        cache_write_tokens: 30,
        output_tokens: 40,
        cost_microusd: 120_000,
        reserved_microusd: 300_000,
        latency_ms: 1234,
        provider_request_id: 'req_01',
        pricing_version: '2026-09-24',
        turn: 2,
        settled: true,
      });
      expect(await store.settle(rows, 300_000, settlement(req.requestId, 120_000))).toEqual([]); // once only
      expect((await store.pools(rows)).map((p) => p.spentMicroUsd)).toEqual([120_000, 120_000]);
      expect(await store.pools([])).toEqual([]);
    });

    it('AIS-09 the cap is exact under concurrency: of 20 parallel reservations only those that fit succeed, and refused ones leave no row', async () => {
      const store = new KyselyBudgetStore(db);
      const rows = rowsFor('2099-01-03', 500_000, 100);
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () => store.reserve(rows, request(100_000))),
      );
      expect(outcomes.filter((o) => o.ok)).toHaveLength(5);
      const refused = outcomes.find((o) => !o.ok);
      expect(refused).toEqual({
        ok: false,
        exhausted: [{ pool: `uid:${UID}`, period: 'day', periodStart: '2099-01-03' }],
      });
      const day = (await store.pools(rows)).find((p) => p.pool !== 'global');
      expect(day).toMatchObject({
        reservedMicroUsd: 500_000,
        calls: 5,
        limitMicroUsd: 500_000,
        callLimit: 100,
      });
      const n = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM llm_requests WHERE uid = ${UID} AND ${`uid:${UID}/day/2099-01-03`} = ANY(charged_keys)`.execute(
        db,
      );
      expect(n.rows[0]?.n).toBe(5);
    });

    it('AIS-09 the call cap refuses once calls reach call_limit', async () => {
      const store = new KyselyBudgetStore(db);
      const rows = rowsFor('2099-01-04', 10_000_000, 2);
      expect((await store.reserve(rows, request(1))).ok).toBe(true);
      expect((await store.reserve(rows, request(1))).ok).toBe(true);
      expect((await store.reserve(rows, request(1))).ok).toBe(false);
    });

    it('AIS-09 the sweeper abandons reservations older than the cutoff and settles them at the estimate', async () => {
      const store = new KyselyBudgetStore(db);
      const rows = rowsFor('2099-01-05', 1_000_000);
      const req = request(70_000);
      await store.reserve(rows, req);
      await sql`UPDATE llm_requests SET created_at = now() - interval '11 minutes' WHERE request_id = ${req.requestId}::uuid`.execute(
        db,
      );
      expect(await store.sweepAbandoned(10 * 60 * 1000)).toBeGreaterThanOrEqual(1);
      const r = await sql<{ status: string; cost_microusd: number }>`
      SELECT status, cost_microusd FROM llm_requests WHERE request_id = ${req.requestId}::uuid`.execute(
        db,
      );
      expect(r.rows[0]).toEqual({ status: 'abandoned', cost_microusd: 70_000 });
      const day = (await store.pools(rows)).find((p) => p.pool !== 'global');
      expect(day).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 70_000 });
      expect(await store.settle(rows, 70_000, settlement(req.requestId, 5))).toEqual([]); // never charged twice
    });
  },
);
