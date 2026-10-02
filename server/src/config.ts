/**
 * Server configuration: ONE Valibot-validated, frozen object built from the environment at startup.
 *
 * Spec: specs/11-server/backend-api.md §3.4 (SRV-02, SRV-14, SRV-18, SRV-20); C9, C10.
 * Primary owner R5, secondary reviewer R2.
 *
 * Rules
 * - No secret has a default. Secrets can be given as `*_FILE` paths (read once, trailing newline
 *   stripped); production requires the file form (SRV-02).
 * - An invalid or unsafe configuration throws ConfigError, which lists the offending VARIABLE NAMES
 *   and never a value; main.ts exits with code 78 (EX_CONFIG).
 * - The database passwords are generated at first start by the db image (ops/db/entrypoint.sh) and
 *   reach the server as DATABASE_PASSWORD_FILE; the server itself generates no secret.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as v from 'valibot';

import { KNOWN_DEV_VALUES } from './config/known-dev-values.ts';

export type PlotiniumEnv = 'local' | 'ci' | 'production';
export type LlmMode = 'live' | 'record' | 'replay';

export interface DatabaseConfig {
  /** postgres://plotinium_app@db:5432/plotinium (role plotinium_app, database.md §3.2). */
  readonly url: string;
  /** From DATABASE_PASSWORD_FILE; undefined when the URL carries the password (local tools, tests). */
  readonly password: string | undefined;
  readonly poolMax: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
}

export interface LlmConfig {
  readonly mode: LlmMode;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly fallbackModel: string;
  readonly temperature: number | undefined;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly maxInflight: number;
  /** Absent: the gateway is degraded with reason `no-key` and everything else works (C12). */
  readonly apiKey: string | undefined;
  readonly recordBudgetUsd: number | undefined;
  readonly budget: {
    readonly monthUsd: number;
    readonly totalUsd: number;
    readonly userUsdDay: number;
    readonly demoUsdDay: number;
    readonly demoCallsDay: number;
    readonly examinerUsdDay: number;
    readonly examinerCallsDay: number;
  };
  readonly upstreamUrl: string | undefined;
  readonly upstreamToken: string | undefined;
  readonly upstreamAcceptHashes: readonly string[];
}

export interface Config {
  readonly env: PlotiniumEnv;
  readonly host: string;
  readonly port: number;
  readonly plotiniumPort: number;
  readonly appOrigin: string;
  readonly allowedOrigins: readonly string[];
  readonly trustProxyCidrs: readonly string[];
  readonly database: DatabaseConfig | null;
  readonly blobDir: string;
  readonly blobMaxBytes: number;
  readonly swapMaxBytes: number;
  readonly swapPageMaxRawBytes: number;
  readonly leaseTtlMs: number;
  readonly heartbeatMs: number;
  readonly feedRetentionDays: number;
  readonly session: {
    readonly slidingDays: number;
    readonly absoluteDays: number;
    readonly guestHours: number;
  };
  readonly guest: { readonly enabled: boolean; readonly maxActive: number };
  readonly authPepper: string | undefined;
  readonly argon2MaxConcurrency: number;
  readonly loginMaxConcurrency: number;
  readonly ai: boolean;
  readonly llm: LlmConfig;
  readonly faultInjection: boolean;
  readonly telemetryRetentionDays: number;
  readonly timeZone: string;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly metrics: { readonly host: string; readonly port: number };
  readonly shutdownGraceMs: number;
  readonly build: { readonly version: string; readonly sha: string; readonly date: string };
  readonly migrationsDir: string;
}

