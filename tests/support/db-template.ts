/**
 * The integration template database (spec §3.2 `integration`): the global setup applies every
 * dbmate migration's `up` section to `plotinium_template` once; each test file then creates its
 * own `t_<hash>` database from it and drops it afterwards, so files never share state.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoRelative } from './storage-names.ts';
import { ident, openPool, withDatabase, type Pool } from './sql.ts';

export const TEMPLATE_DB = 'plotinium_template';
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

export interface Migration {
  version: string;
  file: string;
  up: string;
}

/** The `-- migrate:up` section of a dbmate file (up to `-- migrate:down` or the end). */
export function upSection(sql: string, file = 'migration'): string {
  const lines = sql.split('\n');
  const start = lines.findIndex((l) => /^--\s*migrate:up\b/.test(l));
  if (start < 0) throw new Error(`${file} has no -- migrate:up marker`);
  const end = lines.findIndex((l, i) => i > start && /^--\s*migrate:down\b/.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

export async function readMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((n) => /^\d{14}_[a-z0-9_]+\.sql$/.test(n)).sort();
  return Promise.all(
    names.map(async (file) => ({
      version: file.slice(0, 14),
      file,
      up: upSection(await readFile(join(dir, file), 'utf8'), file),
    })),
  );
}

/** Changes whenever a migration changes, so a stale template is rebuilt. */
export function fingerprint(migrations: readonly Migration[]): string {
  const h = createHash('sha256');
  for (const m of migrations) h.update(`${m.file}\n${m.up}\n`);
  return h.digest('hex').slice(0, 16);
}

/** `t_<sha1(repo-relative path)[0..12]>`: one database per test file. */
export function testDatabaseName(fileUrl: string): string {
  return `t_${createHash('sha1').update(repoRelative(fileUrl)).digest('hex').slice(0, 12)}`;
}

/** Builds (or keeps, when its fingerprint matches) the template database. */
export async function ensureTemplate(
  adminUrl: string,
  migrations: readonly Migration[],
): Promise<'kept' | 'built'> {
  const fp = fingerprint(migrations);
  const admin = openPool(adminUrl, 1);
  try {
    const existing = await admin.query<{ comment: string | null }>(
      `SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1`,
      [TEMPLATE_DB],
    );
    if (existing.rows[0]?.comment === `migrations:${fp}`) return 'kept';
    await admin.query(`DROP DATABASE IF EXISTS ${ident(TEMPLATE_DB)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${ident(TEMPLATE_DB)}`);
    // The app role is cluster-wide and normally made by the db image's init hook (database.md §4.1).
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plotinium_app') THEN CREATE ROLE plotinium_app NOLOGIN; END IF; END $$`,
    );
    const tpl = openPool(withDatabase(adminUrl, TEMPLATE_DB), 1);
    try {
      await tpl.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (version varchar(128) PRIMARY KEY)',
      );
      for (const m of migrations) {
        await tpl.query(m.up);
        await tpl.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
      }
    } finally {
      await tpl.end();
    }
    await admin.query(`COMMENT ON DATABASE ${ident(TEMPLATE_DB)} IS 'migrations:${fp}'`);
    return 'built';
  } finally {
    await admin.end();
  }
}

export interface TestDatabase {
  name: string;
  url: string;
  pool: Pool;
  drop(): Promise<void>;
}

export async function createTestDatabase(adminUrl: string, fileUrl: string): Promise<TestDatabase> {
  const name = testDatabaseName(fileUrl);
  const admin = openPool(adminUrl, 1);
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${ident(name)} TEMPLATE ${ident(TEMPLATE_DB)}`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(adminUrl, name);
  const pool = openPool(url, 10);
  return {
    name,
    url,
    pool,
    drop: async () => {
      await pool.end();
      const a = openPool(adminUrl, 1);
      try {
        await a.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
