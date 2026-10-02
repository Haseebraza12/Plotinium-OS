/**
 * Database self-tests at startup (SRV-17; backend-api.md §3.18.2):
 *   server_version_num is 18.x; extension vector is 0.8.6; the database's locale provider is
 *   builtin (C7); the newest applied migration is at least the build's newest; clock skew between
 *   clock_timestamp() and the process clock (a warning above 2 s: leases use only the database
 *   clock, so skew affects logs only).
 * A NEWER applied migration than the build's passes with a warning: every production migration is
 * expand-only (deployment-and-ci.md D-6), so the previous release runs on the newer schema during
 * a rollback (quality-devops cross-spec request relaxing SRV-17).
 */
import { readdirSync } from 'node:fs';

import { sql } from 'kysely';

import type { Database } from '../db/client.ts';
import { SelfTestError } from './kat.ts';

export interface DbCheckResult {
  readonly serverVersionNum: number;
  readonly vectorVersion: string;
  readonly localeProvider: string;
  readonly appliedMigration: string | null;
  readonly expectedMigration: string | null;
  readonly clockSkewMs: number;
  readonly warnings: readonly string[];
}

/** The newest `YYYYMMDDHHMMSS` prefix among `*.sql` files of a dbmate migrations directory. */
export function newestMigrationIn(dir: string): string | null {
  let newest: string | null = null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const m = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(name);
    if (m?.[1] !== undefined && (newest === null || m[1] > newest)) newest = m[1];
  }
  return newest;
}

export async function runDbChecks(
  database: Database,
  expectedMigration: string | null,
): Promise<DbCheckResult> {
  const r = await sql<{
    server_version_num: string;
    vector: string | null;
    provider: string | null;
    applied: string | null;
    skew_ms: number;
  }>`
    SELECT current_setting('server_version_num') AS server_version_num,
           (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector,
           (SELECT datlocprovider::text FROM pg_database WHERE datname = current_database()) AS provider,
           (SELECT max(version) FROM schema_migrations) AS applied,
           (extract(epoch FROM clock_timestamp()) * 1000)::float8 - ${Date.now()}::float8 AS skew_ms`.execute(
    database.db,
  );
  const row = r.rows[0];
  if (row === undefined) throw new SelfTestError('db-checks', 'no row');
  const version = Number(row.server_version_num);
  if (Math.floor(version / 10_000) !== 18) {
    throw new SelfTestError(
      'db-checks',
      `PostgreSQL 18 required, found server_version_num ${version}`,
    );
  }
  if (row.vector !== '0.8.6') {
    throw new SelfTestError(
      'db-checks',
      `extension vector 0.8.6 required, found ${row.vector ?? 'none'}`,
    );
  }
  if (row.provider !== 'b') {
    throw new SelfTestError(
      'db-checks',
      'the database must use the builtin locale provider (initdb --locale-provider=builtin)',
    );
  }
  const warnings: string[] = [];
  if (expectedMigration !== null) {
    if (row.applied === null || row.applied < expectedMigration) {
      throw new SelfTestError(
        'db-checks',
        `migrations behind the build: applied ${row.applied ?? 'none'}, expected ${expectedMigration}`,
      );
    }
    if (row.applied > expectedMigration) {
      warnings.push(
        `database schema ${row.applied} is newer than this build (${expectedMigration}); running on expand-only migrations`,
      );
    }
  }
  const skew = Math.round(Number(row.skew_ms));
  if (Math.abs(skew) > 2_000) warnings.push(`clock skew between app and database is ${skew} ms`);
  return {
    serverVersionNum: version,
    vectorVersion: row.vector,
    localeProvider: row.provider,
    appliedMigration: row.applied,
    expectedMigration,
    clockSkewMs: skew,
    warnings,
  };
}
