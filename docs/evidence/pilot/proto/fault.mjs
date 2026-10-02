// DB-02 prototype: fault-injection harness. Each bulk op runs in ONE SERIALIZABLE transaction; the test-only
// trigger throws after N inode-row operations; afterwards the tree checksum, orphan probes and quota must be unchanged.
import pg from 'pg';
const c = new pg.Client({ host: '127.0.0.1', port: 55432, user: 'postgres', password: 'proto', database: 'plotinium' });
await c.connect();
await c.query('SET search_path = vfs, public');
const ROOT = '00000000-0000-7000-8000-000000000001';
const q = async (sql, p) => (await c.query(sql, p)).rows;
const [{ ino: bench }] = await q(`SELECT d.ino FROM dentries d JOIN dentries h ON h.ino=d.parent_ino WHERE h.name='home' AND d.name='bench'`);
const lookup = async (name) => (await q(`SELECT ino FROM dentries WHERE parent_ino=$1 AND name=$2`, [bench, name]))[0]?.ino;

async function snapshot() {
  const [s] = await q(`SELECT
     (SELECT md5(string_agg(concat_ws('|', d.parent_ino, d.name, d.ino, i.type, i.mode, i.uid, i.gid, i.size, i.nlink, i.version),
                 E'\\n' ORDER BY d.parent_ino, d.name)) FROM dentries d JOIN inodes i ON i.ino = d.ino) AS checksum,
     (SELECT count(*) FROM inodes i LEFT JOIN dentries d ON d.ino = i.ino WHERE d.ino IS NULL AND i.ino <> $1) AS orphan_inodes,
     (SELECT count(*) FROM dentries d LEFT JOIN inodes p ON p.ino = d.parent_ino WHERE p.ino IS NULL) AS parentless_dentries,
     (SELECT used_bytes || '/' || used_inodes FROM users WHERE uid = 1000) AS bench_quota`, [ROOT]);
  return s;
}

const SUBTREE = `WITH RECURSIVE sub(parent_ino, name, ino, d_type, depth) AS (
    SELECT parent_ino, name, ino, d_type, 0 FROM dentries WHERE parent_ino = $1 AND name = $2
    UNION ALL
    SELECT d.parent_ino, d.name, d.ino, d.d_type, sub.depth + 1 FROM sub JOIN dentries d ON d.parent_ino = sub.ino
    WHERE sub.d_type = 'd')`;

const ops = {
  // rm -r /home/bench/proj  (1,000 nodes)
  'rm -r': async () => {
    await c.query(`${SUBTREE},
      del_d AS (DELETE FROM dentries d USING sub WHERE d.parent_ino = sub.parent_ino AND d.name = sub.name RETURNING d.ino),
      del_i AS (DELETE FROM inodes i USING del_d WHERE i.ino = del_d.ino RETURNING i.uid, i.size)
      UPDATE users u SET used_bytes = u.used_bytes - a.b, used_inodes = u.used_inodes - a.n
      FROM (SELECT uid, sum(size) b, count(*) n FROM del_i GROUP BY uid) a WHERE u.uid = a.uid`, [bench, 'proj']);
    await c.query(`UPDATE inodes SET modified_at = now(), version = version + 1 WHERE ino = $1`, [bench]);
  },
  // chmod -R 700 /home/bench/proj
  'chmod -R': async () => {
    await c.query(`${SUBTREE} UPDATE inodes i SET mode = CASE WHEN i.type = 'd' THEN 448 ELSE 384 END,
        changed_at = now(), version = i.version + 1 FROM sub WHERE i.ino = sub.ino`, [bench, 'proj']);
  },
  // cp -r /home/bench/proj /home/bench/proj-copy  (1,000 new inodes + dentries + quota, one statement)
  'cp -r': async () => {
    await c.query(`${SUBTREE},
      map AS MATERIALIZED (SELECT ino AS old_ino, uuidv7() AS new_ino FROM sub),
      ins_i AS (INSERT INTO inodes (ino, type, mode, uid, gid, size, blob_id, symlink_target)
                SELECT m.new_ino, i.type, i.mode, 1000, 100, i.size, i.blob_id, i.symlink_target
                FROM map m JOIN inodes i ON i.ino = m.old_ino RETURNING ino, size),
      ins_d AS (INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid)
                SELECT CASE WHEN s.depth = 0 THEN $1 ELSE pm.new_ino END,
                       CASE WHEN s.depth = 0 THEN 'proj-copy' ELSE s.name END, m.new_ino, s.d_type, 1000
                FROM sub s JOIN map m ON m.old_ino = s.ino LEFT JOIN map pm ON pm.old_ino = s.parent_ino RETURNING 1)
      UPDATE users SET used_bytes = used_bytes + (SELECT coalesce(sum(size), 0) FROM ins_i),
                       used_inodes = used_inodes + (SELECT count(*) FROM ins_i) WHERE uid = 1000`, [bench, 'proj']);
  },
  // agent batch rename: 500 files in /home/bench/big  file_NNNN.txt -> doc_NNNN.txt (dentry rows + inode ctime)
  'batch rename 500': async () => {
    const big = await lookup('big');
    await c.query(`WITH r AS (UPDATE dentries SET name = 'doc_' || substr(name, 6) WHERE parent_ino = $1 AND name LIKE 'file\\_%' RETURNING ino)
      UPDATE inodes i SET changed_at = now(), version = version + 1 FROM r WHERE i.ino = r.ino`, [big]);
  },
  // mv /home/bench/proj /home/bench/big/proj  (1 dentry row + 2 parent inode rows)
  'mv dir': async () => {
    const big = await lookup('big');
    await c.query(`UPDATE dentries SET parent_ino = $2 WHERE parent_ino = $1 AND name = 'proj'`, [bench, big]);
    await c.query(`UPDATE inodes SET modified_at = now(), version = version + 1 WHERE ino = ANY($1::uuid[])`, [[bench, big]]);
  },
};

