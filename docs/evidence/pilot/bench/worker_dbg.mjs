// Storage micro-benchmarks for the client-storage decision record.
// Runs in a dedicated module worker (the same place the Plotinium storage worker will live).
import { openDB } from '/node_modules/idb/build/index.js';

const now = () => performance.now();
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2);
};
const stats = (arr) => ({ n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), max: +Math.max(...arr).toFixed(2) });
const sha = async (buf) => new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function randBytes(n) {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(u.subarray(i, Math.min(n, i + 65536)));
  return u;
}
// A "process state" of ~5 MB that must be serialised (JSON) as in a real page-out.
function makeState(bytes) {
  const lines = [];
  let size = 0, i = 0;
  while (size < bytes) {
    const l = `line ${i++}: the quick brown fox jumps over the lazy dog ${Math.random()}`;
    lines.push(l);
    size += l.length + 4;
  }
  return { kind: 'editor-buffer', cursor: 12, lines };
}

const RUNS = 40;
const out = {};

async function benchIdbSwap(durability) {
  const db = await openDB('swap-' + durability, 1, { upgrade(d) { d.createObjectStore('pages'); } });
  const state = makeState(5 * 1024 * 1024);
  const outT = [], inT = [];
  for (let r = 0; r < RUNS; r++) {
    // page-out: serialise -> checksum -> write -> read back & verify -> release
    let t0 = now();
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    const sum = await sha(bytes);
    const tx = db.transaction('pages', 'readwrite', { durability });
    tx.store.put({ bytes: bytes.buffer, sum }, 'p' + r);
    await tx.done;
    const back = await db.get('pages', 'p' + r);
    if (!eq(await sha(back.bytes), sum)) throw new Error('checksum');
    outT.push(now() - t0);
    // page-in: read -> verify -> deserialise
    t0 = now();
    const rec = await db.get('pages', 'p' + r);
    if (!eq(await sha(rec.bytes), rec.sum)) throw new Error('checksum');
    const obj = JSON.parse(new TextDecoder().decode(rec.bytes));
    if (obj.lines.length !== state.lines.length) throw new Error('mismatch');
    inT.push(now() - t0);
  }
  db.close();
  return { pageOut: stats(outT), pageIn: stats(inT), payloadMB: +(new TextEncoder().encode(JSON.stringify(state)).length / 1048576).toFixed(2) };
}

async function benchOpfsSwap() {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('swap', { create: true });
  const state = makeState(5 * 1024 * 1024);
  const outT = [], inT = [];
  for (let r = 0; r < RUNS; r++) {
    let t0 = now();
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    const sum = await sha(bytes);
    const fh = await dir.getFileHandle('p' + r + '.tmp', { create: true });
    const h = await fh.createSyncAccessHandle();
    h.truncate(0);
    h.write(bytes, { at: 0 });
    h.flush();
    const rb = new Uint8Array(h.getSize());
    h.read(rb, { at: 0 });
    h.close();
    if (!eq(await sha(rb), sum)) throw new Error('checksum');
    await fh.move('p' + r); // publish atomically by rename
    outT.push(now() - t0);
    t0 = now();
    const fh2 = await dir.getFileHandle('p' + r);
    const h2 = await fh2.createSyncAccessHandle({ mode: 'read-only' });
    const buf = new Uint8Array(h2.getSize());
    h2.read(buf, { at: 0 });
    h2.close();
    if (!eq(await sha(buf), sum)) throw new Error('checksum');
    const obj = JSON.parse(new TextDecoder().decode(buf));
    if (obj.lines.length !== state.lines.length) throw new Error('mismatch');
    inT.push(now() - t0);
  }
  return { pageOut: stats(outT), pageIn: stats(inT) };
}

