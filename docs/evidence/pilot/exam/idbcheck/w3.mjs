import { openDB, unwrap } from '/node_modules/idb/build/index.js';
const now = () => performance.now();
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };
const st = (a) => ({ n: a.length, p50: pct(a, 50), p95: pct(a, 95) });
const out = {};
out.persistInWorker = typeof navigator.storage.persist;
out.persistedInWorker = typeof navigator.storage.persisted;
out.estimateInWorker = typeof navigator.storage.estimate;
async function openVfs(name) {
  return openDB(name, 1, { upgrade(d) {
    d.createObjectStore('inodes', { keyPath: 'ino' });
    d.createObjectStore('dentries', { keyPath: ['parent', 'name'] }).createIndex('by_ino', 'ino');
    d.createObjectStore('users', { keyPath: 'uid' });
    d.createObjectStore('undo', { keyPath: 'opId' });
    d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
  } });
}
async function seed(db, parent, root, n, next) {
  const tx = db.transaction(['inodes', 'dentries', 'users'], 'readwrite');
  const I = tx.objectStore('inodes'), D = tx.objectStore('dentries');
  I.put({ ino: root, type: 'dir', size: 0, version: 1 }); D.put({ parent, name: 'd' + root, ino: root });
  const q = [root]; let c = 1, bytes = 0;
  while (c < n) { const p = q.shift(); for (let k = 0; k < 10 && c < n; k++, c++) { const ino = next++, dir = k < 3, size = dir ? 0 : 2048; bytes += size;
    I.put({ ino, type: dir ? 'dir' : 'file', size, version: 1 }); D.put({ parent: p, name: 'n' + k + '-' + ino, ino }); if (dir) q.push(ino); } }
  const u = (await tx.objectStore('users').get(1)) || { uid: 1, usedBytes: 0, usedInodes: 0 }; u.usedBytes += bytes; u.usedInodes += n; tx.objectStore('users').put(u);
  await tx.done; return next;
}
// cold path: kernel has NOT loaded this subtree; ensureLoaded = readonly level-by-level key-range getAll + inode gets
async function ensureLoaded(db, parent, root) {
  const tx = db.transaction(['inodes', 'dentries']);
  const D = tx.objectStore('dentries'), I = tx.objectStore('inodes');
  const plan = [{ ino: root, type: 'dir', size: 0, parent, name: 'd' + root }];
  let frontier = [root];
  while (frontier.length) {
    const lists = await Promise.all(frontier.map((p) => D.getAll(IDBKeyRange.bound([p, ''], [p, '￿']))));
    const ents = lists.flat();
    const nodes = await Promise.all(ents.map((e) => I.get(e.ino)));
    nodes.forEach((n, i) => plan.push({ ino: n.ino, type: n.type, size: n.size, parent: ents[i].parent, name: ents[i].name }));
    frontier = nodes.filter((n) => n.type === 'dir').map((n) => n.ino);
  }
  await tx.done; return plan;
}
class Fault extends Error {}
// failMode 'sync' = throw in builder before requests execute; 'executed' = throw from onsuccess of the N-th delete (ops really applied inside tx)
function rm(db, plan, failAfter = Infinity, failMode = 'sync') {
  return new Promise((resolve, reject) => {
    const tx = unwrap(db).transaction(['inodes', 'dentries', 'users', 'undo', 'outbox'], 'readwrite', { durability: 'strict' });
    const I = tx.objectStore('inodes'), D = tx.objectStore('dentries'); let freed = 0, done = 0, failed = false;
    try {
      plan.forEach((n, i) => {
        if (failMode === 'sync' && i + 1 > failAfter) throw new Fault('sync');
        const r = I.delete(n.ino);
        if (failMode === 'executed') r.onsuccess = () => { if (++done === failAfter && !failed) { failed = true; tx.abort(); reject(new Fault('executed')); } };
        if (n.type === 'dir') D.delete(IDBKeyRange.bound([n.ino, ''], [n.ino, '￿']));
        freed += n.size;
      });
      D.delete([plan[0].parent, plan[0].name]);
      const g = tx.objectStore('users').get(1); g.onsuccess = () => { const u = g.result; u.usedBytes -= freed; u.usedInodes -= plan.length; tx.objectStore('users').put(u); };
      const opId = crypto.randomUUID();
      tx.objectStore('undo').put({ opId, nodes: plan }); tx.objectStore('outbox').add({ opId, call: 'unlink' });
    } catch (e) { tx.abort(); return reject(e); }
    tx.oncomplete = () => resolve(freed); tx.onabort = () => { if (!failed) reject(tx.error || new Error('abort')); };
  });
}
async function probe(db) { const tx = db.transaction(['inodes', 'dentries', 'users']); const [a, b, u] = await Promise.all([tx.objectStore('inodes').count(), tx.objectStore('dentries').count(), tx.objectStore('users').get(1)]); return `${a}/${b}/${u.usedBytes}/${u.usedInodes}`; }
async function main() {
  const db = await openVfs('v3');
  let next = await seed(db, 1, 2, 10000, 100);
  const r = { ensureLoaded1000: [], rmPlanned1000: [], endToEndCold1000: [] };
  let execFaultOk = 0, syncFaultOk = 0, posOk = 0; const N = 20;
  for (let i = 0; i < N; i++) {
    const root = next++; next = await seed(db, 1, root, 1000, next) + 1;
    const before = await probe(db);
    let p = await ensureLoaded(db, 1, root);
    try { await rm(db, p, 500, 'executed'); } catch (e) { if (!(e instanceof Fault)) throw e; }
    if ((await probe(db)) === before) execFaultOk++;
    try { await rm(db, p, 500, 'sync'); } catch (e) { if (!(e instanceof Fault)) throw e; }
    if ((await probe(db)) === before) syncFaultOk++;
    let t0 = now(); p = await ensureLoaded(db, 1, root); const t1 = now(); await rm(db, p); const t2 = now();
    r.ensureLoaded1000.push(t1 - t0); r.rmPlanned1000.push(t2 - t1); r.endToEndCold1000.push(t2 - t0);
    const after = await probe(db); if (after.startsWith(String(+before.split('/')[0] - 1000) + '/')) posOk++;
    out.planLen = p.length;
  }
  out.bulk = { ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, st(v)])), execFaultUnchanged: `${execFaultOk}/${N}`, syncFaultUnchanged: `${syncFaultOk}/${N}`, positive: `${posOk}/${N}` };
  // scheduling: long readonly scan vs small readwrite
  const w = [];
  for (let i = 0; i < 8; i++) {
    const ro = db.transaction(['inodes', 'dentries']);
    const scan = Promise.all([ro.objectStore('inodes').getAll(), ro.objectStore('dentries').getAll()]);
    const tA = now();
    const rw = db.transaction(['inodes', 'outbox'], 'readwrite', { durability: 'strict' });
    rw.objectStore('outbox').add({ opId: 'x' + i + Math.random(), call: 'mkdir' }); rw.objectStore('inodes').put({ ino: 9e9 + i, type: 'dir', size: 0, version: 1 });
    let roDone = 0; scan.then(() => { roDone = now() - tA; });
    await rw.done; const rwDone = now() - tA; await scan; await ro.done;
    w.push({ rwCommitMs: +rwDone.toFixed(1), roScanMs: +roDone.toFixed(1), rwFinishedAfterScan: rwDone >= roDone && roDone > 0 });
  }
  out.scheduling = w;
  const alone = []; for (let i = 0; i < 20; i++) { const t = now(); const rw = db.transaction(['inodes', 'outbox'], 'readwrite', { durability: 'strict' }); rw.objectStore('outbox').add({ opId: 'y' + i + Math.random() }); rw.objectStore('inodes').put({ ino: 8e9 + i, type: 'dir' }); await rw.done; alone.push(now() - t); }
  out.smallRwAlone = st(alone);
  db.close();
}
self.onmessage = async () => { try { await main(); self.postMessage({ ok: true, out }); } catch (e) { self.postMessage({ ok: false, err: String(e && e.stack || e), out }); } };
