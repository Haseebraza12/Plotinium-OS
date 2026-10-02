// Does FOR UPDATE under SERIALIZABLE turn a conflict into a wait, or into a wait-then-40001?
import pg from '../ormproto/node_modules/pg/lib/index.js';
const url = 'postgres://postgres:exam@127.0.0.1:55499/postgres';
const setup = new pg.Client(url); await setup.connect();
await setup.query(`DROP TABLE IF EXISTS users, op_log; CREATE TABLE users(uid int primary key, used_bytes bigint not null, quota_bytes bigint not null, CHECK (used_bytes <= quota_bytes));
 CREATE TABLE op_log(op_id text primary key); INSERT INTO users VALUES (1, 0, 1000000);`);
async function scenario(level, lockFirst) {
  await setup.query('UPDATE users SET used_bytes = 0; TRUNCATE op_log');
  const a = new pg.Client(url), b = new pg.Client(url); await a.connect(); await b.connect();
  const log = [];
  await a.query(`BEGIN ISOLATION LEVEL ${level}`); await b.query(`BEGIN ISOLATION LEVEL ${level}`);
  // B takes its snapshot first (e.g. op_log insert), unless lockFirst
  if (!lockFirst) await b.query(`INSERT INTO op_log VALUES ('b')`);
  // A: lock quota row, update it
  await a.query('SELECT * FROM users WHERE uid = 1 FOR UPDATE'); await a.query('UPDATE users SET used_bytes = used_bytes + 100 WHERE uid = 1');
  // B: tries to lock the quota row -> blocks until A commits
  const bp = b.query('SELECT * FROM users WHERE uid = 1 FOR UPDATE').then(async (r) => { log.push('B got lock, sees used=' + r.rows[0].used_bytes); await b.query('UPDATE users SET used_bytes = used_bytes + 50 WHERE uid = 1'); await b.query('COMMIT'); log.push('B commit'); })
    .catch(async (e) => { log.push('B error ' + e.code + ' ' + e.message); await b.query('ROLLBACK'); });
  await new Promise((r) => setTimeout(r, 200)); log.push('A commit'); await a.query('COMMIT');
  await bp;
  const final = (await setup.query('SELECT used_bytes FROM users WHERE uid=1')).rows[0].used_bytes;
  console.log({ level, lockFirst, log, final });
  await a.end(); await b.end();
}
await scenario('SERIALIZABLE', false);
await scenario('SERIALIZABLE', true);
await scenario('READ COMMITTED', false);
await setup.end();
