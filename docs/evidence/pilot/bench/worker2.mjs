// Round 2: interleaved, repeated measurements to cancel machine-load drift.
import { openDB, unwrap } from '/node_modules/idb/build/index.js';

const now = () => performance.now();
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1); };
const stats = (arr) => ({ n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95) });
const sha = async (buf) => new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const out = {};

function makeStateBytes(bytes) {
  const lines = []; let size = 0, i = 0;
  while (size < bytes) { const l = `line ${i++}: the quick brown fox jumps over the lazy dog ${Math.random()}`; lines.push(l); size += l.length + 4; }
  return new TextEncoder().encode(JSON.stringify({ kind: 'editor-buffer', lines }));
}

async function swapInterleaved(N = 60) {
  const db = await openDB('swap2', 1, { upgrade(d) { d.createObjectStore('pages'); } });
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('swap2', { create: true });
  const bytes = makeStateBytes(5 * 1024 * 1024);
  const sum = await sha(bytes);
  const r = { idbOut: [], idbIn: [], idbReadOnly: [], opfsOut: [], opfsIn: [], opfsReadOnly: [], parseAndVerify: [] };
  const idb = async (k) => {
    let t0 = now();
    const tx = db.transaction('pages', 'readwrite', { durability: 'relaxed' });
    tx.store.put({ bytes: bytes.slice().buffer, sum }, k); await tx.done;
    const back = await db.get('pages', k); if (!eq(await sha(back.bytes), sum)) throw new Error('sum');
    r.idbOut.push(now() - t0);
    t0 = now(); const rec = await db.get('pages', k); r.idbReadOnly.push(now() - t0);
    if (!eq(await sha(rec.bytes), rec.sum)) throw new Error('sum'); JSON.parse(new TextDecoder().decode(rec.bytes));
    r.idbIn.push(now() - t0);
  };
  const opfs = async (k) => {
    let t0 = now();
    const fh = await dir.getFileHandle(k + '.tmp', { create: true });
    const h = await fh.createSyncAccessHandle(); h.truncate(0); h.write(bytes, { at: 0 }); h.flush();
    const rb = new Uint8Array(h.getSize()); h.read(rb, { at: 0 }); h.close();
    if (!eq(await sha(rb), sum)) throw new Error('sum');
    await fh.move(k + '.pg');
    r.opfsOut.push(now() - t0);
    t0 = now();
    const h2 = await (await dir.getFileHandle(k + '.pg')).createSyncAccessHandle({ mode: 'read-only' });
    const buf = new Uint8Array(h2.getSize()); h2.read(buf, { at: 0 }); h2.close();
    r.opfsReadOnly.push(now() - t0);
    if (!eq(await sha(buf), sum)) throw new Error('sum'); JSON.parse(new TextDecoder().decode(buf));
    r.opfsIn.push(now() - t0);
  };
  for (let i = 0; i < N; i++) {
    if (i % 2) { await idb('p' + i); await opfs('p' + i); } else { await opfs('p' + i); await idb('p' + i); }
    const t0 = now(); await sha(bytes); JSON.parse(new TextDecoder().decode(bytes)); r.parseAndVerify.push(now() - t0);
  }
  db.close();
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, stats(v)]));
}

