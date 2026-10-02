/**
 * BudgetStore on PostgreSQL through Kysely (database.md §3.21, §4.11.17; backend-api.md §3.13.2,
 * §5.4). Hand-written `sql` templates; every method is one short transaction or one statement, and
 * none is ever open while the provider is called (INV-SRV-3).
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.gen.ts';
import {
  keyString,
  parseKeyString,
  type BudgetKey,
  type BudgetPeriod,
  type BudgetPool,
  type BudgetRow,
  type BudgetStore,
  type NewLlmRequest,
  type PoolState,
  type ReserveOutcome,
  type Settlement,
} from './budget.ts';

interface PoolRow {
  pool: string;
  period: string;
  period_start: string;
  limit_microusd: number | string;
  call_limit: number | null;
  reserved_microusd: number | string;
  spent_microusd: number | string;
  calls: number;
}

/** Thrown inside the reserve transaction to roll it back. */
class Exhausted extends Error {
  readonly keys: readonly BudgetKey[];
  constructor(keys: readonly BudgetKey[]) {
    super('budget exhausted');
    this.keys = keys;
  }
}

const cols = (keys: readonly BudgetKey[]) => ({
  pools: keys.map((k) => k.pool),
  periods: keys.map((k) => k.period),
  starts: keys.map((k) => k.periodStart),
});

function toState(r: PoolRow): PoolState {
  return {
    pool: r.pool as BudgetPool,
    period: r.period as BudgetPeriod,
    periodStart: r.period_start,
    limitMicroUsd: Number(r.limit_microusd),
    callLimit: r.call_limit,
    reservedMicroUsd: Number(r.reserved_microusd),
    spentMicroUsd: Number(r.spent_microusd),
    calls: r.calls,
  };
}

const POOL_COLUMNS = sql`u.pool, u.period, to_char(u.period_start, 'YYYY-MM-DD') AS period_start,
  u.limit_microusd, u.call_limit, u.reserved_microusd, u.spent_microusd, u.calls`;

