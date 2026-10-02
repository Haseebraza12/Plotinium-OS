/**
 * One scratch database per DB-gated test FILE, cloned from the database DATABASE_URL names
 * (testing-and-performance.md TST-23: "each test file gets its own database cloned from the
 * template").
 *
 * Why: Vitest runs test files in parallel, and several server suites assert properties of the
 * WHOLE database (the integrity probes, a subtree checksum, the lease sweeper's DELETE of every
 * due row). Sharing one database, each file saw the others' half-built fixtures and failed,
 * although every file passed alone. Cloning keeps the suites independent and lets them run in
 * parallel.
 *
 *   const URL_ = await scratchDatabaseUrl('sync');   // top level of the test file
 *
 * DATABASE_URL must name a freshly migrated database that NOTHING is connected to (for example
 * `plotinium_test`; server/src/db/db.int.test.ts has the recipe). It is used only as the
 * `CREATE DATABASE … TEMPLATE` source and is never written. The clone is dropped (WITH FORCE)
 * after the file's last hook. When the template is busy (PostgreSQL 55006, someone is connected,
 * for example a running app container on `plotinium`), the file falls back to DATABASE_URL itself
 * and says so, which is the old shared-database behaviour.
 *
 * Without DATABASE_URL it returns undefined and the DB-gated suites skip, as before.
 */
import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll } from 'vitest';

/** Cluster-wide serialisation of the clones (they all run from the maintenance database). */
const CLONE_LOCK = 0x706c7431; // 'plt1'
const BUSY_RETRIES = 20;
const BUSY_WAIT_MS = 150;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function maintenanceUrl(url: URL): string {
  const m = new URL(url.toString());
  m.pathname = '/postgres';
  return m.toString();
}

async function withMaintenance<T>(url: URL, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: maintenanceUrl(url) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function isObjectInUse(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '55006';
}

/**
 * The URL of a fresh clone of DATABASE_URL's database for the calling test file, or undefined
 * when DATABASE_URL is unset. Registers a file-level afterAll that drops the clone.
 */
export async function scratchDatabaseUrl(label: string): Promise<string | undefined> {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined || raw === '') return undefined;
  const base = new URL(raw);
  const template = decodeURIComponent(base.pathname.replace(/^\//, ''));
  const safeLabel = label
    .replace(/[^a-z0-9_]/gi, '_')
    .toLowerCase()
    .slice(0, 16);
  const name = `${template.slice(0, 24)}_${safeLabel}_${randomBytes(4).toString('hex')}`;

  try {
    await withMaintenance(base, async (client) => {
      await client.query('SELECT pg_advisory_lock($1)', [CLONE_LOCK]);
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await client.query(
              `CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(template)}`,
            );
            return true;
          } catch (e) {
            if (!isObjectInUse(e) || attempt >= BUSY_RETRIES) throw e;
            await new Promise((r) => setTimeout(r, BUSY_WAIT_MS));
          }
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [CLONE_LOCK]);
      }
    });
  } catch (e) {
    if (!isObjectInUse(e)) throw e;
    process.stderr.write(
      `[scratch-db] ${template} is in use; ${label} shares it (parallel files may interfere)\n`,
    );
    return raw;
  }

  afterAll(async () => {
    await withMaintenance(base, (client) =>
      client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`),
    );
  });
  const url = new URL(raw);
  url.pathname = `/${encodeURIComponent(name)}`;
  return url.toString();
}

/**
 * TEST_APP_DATABASE_URL (the run-time role plotinium_app) pointed at the same clone as
 * `ownerUrl`, or undefined when either is unset. Suites use it to run the server with the
 * production grants while fixtures are written as the owner.
 */
export function appRoleUrl(ownerUrl: string | undefined): string | undefined {
  const app = process.env['TEST_APP_DATABASE_URL'];
  if (app === undefined || app === '' || ownerUrl === undefined) return undefined;
  const url = new URL(app);
  url.pathname = new URL(ownerUrl).pathname;
  return url.toString();
}
