// Deterministic seed: 50 users, ~100k inodes, realistic depth spread, a depth-8 path and a 500-entry dir.
import pg from "../ormproto/node_modules/pg/lib/index.js";
import { readFileSync } from 'node:fs';
const url = 'postgres://postgres:exam@127.0.0.1:55499/vfs';
const client = new pg.Client(url); await client.connect();
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const rnd = mulberry32(42);
await client.query('DROP TABLE IF EXISTS dentries, inodes, users CASCADE');
await client.query(readFileSync(new URL('../ormproto/schema.sql', import.meta.url), 'utf8').split('-- migrate:down')[0]);
const users = []; for (let u = 0; u <= 50; u++) users.push([u, u === 0 ? 'root' : `user${u}`, 10n ** 12n]);
await client.query('INSERT INTO users(uid,username,quota_bytes) SELECT * FROM unnest($1::int[],$2::text[],$3::bigint[])', [users.map(r=>r[0]), users.map(r=>r[1]), users.map(r=>String(r[2]))]);
const inodes = []; const dents = []; let next = 1;
const mk = (type, uid, parent, name) => { const ino = next++; inodes.push([ino, type, type === 'dir' ? 0o755 : 0o644, uid, type === 'file' ? Math.floor(rnd()*100000) : 0, Date.now() - Math.floor(rnd()*60)*86400000]); if (parent) dents.push([parent, name, ino]); return ino; };
const root = mk('dir', 0, null); const home = mk('dir', 0, root, 'home');
const depthOf = new Map([[root,0],[home,1]]);
for (let u = 1; u <= 50; u++) {
  const h = mk('dir', u, home, `user${u}`); depthOf.set(h, 2);
  const dirs = [h];
  for (let i = 0; i < 1990; i++) {
    // bias toward recently created dirs -> realistic depth spread (mostly 3-8, tail to ~14)
    const p = dirs[Math.floor(rnd() * dirs.length)]; // random recursive tree: depth ~ ln(n)
    const isDir = rnd() < 0.18;
    const ino = mk(isDir ? 'dir' : 'file', u, p, `${isDir ? 'dir' : 'file'}_${i}${isDir ? '' : ['.md','.txt','.ts','.pdf'][i % 4]}`);
    depthOf.set(ino, depthOf.get(p) + 1); if (isDir) dirs.push(ino);
  }
}
// fixtures: /home/user1/a/b/c/d/e/f (depth 8) and /home/user1/big (500 entries)
let p = 3; for (const n of ['a','b','c','d','e','f']) p = mk('dir', 1, p, n);
const big = mk('dir', 1, 3, 'big'); for (let i = 0; i < 500; i++) mk('file', 1, big, `f${String(i).padStart(4,'0')}.txt`);
const col = (rows, i) => rows.map(r => r[i]);
for (let s = 0; s < inodes.length; s += 5000) { const c = inodes.slice(s, s + 5000);
  await client.query(`INSERT INTO inodes(ino,type,mode,uid,size,modified_at) SELECT a,b,c,d,e,to_timestamp(f/1000.0) FROM unnest($1::bigint[],$2::text[],$3::smallint[],$4::int[],$5::bigint[],$6::float8[]) AS t(a,b,c,d,e,f)`, [col(c,0),col(c,1),col(c,2),col(c,3),col(c,4),col(c,5)]); }
for (let s = 0; s < dents.length; s += 5000) { const c = dents.slice(s, s + 5000);
  await client.query('INSERT INTO dentries(parent_ino,name,ino) SELECT * FROM unnest($1::bigint[],$2::text[],$3::bigint[])', [col(c,0),col(c,1),col(c,2)]); }
await client.query('ANALYZE');
const depths = [...depthOf.values()]; const hist = {}; for (const d of depths) hist[d] = (hist[d]||0)+1;
console.log(JSON.stringify({ inodes: inodes.length, dentries: dents.length, maxDepth: Math.max(...depths), depthHistogram: hist, bigDir: big }));
await client.end();
