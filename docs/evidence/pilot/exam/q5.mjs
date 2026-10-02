import pg from '../ormproto/node_modules/pg/lib/index.js';
const pool = new pg.Pool({ connectionString: 'postgres://postgres:exam@127.0.0.1:55499/vfs', max: 2 });
const home = Number((await pool.query(`SELECT ino FROM dentries WHERE parent_ino = 2 AND name = 'user7'`)).rows[0].ino);
const root = 7e12; const ins = [[root, 'dir']]; const den = [[home, 'q5root', root]]; const dirs = [root];
for (let i = 1; i < 1000; i++) { const ino = root + i; const isDir = i < 100; ins.push([ino, isDir ? 'dir' : 'file']); den.push([dirs[Math.floor((i - 1) / 10)] ?? dirs.at(-1), `n${i}`, ino]); if (isDir) dirs.push(ino); }
await pool.query(`INSERT INTO inodes(ino,type,mode,uid,size) SELECT a,b,493,7,1000 FROM unnest($1::bigint[],$2::text[]) t(a,b)`, [ins.map(r => r[0]), ins.map(r => r[1])]);
await pool.query(`INSERT INTO dentries(parent_ino,name,ino) SELECT * FROM unnest($1::bigint[],$2::text[],$3::bigint[])`, [den.map(r => r[0]), den.map(r => r[1]), den.map(r => r[2])]);
await pool.query('ANALYZE dentries; ANALYZE inodes');
const Q5 = `WITH RECURSIVE sub(ino) AS (SELECT $1::bigint UNION ALL SELECT d.ino FROM dentries d JOIN sub s ON d.parent_ino = s.ino) SELECT count(*)::int n, sum(i.size)::bigint bytes FROM sub JOIN inodes i USING (ino)`;
for (let i = 0; i < 100; i++) await pool.query(Q5, [root]);
const t = []; let r; for (let i = 0; i < 1000; i++) { const s = performance.now(); r = await pool.query(Q5, [root]); t.push(performance.now() - s); }
t.sort((a, b) => a - b); console.log({ nodes: r.rows[0].n, p50: t[499].toFixed(2), p95: t[949].toFixed(2), p99: t[989].toFixed(2) });
const plan = (await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${Q5}`, [root])).rows[0]['QUERY PLAN'][0]; console.log('server exec ms', plan['Execution Time']);
await pool.query(`DELETE FROM dentries WHERE ino >= $1 AND ino < $2`, [root, root + 1000]); await pool.query(`DELETE FROM inodes WHERE ino >= $1 AND ino < $2`, [root, root + 1000]);
await pool.end();
