// Contention probe: how often does SERIALIZABLE abort (40001) for VFS-like mutations that do NOT logically conflict?
import pg from '../ormproto/node_modules/pg/lib/index.js';
const url = 'postgres://postgres:exam@127.0.0.1:55499/vfs';
const LEVEL = process.env.LEVEL ?? 'SERIALIZABLE';
const DUR = Number(process.env.DUR ?? 10000);
const SMALL = Number(process.env.SMALL ?? 30);   // distinct users doing small writes
const SAMEUSER = Number(process.env.SAMEUSER ?? 0); // extra small writers all sharing uid 1 (multi-tab / agent+editor)
const BULK = Number(process.env.BULK ?? 3);
const THINK = Number(process.env.THINK ?? 0);     // users doing 300-node build + per-node rm -r
const pool = new pg.Pool({ connectionString: url, max: SMALL + SAMEUSER + BULK + 2 });
const q = (c, t, v) => c.query(t, v);
const homes = new Map((await pool.query(`SELECT d.name, d.ino FROM dentries d WHERE d.parent_ino = 2`)).rows.map(r => [r.name, Number(r.ino)]));
let nextIno = Number((await pool.query('SELECT max(ino) m FROM inodes')).rows[0].m) + 1000;
const stats = {};
const bump = (k, f) => { stats[k] ??= { commit: 0, e40001: 0, other: 0, ms: [] }; stats[k][f]++; };
async function tx(kind, body) {
  const c = await pool.connect();
  try {
    const t0 = performance.now();
    await c.query(`BEGIN ISOLATION LEVEL ${LEVEL}`);
    await body(c); await c.query('COMMIT'); bump(kind, 'commit'); stats[kind].ms.push(performance.now() - t0);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); if (e.code === '40001' || e.code === '40P01') { bump(kind, 'e40001'); if (stats[kind].e40001 <= 2 && process.env.SHOWERR) console.error(kind, e.message, '|', e.detail, '|', e.hint); } else { bump(kind, 'other'); if ((stats[kind].other) < 3) console.error(kind, e.code, e.message); } }
  finally { c.release(); }
}
const walk = (c, parts) => q(c, `WITH RECURSIVE walk(depth, ino) AS (SELECT 0, 1::bigint UNION ALL SELECT w.depth+1, d.ino FROM walk w JOIN dentries d ON d.parent_ino = w.ino AND d.name = ($1::text[])[w.depth+1] WHERE w.depth < cardinality($1::text[])) SELECT w.depth, i.* FROM walk w JOIN inodes i ON i.ino = w.ino ORDER BY w.depth`, [parts]);
async function smallWrite(uid, kind) {
  const home = homes.get(`user${uid}`); const ino = process.env.INOMODE === 'random' ? 1e9 + Math.floor(Math.random() * 1e12) : nextIno++;
  await tx(kind, async (c) => {
    await q(c, 'SELECT * FROM users WHERE uid = $1 FOR UPDATE', [uid]);            // rule 2: quota row first
    await walk(c, ['home', `user${uid}`]);                                           // resolve + x checks
    await q(c, 'SELECT 1 FROM dentries WHERE parent_ino = $1 AND name = $2', [home, `f${ino}`]); // EEXIST check
    await q(c, `INSERT INTO inodes(ino,type,mode,uid,size) VALUES ($1,'file',420,$2,100)`, [ino, uid]);
    await q(c, 'INSERT INTO dentries(parent_ino,name,ino) VALUES ($1,$2,$3)', [home, `f${ino}`, ino]);
    await q(c, 'UPDATE inodes SET version = version + 1, modified_at = now() WHERE ino = $1', [home]);
    await q(c, 'UPDATE users SET used_bytes = used_bytes + 100 WHERE uid = $1', [uid]);
  });
}
async function bulk(uid) {
  const home = homes.get(`user${uid}`);
  const root = nextIno; nextIno += 400; const ins = [], den = [];
  ins.push([root, 'dir', uid]); den.push([home, `bulk${root}`, root]); const dirs = [root];
  for (let i = 1; i < 300; i++) { const ino = root + i; const isDir = i < 30; ins.push([ino, isDir ? 'dir' : 'file', uid]); den.push([dirs[Math.floor((i - 1) / 10)] ?? dirs.at(-1), `n${i}`, ino]); if (isDir) dirs.push(ino); }
  await tx('bulk-cp', async (c) => {
    await q(c, 'SELECT * FROM users WHERE uid = $1 FOR UPDATE', [uid]);
    if (process.env.BULKMODE === 'set') {
      await q(c, 'INSERT INTO inodes(ino,type,mode,uid) SELECT a, b, 493, $3 FROM unnest($1::bigint[], $2::text[]) AS t(a,b)', [ins.map(r => r[0]), ins.map(r => r[1]), uid]);
      await q(c, 'INSERT INTO dentries(parent_ino,name,ino) SELECT * FROM unnest($1::bigint[], $2::text[], $3::bigint[])', [den.map(r => r[0]), den.map(r => r[1]), den.map(r => r[2])]);
    } else for (let i = 0; i < ins.length; i++) { await q(c, 'INSERT INTO inodes(ino,type,mode,uid) VALUES ($1,$2,493,$3)', ins[i]); await q(c, 'INSERT INTO dentries(parent_ino,name,ino) VALUES ($1,$2,$3)', den[i]); }
    await q(c, 'UPDATE inodes SET version = version + 1 WHERE ino = $1', [home]);
  });
  await tx('bulk-rm', async (c) => {
    await q(c, 'SELECT * FROM users WHERE uid = $1 FOR UPDATE', [uid]);
    const plan = (await q(c, `WITH RECURSIVE sub(ino, parent_ino, name, depth) AS (SELECT d.ino, d.parent_ino, d.name, 0 FROM dentries d WHERE d.ino = $1 UNION ALL SELECT d.ino, d.parent_ino, d.name, s.depth+1 FROM dentries d JOIN sub s ON d.parent_ino = s.ino) SELECT ino, parent_ino, name FROM sub ORDER BY depth DESC`, [root])).rows;
    if (process.env.BULKMODE === 'set') { await q(c, 'DELETE FROM dentries WHERE ino = ANY($1::bigint[])', [plan.map(n => n.ino)]); await q(c, 'DELETE FROM inodes WHERE ino = ANY($1::bigint[])', [plan.map(n => n.ino)]); }
    else for (const n of plan) { await q(c, 'DELETE FROM dentries WHERE parent_ino = $1 AND name = $2', [n.parent_ino, n.name]); await q(c, 'DELETE FROM inodes WHERE ino = $1', [n.ino]); }
    await q(c, 'UPDATE inodes SET version = version + 1 WHERE ino = $1', [home]);
  });
}
const end = Date.now() + DUR; const workers = [];
for (let u = 1; u <= SMALL; u++) workers.push((async () => { while (Date.now() < end) { await smallWrite(u + 5, 'small-distinct-users'); if (THINK) await new Promise(r => setTimeout(r, Math.random() * 2 * THINK)); } })());
for (let k = 0; k < SAMEUSER; k++) workers.push((async () => { while (Date.now() < end) { await smallWrite(1, 'small-same-user'); if (THINK) await new Promise(r => setTimeout(r, Math.random() * 2 * THINK)); } })());
for (let b = 0; b < BULK; b++) workers.push((async () => { while (Date.now() < end) await bulk(45 + b); })());
await Promise.all(workers);
for (const [k, s] of Object.entries(stats)) { s.ms.sort((a, b) => a - b); const p95 = s.ms[Math.floor(s.ms.length * 0.95)]?.toFixed(1); const tot = s.commit + s.e40001 + s.other;
  console.log(`${LEVEL} ${k.padEnd(22)} commits=${s.commit} aborts40001=${s.e40001} (${(100 * s.e40001 / tot).toFixed(1)}%) other=${s.other} p95ms=${p95}`); }
await pool.end();