async function openVfs(name) {
  return openDB(name, 1, {
    upgrade(d) {
      d.createObjectStore('inodes', { keyPath: 'ino' }).createIndex('by_uid_mtime', ['uid', 'mtime']);
      d.createObjectStore('dentries', { keyPath: ['parent', 'name'] }).createIndex('by_ino', 'ino');
      d.createObjectStore('users', { keyPath: 'uid' });
      d.createObjectStore('undo', { keyPath: 'opId' });
      d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }).createIndex('by_op', 'opId', { unique: true });
    },
  });
}
// seed an n-node subtree (fan-out 10, 30% dirs) in ONE txn; returns plan (what the in-memory tree would hold)
async function seed(db, parent, rootIno, n, next) {
  const tx = db.transaction(['inodes', 'dentries', 'users'], 'readwrite');
  const I = tx.objectStore('inodes'), D = tx.objectStore('dentries');
  const plan = [{ ino: rootIno, type: 'dir', size: 0, parent, name: 'd' + rootIno }];
  I.put({ ino: rootIno, type: 'dir', mode: 0o755, uid: 1001, gid: 100, size: 0, nlink: 2, version: 1, mtime: Date.now() });
  D.put({ parent, name: 'd' + rootIno, ino: rootIno });
  const q = [rootIno]; let c = 1, bytes = 0;
  while (c < n) {
    const p = q.shift();
    for (let k = 0; k < 10 && c < n; k++, c++) {
      const ino = next++, isDir = k < 3, size = isDir ? 0 : 2048; bytes += size;
      I.put({ ino, type: isDir ? 'dir' : 'file', mode: 0o644, uid: 1001, gid: 100, size, nlink: 1, version: 1, mtime: Date.now() - k * 1000 });
      D.put({ parent: p, name: 'n' + k + '-' + ino, ino });
      plan.push({ ino, type: isDir ? 'dir' : 'file', size, parent: p, name: 'n' + k + '-' + ino });
      if (isDir) q.push(ino);
    }
  }
  const u = (await tx.objectStore('users').get(1001)) || { uid: 1001, usedBytes: 0, usedInodes: 0 };
  u.usedBytes += bytes; u.usedInodes += n; tx.objectStore('users').put(u);
  await tx.done;
  return { plan, next };
}
class Fault extends Error {}
// rm -r from the kernel's in-memory plan: blind deletes, ONE txn over 5 stores, strict durability, fault hook
function rmPlanned(db, plan, failAfter = Infinity) {
  return new Promise((resolve, reject) => {
    const tx = unwrap(db).transaction(['inodes', 'dentries', 'users', 'undo', 'outbox'], 'readwrite', { durability: 'strict' });
    const I = tx.objectStore('inodes'), D = tx.objectStore('dentries');
    const opId = crypto.randomUUID();
    let freed = 0;
    try {
      plan.forEach((node, i) => {
        if (i + 1 > failAfter) throw new Fault('injected fault after ' + failAfter + ' node ops');
        I.delete(node.ino);
        if (node.type === 'dir') D.delete(IDBKeyRange.bound([node.ino, ''], [node.ino, '￿']));
        freed += node.size;
      });
      D.delete([plan[0].parent, plan[0].name]);
      const g = tx.objectStore('users').get(1001);
      g.onsuccess = () => { const u = g.result; u.usedBytes -= freed; u.usedInodes -= plan.length; tx.objectStore('users').put(u); };
      tx.objectStore('undo').put({ opId, nodes: plan });
      tx.objectStore('outbox').add({ opId, lts: Date.now(), call: 'unlink', args: { ino: plan[0].ino, recursive: true }, pre: [{ ino: plan[0].ino, version: 1 }], state: 'pending' });
    } catch (e) { tx.abort(); return reject(e); }
    tx.oncomplete = () => resolve(freed);
    tx.onabort = () => reject(tx.error || new Error('abort'));
  });
}
async function probe(db) {
  const tx = db.transaction(['inodes', 'dentries', 'users']);
  const [ic, dc, u] = await Promise.all([tx.objectStore('inodes').count(), tx.objectStore('dentries').count(), tx.objectStore('users').get(1001)]);
  return `${ic}/${dc}/${u.usedBytes}/${u.usedInodes}`;
}

