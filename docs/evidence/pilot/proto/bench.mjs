// Q1-Q5 benchmark: p50/p95 over N runs, measured from the Node client (includes driver + loopback RTT)
import pg from 'pg';
const N = Number(process.env.N ?? 1000);
const label = process.argv[2] ?? 'run';
const c = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: 'proto', database: 'plotinium', options: process.env.ISO ? '-c default_transaction_isolation=' + process.env.ISO : undefined });
await c.connect();
await c.query('SET search_path = vfs, public');
const ROOT = '00000000-0000-7000-8000-000000000001';
const one = async (sql, p) => (await c.query(sql, p)).rows;
const [{ ino: bench }] = await one(`SELECT d.ino FROM dentries d JOIN dentries h ON h.ino = d.parent_ino WHERE h.name='home' AND d.name='bench'`);
const [{ ino: big }] = await one(`SELECT ino FROM dentries WHERE parent_ino=$1 AND name='big'`, [bench]);
const [{ ino: proj }] = await one(`SELECT ino FROM dentries WHERE parent_ino=$1 AND name='proj'`, [bench]);
const users = (await one(`SELECT uid FROM users WHERE uid >= 1000`)).map(r => r.uid);
const prefixes = ['rep', 'not', 'dra', 'mai', 'ind', 'rea', 'tod', 'img', 'dat', 'tes', 'r', 'n', 'report_1', 'data_2'];

const Q = {
  Q1: { sql: `WITH RECURSIVE walk(depth, ino, d_type) AS (
            SELECT 0, $1::uuid, 'd'::"char"
            UNION ALL
            SELECT w.depth + 1, d.ino, d.d_type
            FROM walk w JOIN dentries d ON d.parent_ino = w.ino AND d.name = ($2::text[])[w.depth + 1]
            WHERE w.depth < cardinality($2::text[]))
          SELECT w.depth, w.ino, i.type, i.mode, i.uid, i.gid, i.symlink_target
          FROM walk w JOIN inodes i ON i.ino = w.ino ORDER BY w.depth`,
        args: () => [ROOT, ['home', 'bench', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6']] },
  Q2: { sql: `SELECT d.name, d.ino, d.d_type, i.size, i.mode, i.uid, i.modified_at
          FROM dentries d JOIN inodes i ON i.ino = d.ino
          WHERE d.parent_ino = $1 ORDER BY d.name`, args: () => [big] },
  Q3: { sql: `SELECT d.parent_ino, d.name, d.ino FROM dentries d
          WHERE d.owner_uid = $1 AND lower(d.name) LIKE $2 ORDER BY lower(d.name) LIMIT 50`,
        args: (k) => [users[k % users.length], prefixes[k % prefixes.length] + '%'] },
  Q4: { sql: `SELECT i.ino, i.size, i.modified_at FROM inodes i
          WHERE i.uid = $1 AND i.type = 'f' AND i.modified_at >= now() - interval '7 days'
          ORDER BY i.modified_at DESC LIMIT 50`, args: (k) => [users[k % users.length]] },
  Q5: { sql: `WITH RECURSIVE t(ino, d_type) AS (
            SELECT $1::uuid, 'd'::"char"
            UNION ALL
            SELECT d.ino, d.d_type FROM t JOIN dentries d ON d.parent_ino = t.ino WHERE t.d_type = 'd')
          SELECT count(*) AS nodes, sum(i.size) AS bytes FROM inodes i WHERE i.ino IN (SELECT ino FROM t)`,
        args: () => [proj] },
};
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
const out = {};
for (const [name, q] of Object.entries(Q)) {
  for (let k = 0; k < 50; k++) await c.query({ name, text: q.sql, values: q.args(k) }); // warm-up
  const t = [];
  let rows;
  for (let k = 0; k < N; k++) {
    const s = process.hrtime.bigint();
    rows = (await c.query({ name, text: q.sql, values: q.args(k) })).rows;
    t.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  t.sort((a, b) => a - b);
  out[name] = { p50: +pct(t, 0.5).toFixed(3), p95: +pct(t, 0.95).toFixed(3), max: +t[t.length - 1].toFixed(2), lastRows: rows.length };
  if (name === 'Q5') out[name].result = rows[0];
}
console.log(JSON.stringify({ label, N, ...out }, null, 1));
await c.end();
