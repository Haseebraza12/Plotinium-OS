/**
 * The database client: one node-postgres Pool and one Kysely instance on top of it.
 *
 * Spec: specs/09-database/database.md §3.26 and §4.10 (C8: Kysely 0.29.6 on pg, kysely-codegen
 * types, Kysely is the query builder only; its Migrator is never used).
 * Primary owner R2, secondary reviewer R5.
 *
 * Type parsers are set PER POOL (the `types` option), not with the global pg.types registry, so
 * tests and tools that load pg for other purposes are not affected:
 *   int8 (OID 20)  -> number, guarded by Number.isSafeInteger (RangeError -> EIO). Never BigInt:
 *                     results cross the WebSocket as JSON and JSON.stringify throws on BigInt.
 *   date (OID 1082) -> the raw 'YYYY-MM-DD' string (no local-midnight shift of budget periods).
 *   everything else -> pg's defaults (timestamptz -> Date, uuid -> string, bytea -> Buffer,
 *                     jsonb -> parsed objects).
 * A jsonb parameter that is an ARRAY must be passed as JSON.stringify(value) with a ::jsonb cast
 * (node-postgres turns JS arrays into PostgreSQL arrays).
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { DatabaseConfig } from '../config.ts';
import type { DB } from './types.gen.ts';

const INT8_OID = 20;
const DATE_OID = 1082;

export function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new RangeError(`int8 outside the safe integer range: ${value}`);
  return n;
}

export function parseDate(value: string): string {
  return value;
}

type GetTypeParser = pg.CustomTypesConfig['getTypeParser'];

function getTypeParser(oid: number, format?: 'text' | 'binary'): unknown {
  if (format !== 'binary') {
    if (oid === INT8_OID) return parseInt8;
    if (oid === DATE_OID) return parseDate;
  }
  return format === 'binary' ? pg.types.getTypeParser(oid, 'binary') : pg.types.getTypeParser(oid);
}

/**
 * The connection string with the password from DATABASE_PASSWORD_FILE filled in. pg lets the
 * fields parsed from connectionString override explicit options (a URL without a password would
 * blank a separate `password` option), so the password travels inside the URL, in memory only.
 */
export function withPassword(url: string, password: string | undefined): string {
  if (password === undefined) return url;
  const u = new URL(url);
  u.password = encodeURIComponent(password);
  return u.toString();
}

/** The per-pool type configuration (exported for tests and tools). */
export const PG_TYPES: pg.CustomTypesConfig = {
  getTypeParser: getTypeParser as GetTypeParser,
};

export interface Database {
  readonly pool: pg.Pool;
  readonly db: Kysely<DB>;
  /** Ends the pool; idempotent. */
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  /** Shown in pg_stat_activity; default 'plotinium-app'. */
  readonly applicationName?: string;
  /** Receives errors of idle pooled clients (for example a server restart). */
  readonly onIdleError?: (err: Error) => void;
}

/**
 * Creates the pool (max DB_POOL_MAX, idle 30 s, connect timeout 5 s) and the Kysely instance.
 * Only transaction-scoped advisory locks are used anywhere, so PgBouncer in transaction mode
 * stays possible (a reversal target).
 */
export function createDatabase(
  config: DatabaseConfig,
  options: CreateDatabaseOptions = {},
): Database {
  const pool = new pg.Pool({
    connectionString: withPassword(config.url, config.password),
    max: config.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: options.applicationName ?? 'plotinium-app',
    types: PG_TYPES,
  });
  pool.on('error', (err) => {
    options.onIdleError?.(err);
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  let closed: Promise<void> | undefined;
  return {
    pool,
    db,
    close() {
      closed ??= db.destroy();
      return closed;
    },
  };
}
