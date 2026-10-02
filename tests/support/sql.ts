/**
 * A minimal PostgreSQL client for the integration and fault-injection suites (spec §3.2
 * `integration` project, TST-23: the Compose `db` service, no Testcontainers).
 *
 * tests/ is not a workspace package and the workspace does not hoist, so `pg` is not resolvable
 * from here. It is loaded from the server package, which declares it, and typed with the small
 * interface below. TODO(R5): when tests/ becomes a workspace package (or pg is a root
 * devDependency), import pg directly and delete the createRequire indirection.
 */
import { createRequire } from 'node:module';

export interface QueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface PoolClient extends Queryable {
  release(err?: Error | boolean): void;
}

export interface Pool extends Queryable {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

export interface PgError extends Error {
  code?: string;
  hint?: string;
  detail?: string;
  constraint?: string;
}

interface PgModule {
  Pool: new (config: { connectionString: string; max?: number; application_name?: string }) => Pool;
}

let pg: PgModule | undefined;

export function loadPg(): PgModule {
  if (pg === undefined) {
    const require = createRequire(new URL('../../server/package.json', import.meta.url));
    pg = require('pg') as PgModule;
  }
  return pg;
}

export function openPool(connectionString: string, max = 4): Pool {
  const { Pool } = loadPg();
  return new Pool({ connectionString, max, application_name: 'plotinium-tests' });
}

export function isPgError(err: unknown): err is PgError {
  return err instanceof Error && typeof (err as PgError).code === 'string';
}

/** The same server with another database name in the URL. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.href;
}

/** Double-quoted SQL identifier for names built by the harness (never user input). */
export function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new RangeError(`unsafe identifier ${name}`);
  return `"${name}"`;
}

/** Runs `fn` in one transaction on one connection; rolls back on any error and rethrows it. */
export async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
