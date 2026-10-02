// DB-02 probe: rm -r on a 1,000-node subtree with a fault injected at node 500, via Kysely in one SERIALIZABLE txn.
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: 'postgres://postgres:proto@127.0.0.1:55433/vfs', max: 4 }) }) });
class InjectedFault extends Error {}
const faults = (failAt) => { let n = 0; return { tick() { if (++n === failAt) throw new InjectedFault(`injected at node op ${n}`); }, get count() { return n; } }; };

let next = Number((await sql`SELECT max(ino) m FROM inodes`.execute(db)).rows[0].m) + 1;
const HOME3 = (await sql`SELECT ino FROM dentries WHERE parent_ino=(SELECT ino FROM dentries WHERE parent_ino=1 AND name='home') AND name='user3'`.execute(db)).rows[0].ino;
async function buildSubtree(name) { // 1 root dir + 999 descendants (fan-out 10)
  const rootIno = next++; const ins = [{ ino: rootIno, type: 'dir', mode: 0o755, uid: 3 }]; const den = [{ parent_ino: HOME3, name, ino: rootIno }];
  const dirs = [rootIno];
  for (let i = 1; i < 1000; i++) { const p = dirs[Math.floor((i - 1) / 10)] ?? dirs[dirs.length - 1]; const isDir = i < 100; const ino = next++;
    ins.push({ ino, type: isDir ? 'dir' : 'file', mode: 0o644, uid: 3, size: 100 }); den.push({ parent_ino: p, name: `n${i}`, ino }); if (isDir) dirs.push(ino); }
  await db.insertInto('inodes').values(ins).execute(); await db.insertInto('dentries').values(den).execute(); return rootIno;
}
const checksum = async () => (await sql`SELECT md5(string_agg(d.parent_ino||'/'||d.name||'>'||d.ino||':'||i.mode||':'||i.uid||':'||i.size, ',' ORDER BY d.parent_ino, d.name)) AS c, count(*)::int AS n FROM dentries d JOIN inodes i ON i.ino = d.ino`.execute(db)).rows[0];
const orphans = async () => (await sql`SELECT (SELECT count(*) FROM inodes i LEFT JOIN dentries d ON d.ino = i.ino WHERE d.ino IS NULL AND i.ino <> 1)::int AS orphan_inodes, (SELECT count(*) FROM dentries d LEFT JOIN inodes p ON p.ino = d.parent_ino WHERE p.ino IS NULL)::int AS dangling_dentries`.execute(db)).rows[0];

async function rmR(rootIno, fault) {
  return db.transaction().setIsolationLevel('serializable').execute(async (trx) => {
    // plan: post-order list of the subtree (children before parents), one recursive query
    const plan = (await sql`WITH RECURSIVE sub(ino, parent_ino, name, depth) AS (
        SELECT d.ino, d.parent_ino, d.name, 0 FROM dentries d WHERE d.ino = ${rootIno}
        UNION ALL SELECT d.ino, d.parent_ino, d.name, s.depth + 1 FROM dentries d JOIN sub s ON d.parent_ino = s.ino)
      SELECT ino, parent_ino, name FROM sub ORDER BY depth DESC`.execute(trx)).rows;
    for (const n of plan) {                      // M node ops; the hook may throw after N of them
      await trx.deleteFrom('dentries').where('parent_ino', '=', n.parent_ino).where('name', '=', n.name).execute();
      await trx.deleteFrom('inodes').where('ino', '=', n.ino).execute();
      fault?.tick();
    }
    return plan.length;
  });
}
const before = await checksum(); const probesBefore = await orphans();
const victim = await buildSubtree('victim'); const withSubtree = await checksum();
let err; const t0 = performance.now();
try { await rmR(victim, faults(500)); } catch (e) { err = e.message; }
const tFail = performance.now() - t0; const afterFail = await checksum();
console.log({ injected: err, rolledBackMs: tFail.toFixed(1), checksumUnchanged: afterFail.c === withSubtree.c, rows: afterFail.n, probes: await orphans() });
const t1 = performance.now(); const removed = await rmR(victim); const tOk = performance.now() - t1;
console.log({ removed, perNodeRmMs: tOk.toFixed(1), backToBaseline: (await checksum()).c === before.c, probes: await orphans(), probesBefore });
await db.destroy();
