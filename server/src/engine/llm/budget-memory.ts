/**
 * MemoryBudgetStore: the BudgetStore contract over in-process maps, with the same semantics as
 * the SQL store (conditional all-or-nothing reservation, unconditional settlement, abandonment).
 * Used by unit tests and by tools that run without a database; production uses KyselyBudgetStore.
 */
import {
  keyString,
  parseKeyString,
  sameKey,
  type BudgetKey,
  type BudgetRow,
  type BudgetStore,
  type LlmRequestStatus,
  type NewLlmRequest,
  type PoolState,
  type ReserveOutcome,
  type Settlement,
} from './budget.ts';

export interface MemoryLlmRequest extends NewLlmRequest {
  status: LlmRequestStatus;
  chargedKeys: string[];
  createdAtMs: number;
  settledAtMs: number | null;
  servedModel: string | null;
  stopReason: string | null;
  refusalCategory: string | null;
  providerRequestId: string | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number | null;
  latencyMs: number | null;
  error: string | null;
}

interface MutablePool {
  pool: PoolState['pool'];
  period: PoolState['period'];
  periodStart: string;
  limitMicroUsd: number;
  callLimit: number | null;
  reservedMicroUsd: number;
  spentMicroUsd: number;
  calls: number;
}

export class MemoryBudgetStore implements BudgetStore {
  readonly usage = new Map<string, MutablePool>();
  readonly requests = new Map<string, MemoryLlmRequest>();
  readonly #now: () => number;
  /** Test hook: counts transactions so tests can assert "short transactions only". */
  transactions = 0;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  reserve(rows: readonly BudgetRow[], request: NewLlmRequest): Promise<ReserveOutcome> {
    this.transactions++;
    for (const row of rows) {
      const k = keyString(row);
      if (!this.usage.has(k)) {
        this.usage.set(k, {
          pool: row.pool,
          period: row.period,
          periodStart: row.periodStart,
          limitMicroUsd: row.limitMicroUsd,
          callLimit: row.callLimit,
          reservedMicroUsd: 0,
          spentMicroUsd: 0,
          calls: 0,
        });
      }
    }
    const est = request.reservedMicroUsd;
    const exhausted: BudgetKey[] = [];
    for (const row of rows) {
      const p = this.usage.get(keyString(row));
      if (
        p === undefined ||
        p.spentMicroUsd + p.reservedMicroUsd + est > p.limitMicroUsd ||
        (p.callLimit !== null && p.calls >= p.callLimit)
      ) {
        exhausted.push({ pool: row.pool, period: row.period, periodStart: row.periodStart });
      }
    }
    if (exhausted.length > 0) return Promise.resolve({ ok: false, exhausted });
    for (const row of rows) {
      const p = this.usage.get(keyString(row));
      if (p !== undefined) {
        p.reservedMicroUsd += est;
        p.calls += 1;
      }
    }
    this.requests.set(request.requestId, {
      ...request,
      status: 'reserved',
      chargedKeys: rows.map(keyString),
      createdAtMs: this.#now(),
      settledAtMs: null,
      servedModel: null,
      stopReason: null,
      refusalCategory: null,
      providerRequestId: null,
      inputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      costMicroUsd: null,
      latencyMs: null,
      error: null,
    });
    return Promise.resolve({ ok: true });
  }

  settle(
    keys: readonly BudgetKey[],
    reservedMicroUsd: number,
    s: Settlement,
  ): Promise<readonly PoolState[]> {
    this.transactions++;
    const r = this.requests.get(s.requestId);
    if (r === undefined || r.status !== 'reserved') return Promise.resolve([]);
    r.status = s.status;
    r.servedModel = s.servedModel;
    r.stopReason = s.stopReason;
    r.refusalCategory = s.refusalCategory;
    r.providerRequestId = s.providerRequestId;
    r.inputTokens = s.tokens?.input ?? null;
    r.cacheReadTokens = s.tokens?.cacheRead ?? null;
    r.cacheWriteTokens = s.tokens?.cacheWrite ?? null;
    r.outputTokens = s.tokens?.output ?? null;
    r.costMicroUsd = s.costMicroUsd;
    r.latencyMs = s.latencyMs;
    r.error = s.error;
    r.settledAtMs = this.#now();
    return Promise.resolve(this.#apply(keys, reservedMicroUsd, s.costMicroUsd));
  }

  sweepAbandoned(olderThanMs: number): Promise<number> {
    this.transactions++;
    const cutoff = this.#now() - olderThanMs;
    let n = 0;
    for (const r of this.requests.values()) {
      if (r.status !== 'reserved' || r.createdAtMs >= cutoff) continue;
      r.status = 'abandoned';
      r.costMicroUsd = r.reservedMicroUsd;
      r.error = 'abandoned';
      r.settledAtMs = this.#now();
      this.#apply(r.chargedKeys.map(parseKeyString), r.reservedMicroUsd, r.reservedMicroUsd);
      n++;
    }
    return Promise.resolve(n);
  }

  pools(keys: readonly BudgetKey[]): Promise<readonly PoolState[]> {
    const out: PoolState[] = [];
    for (const k of keys) {
      const p = this.usage.get(keyString(k));
      if (p !== undefined) out.push({ ...p });
    }
    return Promise.resolve(out);
  }

  /** Test helper: the row of one key. */
  pool(k: BudgetKey): PoolState | undefined {
    const p = this.usage.get(keyString(k));
    return p === undefined ? undefined : { ...p };
  }

  #apply(keys: readonly BudgetKey[], reserved: number, spent: number): PoolState[] {
    const out: PoolState[] = [];
    for (const k of keys) {
      const p = [...this.usage.values()].find((u) => sameKey(u, k));
      if (p === undefined) continue;
      p.reservedMicroUsd = Math.max(0, p.reservedMicroUsd - reserved);
      p.spentMicroUsd += spent;
      out.push({ ...p });
    }
    return out;
  }
}