export class KyselyBudgetStore implements BudgetStore {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async reserve(rows: readonly BudgetRow[], req: NewLlmRequest): Promise<ReserveOutcome> {
    const { pools, periods, starts } = cols(rows);
    const limits = rows.map((r) => r.limitMicroUsd);
    const callLimits = rows.map((r) => r.callLimit);
    try {
      await this.#db.transaction().execute(async (tx) => {
        await sql`INSERT INTO llm_usage (pool, period, period_start, limit_microusd, call_limit)
          SELECT * FROM unnest(${pools}::text[], ${periods}::text[], ${starts}::date[],
                               ${limits}::bigint[], ${callLimits}::int[])
          ON CONFLICT ON CONSTRAINT llm_usage_pkey DO NOTHING`.execute(tx);
        await sql`INSERT INTO llm_requests (request_id, uid, os_session_id, pid, prompt_id, turn, purpose,
                    requested_model, effort, pricing_version, status, reserved_microusd, charged_keys)
          VALUES (${req.requestId}::uuid, ${req.uid}, ${req.osSessionId}::uuid, ${req.pid},
                  ${req.promptId}::uuid, ${req.turn}, ${req.purpose}, ${req.requestedModel}, ${req.effort},
                  ${req.pricingVersion}, 'reserved', ${req.reservedMicroUsd},
                  ${rows.map(keyString)}::text[])`.execute(tx);
        const updated = await sql<{ pool: string; period: string; period_start: string }>`
          WITH k(pool, period, period_start) AS (
            SELECT * FROM unnest(${pools}::text[], ${periods}::text[], ${starts}::date[]))
          UPDATE llm_usage u
             SET reserved_microusd = u.reserved_microusd + ${req.reservedMicroUsd}::bigint,
                 calls = u.calls + 1
            FROM k
           WHERE (u.pool, u.period, u.period_start) = (k.pool, k.period, k.period_start)
             AND u.spent_microusd + u.reserved_microusd + ${req.reservedMicroUsd}::bigint <= u.limit_microusd
             AND (u.call_limit IS NULL OR u.calls < u.call_limit)
          RETURNING u.pool, u.period, to_char(u.period_start, 'YYYY-MM-DD') AS period_start`.execute(
          tx,
        );
        if (updated.rows.length < rows.length) {
          const got = new Set(updated.rows.map((r) => `${r.pool}/${r.period}/${r.period_start}`));
          throw new Exhausted(rows.filter((r) => !got.has(keyString(r))).map(parseKeyString_));
        }
      });
    } catch (e) {
      if (e instanceof Exhausted) return { ok: false, exhausted: e.keys };
      throw e;
    }
    return { ok: true };
  }

  async settle(
    keys: readonly BudgetKey[],
    reservedMicroUsd: number,
    s: Settlement,
  ): Promise<readonly PoolState[]> {
    const { pools, periods, starts } = cols(keys);
    return this.#db.transaction().execute(async (tx) => {
      const r = await sql<{ request_id: string }>`
        UPDATE llm_requests
           SET status = ${s.status}, served_model = ${s.servedModel}, stop_reason = ${s.stopReason},
               refusal_category = ${s.refusalCategory}, provider_request_id = ${s.providerRequestId},
               input_tokens = ${s.tokens?.input ?? null}, cache_read_tokens = ${s.tokens?.cacheRead ?? null},
               cache_write_tokens = ${s.tokens?.cacheWrite ?? null}, output_tokens = ${s.tokens?.output ?? null},
               cost_microusd = ${s.costMicroUsd}, latency_ms = ${Math.max(0, Math.round(s.latencyMs))},
               error = ${s.error}, settled_at = now()
         WHERE request_id = ${s.requestId}::uuid AND status = 'reserved'
        RETURNING request_id`.execute(tx);
      if (r.rows.length === 0) return [];
      const u = await sql<PoolRow>`
        UPDATE llm_usage u
           SET reserved_microusd = greatest(u.reserved_microusd - ${reservedMicroUsd}::bigint, 0),
               spent_microusd = u.spent_microusd + ${s.costMicroUsd}::bigint
          FROM unnest(${pools}::text[], ${periods}::text[], ${starts}::date[]) AS k(pool, period, period_start)
         WHERE (u.pool, u.period, u.period_start) = (k.pool, k.period, k.period_start)
        RETURNING ${POOL_COLUMNS}`.execute(tx);
      return u.rows.map(toState);
    });
  }

  async sweepAbandoned(olderThanMs: number): Promise<number> {
    return this.#db.transaction().execute(async (tx) => {
      const r = await sql<{ reserved_microusd: number | string; charged_keys: string[] }>`
        UPDATE llm_requests
           SET status = 'abandoned', cost_microusd = reserved_microusd, error = 'abandoned', settled_at = now()
         WHERE status = 'reserved'
           AND created_at < now() - make_interval(secs => ${olderThanMs / 1000}::double precision)
        RETURNING reserved_microusd, charged_keys`.execute(tx);
      const amounts = new Map<string, number>();
      for (const row of r.rows) {
        for (const k of row.charged_keys) {
          amounts.set(k, (amounts.get(k) ?? 0) + Number(row.reserved_microusd));
        }
      }
      if (amounts.size > 0) {
        const keys = [...amounts.keys()].map(parseKeyString);
        const { pools, periods, starts } = cols(keys);
        const amts = [...amounts.values()];
        await sql`
          UPDATE llm_usage u
             SET reserved_microusd = greatest(u.reserved_microusd - k.amount, 0),
                 spent_microusd = u.spent_microusd + k.amount
            FROM unnest(${pools}::text[], ${periods}::text[], ${starts}::date[], ${amts}::bigint[])
                 AS k(pool, period, period_start, amount)
           WHERE (u.pool, u.period, u.period_start) = (k.pool, k.period, k.period_start)`.execute(
          tx,
        );
      }
      return r.rows.length;
    });
  }

  async pools(keys: readonly BudgetKey[]): Promise<readonly PoolState[]> {
    if (keys.length === 0) return [];
    const { pools, periods, starts } = cols(keys);
    const r = await sql<PoolRow>`
      SELECT ${POOL_COLUMNS}
        FROM llm_usage u
        JOIN unnest(${pools}::text[], ${periods}::text[], ${starts}::date[]) AS k(pool, period, period_start)
          ON (u.pool, u.period, u.period_start) = (k.pool, k.period, k.period_start)`.execute(
      this.#db,
    );
    return r.rows.map(toState);
  }
}

function parseKeyString_(row: BudgetRow): BudgetKey {
  return parseKeyString(keyString(row));
}
