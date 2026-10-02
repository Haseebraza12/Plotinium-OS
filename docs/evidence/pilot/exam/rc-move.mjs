// DB-03 under READ COMMITTED: a global directory-move advisory lock (Linux s_vfs_rename_mutex analogue) + ancestor check after the lock.
import pg from '../ormproto/node_modules/pg/lib/index.js';
const pool = new pg.Pool({ connectionString: 'postgres://postgres:exam@127.0.0.1:55499/vfs', max: 40 });
const HOME2 = Number((await pool.query(`SELECT ino FROM dentries WHERE parent_ino = 2 AND name = 'user2'`)).rows[0].ino);
let next = 5e12;
const unreachable = async () => (await pool.query(`WITH RECURSIVE reach(ino) AS (SELECT 1::bigint UNION SELECT d.ino FROM dentries d JOIN reach r ON d.parent_ino = r.ino) SELECT count(*)::int n FROM dentries d WHERE d.ino NOT IN (SELECT ino FROM reach)`)).rows[0].n;
async function mv(src, srcName, dst, useLock) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    if (useLock) await c.query(`SELECT pg_advisory_xact_lock(hashtext('vfs.dirmove'))`);
    const anc = await c.query(`WITH RECURSIVE anc(ino) AS (SELECT parent_ino FROM dentries WHERE ino = $1 UNION SELECT d.parent_ino FROM dentries d JOIN anc a ON d.ino = a.ino) SELECT 1 FROM anc WHERE ino = $2`, [dst, src]);
    if (dst === src || anc.rowCount) { await c.query('ROLLBACK'); return 'EINVAL'; }
    await new Promise((r) => setTimeout(r, 20));
    await c.query('UPDATE dentries SET parent_ino = $1 WHERE parent_ino = $2 AND name = $3', [dst, HOME2, srcName]);
    await c.query('COMMIT'); return 'ok';
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); return e.code; } finally { c.release(); }
}
for (const useLock of [false, true]) {
  const outcomes = {}; let bad = 0;
  for (let i = 0; i < 50; i++) {
    const x = next++, y = next++;
    await pool.query(`INSERT INTO inodes(ino,type,mode,uid) VALUES ($1,'dir',493,2),($2,'dir',493,2)`, [x, y]);
    await pool.query(`INSERT INTO dentries(parent_ino,name,ino) VALUES ($1,$2,$3),($1,$4,$5)`, [HOME2, `X${x}`, x, `Y${y}`, y]);
    const [a, b] = await Promise.all([mv(x, `X${x}`, y, useLock), mv(y, `Y${y}`, x, useLock)]);
    const k = [a, b].sort().join('+'); outcomes[k] = (outcomes[k] ?? 0) + 1;
    const u = await unreachable(); if (u) { bad++; await pool.query(`WITH RECURSIVE reach(ino) AS (SELECT 1::bigint UNION SELECT d.ino FROM dentries d JOIN reach r ON d.parent_ino = r.ino) DELETE FROM dentries WHERE ino NOT IN (SELECT ino FROM reach)`); }
  }
  console.log({ level: 'READ COMMITTED', advisoryDirMoveLock: useLock, trials: 50, outcomes, trialsLeavingUnreachableEntries: bad });
}
await pool.end();
