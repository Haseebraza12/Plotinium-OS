import { openDB } from '/node_modules/idb/build/index.js';
const now = () => performance.now();
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))].toFixed(1); };
const st = (a) => ({ n: a.length, p50: pct(a, 50), p95: pct(a, 95) });
const sha = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function mk(bytes) { const L = []; let s = 0, i = 0; while (s < bytes) { const l = `line ${i++}: quick brown fox ${Math.random()}`; L.push(l); s += l.length + 4; } return new TextEncoder().encode(JSON.stringify({ L })); }
async function main() {
  const out = {};
  const e = await navigator.storage.estimate(); out.quotaGB = +(e.quota / 1e9).toFixed(2); out.persisted = await navigator.storage.persisted();
  const db = await openDB('s4', 1, { upgrade(d) { d.createObjectStore('pages'); d.createObjectStore('small', { autoIncrement: true }); } });
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('s4', { create: true });
  const bytes = mk(5 * 1024 * 1024), sum = await sha(bytes);
  const r = { smallStrict: [], smallRelaxed: [], idbOutRelaxed: [], idbOutStrict: [], idbIn: [], opfsOut: [], opfsIn: [] };
  for (let i = 0; i < 100; i++) for (const d of (i % 2 ? ['strict', 'relaxed'] : ['relaxed', 'strict'])) { const t = now(); const tx = db.transaction('small', 'readwrite', { durability: d }); tx.store.add({ i, op: 'mkdir', args: { p: '/home/x' + i } }); await tx.done; r[d === 'strict' ? 'smallStrict' : 'smallRelaxed'].push(now() - t); }
  const idbOut = async (k, d, arr) => { const t = now(); const tx = db.transaction('pages', 'readwrite', { durability: d }); tx.store.put({ b: bytes.slice().buffer, sum }, k); await tx.done; const back = await db.get('pages', k); if (!eq(await sha(back.b), sum)) throw 1; arr.push(now() - t); };
  const idbIn = async (k) => { const t = now(); const rec = await db.get('pages', k); if (!eq(await sha(rec.b), rec.sum)) throw 1; JSON.parse(new TextDecoder().decode(rec.b)); r.idbIn.push(now() - t); };
  const opfsOut = async (k) => { const t = now(); const fh = await dir.getFileHandle(k + '.tmp', { create: true }); const h = await fh.createSyncAccessHandle(); h.truncate(0); h.write(bytes, { at: 0 }); h.flush(); const rb = new Uint8Array(h.getSize()); h.read(rb, { at: 0 }); h.close(); if (!eq(await sha(rb), sum)) throw 1; await fh.move(k + '.pg'); r.opfsOut.push(now() - t); };
  const opfsIn = async (k) => { const t = now(); const h = await (await dir.getFileHandle(k + '.pg')).createSyncAccessHandle({ mode: 'read-only' }); const b = new Uint8Array(h.getSize()); h.read(b, { at: 0 }); h.close(); if (!eq(await sha(b), sum)) throw 1; JSON.parse(new TextDecoder().decode(b)); r.opfsIn.push(now() - t); };
  for (let j = 0; j < 8; j++) { await idbOut('p' + j, 'relaxed', []); await idbOut('p' + j + 's', 'strict', []); await opfsOut('p' + j); }
  for (const k of Object.keys(r)) if (k.startsWith('opfs')) r[k].length = 0;
  for (let i = 0; i < 40; i++) {
    const k = 'p' + (i % 8);
    const seq = [() => idbOut(k, 'relaxed', r.idbOutRelaxed), () => idbIn(k), () => idbOut(k + 's', 'strict', r.idbOutStrict), () => opfsOut(k), () => opfsIn(k)];
    if (i % 2) seq.reverse();
    for (const f of seq) await f();
  }
  db.close();
  out.r = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, st(v)]));
  return out;
}
self.onmessage = async () => { try { self.postMessage({ ok: true, out: await main() }); } catch (e) { self.postMessage({ ok: false, err: String(e && e.stack || e) }); } };
