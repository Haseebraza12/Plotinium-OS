/**
 * Global setup of the `integration` project (spec §3.2): waits for the Compose database and builds
 * the `plotinium_template` database from db/migrations once per migration set. Without
 * DATABASE_URL it does nothing and the database suites skip themselves.
 */
import { readMigrations, ensureTemplate } from '../support/db-template.ts';
import { databaseUrl } from '../support/env.ts';
import { openPool } from '../support/sql.ts';

const WAIT_MS = 60_000;

async function waitForDatabase(url: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  let last: unknown;
  while (Date.now() < deadline) {
    const pool = openPool(url, 1);
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      await pool.end();
    }
  }
  throw new Error(`database not reachable within ${WAIT_MS} ms: ${String(last)}`);
}

export default async function setup(): Promise<void> {
  const url = databaseUrl();
  if (url === undefined) return;
  await waitForDatabase(url);
  const state = await ensureTemplate(url, await readMigrations());
  process.stdout.write(`integration: template database ${state}\n`);
}
