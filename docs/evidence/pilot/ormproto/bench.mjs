// Per-query overhead: same Q1/Q2 through raw drivers, Kysely and Drizzle. p50/p95 over 1,000 runs after 100 warm-up.
import pg from 'pg';
import postgres from 'postgres';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, bigint, text, integer, smallint, timestamp } from 'drizzle-orm/pg-core';
import { eq, asc, sql as dsql } from 'drizzle-orm';

const url = 'postgres://postgres:proto@127.0.0.1:55433/vfs';
const PARTS = ['home', 'user1', 'a', 'b', 'c', 'd', 'e', 'f'];
const BIG = Number(process.env.BIG ?? 99559);
const Q1 = `WITH RECURSIVE walk(depth, ino) AS (
  SELECT 0, 1::bigint
  UNION ALL
  SELECT w.depth + 1, d.ino FROM walk w
  JOIN dentries d ON d.parent_ino = w.ino AND d.name = ($1::text[])[w.depth + 1]
  WHERE w.depth < cardinality($1::text[]))
SELECT w.depth, i.ino, i.type, i.mode, i.uid FROM walk w JOIN inodes i ON i.ino = w.ino ORDER BY w.depth`;
const Q2 = `SELECT d.name, i.ino, i.type, i.mode, i.size, i.modified_at FROM dentries d JOIN inodes i ON i.ino = d.ino WHERE d.parent_ino = $1 ORDER BY d.name`;

async function bench(label, fn, check) {
  for (let i = 0; i < 100; i++) await fn();
  const r = await fn(); if (check) check(r);
  const t = [];
  for (let i = 0; i < 1000; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  const pct = (p) => t[Math.min(t.length - 1, Math.ceil(p / 100 * t.length) - 1)].toFixed(3);
  console.log(`${label.padEnd(34)} p50=${pct(50)} ms  p95=${pct(95)} ms  p99=${pct(99)} ms`);
}
const q1ok = (rows) => { if (rows.length !== 9) throw new Error('Q1 expected 9 rows, got ' + rows.length); };
const q2ok = (rows) => { if (rows.length !== 500) throw new Error('Q2 expected 500 rows, got ' + rows.length); };

// raw pg
const pool = new pg.Pool({ connectionString: url, max: 4 });
await bench('Q1 raw pg (unnamed)', async () => (await pool.query(Q1, [PARTS])).rows, q1ok);
await bench('Q1 raw pg (named prepared)', async () => (await pool.query({ name: 'q1', text: Q1, values: [PARTS] })).rows, q1ok);
// postgres.js
const pjs = postgres(url, { max: 4 });
await bench('Q1 postgres.js (auto-prepared)', async () => await pjs.unsafe(Q1, [PARTS], { prepare: true }), q1ok);
// Kysely + pg, typed builder incl. WITH RECURSIVE
const kdb = new Kysely({ dialect: new PostgresDialect({ pool }) });
const kQ1 = (db) => db.withRecursive('walk(depth, ino)', (qb) =>
    qb.selectNoFrom([sql`0`.as('depth'), sql`1::bigint`.as('ino')])
      .unionAll(qb.selectFrom('walk as w')
        .innerJoin('dentries as d', (j) => j.onRef('d.parent_ino', '=', 'w.ino').on('d.name', '=', sql`(${PARTS}::text[])[w.depth + 1]`))
        .select([sql`w.depth + 1`.as('depth'), 'd.ino'])
        .where('w.depth', '<', PARTS.length)))
  .selectFrom('walk as w').innerJoin('inodes as i', 'i.ino', 'w.ino')
  .select(['w.depth', 'i.ino', 'i.type', 'i.mode', 'i.uid']).orderBy('w.depth').execute();
await bench('Q1 Kysely + pg (withRecursive)', () => kQ1(kdb), q1ok);
const kdbJs = new Kysely({ dialect: new PostgresJSDialect({ postgres: postgres(url, { max: 4 }) }) });
await bench('Q1 Kysely + postgres.js', () => kQ1(kdbJs), q1ok);
// Drizzle (no WITH RECURSIVE builder -> raw sql escape hatch)
const ddb = drizzle(pool);
await bench('Q1 Drizzle + pg (sql`` escape hatch)', async () => (await ddb.execute(dsql`WITH RECURSIVE walk(depth, ino) AS (SELECT 0, 1::bigint UNION ALL SELECT w.depth + 1, d.ino FROM walk w JOIN dentries d ON d.parent_ino = w.ino AND d.name = (${dsql.param(PARTS)}::text[])[w.depth + 1] WHERE w.depth < ${PARTS.length}) SELECT w.depth, i.ino, i.type, i.mode, i.uid FROM walk w JOIN inodes i ON i.ino = w.ino ORDER BY w.depth`)).rows, q1ok);

// Q2
await bench('Q2 raw pg (unnamed)', async () => (await pool.query(Q2, [BIG])).rows, q2ok);
await bench('Q2 postgres.js', async () => await pjs.unsafe(Q2, [BIG], { prepare: true }), q2ok);
await bench('Q2 Kysely + pg', () => kdb.selectFrom('dentries as d').innerJoin('inodes as i', 'i.ino', 'd.ino')
  .select(['d.name', 'i.ino', 'i.type', 'i.mode', 'i.size', 'i.modified_at']).where('d.parent_ino', '=', BIG).orderBy('d.name').execute(), q2ok);
await bench('Q2 Kysely + postgres.js', () => kdbJs.selectFrom('dentries as d').innerJoin('inodes as i', 'i.ino', 'd.ino')
  .select(['d.name', 'i.ino', 'i.type', 'i.mode', 'i.size', 'i.modified_at']).where('d.parent_ino', '=', BIG).orderBy('d.name').execute(), q2ok);
const inodesT = pgTable('inodes', { ino: bigint('ino', { mode: 'number' }).primaryKey(), type: text('type'), mode: smallint('mode'), uid: integer('uid'), size: bigint('size', { mode: 'number' }), modified_at: timestamp('modified_at', { withTimezone: true }) });
const dentriesT = pgTable('dentries', { parent_ino: bigint('parent_ino', { mode: 'number' }), name: text('name'), ino: bigint('ino', { mode: 'number' }) });
await bench('Q2 Drizzle + pg', () => ddb.select({ name: dentriesT.name, ino: inodesT.ino, type: inodesT.type, mode: inodesT.mode, size: inodesT.size, modified_at: inodesT.modified_at })
  .from(dentriesT).innerJoin(inodesT, eq(inodesT.ino, dentriesT.ino)).where(eq(dentriesT.parent_ino, BIG)).orderBy(asc(dentriesT.name)), q2ok);

// server-side execution time (EXPLAIN ANALYZE) for reference
for (const [n, q, v] of [['Q1', Q1, [PARTS]], ['Q2', Q2, [BIG]]]) {
  const plan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q}`, v)).rows[0]['QUERY PLAN'][0];
  console.log(`${n} server Execution Time=${plan['Execution Time']} ms  Planning Time=${plan['Planning Time']} ms  top node=${plan.Plan['Node Type']}`);
}
// Kysely compile-only cost (no DB): how much time the builder itself adds
{ const t0 = performance.now(); for (let i = 0; i < 10000; i++) kdb.selectFrom('dentries as d').innerJoin('inodes as i', 'i.ino', 'd.ino').select(['d.name', 'i.ino']).where('d.parent_ino', '=', BIG).orderBy('d.name').compile();
  console.log(`Kysely compile-only: ${((performance.now() - t0) / 10000 * 1000).toFixed(1)} us/query`); }
await pool.end(); await pjs.end(); await kdbJs.destroy();