/** Thrown for an invalid or unsafe configuration. `problems` name variables, never values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------------------------
// Schema of the raw environment (every value is a string or absent)
// ---------------------------------------------------------------------------------------------

const int = (def: number, min: number, max: number) =>
  v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.regex(/^\d+$/, 'a non-negative integer'),
      v.transform(Number),
      v.integer(),
      v.minValue(min),
      v.maxValue(max),
    ),
    String(def),
  );

const decimal = (def: number, min: number, max: number) =>
  v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.regex(/^\d+(\.\d+)?$/, 'a non-negative decimal number'),
      v.transform(Number),
      v.minValue(min),
      v.maxValue(max),
    ),
    String(def),
  );

const flag = (def: '0' | '1') =>
  v.optional(
    v.pipe(
      v.picklist(['0', '1']),
      v.transform((s) => s === '1'),
    ),
    def,
  );

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));
const text = (def: string) => v.optional(nonEmpty, def);
const optText = () => v.optional(nonEmpty);

const csv = v.optional(
  v.pipe(
    v.string(),
    v.transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    ),
  ),
  '',
);

const EnvSchema = v.object({
  PLOTINIUM_ENV: v.optional(v.picklist(['local', 'ci', 'production']), 'local'),
  PORT: int(3000, 1, 65535),
  HOST: text('0.0.0.0'),
  PLOTINIUM_PORT: int(4717, 1, 65535),
  APP_ORIGIN: v.optional(v.pipe(v.string(), v.trim(), v.url('an absolute URL'))),
  ALLOWED_ORIGINS: csv,
  TRUST_PROXY_CIDRS: v.optional(csv.wrapped, '172.30.47.0/24'),
  DATABASE_URL: v.optional(
    v.pipe(v.string(), v.trim(), v.regex(/^postgres(ql)?:\/\//, 'a postgres:// URL')),
  ),
  DATABASE_PASSWORD_FILE: optText(),
  DB_POOL_MAX: int(10, 1, 100),
  DB_STATEMENT_TIMEOUT_MS: int(10_000, 100, 600_000),
  DB_LOCK_TIMEOUT_MS: int(2_000, 10, 60_000),
  BLOB_DIR: text('/var/lib/plotinium/blobs'),
  BLOB_MAX_BYTES: int(134_217_728, 1, 2 ** 40),
  PLOTINIUM_SWAP_MAX_BYTES: int(1_073_741_824, 0, 2 ** 45),
  SWAP_PAGE_MAX_RAW_BYTES: int(16_777_216, 1, 67_108_864),
  LEASE_TTL_MS: int(30_000, 15_000, 120_000),
  FEED_RETENTION_DAYS: int(30, 1, 3650),
  SESSION_SLIDING_DAYS: int(10, 1, 365),
  SESSION_ABSOLUTE_DAYS: int(30, 1, 365),
  GUEST_SESSION_HOURS: int(2, 1, 72),
  GUEST_ENABLED: flag('1'),
  GUEST_MAX_ACTIVE: int(20, 0, 10_000),
  AUTH_PEPPER_FILE: optText(),
  ARGON2_MAX_CONCURRENCY: int(2, 1, 64),
  LOGIN_MAX_CONCURRENCY: int(4, 1, 256),
  AI: flag('1'),
  ANTHROPIC_API_KEY: optText(),
  ANTHROPIC_API_KEY_FILE: optText(),
  LLM_MODE: v.optional(v.picklist(['live', 'record', 'replay'])),
  LLM_RECORD_BUDGET_USD: v.optional(
    v.pipe(v.string(), v.trim(), v.regex(/^\d+(\.\d+)?$/), v.transform(Number)),
  ),
  LLM_PROVIDER: text('anthropic'),
  LLM_MODEL: text('claude-opus-5-5'),
  LLM_EFFORT: text('medium'),
  LLM_FALLBACK_MODEL: text('claude-opus-5'),
  LLM_TEMPERATURE: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.regex(/^\d+(\.\d+)?$/),
      v.transform(Number),
      v.minValue(0),
      v.maxValue(1),
    ),
  ),
  LLM_MAX_TOKENS: int(8000, 1, 128_000),
  LLM_TIMEOUT_MS: int(45_000, 1_000, 600_000),
  LLM_MAX_INFLIGHT: int(4, 1, 64),
  LLM_BUDGET_USD_MONTH: decimal(50, 0, 100_000),
  LLM_BUDGET_USD_TOTAL: decimal(250, 0, 100_000),
  LLM_USER_USD_DAY: decimal(2, 0, 10_000),
  LLM_DEMO_USD_DAY: decimal(3, 0, 10_000),
  LLM_DEMO_CALLS_DAY: int(20, 0, 1_000_000),
  LLM_EXAMINER_USD_DAY: decimal(15, 0, 10_000),
  LLM_EXAMINER_CALLS_DAY: int(100, 0, 1_000_000),
  LLM_UPSTREAM_URL: v.optional(v.pipe(v.string(), v.trim(), v.url('an absolute URL'))),
  LLM_UPSTREAM_TOKEN_FILE: optText(),
  LLM_UPSTREAM_ACCEPT_FILE: optText(),
  FAULT_INJECTION: flag('0'),
  TELEMETRY_RETENTION_DAYS: int(180, 1, 3650),
  PLOTINIUM_TZ: text('Asia/Karachi'),
  LOG_LEVEL: v.optional(
    v.picklist(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    'info',
  ),
  METRICS_HOST: text('127.0.0.1'),
  METRICS_PORT: int(9464, 1, 65535),
  SHUTDOWN_GRACE_MS: int(10_000, 100, 120_000),
  BUILD_VERSION: text('0.1.0'),
  BUILD_SHA: text('unknown'),
  BUILD_DATE: text('unknown'),
  PLOTINIUM_MIGRATIONS_DIR: optText(),
});

/** Reads a secret file. parseConfig removes ONE trailing newline; nothing else is trimmed. */
export type SecretReader = (path: string) => string;