const results = [];
for (const [name, fn] of Object.entries(ops)) {
  const faultAt = name === 'mv dir' ? 1 : name === 'batch rename 500' ? 250 : 500;
  const before = await snapshot();
  let err = null; const t0 = performance.now();
  try {
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await c.query(`SELECT set_config('plotinium.fault_after', $1, true), set_config('plotinium.fault_count', '0', true)`, [String(faultAt)]);
    await fn();
    await c.query('COMMIT');
  } catch (e) { err = e.message; await c.query('ROLLBACK'); }
  const failMs = performance.now() - t0;
  const after = await snapshot();
  // now run it for real (no fault) to prove the op itself works and to time it
  const t1 = performance.now();
  await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); await fn(); await c.query('ROLLBACK'); // rolled back to keep fixtures
  const okMs = performance.now() - t1;
  results.push({ op: name, fault_after: faultAt, error: err, failed_txn_ms: +failMs.toFixed(1), clean_run_ms: +okMs.toFixed(1),
    checksum_unchanged: before.checksum === after.checksum, orphan_inodes: +after.orphan_inodes,
    parentless_dentries: +after.parentless_dentries, quota_unchanged: before.bench_quota === after.bench_quota });
}
// quota as a DB invariant: try to cp -r beyond quota
await c.query(`UPDATE users SET quota_bytes = used_bytes + 1000 WHERE uid = 1000`);
let quotaErr = null;
try { await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); await ops['cp -r'](); await c.query('COMMIT'); }
catch (e) { quotaErr = `${e.code} ${e.constraint ?? ''}`; await c.query('ROLLBACK'); }
await c.query(`UPDATE users SET quota_bytes = 5368709120 WHERE uid = 1000`);
// constraint probes (DB-04)
const probe = async (sql) => { try { await c.query(sql); return 'ACCEPTED (bad)'; } catch (e) { return `${e.code} ${e.constraint ?? e.message}`; } };
const dbo4 = {
  dup_name: await probe(`INSERT INTO dentries SELECT parent_ino, parent_type, name, ino, d_type, owner_uid FROM dentries WHERE parent_ino = '${bench}' LIMIT 1`),
  file_as_parent: await probe(`WITH f AS (SELECT ino FROM dentries WHERE d_type='f' LIMIT 1) INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) SELECT f.ino, 'x', '${bench}', 'd', 1000 FROM f`),
  bad_mode: await probe(`UPDATE inodes SET mode = 4095 WHERE ino = '${bench}'`),
  bad_type: await probe(`INSERT INTO inodes (type, mode, uid, gid) VALUES ('x', 420, 1000, 100)`),
  slash_in_name: await probe(`UPDATE dentries SET name = 'a/b' WHERE parent_ino = '${bench}' AND name = 'big'`),
  dir_hardlink: await probe(`INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) VALUES ('${ROOT}', 'bench2', '${bench}', 'd', 1000)`),
  owner_mismatch: await probe(`INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) SELECT '${ROOT}', 'zz', ino, d_type, 0 FROM dentries WHERE parent_ino='${bench}' AND d_type='f' LIMIT 1`),
};
console.log(JSON.stringify({ results, quota_exceeded: quotaErr, db04_probes: dbo4 }, null, 1));
await c.end();