async function bulkOps(N = 20) {
  const db = await openVfs('vfs2');
  let { next } = await seed(db, 1, 2, 10000, 100);
  // SQLite side, same shapes
  const { default: init } = await import('/node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs');
  const sqlite3 = await init();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'bench2' });
  const sdb = new pool.OpfsSAHPoolDb('/vfs2.db');
  sdb.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE inodes(ino INTEGER PRIMARY KEY, type TEXT CHECK(type IN ('file','dir','symlink')), mode INT, uid INT, size INT, version INT);
    CREATE TABLE dentries(parent INT, name TEXT, ino INT NOT NULL REFERENCES inodes(ino) ON DELETE CASCADE, PRIMARY KEY(parent,name)) WITHOUT ROWID;
    CREATE INDEX dentries_ino ON dentries(ino);`);
  const sSeed = (root, n, start) => {
    const plan = [];
    sdb.exec('BEGIN');
    const qi = sdb.prepare('INSERT INTO inodes VALUES(?,?,?,?,?,1)'), qd = sdb.prepare('INSERT INTO dentries VALUES(?,?,?)');
    qi.bind([root, 'dir', 493, 1001, 0]).stepReset(); qd.bind([1, 'd' + root, root]).stepReset();
    const q = [root]; let c = 1, nx = start;
    while (c < n) { const p = q.shift(); for (let k = 0; k < 10 && c < n; k++, c++) { const ino = nx++; qi.bind([ino, k < 3 ? 'dir' : 'file', 420, 1001, 2048]).stepReset(); qd.bind([p, 'n' + k + '-' + ino, ino]).stepReset(); if (k < 3) q.push(ino); } }
    qi.finalize(); qd.finalize(); sdb.exec('COMMIT');
    return nx;
  };
  let snext = sSeed(2, 10000, 100);
  const r = { idbSeed1000: [], idbRmPlanned1000: [], sqliteSeed1000: [], sqliteRm1000: [] };
  let faultOk = 0, positiveOk = 0;
  for (let i = 0; i < N; i++) {
    let t0 = now();
    const s = await seed(db, 1, next, 1000, next + 1); next = s.next + 1;
    r.idbSeed1000.push(now() - t0);
    const before = await probe(db);
    try { await rmPlanned(db, s.plan, 500); } catch (e) { if (!(e instanceof Fault)) throw e; }
    if ((await probe(db)) === before) faultOk++;
    t0 = now(); await rmPlanned(db, s.plan); r.idbRmPlanned1000.push(now() - t0);
    const after = await probe(db);
    if (after !== before && after.startsWith(String(+before.split('/')[0] - 1000))) positiveOk++;
    // SQLite
    const sroot = snext; t0 = now(); snext = sSeed(sroot, 1000, sroot + 1) + 1; r.sqliteSeed1000.push(now() - t0);
    t0 = now();
    sdb.exec('BEGIN');
    sdb.exec({ sql: `WITH RECURSIVE sub(ino) AS (SELECT ? UNION ALL SELECT d.ino FROM dentries d JOIN sub ON d.parent=sub.ino) DELETE FROM inodes WHERE ino IN (SELECT ino FROM sub)`, bind: [sroot] });
    sdb.exec({ sql: 'DELETE FROM dentries WHERE parent=1 AND name=?', bind: ['d' + sroot] });
    sdb.exec('COMMIT');
    r.sqliteRm1000.push(now() - t0);
  }
  const sLeft = sdb.selectValue('SELECT count(*) FROM inodes');
  sdb.close();
  // boot: full metadata load vs lazy (root + /home level + 2 levels of the user's tree)
  const full = [], lazy = [];
  let rows = 0;
  for (let i = 0; i < 12; i++) {
    let t0 = now();
    const d2 = await openVfs('vfs2');
    const tx = d2.transaction(['inodes', 'dentries']);
    const [inos, dens] = await Promise.all([tx.objectStore('inodes').getAll(), tx.objectStore('dentries').getAll()]);
    const m = new Map(); for (const d of dens) { let c = m.get(d.parent); if (!c) m.set(d.parent, (c = new Map())); c.set(d.name, d.ino); }
    rows = inos.length; full.push(now() - t0); d2.close();
    t0 = now();
    const d3 = await openVfs('vfs2');
    const tx3 = d3.transaction(['inodes', 'dentries']);
    const D = tx3.objectStore('dentries'), I = tx3.objectStore('inodes');
    let frontier = [2], loaded = 0;
    for (let level = 0; level < 3; level++) {
      const lists = await Promise.all(frontier.map((p) => D.getAll(IDBKeyRange.bound([p, ''], [p, '￿']))));
      const ents = lists.flat(); loaded += ents.length;
      const nodes = await Promise.all(ents.map((e) => I.get(e.ino)));
      frontier = nodes.filter((n) => n.type === 'dir').map((n) => n.ino).slice(0, 10);
    }
    lazy.push(now() - t0); d3.close();
    out.lazyEntries = loaded;
  }
  db.close();
  return { ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, stats(v)])), faultInjectionUnchanged: `${faultOk}/${N}`, successDeleted1000: `${positiveOk}/${N}`, sqliteLeftover: sLeft,
    bootFullLoad: { ...stats(full), inodes: rows }, bootLazyLoad: stats(lazy) };
}

async function sqliteColdInit(N = 5) {
  // fresh module instance each time is not possible in one worker; measure first init separately in round 1
  return null;
}

self.onmessage = async () => {
  try {
    out.ua = navigator.userAgent;
    out.swap = await swapInterleaved();
    self.postMessage({ progress: 'swap', t: now() });
    out.bulk = await bulkOps();
    self.postMessage({ ok: true, out });
  } catch (e) { self.postMessage({ ok: false, err: String((e && e.stack) || e), out }); }
};
