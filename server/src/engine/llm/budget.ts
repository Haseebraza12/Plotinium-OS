/**
 * The LLM budget: pools, periods, the charged keys of a call, and the BudgetStore contract
 * (backend-api.md §3.13.2, §5.4; database.md §3.21, §4.11.17; ai-safety-and-evaluation.md §3.12).
 *
 * Reserve, call, settle: a call first RESERVES its worst-case cost in one short transaction
 * (a conditional UPDATE over every charged llm_usage row), the provider is called OUTSIDE any
 * transaction, and a second short transaction SETTLES the actual cost unconditionally. No row lock
 * or pool connection is ever held across the provider call (INV-SRV-3).
 *
 * Pools and periods (llm_usage.pool / period; days are calendar days in PLOTINIUM_TZ):
 *   global      month (LLM_BUDGET_USD_MONTH) and semester (LLM_BUDGET_USD_TOTAL, the project hard cap)
 *   uid:<uid>   day (LLM_USER_USD_DAY; examiners get their per-account examiner limits)
 *   examiners   day (LLM_EXAMINER_USD_DAY, LLM_EXAMINER_CALLS_DAY), accounts of kind 'examiner'
 *   demo        day (LLM_DEMO_USD_DAY, LLM_DEMO_CALLS_DAY), shared by guests and the demo account
 * So a call charges at most four rows (§5.4): global month, global semester, the caller's day and,
 * for examiners and guests/demo, their shared pool's day.
 */

export type AccountKind = 'root' | 'user' | 'guest' | 'demo' | 'examiner';
export type BudgetPool = 'global' | 'examiners' | 'demo' | `uid:${number}`;
export type BudgetPeriod = 'day' | 'month' | 'semester';

export interface BudgetKey {
  readonly pool: BudgetPool;
  readonly period: BudgetPeriod;
  /** 'YYYY-MM-DD' (a PostgreSQL date, kept as a string: database client parses dates raw). */
  readonly periodStart: string;
}

export interface BudgetRow extends BudgetKey {
  readonly limitMicroUsd: number;
  /** null: no call cap on this row. */
  readonly callLimit: number | null;
}

export interface PoolState extends BudgetRow {
  readonly reservedMicroUsd: number;
  readonly spentMicroUsd: number;
  readonly calls: number;
}

/** Budget limits in US$ and calls, exactly LlmConfig['budget'] (server/src/config.ts). */
export interface BudgetLimits {
  readonly monthUsd: number;
  readonly totalUsd: number;
  readonly userUsdDay: number;
  readonly demoUsdDay: number;
  readonly demoCallsDay: number;
  readonly examinerUsdDay: number;
  readonly examinerCallsDay: number;
}

export type LlmPurpose = 'plan' | 'extract' | 'answer' | 'eval' | 'bakeoff' | 'health';
export type LlmRequestStatus = 'reserved' | 'ok' | 'error' | 'refused' | 'abandoned' | 'replayed';

/** The llm_requests row inserted by `reserve` (status 'reserved'). */
export interface NewLlmRequest {
  readonly requestId: string;
  readonly uid: number;
  readonly osSessionId: string | null;
  readonly pid: number | null;
  readonly promptId: string | null;
  readonly turn: number;
  readonly purpose: LlmPurpose;
  readonly requestedModel: string;
  readonly effort: string | null;
  readonly pricingVersion: string;
  readonly reservedMicroUsd: number;
}

/** What `settle` writes to the llm_requests row. */
export interface Settlement {
  readonly requestId: string;
  readonly status: Exclude<LlmRequestStatus, 'reserved' | 'abandoned'>;
  readonly servedModel: string | null;
  readonly stopReason: string | null;
  readonly refusalCategory: string | null;
  readonly providerRequestId: string | null;
  /** null when no usage came back (abort, timeout, crash): the reservation is charged. */
  readonly tokens: {
    readonly input: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly output: number;
  } | null;
  readonly costMicroUsd: number;
  readonly latencyMs: number;
  /** Short error text (errno and reason). Never a prompt, a response or a credential. */
  readonly error: string | null;
}

