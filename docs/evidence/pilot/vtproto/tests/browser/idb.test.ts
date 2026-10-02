import { test, expect } from 'vitest';
const open = (name: string) => new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(name, 1);
  r.onupgradeneeded = () => { const s = r.result.createObjectStore('dentries', { keyPath: ['parent', 'name'] }); r.result.createObjectStore('quota'); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
class InjectedFault extends Error {}
test('IndexedDB: fault after N of M node ops aborts the whole transaction (client mirror atomicity)', async () => {
  const db = await open('fi-' + Math.random());
  await new Promise<void>((res) => { const tx = db.transaction(['dentries', 'quota'], 'readwrite');
    for (let i = 0; i < 1000; i++) tx.objectStore('dentries').put({ parent: 1, name: 'f' + i, ino: 100 + i }); tx.objectStore('quota').put(1000, 'u1'); tx.oncomplete = () => res(); });
  const failAfter = 500; let ops = 0;
  const result = await new Promise<string>((res) => { const tx = db.transaction(['dentries', 'quota'], 'readwrite');
    tx.onabort = () => res('aborted'); tx.oncomplete = () => res('committed');
    const st = tx.objectStore('dentries');
    try { for (let i = 0; i < 1000; i++) { if (++ops > failAfter) throw new InjectedFault(); st.delete([1, 'f' + i]); } tx.objectStore('quota').put(0, 'u1'); }
    catch { tx.abort(); } });
  const count = await new Promise<number>((res) => { const r = db.transaction('dentries').objectStore('dentries').count(); r.onsuccess = () => res(r.result); });
  const quota = await new Promise<number>((res) => { const r = db.transaction('quota').objectStore('quota').get('u1'); r.onsuccess = () => res(r.result); });
  expect(result).toBe('aborted'); expect(count).toBe(1000); expect(quota).toBe(1000);
});
test('real browser APIs are present: OPFS, Workers, crypto.subtle PBKDF2, crossOriginIsolated', async () => {
  const dir = await navigator.storage.getDirectory(); const fh = await dir.getFileHandle('x.bin', { create: true });
  const w = await fh.createWritable(); await w.write(new Uint8Array([1, 2, 3])); await w.close();
  expect((await fh.getFile()).size).toBe(3);
  const worker = new Worker(URL.createObjectURL(new Blob(['onmessage=e=>postMessage(e.data*2)'], { type: 'text/javascript' })));
  const v = await new Promise(r => { worker.onmessage = e => r(e.data); worker.postMessage(21); }); expect(v).toBe(42);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveBits']);
  const t0 = performance.now();
  await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: crypto.getRandomValues(new Uint8Array(16)), iterations: 600_000 }, key, 256);
  console.log('Chrome PBKDF2-SHA256 600k ms:', (performance.now() - t0).toFixed(1), 'crossOriginIsolated:', self.crossOriginIsolated);
});
