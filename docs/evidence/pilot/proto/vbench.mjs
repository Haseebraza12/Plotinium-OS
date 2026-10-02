// RAG-05 prototype: permission-filtered cosine top-10 over 20k chunks, exact vs HNSW (+ iterative scan)
import pg from 'pg';
const c = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: 'proto', database: 'plotinium' });
await c.connect();
await c.query('SET search_path = vfs, public');
const N = 300;
const distinct = (await c.query(`SELECT count(DISTINCT embedding::text) n FROM (SELECT embedding FROM file_chunks LIMIT 100) s`)).rows[0].n;
const randVec = () => { const v = Array.from({ length: 384 }, () => Math.random() - 0.5); const n = Math.hypot(...v); return '[' + v.map(x => (x / n).toFixed(6)).join(',') + ']'; };
// Unix read check at query time using CURRENT inode mode/uid/gid (directory x-bits are checked afterwards for the k survivors)
const SQL = `
  WITH me AS (SELECT $2::int AS uid, ARRAY(SELECT gid FROM user_groups WHERE uid = $2) AS gids)
  SELECT c.chunk_id, c.ino, c.line_start, c.embedding <=> $1::vector AS dist
  FROM file_chunks c JOIN inodes i ON i.ino = c.ino CROSS JOIN me
  WHERE me.uid = 0
     OR CASE WHEN i.uid = me.uid THEN (i.mode & 256) <> 0
             WHEN i.gid = ANY (me.gids) THEN (i.mode & 32) <> 0
             ELSE (i.mode & 4) <> 0 END
  ORDER BY c.embedding <=> $1::vector
  LIMIT 10`;
async function run(label, setup = []) {
  await c.query('BEGIN');
  for (const s of setup) await c.query(s);
  const t = [];
  let rows;
  for (let k = 0; k < N; k++) {
    const s = performance.now();
    rows = (await c.query(SQL, [randVec(), 1000 + (k % 60)])).rows;
    t.push(performance.now() - s);
  }
  await c.query('COMMIT');
  t.sort((a, b) => a - b);
  return { label, p50: +t[N >> 1].toFixed(2), p95: +t[Math.floor(N * 0.95)].toFixed(2), rows: rows.length };
}
const out = [];
out.push(await run('exact (no vector index)'));
await c.query(`CREATE INDEX IF NOT EXISTS file_chunks_hnsw ON file_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`);
await c.query('ANALYZE file_chunks');
out.push(await run('hnsw, no iterative scan', ['SET LOCAL hnsw.ef_search = 40']));
out.push(await run('hnsw + iterative_scan=relaxed_order', ['SET LOCAL hnsw.ef_search = 40', "SET LOCAL hnsw.iterative_scan = 'relaxed_order'"]));
// recall of hnsw+iterative vs exact for 50 queries
let hit = 0, tot = 0;
for (let k = 0; k < 50; k++) {
  const v = randVec(), uid = 1000 + (k % 60);
  await c.query('BEGIN'); await c.query('SET LOCAL enable_indexscan = off');
  const exact = (await c.query(SQL, [v, uid])).rows.map(r => r.chunk_id); await c.query('COMMIT');
  await c.query('BEGIN'); await c.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
  const ann = new Set((await c.query(SQL, [v, uid])).rows.map(r => r.chunk_id)); await c.query('COMMIT');
  hit += exact.filter(x => ann.has(x)).length; tot += exact.length;
}
const plan = (await c.query(`EXPLAIN (COSTS OFF) ${SQL}`, [randVec(), 1001])).rows.map(r => r['QUERY PLAN']).join('\n');
await c.query('DROP INDEX file_chunks_hnsw');
console.log(JSON.stringify({ distinct_in_sample: distinct, results: out, recall_at_10_hnsw_iter_vs_exact_on_random_vectors: +(hit / tot).toFixed(3), plan }, null, 1));
await c.end();
