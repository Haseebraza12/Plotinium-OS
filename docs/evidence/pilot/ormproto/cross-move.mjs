// DB-03 probe: two clients move overlapping subtrees at the same time (A: X -> Y/, B: Y -> X/).
// Runs the interleaving under READ COMMITTED (no extra locks) and SERIALIZABLE, then with the retry wrapper.
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
const url = 'postgres://postgres:proto@127.0.0.1:55433/vfs';
const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 8 }) }) });
const HOME2 = (await sql`SELECT d.ino FROM dentries d WHERE d.parent_ino = (SELECT ino FROM dentries WHERE parent_ino=1 AND name='home') AND d.name='user2'`.execute(db)).rows[0].ino;
let nextIno = Number((await sql`SELECT max(ino) m FROM inodes`.execute(db)).rows[0].m) + 1;

async function fresh() { // two sibling dirs X and Y under /home/user2
  const x = nextIno++, y = nextIno++;
  await db.insertInto('inodes').values([{ ino: x, type: 'dir', mode: 0o755, uid: 2 }, { ino: y, type: 'dir', mode: 0o755, uid: 2 }]).execute();
  await db.insertInto('dentries').values([{ parent_ino: HOME2, name: `X${x}`, ino: x }, { parent_ino: HOME2, name: `Y${y}`, ino: y }]).execute();
  return { x, y };
}
// ancestors of `ino` walking UP via dentries(ino) index; UNION (not UNION ALL) guarantees termination even on a corrupted cycle
const isAncestorOrSelf = async (trx, candidate, ino) => candidate === ino || !!(await trx.withRecursive('anc(ino)', (qb) =>
    qb.selectFrom('dentries').select('parent_ino as ino').where('ino', '=', ino)
      .union(qb.selectFrom('dentries as d').innerJoin('anc', 'anc.ino', 'd.ino').select('d.parent_ino as ino')))
  .selectFrom('anc').select('ino').where('ino', '=', candidate).executeTakeFirst());

async function moveSteps(trx, srcIno, srcName, dstIno) {
  if (await isAncestorOrSelf(trx, srcIno, dstIno)) throw Object.assign(new Error('EINVAL'), { errno: 'EINVAL' });
  return async () => { await trx.updateTable('dentries').set({ parent_ino: dstIno }).where('parent_ino', '=', HOME2).where('name', '=', srcName).execute(); };
}
const cycleProbe = async () => (await sql`WITH RECURSIVE reach(ino) AS (SELECT 1::bigint UNION SELECT d.ino FROM dentries d JOIN reach r ON d.parent_ino = r.ino) SELECT count(*)::int AS unreachable FROM dentries d WHERE d.ino NOT IN (SELECT ino FROM reach)`.execute(db)).rows[0].unreachable;

async function interleave(level) {
  const { x, y } = await fresh();
  const t1 = await db.startTransaction().setIsolationLevel(level).execute();
  const t2 = await db.startTransaction().setIsolationLevel(level).execute();
  const out = [];
  try {
    const w1 = await moveSteps(t1, x, `X${x}`, y);   // A checks "Y not inside X"  -> ok
    const w2 = await moveSteps(t2, y, `Y${y}`, x);   // B checks "X not inside Y"  -> ok (sees old snapshot)
    await w1(); await w2();
    for (const [n, t] of [['A', t1], ['B', t2]]) { try { await t.commit().execute(); out.push(`${n}:commit`); } catch (e) { out.push(`${n}:${e.code}`); await t.rollback().execute().catch(() => {}); } }
  } catch (e) { out.push('err:' + (e.code ?? e.message)); await t1.rollback().execute().catch(() => {}); await t2.rollback().execute().catch(() => {}); }
  return { level, outcome: out.join(' '), unreachableEntriesAfter: await cycleProbe() };
}
console.log(await interleave('read committed'));
// repair the RC damage so the next probe starts clean
await sql`WITH RECURSIVE reach(ino) AS (SELECT 1::bigint UNION SELECT d.ino FROM dentries d JOIN reach r ON d.parent_ino = r.ino) DELETE FROM dentries WHERE ino NOT IN (SELECT ino FROM reach)`.execute(db);
console.log(await interleave('serializable'));

// retry wrapper: the loser re-runs from scratch and now fails the ancestor check -> EINVAL, tree stays a tree
const RETRY = new Set(['40001', '40P01']);
async function withTx(fn, attempts = 5) {
  for (let a = 1; ; a++) {
    try { return await db.transaction().setIsolationLevel('serializable').execute(fn); }
    catch (e) { if (!RETRY.has(e.code) || a >= attempts) throw e; await new Promise((r) => setTimeout(r, Math.random() * 10 * 2 ** a)); }
  }
}
{ const { x, y } = await fresh(); let tries = { A: 0, B: 0 };
  const mv = (tag, src, name, dst) => withTx(async (trx) => { tries[tag]++; const w = await moveSteps(trx, src, name, dst); await new Promise((r) => setTimeout(r, 20)); await w(); return 'ok'; })
    .catch((e) => e.errno ?? e.code);
  const [a, b] = await Promise.all([mv('A', x, `X${x}`, y), mv('B', y, `Y${y}`, x)]);
  console.log({ withRetry: { A: a, B: b, attempts: tries }, unreachableEntriesAfter: await cycleProbe() }); }
await db.destroy();
