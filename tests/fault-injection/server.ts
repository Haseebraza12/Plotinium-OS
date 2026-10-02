/**
 * The server half of the oracle (spec §3.6.5; TST-09): reads the tree, blob and quota rows with
 * SQL and runs db/probes/integrity.sql, then hands the rows to the shared `takeSnapshot`, so the
 * client and the server are judged by the same code.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { INO } from '../../protocol/src/wellknown.ts';
import {
  takeSnapshot,
  type InodeType,
  type OracleSnapshot,
  type StoreRows,
} from '../support/oracle.ts';
import type { Pool } from '../support/sql.ts';

export const PROBES_PATH = fileURLToPath(new URL('../../db/probes/integrity.sql', import.meta.url));

/**
 * db/probes/integrity.sql is a psql script (`\if`, `\set`, `:'root'`). This turns it into one
 * plain statement for a driver: meta-commands and the BEGIN/COMMIT lines go (the caller opens the
 * read-only snapshot transaction itself) and the root variable is bound as a literal.
 */
export function probeStatement(script: string, root: string = INO.ROOT): string {
  if (!/^[0-9a-f-]{36}$/.test(root)) throw new RangeError(`not a uuid: ${root}`);
  return script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('\\') && !/^\s*(BEGIN|COMMIT)\b/i.test(line))
    .join('\n')
    .replaceAll(":'root'", `'${root}'`)
    .trim()
    .replace(/;\s*$/, '');
}

export interface ProbeRow {
  probe: string;
  detail: string;
}

export async function runProbes(pool: Pool, root: string = INO.ROOT): Promise<ProbeRow[]> {
  const sql = probeStatement(readFileSync(PROBES_PATH, 'utf8'), root);
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const res = await c.query<ProbeRow>(sql);
    await c.query('COMMIT');
    return res.rows;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Every row the oracle needs, in one repeatable-read snapshot. */
export async function readStoreRows(pool: Pool, subtreeRoot: string): Promise<StoreRows> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const inodes = await c.query<{
      ino: string;
      type: InodeType;
      mode: number;
      uid: number;
      gid: number;
      size: number;
      nlink: number;
      version: number;
      blob: string | null;
    }>(
      `SELECT ino::text, type, mode::int, uid, gid, size::float8 AS size, nlink, version::float8 AS version, blob_id::text AS blob FROM inodes`,
    );
    const dentries = await c.query<{ parent: string; name: string; ino: string; dType: InodeType }>(
      `SELECT parent_ino::text AS parent, name, ino::text, d_type AS "dType" FROM dentries`,
    );
    const blobs = await c.query<{ blob: string; refcount: number }>(
      `SELECT blob_id::text AS blob, refcount FROM blobs`,
    );
    const quota = await c.query<{ uid: number; usedBytes: number; usedInodes: number }>(
      `SELECT uid, used_bytes::float8 AS "usedBytes", used_inodes::float8 AS "usedInodes" FROM users`,
    );
    const outbox = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM op_log`);
    await c.query('COMMIT');
    return {
      subtreeRoot,
      fsRoot: INO.ROOT,
      inodes: inodes.rows,
      dentries: dentries.rows,
      blobs: blobs.rows,
      quota: quota.rows,
      outboxLen: outbox.rows[0]?.n ?? 0,
      undoLen: 0,
      fsckClean: true,
    };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** `probes.server(sql)` of spec §3.3: the snapshot plus the integrity probes as `fsckClean`. */
export async function serverSnapshot(
  pool: Pool,
  subtreeRoot: string,
): Promise<OracleSnapshot & { probes: ProbeRow[] }> {
  const rows = await readStoreRows(pool, subtreeRoot);
  const probes = await runProbes(pool);
  return { ...takeSnapshot({ ...rows, fsckClean: probes.length === 0 }), probes };
}