export type ReserveOutcome =
  { readonly ok: true } | { readonly ok: false; readonly exhausted: readonly BudgetKey[] };

/**
 * The storage side of the budget. Every method is ONE short transaction (or one statement).
 * Implementations: KyselyBudgetStore (PostgreSQL) and MemoryBudgetStore (tests, local tools).
 */
export interface BudgetStore {
  /**
   * Creates missing period rows (ON CONFLICT DO NOTHING), inserts the llm_requests row with
   * status 'reserved', and runs ONE conditional UPDATE over the charged rows:
   *   reserved += est, calls += 1 WHERE spent + reserved + est <= limit AND (call_limit IS NULL OR calls < call_limit)
   * If fewer rows were updated than keys charged, everything rolls back and the outcome names the
   * exhausted keys.
   */
  reserve(rows: readonly BudgetRow[], request: NewLlmRequest): Promise<ReserveOutcome>;
  /**
   * Unconditional: the request row takes the settlement (only while it is still 'reserved', so a
   * row the sweeper already abandoned is never charged twice) and every charged row gets
   * reserved -= reservedMicroUsd, spent += costMicroUsd. Returns the charged rows after the update
   * (empty when the request was no longer reserved).
   */
  settle(
    keys: readonly BudgetKey[],
    reservedMicroUsd: number,
    settlement: Settlement,
  ): Promise<readonly PoolState[]>;
  /** Marks reservations older than `olderThanMs` 'abandoned' and settles them at the estimate. */
  sweepAbandoned(olderThanMs: number): Promise<number>;
  /** Current state of the given rows (missing rows are omitted). */
  pools(keys: readonly BudgetKey[]): Promise<readonly PoolState[]>;
}

/** `pool/period/period_start`, the llm_requests.charged_keys element format. */
export function keyString(k: BudgetKey): string {
  return `${k.pool}/${k.period}/${k.periodStart}`;
}

const POOL_RE = /^(?:global|examiners|demo|uid:\d{1,10})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isBudgetPool(s: string): s is BudgetPool {
  return POOL_RE.test(s);
}

export function parseKeyString(s: string): BudgetKey {
  const [pool, period, periodStart, ...rest] = s.split('/');
  if (
    rest.length > 0 ||
    pool === undefined ||
    !isBudgetPool(pool) ||
    (period !== 'day' && period !== 'month' && period !== 'semester') ||
    periodStart === undefined ||
    !DATE_RE.test(periodStart)
  ) {
    throw new RangeError(`not a budget key: ${s}`);
  }
  return { pool, period, periodStart };
}

export function sameKey(a: BudgetKey, b: BudgetKey): boolean {
  return a.pool === b.pool && a.period === b.period && a.periodStart === b.periodStart;
}

// ---------------------------------------------------------------------------------------------
// Calendar in PLOTINIUM_TZ
// ---------------------------------------------------------------------------------------------