const defaultReader: SecretReader = (path) => readFileSync(path, 'utf8');

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

const MIN_SECRET_BYTES = 32;

/**
 * Parses `env` into a frozen Config. Throws ConfigError on any problem (all problems at once).
 * `readSecret` is injectable so tests never touch the file system.
 */
export function parseConfig(
  env: Readonly<Record<string, string | undefined>>,
  readSecret: SecretReader = defaultReader,
): Config {
  const parsed = v.safeParse(EnvSchema, pickDefined(env), { abortPipeEarly: true });
  if (!parsed.success) {
    // Never echo the received value: it may be a secret (SRV-02).
    const problems = parsed.issues.map((issue) => {
      const name = v.getDotPath(issue) ?? 'environment';
      return `${name}: invalid${issue.expected ? ` (expected ${issue.expected})` : ''}`;
    });
    throw new ConfigError([...new Set(problems)]);
  }
  const e = parsed.output;
  const problems: string[] = [];
  const envName: PlotiniumEnv = e.PLOTINIUM_ENV;
  const production = envName === 'production';

  const secret = (fileVar: string, path: string | undefined): string | undefined => {
    if (path === undefined) return undefined;
    try {
      return readSecret(path).replace(/\r?\n$/, ''); // one trailing newline is not part of a secret
    } catch {
      problems.push(`${fileVar}: cannot read the file`);
      return undefined;
    }
  };
  const checkSecret = (name: string, value: string | undefined, required: boolean): void => {
    if (value === undefined) {
      if (required) problems.push(`${name}: required in production`);
      return;
    }
    if (production && Buffer.byteLength(value, 'utf8') < MIN_SECRET_BYTES) {
      problems.push(`${name}: shorter than ${MIN_SECRET_BYTES} bytes`);
    }
    if (production && KNOWN_DEV_VALUES.has(value)) {
      problems.push(`${name}: a known development value`);
    }
  };

  // Origins (SRV-06, SRV-07)
  const appOrigin = normaliseOrigin(e.APP_ORIGIN ?? `http://localhost:${e.PLOTINIUM_PORT}`);
  if (appOrigin === null) problems.push('APP_ORIGIN: must be an origin (scheme, host, port only)');
  const allowedOrigins: string[] = [];
  for (const o of e.ALLOWED_ORIGINS) {
    const n = normaliseOrigin(o);
    if (n === null) problems.push('ALLOWED_ORIGINS: every entry must be an origin');
    else allowedOrigins.push(n);
  }

  // Database
  const dbPassword = secret('DATABASE_PASSWORD_FILE', e.DATABASE_PASSWORD_FILE);
  let database: DatabaseConfig | null = null;
  if (e.DATABASE_URL !== undefined) {
    database = {
      url: e.DATABASE_URL,
      password: dbPassword,
      poolMax: e.DB_POOL_MAX,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: e.DB_LOCK_TIMEOUT_MS,
    };
  }

  // LLM
  const inlineKey = e.ANTHROPIC_API_KEY;
  const fileKey = secret('ANTHROPIC_API_KEY_FILE', e.ANTHROPIC_API_KEY_FILE);
  const apiKey = fileKey ?? inlineKey;
  const llmMode: LlmMode = e.LLM_MODE ?? (envName === 'ci' ? 'replay' : 'live');
  const upstreamToken = secret('LLM_UPSTREAM_TOKEN_FILE', e.LLM_UPSTREAM_TOKEN_FILE);
  const upstreamAccept = secret('LLM_UPSTREAM_ACCEPT_FILE', e.LLM_UPSTREAM_ACCEPT_FILE);
  const pepper = secret('AUTH_PEPPER_FILE', e.AUTH_PEPPER_FILE);

  // Always-on rules
  if (e.SESSION_SLIDING_DAYS > e.SESSION_ABSOLUTE_DAYS) {
    problems.push('SESSION_SLIDING_DAYS: must not exceed SESSION_ABSOLUTE_DAYS');
  }
  if (llmMode === 'record' && e.LLM_RECORD_BUDGET_USD === undefined) {
    problems.push('LLM_RECORD_BUDGET_USD: required with LLM_MODE=record');
  }
  if (envName === 'ci' && llmMode !== 'replay') {
    problems.push('LLM_MODE: ci accepts only replay (spec §12.6: CI uses recorded responses)');
  }
  if (pepper !== undefined && Buffer.byteLength(pepper, 'utf8') < MIN_SECRET_BYTES) {
    problems.push(`AUTH_PEPPER_FILE: shorter than ${MIN_SECRET_BYTES} bytes`);
  }

  // Production guards (backend-api.md §3.4, SRV-02, SRV-14; C7, C10)
  if (production) {
    if (appOrigin !== null && !appOrigin.startsWith('https://')) {
      problems.push('APP_ORIGIN: must be https:// in production');
    }
    if (allowedOrigins.length > 0) problems.push('ALLOWED_ORIGINS: must be empty in production');
    if (e.FAULT_INJECTION) {
      problems.push('FAULT_INJECTION: must be 0 in production (the fault harness never ships)');
    }
    if (llmMode !== 'live') problems.push('LLM_MODE: must be live in production');
    if (database === null) problems.push('DATABASE_URL: required');
    else if (urlHasPassword(database.url)) {
      problems.push('DATABASE_URL: must not contain a password in production');
    }
    if (inlineKey !== undefined) {
      problems.push('ANTHROPIC_API_KEY: must be given as ANTHROPIC_API_KEY_FILE in production');
    }
    checkSecret('DATABASE_PASSWORD_FILE', dbPassword, true);
    checkSecret('ANTHROPIC_API_KEY_FILE', fileKey, false);
    checkSecret('AUTH_PEPPER_FILE', pepper, false);
    checkSecret('LLM_UPSTREAM_TOKEN_FILE', upstreamToken, false);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const config: Config = {
    env: envName,
    host: e.HOST,
    port: e.PORT,
    plotiniumPort: e.PLOTINIUM_PORT,
    appOrigin: appOrigin ?? '',
    allowedOrigins,
    trustProxyCidrs: e.TRUST_PROXY_CIDRS,
    database,
    blobDir: e.BLOB_DIR,
    blobMaxBytes: e.BLOB_MAX_BYTES,
    swapMaxBytes: e.PLOTINIUM_SWAP_MAX_BYTES,
    swapPageMaxRawBytes: e.SWAP_PAGE_MAX_RAW_BYTES,
    leaseTtlMs: e.LEASE_TTL_MS,
    heartbeatMs: Math.floor(e.LEASE_TTL_MS / 3),
    feedRetentionDays: e.FEED_RETENTION_DAYS,
    session: {
      slidingDays: e.SESSION_SLIDING_DAYS,
      absoluteDays: e.SESSION_ABSOLUTE_DAYS,
      guestHours: e.GUEST_SESSION_HOURS,
    },
    guest: { enabled: e.GUEST_ENABLED, maxActive: e.GUEST_MAX_ACTIVE },
    authPepper: pepper,
    argon2MaxConcurrency: e.ARGON2_MAX_CONCURRENCY,
    loginMaxConcurrency: e.LOGIN_MAX_CONCURRENCY,
    ai: e.AI,
    llm: {
      mode: llmMode,
      provider: e.LLM_PROVIDER,
      model: e.LLM_MODEL,
      effort: e.LLM_EFFORT,
      fallbackModel: e.LLM_FALLBACK_MODEL,
      temperature: e.LLM_TEMPERATURE,
      maxTokens: e.LLM_MAX_TOKENS,
      timeoutMs: e.LLM_TIMEOUT_MS,
      maxInflight: e.LLM_MAX_INFLIGHT,
      apiKey,
      recordBudgetUsd: e.LLM_RECORD_BUDGET_USD,
      budget: {
        monthUsd: e.LLM_BUDGET_USD_MONTH,
        totalUsd: e.LLM_BUDGET_USD_TOTAL,
        userUsdDay: e.LLM_USER_USD_DAY,
        demoUsdDay: e.LLM_DEMO_USD_DAY,
        demoCallsDay: e.LLM_DEMO_CALLS_DAY,
        examinerUsdDay: e.LLM_EXAMINER_USD_DAY,
        examinerCallsDay: e.LLM_EXAMINER_CALLS_DAY,
      },
      upstreamUrl: e.LLM_UPSTREAM_URL,
      upstreamToken,
      upstreamAcceptHashes: (upstreamAccept ?? '')
        .split(/\r?\n/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[0-9a-f]{64}$/.test(s)),
    },
    faultInjection: e.FAULT_INJECTION,
    telemetryRetentionDays: e.TELEMETRY_RETENTION_DAYS,
    timeZone: e.PLOTINIUM_TZ,
    logLevel: e.LOG_LEVEL,
    metrics: { host: e.METRICS_HOST, port: e.METRICS_PORT },
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    build: { version: e.BUILD_VERSION, sha: e.BUILD_SHA, date: e.BUILD_DATE },
    migrationsDir: e.PLOTINIUM_MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR,
  };
  return deepFreeze(config);
}

/** The cookie name for this origin: `__Host-` needs a secure (https) origin (C10). */
export function sessionCookieName(config: Pick<Config, 'appOrigin'>): string {
  return config.appOrigin.startsWith('https://') ? '__Host-plt_sid' : 'plt_sid';
}

/** Every origin accepted for CSRF and WebSocket upgrade checks (exact match, SRV-06/07). */
export function originAllowlist(config: Pick<Config, 'appOrigin' | 'allowedOrigins'>): Set<string> {
  return new Set([config.appOrigin, ...config.allowedOrigins]);
}

function normaliseOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username || u.password) {
      return null;
    }
    return u.origin;
  } catch {
    return null;
  }
}

function urlHasPassword(url: string): boolean {
  try {
    return new URL(url).password !== '';
  } catch {
    return false;
  }
}

function pickDefined(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(EnvSchema.entries)) {
    const value = env[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