// ---- VFS metadata mirror: atomic rm -r across stores in ONE IndexedDB transaction ----
async function openVfs(name) {
  return openDB(name, 1, {
    upgrade(d) {
      const ino = d.createObjectStore('inodes', { keyPath: 'ino' });
      ino.createIndex('by_uid_mtime', ['uid', 'mtime']);
      const de = d.createObjectStore('dentries', { keyPath: ['parent', 'name'] });
      de.createIndex('by_ino', 'ino');
      d.createObjectStore('users', { keyPath: 'uid' });
      d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }).createIndex('by_op', 'opId', { unique: true });
    },
  });
}
// build a tree of `n` nodes under parent 1 (fan-out 10) -> returns inos
async function seedTree(db, rootIno, n, startIno) {
  const tx = db.transaction(['inodes', 'dentries', 'users'], 'readwrite');
  const inodes = tx.objectStore('inodes'), dentries = tx.objectStore('dentries');
  const queue = [rootIno];
  let next = startIno, bytes = 0;
  inodes.put({ ino: rootIno, type: 'dir', mode: 0o755, uid: 1001, size: 0, nlink: 2, version: 1, mtime: Date.now() });
  dentries.put({ parent: 1, name: 'old-drafts-' + rootIno, ino: rootIno });
  let created = 1;
  while (created < n) {
    const p = queue.shift();
    for (let k = 0; k < 10 && created < n; k++, created++) {
      const ino = next++;
      const isDir = k < 3;
      const size = isDir ? 0 : 2048;
      bytes += size;
      inodes.put({ ino, type: isDir ? 'dir' : 'file', mode: 0o644, uid: 1001, size, nlink: 1, version: 1, mtime: Date.now() - k * 1000 });
      dentries.put({ parent: p, name: 'n' + k + '-' + ino, ino });
      if (isDir) queue.push(ino);
    }
  }
  const u = (await tx.objectStore('users').get(1001)) || { uid: 1001, usedBytes: 0, usedInodes: 0, quotaBytes: 1e12, quotaInodes: 1e7 };
  u.usedBytes += bytes; u.usedInodes += n;
  tx.objectStore('users').put(u);
  await tx.done;
  return next;
}
class FaultInjected extends Error {}
// rm -r: walk subtree via [parent,name] key range, delete inodes + dentries, update quota, append ONE outbox op
function rmR(db, rootIno, failAfter = Infinity) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['inodes', 'dentries', 'users', 'outbox'], 'readwrite', { durability: 'strict' });
    const inodes = tx.objectStore('inodes'), dentries = tx.objectStore('dentries');
    let ops = 0, freedBytes = 0, freedInodes = 0, pending = 0, done = false;
    const fail = (e) => { if (!done) { done = true; try { tx.abort(); } catch {} reject(e); } };
    const finish = () => {
      // all subtree nodes deleted: detach root dentry, update quota, append outbox op
      const q = tx.objectStore('users').get(1001);
      q.onsuccess = () => {
        const u = q.result; u.usedBytes -= freedBytes; u.usedInodes -= freedInodes;
        tx.objectStore('users').put(u);
        dentries.delete([1, 'old-drafts-' + rootIno]);
        tx.objectStore('outbox').add({ opId: crypto.randomUUID(), lts: Date.now(), op: 'unlink', args: { ino: rootIno, recursive: true }, baseVersion: 1, state: 'pending' });
      };
    };
    const visit = (ino) => {
      pending++;
      const g = inodes.get(ino);
      g.onsuccess = () => {
        const node = g.result;
        if (++ops > failAfter) return fail(new FaultInjected('fault after ' + failAfter));
        freedBytes += node.size; freedInodes++;
        inodes.delete(ino);
        if (node.type === 'dir') {
          const range = IDBKeyRange.bound([ino, ''], [ino, '￿']);
          const c = dentries.getAll(range);
          c.onsuccess = () => {
            for (const d of c.result) visit(d.ino);
            dentries.delete(range);
            if (--pending === 0) finish();
          };
        } else if (--pending === 0) finish();
      };
    };
    visit(rootIno);
    tx.oncomplete = () => resolve({ ops, freedInodes });
    tx.onerror = (e) => { e.preventDefault?.(); };
    tx.onabort = () => { if (!done) { done = true; reject(tx.error || new Error('aborted')); } };
  });
}
async function checksumTree(db) {
  const tx = db.transaction(['inodes', 'dentries', 'users'], 'readonly');
  const [ic, dc, u] = await Promise.all([tx.objectStore('inodes').count(), tx.objectStore('dentries').count(), tx.objectStore('users').get(1001)]);
  return `${ic}/${dc}/${u.usedBytes}/${u.usedInodes}`;
}
async function benchRmR() {
  const db = await openVfs('vfs-rm');
  // background population: 10,000 other inodes so the stores are realistic
  let next = await seedTree(db, 2, 10000, 100);
  const t = [], seedT = [];
  let faultOk = 0;
  for (let r = 0; r < 15; r++) {
    const root = next++;
    let t0 = now();
    next = await seedTree(db, root, 1000, next);
    seedT.push(now() - t0);
    // fault injection at node 500 -> must leave the tree unchanged
    const before = await checksumTree(db);
    try { await rmR(db, root, 500); } catch (e) { if (!(e instanceof FaultInjected) && e.name !== 'AbortError') throw e; }
    const after = await checksumTree(db);
    if (before === after) faultOk++;
    t0 = now();
    const res = await rmR(db, root);
    t.push(now() - t0);
    const after2 = await checksumTree(db);
    if (r < 2) (out.dbg ||= []).push({before, after, after2, res});
  }
  db.close();
  return { rmR1000_strict: stats(t), bulkInsert1000: stats(seedT), faultInjectionUnchanged: `${faultOk}/15` };
}
async function benchResolveAndBoot() {
  const db = await openVfs('vfs-rm');
  // point lookups on compound key [parent,name] (cold-path path-resolution step)
  const all = await db.getAll('dentries');
  const lk = [];
  for (let i = 0; i < 1000; i++) {
    const d = all[(Math.random() * all.length) | 0];
    const t0 = now();
    const tx = db.transaction(['dentries', 'inodes']);
    const de = await tx.objectStore('dentries').get([d.parent, d.name]);
    await tx.objectStore('inodes').get(de.ino);
    lk.push(now() - t0);
  }
  db.close();
  // boot: open + load entire metadata to rebuild the in-memory n-ary tree
  const bootT = [];
  let rows = 0;
  for (let r = 0; r < 10; r++) {
    const t0 = now();
    const db2 = await openVfs('vfs-rm');
    const tx = db2.transaction(['inodes', 'dentries']);
    const [inos, dens] = await Promise.all([tx.objectStore('inodes').getAll(), tx.objectStore('dentries').getAll()]);
    const children = new Map();
    for (const d of dens) { let m = children.get(d.parent); if (!m) children.set(d.parent, (m = new Map())); m.set(d.name, d.ino); }
    rows = inos.length;
    bootT.push(now() - t0);
    db2.close();
  }
  return { dentryPlusInodeGet: stats(lk), bootLoadAllMetadata: { ...stats(bootT), inodes: rows } };
}
async function benchOutboxAppend() {
  const db = await openVfs('vfs-outbox');
  const res = {};
  for (const durability of ['relaxed', 'strict']) {
    const t = [];
    for (let i = 0; i < 200; i++) {
      const t0 = now();
      const tx = db.transaction(['inodes', 'outbox'], 'readwrite', { durability });
      tx.objectStore('inodes').put({ ino: 1e6 + i, type: 'file', mode: 0o644, uid: 1001, size: 10, nlink: 1, version: 1, mtime: Date.now() });
      tx.objectStore('outbox').add({ opId: crypto.randomUUID(), lts: i, op: 'write', args: { ino: 1e6 + i }, state: 'pending' });
      await tx.done;
      t.push(now() - t0);
    }
    res['writePlusOutbox_' + durability] = stats(t);
  }
  db.close();
  return res;
}
async function benchSqlite() {
  const t0 = now();
  const { default: init } = await import('/node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs');
  const sqlite3 = await init();
  const tInit = now() - t0;
  const t1 = now();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'bench-pool' });
  const db = new pool.OpfsSAHPoolDb('/vfs.db');
  const tOpen = now() - t1;
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS inodes(ino INTEGER PRIMARY KEY, type TEXT, size INT);
    CREATE TABLE IF NOT EXISTS dentries(parent INT, name TEXT, ino INT REFERENCES inodes(ino) ON DELETE CASCADE, PRIMARY KEY(parent,name));`);
  const rm = [];
  let next = 10;
  for (let r = 0; r < 15; r++) {
    const root = next;
    db.exec('BEGIN');
    const qi = db.prepare('INSERT INTO inodes VALUES(?,?,?)'), qd = db.prepare('INSERT INTO dentries VALUES(?,?,?)');
    qi.bind([root, 'dir', 0]).stepReset(); qd.bind([1, 'r' + root, root]).stepReset();
    const queue = [root]; let c = 1; next++;
    while (c < 1000) { const p = queue.shift(); for (let k = 0; k < 10 && c < 1000; k++, c++) { const ino = next++; qi.bind([ino, k < 3 ? 'dir' : 'file', 2048]).stepReset(); qd.bind([p, 'n' + k, ino]).stepReset(); if (k < 3) queue.push(ino); } }
    qi.finalize(); qd.finalize();
    db.exec('COMMIT');
    const t2 = now();
    db.exec('BEGIN');
    db.exec({ sql: `WITH RECURSIVE sub(ino) AS (SELECT ? UNION ALL SELECT d.ino FROM dentries d JOIN sub ON d.parent=sub.ino)
      DELETE FROM inodes WHERE ino IN (SELECT ino FROM sub)`, bind: [root] });
    db.exec({ sql: 'DELETE FROM dentries WHERE parent=1 AND name=?', bind: ['r' + root] });
    db.exec('COMMIT');
    rm.push(now() - t2);
  }
  const left = db.selectValue('SELECT count(*) FROM inodes');
  db.close();
  return { leftoverInodes: left, initWasmMs: +tInit.toFixed(1), installSahPoolAndOpenMs: +tOpen.toFixed(1), rmR1000: stats(rm) };
}
async function benchPbkdf2() {
  const t = [];
  for (let i = 0; i < 5; i++) {
    const t0 = now();
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('correct horse battery staple'), 'PBKDF2', false, ['deriveBits']);
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: crypto.getRandomValues(new Uint8Array(16)), iterations: 600000 }, key, 256);
    t.push(now() - t0);
  }
  return { pbkdf2_600k: stats(t) };
}

self.onmessage = async () => {
  try {
    if (self.location.search.includes('debug')) { out.rmR = await benchRmR(); self.postMessage({ ok: true, out }); return; }
    out.chrome = navigator.userAgent;
    out.cores = navigator.hardwareConcurrency;
    out.persistedBefore = await navigator.storage.persisted?.();
    out.idbSwap_relaxed = await benchIdbSwap('relaxed');
    self.postMessage({ progress: 'idbSwap_relaxed', t: performance.now() });
    out.idbSwap_strict = await benchIdbSwap('strict');
    self.postMessage({ progress: 'idbSwap_strict', t: performance.now() });
    out.opfsSwap = await benchOpfsSwap();
    self.postMessage({ progress: 'opfsSwap', t: performance.now() });
    out.rmR = await benchRmR();
    self.postMessage({ progress: 'rmR', t: performance.now() });
    out.lookupAndBoot = await benchResolveAndBoot();
    self.postMessage({ progress: 'lookupAndBoot', t: performance.now() });
    out.outbox = await benchOutboxAppend();
    self.postMessage({ progress: 'outbox', t: performance.now() });
    out.sqlite = await benchSqlite();
    self.postMessage({ progress: 'sqlite', t: performance.now() });
    out.pbkdf2 = await benchPbkdf2();
    self.postMessage({ progress: 'pbkdf2', t: performance.now() });
    out.estimate = await navigator.storage.estimate();
    self.postMessage({ ok: true, out });
  } catch (e) {
    self.postMessage({ ok: false, err: String(e && e.stack || e), out });
  }
};
