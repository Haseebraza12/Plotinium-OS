// DB-03 prototype: concurrent directory moves under three concurrency-control designs.
//  RC_NAIVE  : READ COMMITTED, ancestor check, no extra locks          (expected to corrupt the tree)
//  SERIAL    : SERIALIZABLE + retry on 40001/40P01                      (candidate A)
//  RC_LOCKED : READ COMMITTED + tree-wide advisory "rename lock" for cross-directory directory moves
//              (Linux s_vfs_rename_mutex analogue)                        (candidate B)
import pg from 'pg';
const cfg = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'proto', database: 'plotinium' };
const ROOT = '00000000-0000-7000-8000-000000000001';
const mode = process.argv[2];
const CLIENTS = Number(process.env.CLIENTS ?? 8), MOVES = Number(process.env.MOVES ?? 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANCESTOR_CHECK = `WITH RECURSIVE up(ino, depth) AS (
    SELECT $1::uuid, 0
    UNION ALL
    SELECT d.parent_ino, up.depth + 1 FROM up JOIN dentries d ON d.ino = up.ino AND d.d_type = 'd'
    WHERE up.depth < 4096)
  SELECT EXISTS (SELECT 1 FROM up WHERE ino = $2::uuid) AS cycle`;

async function moveDir(c, src, dst) {
  // src, dst: directory inos. Moves src (keeping its name) under dst.
  if (mode === 'RC_LOCKED') await c.query(`SELECT pg_advisory_xact_lock(42)`); // one rename lock per filesystem
  const s = await c.query(`SELECT parent_ino, name FROM dentries WHERE ino = $1 AND d_type = 'd'`, [src]);
  if (!s.rows.length) return 'ENOENT';
  const { parent_ino, name } = s.rows[0];
  if (src === dst) return 'EINVAL';
  // lock both parent directory inodes (their mtime/nlink change); ordered to avoid deadlock
  await c.query(`SELECT ino FROM inodes WHERE ino = ANY($1::uuid[]) ORDER BY ino FOR UPDATE`, [[parent_ino, dst]]);
  const { rows: [{ cycle }] } = await c.query(ANCESTOR_CHECK, [dst, src]);
  if (cycle) return 'EINVAL';
  await sleep(Math.random() * 3); // widen the race window like a slow permission check would
  const newName = name.replace(/~\d+$/, '') + '~' + Math.floor(Math.random() * 1e9);
  await c.query(`UPDATE dentries SET parent_ino = $1, name = $2 WHERE parent_ino = $3 AND name = $4`,
    [dst, newName, parent_ino, name]);
  await c.query(`UPDATE inodes SET modified_at = now(), version = version + 1 WHERE ino = ANY($1::uuid[])`, [[parent_ino, dst]]);
  return 'OK';
}

async function txn(c, fn) {
  const level = mode.startsWith('SERIAL') ? 'SERIALIZABLE' : 'READ COMMITTED';
  for (let attempt = 1; ; attempt++) {
    try {
      // SERIAL_LOCKED: take the rename lock BEFORE the snapshot exists (session-level, released after COMMIT)
      if (mode === 'SERIAL_LOCKED') await c.query(`SELECT pg_advisory_lock(42)`);
      await c.query(`BEGIN ISOLATION LEVEL ${level}`);
      const r = await fn();
      await c.query(r === 'OK' ? 'COMMIT' : 'ROLLBACK');
      if (mode === 'SERIAL_LOCKED') await c.query(`SELECT pg_advisory_unlock(42)`);
      return { r, attempt };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if (mode === 'SERIAL_LOCKED') await c.query(`SELECT pg_advisory_unlock(42)`).catch(() => {});
      if ((e.code === '40001' || e.code === '40P01') && attempt < 10) {
        await sleep(Math.random() * 2 ** attempt);
        continue;
      }
      return { r: 'ERR_' + e.code, attempt };
    }
  }
}

const admin = new pg.Client(cfg); await admin.connect();
await admin.query('SET search_path = vfs, public');
// fresh sandbox: /home/bench/mvtest with 40 sibling directories
const [{ ino: bench }] = (await admin.query(`SELECT d.ino FROM dentries d JOIN dentries h ON h.ino=d.parent_ino WHERE h.name='home' AND d.name='bench'`)).rows;
const old = (await admin.query(`SELECT ino FROM dentries WHERE parent_ino=$1 AND name='mvtest'`, [bench])).rows[0];
if (old) {
  await admin.query(`WITH RECURSIVE t AS (SELECT $1::uuid ino UNION ALL SELECT d.ino FROM t JOIN dentries d ON d.parent_ino=t.ino) , x AS (DELETE FROM dentries WHERE ino IN (SELECT ino FROM t) RETURNING ino) DELETE FROM inodes WHERE ino IN (SELECT ino FROM x) OR ino=$1`, [old.ino]);
}
// orphans from a previous corrupted run (detached cycles): clean them too
await admin.query(`WITH RECURSIVE r AS (SELECT $1::uuid ino UNION ALL SELECT d.ino FROM r JOIN dentries d ON d.parent_ino=r.ino),
  lost AS (SELECT ino FROM inodes WHERE ino NOT IN (SELECT ino FROM r)),
  x AS (DELETE FROM dentries WHERE ino IN (SELECT ino FROM lost)) DELETE FROM inodes WHERE ino IN (SELECT ino FROM lost)`, [ROOT]);
const mv = (await admin.query(`SELECT mk($1, 'mvtest', 'd', 1000, 100, 493, 0, now()) AS ino`, [bench])).rows[0].ino;
const dirs = [];
for (let i = 0; i < 40; i++) dirs.push((await admin.query(`SELECT mk($1, $2, 'd', 1000, 100, 493, 0, now()) AS ino`, [mv, 'd' + i])).rows[0].ino);

const stats = { OK: 0, EINVAL: 0, other: {}, retries: 0, lat: [] };
await Promise.all(Array.from({ length: CLIENTS }, async () => {
  const c = new pg.Client(cfg); await c.connect(); await c.query('SET search_path = vfs, public');
  for (let k = 0; k < MOVES; k++) {
    const a = dirs[Math.floor(Math.random() * dirs.length)], b = dirs[Math.floor(Math.random() * dirs.length)];
    const t0 = performance.now();
    const { r, attempt } = await txn(c, () => moveDir(c, a, b));
    stats.lat.push(performance.now() - t0);
    stats.retries += attempt - 1;
    if (r === 'OK' || r === 'EINVAL') stats[r]++; else stats.other[r] = (stats.other[r] ?? 0) + 1;
  }
  await c.end();
}));

// invariant: every directory in the sandbox is still reachable from / (no cycles, no detached subtrees)
const { rows: [inv] } = await admin.query(`WITH RECURSIVE r AS (SELECT $1::uuid ino, 0 depth UNION ALL SELECT d.ino, depth+1 FROM r JOIN dentries d ON d.parent_ino=r.ino WHERE depth < 5000)
  SELECT count(*) FILTER (WHERE i.ino NOT IN (SELECT ino FROM r)) AS unreachable_inodes,
         (SELECT count(*) FROM dentries d LEFT JOIN inodes p ON p.ino = d.parent_ino WHERE p.ino IS NULL) AS dangling_dentries
  FROM inodes i`, [ROOT]);
stats.lat.sort((x, y) => x - y);
const p = (q) => stats.lat[Math.floor(q * stats.lat.length)].toFixed(2);
console.log(JSON.stringify({ mode, CLIENTS, MOVES, ok: stats.OK, einval: stats.EINVAL, other: stats.other,
  retries: stats.retries, p50_ms: p(0.5), p95_ms: p(0.95), unreachable_inodes: Number(inv.unreachable_inodes),
  dangling_dentries: Number(inv.dangling_dentries) }));
await admin.end();