export interface LocalClock {
  /** 'YYYY-MM-DD' in the zone. */
  readonly day: string;
  readonly year: number;
  readonly month: number;
  /** Milliseconds until the next local midnight (at least 1 s). */
  readonly msToNextDay: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function localClock(nowMs: number, timeZone: string): LocalClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(nowMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const secondsIntoDay = get('hour') * 3600 + get('minute') * 60 + get('second');
  const msIntoSecond = ((nowMs % 1000) + 1000) % 1000;
  const msToNextDay = Math.max(1000, (86_400 - secondsIntoDay) * 1000 - msIntoSecond);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return { day: `${year}-${pad(month)}-${pad(day)}`, year, month, msToNextDay };
}

/**
 * The semester budget period (the project hard cap, LLM_BUDGET_USD_TOTAL): Fall runs August to
 * January and Spring February to July, so Fall 2026 is period_start 2026-08-01.
 */
export function semesterStartOf(year: number, month: number): string {
  if (month >= 8) return `${year}-08-01`;
  if (month === 1) return `${year - 1}-08-01`;
  return `${year}-02-01`;
}

/** The rows one call of `caller` charges (§3.13.2; see the module comment). */
export function chargedRows(
  caller: { readonly uid: number; readonly kind: AccountKind },
  clock: LocalClock,
  limits: BudgetLimits,
  semesterStart: string = semesterStartOf(clock.year, clock.month),
): BudgetRow[] {
  const monthStart = `${clock.day.slice(0, 7)}-01`;
  const rows: BudgetRow[] = [
    {
      pool: 'global',
      period: 'month',
      periodStart: monthStart,
      limitMicroUsd: micro(limits.monthUsd),
      callLimit: null,
    },
    {
      pool: 'global',
      period: 'semester',
      periodStart: semesterStart,
      limitMicroUsd: micro(limits.totalUsd),
      callLimit: null,
    },
  ];
  const own: BudgetPool = `uid:${caller.uid}`;
  switch (caller.kind) {
    case 'examiner':
      rows.push(
        {
          pool: own,
          period: 'day',
          periodStart: clock.day,
          limitMicroUsd: micro(limits.examinerUsdDay),
          callLimit: limits.examinerCallsDay,
        },
        {
          pool: 'examiners',
          period: 'day',
          periodStart: clock.day,
          limitMicroUsd: micro(limits.examinerUsdDay),
          callLimit: limits.examinerCallsDay,
        },
      );
      break;
    case 'guest':
    case 'demo':
      rows.push(
        {
          pool: own,
          period: 'day',
          periodStart: clock.day,
          limitMicroUsd: micro(limits.userUsdDay),
          callLimit: null,
        },
        {
          pool: 'demo',
          period: 'day',
          periodStart: clock.day,
          limitMicroUsd: micro(limits.demoUsdDay),
          callLimit: limits.demoCallsDay,
        },
      );
      break;
    case 'user':
    case 'root':
      rows.push({
        pool: own,
        period: 'day',
        periodStart: clock.day,
        limitMicroUsd: micro(limits.userUsdDay),
        callLimit: null,
      });
      break;
  }
  return rows;
}

function micro(usd: number): number {
  return Math.round(usd * 1_000_000);
}

// ---------------------------------------------------------------------------------------------
// Alerts at 50, 80 and 100 % of the global caps
// ---------------------------------------------------------------------------------------------

export const ALERT_THRESHOLDS = [0.5, 0.8, 1] as const;

export interface BudgetAlert {
  readonly pool: 'global';
  readonly period: BudgetPeriod;
  readonly periodStart: string;
  /** The threshold just crossed: 0.5, 0.8 or 1. */
  readonly threshold: number;
  /** spent / limit after the settlement. */
  readonly ratio: number;
  readonly spentMicroUsd: number;
  readonly limitMicroUsd: number;
}

/**
 * Alerts for the thresholds that one settlement of `addedMicroUsd` crossed on the global rows
 * (`after` is the state RETURNED by the settle UPDATE). Each threshold fires once per period.
 */
export function crossedAlerts(after: readonly PoolState[], addedMicroUsd: number): BudgetAlert[] {
  const alerts: BudgetAlert[] = [];
  for (const row of after) {
    if (row.pool !== 'global' || row.limitMicroUsd <= 0) continue;
    const before = (row.spentMicroUsd - addedMicroUsd) / row.limitMicroUsd;
    const ratio = row.spentMicroUsd / row.limitMicroUsd;
    for (const threshold of ALERT_THRESHOLDS) {
      if (before < threshold && ratio >= threshold) {
        alerts.push({
          pool: 'global',
          period: row.period,
          periodStart: row.periodStart,
          threshold,
          ratio,
          spentMicroUsd: row.spentMicroUsd,
          limitMicroUsd: row.limitMicroUsd,
        });
      }
    }
  }
  return alerts;
}

/** Budget left for a caller: the smallest (limit - spent - reserved) over its charged rows. */
export function budgetLeft(rows: readonly BudgetRow[], states: readonly PoolState[]): number {
  let left = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const s = states.find((p) => sameKey(p, row));
    const available =
      s === undefined ? row.limitMicroUsd : s.limitMicroUsd - s.spentMicroUsd - s.reservedMicroUsd;
    left = Math.min(left, available);
  }
  return Number.isFinite(left) ? Math.max(0, left) : 0;
}
