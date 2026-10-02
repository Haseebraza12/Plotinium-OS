// Realistic mixed multi-user workload: how often does SERIALIZABLE abort (false positives included)?
// 12 users work in their own homes + 1 agent client doing 500-file batch renames in /home/bench/big.
import pg from 'pg';
const cfg = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'proto', database: 'plotinium' };
const level = process.argv[2] === 'RC' ? 'READ COMMITTED' : 'SERIALIZABLE';
const USERS = Number(process.env.USERS ?? 12), OPS = Number(process.env.OPS ?? 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const stats = { ops: 0, retries: 0, gaveUp: 0, byOp: {}, lat: [] };

async function txn(c, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      await c.query(`BEGIN ISOLATION LEVEL ${level}`);
      const r = await fn();
      await c.query('COMMIT');
      return attempt;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      if ((e.code === '40001' || e.code === '40P01') && attempt < 8) { await sleep(Math.random() * 2 ** attempt); continue; }
      if (e.code === '40001' || e.code === '40P01') return -1;
      return attempt; // domain errors (ENOENT etc.) count as completed ops
    }
  }
}

async function user(uid) {
  const c = new pg.Client(cfg); await c.connect(); await c.query('SET search_path = vfs, public');
  const dirs = (await c.query(`SELECT ino FROM inodes WHERE uid = $1 AND type = 'd'`, [uid])).rows.map(r => r.ino);
  let files = (await c.query(`SELECT ino FROM inodes WHERE uid = $1 AND type = 'f'`, [uid])).rows.map(r => r.ino);
  for (let k = 0; k < OPS; k++) {
    const x = Math.random();
    const op = x < 0.4 ? 'create' : x < 0.65 ? 'write' : x < 0.8 ? 'rename' : x < 0.9 ? 'rm' : 'ls';
    const t0 = performance.now();
    const attempts = await txn(c, async () => {
      if (op === 'create') {
        const p = pick(dirs), size = Math.floor(Math.random() * 50000);
        await c.query(`UPDATE inodes SET modified_at = now(), version = version + 1 WHERE ino = $1`, [p]);
        const { rows: [{ ino }] } = await c.query(`INSERT INTO inodes (type, mode, uid, gid, size) VALUES ('f', 420, $1, 100, $2) RETURNING ino`, [uid, size]);
        await c.query(`INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) VALUES ($1, $2, $3, 'f', $4)`, [p, 'new_' + ino, ino, uid]);
        await c.query(`UPDATE users SET used_bytes = used_bytes + $2, used_inodes = used_inodes + 1 WHERE uid = $1`, [uid, size]);
        files.push(ino);
      } else if (op === 'write') {
        const f = pick(files);
        const { rows } = await c.query(`SELECT size, version FROM inodes WHERE ino = $1`, [f]);
        if (!rows.length) return;
        const ns = Math.floor(Math.random() * 50000);
        const r = await c.query(`UPDATE inodes SET size = $2, version = version + 1, modified_at = now() WHERE ino = $1 AND version = $3`, [f, ns, rows[0].version]);
        if (r.rowCount === 1) await c.query(`UPDATE users SET used_bytes = used_bytes + $2 WHERE uid = $1`, [uid, ns - Number(rows[0].size)]);
      } else if (op === 'rename') {
        const f = pick(files);
        await c.query(`UPDATE dentries SET name = 'r' || floor(random() * 1e9)::text || '_' || ino WHERE ino = $1`, [f]);
      } else if (op === 'rm') {
        const f = files.splice(Math.floor(Math.random() * files.length), 1)[0];
        const { rows } = await c.query(`DELETE FROM dentries WHERE ino = $1 RETURNING parent_ino`, [f]);
        if (!rows.length) return;
        await c.query(`UPDATE inodes SET modified_at = now(), version = version + 1 WHERE ino = $1`, [rows[0].parent_ino]);
        const { rows: [d] } = await c.query(`DELETE FROM inodes WHERE ino = $1 RETURNING size`, [f]);
        await c.query(`UPDATE users SET used_bytes = used_bytes - $2, used_inodes = used_inodes - 1 WHERE uid = $1`, [uid, d.size]);
      } else {
        await c.query(`SELECT d.name, i.size FROM dentries d JOIN inodes i ON i.ino = d.ino WHERE d.parent_ino = $1 ORDER BY d.name`, [pick(dirs)]);
      }
    });
    stats.lat.push(performance.now() - t0);
    stats.ops++;
    if (attempts === -1) stats.gaveUp++; else stats.retries += attempts - 1;
    const b = (stats.byOp[op] ??= { n: 0, retries: 0 }); b.n++; if (attempts > 1) b.retries += attempts - 1;
  }
  await c.end();
}

async function agent() {
  const c = new pg.Client(cfg); await c.connect(); await c.query('SET search_path = vfs, public');
  const { rows: [{ ino: big }] } = await c.query(`SELECT d.ino FROM dentries d JOIN dentries b ON b.ino = d.parent_ino WHERE b.name = 'bench' AND d.name = 'big'`);
  const res = { batches: 0, retries: 0, lat: [] };
  for (let k = 0; k < 20; k++) {
    const [from, to] = k % 2 ? ['doc_', 'file_'] : ['file_', 'doc_'];
    const t0 = performance.now();
    const attempts = await txn(c, async () => {
      await c.query(`WITH r AS (UPDATE dentries SET name = $2 || substr(name, length($3) + 1) WHERE parent_ino = $1 AND starts_with(name, $3) RETURNING ino)
        UPDATE inodes i SET changed_at = now(), version = version + 1 FROM r WHERE i.ino = r.ino`, [big, to, from]);
    });
    res.lat.push(performance.now() - t0); res.batches++; res.retries += Math.max(0, attempts - 1);
  }
  await c.end();
  return res;
}

const uids = Array.from({ length: USERS }, (_, i) => 1001 + i);
const [ag] = await Promise.all([agent(), ...uids.map(user)]);
stats.lat.sort((a, b) => a - b);
const p = (q) => +stats.lat[Math.floor(q * stats.lat.length)].toFixed(2);
const admin = new pg.Client(cfg); await admin.connect(); await admin.query('SET search_path = vfs, public');
const { rows: [chk] } = await admin.query(`SELECT
  (SELECT count(*) FROM users u WHERE u.uid > 0 AND u.used_bytes <> (SELECT coalesce(sum(size), 0) FROM inodes i WHERE i.uid = u.uid)) AS quota_drift_users,
  (SELECT count(*) FROM inodes i LEFT JOIN dentries d ON d.ino = i.ino WHERE d.ino IS NULL AND i.ino <> '00000000-0000-7000-8000-000000000001') AS orphan_inodes`);
await admin.end();
console.log(JSON.stringify({ level, USERS, OPS, ops: stats.ops, retries: stats.retries, retry_rate: +(stats.retries / stats.ops).toFixed(4),
  gave_up: stats.gaveUp, byOp: stats.byOp, p50_ms: p(0.5), p95_ms: p(0.95),
  agent_batch_rename_500: { batches: ag.batches, retries: ag.retries, p50_ms: +ag.lat.sort((a, b) => a - b)[10].toFixed(1) },
  quota_drift_users: +chk.quota_drift_users, orphan_inodes: +chk.orphan_inodes }));
