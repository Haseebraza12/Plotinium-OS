// "Kernel worker": answers syscalls on ports, spawns nested executor workers, OPFS swap test, SAB ping-pong.
import { stats } from './dsa.js';
const inodes = new Map(); for (let i = 0; i < 10000; i++) inodes.set('/home/u/f' + i, { ino: i, type: 'file', mode: 0o644, uid: 1000, gid: 100, size: i * 10, mtime: 1790000000000 + i, version: 1 });
function handleSyscall(port) {
  port.onmessage = (e) => { const m = e.data;
    if (m.call === 'stat') { const v = inodes.get(m.args.path); port.postMessage(v ? { id: m.id, ok: true, value: v } : { id: m.id, ok: false, errno: 'ENOENT' }); }
    else if (m.call === 'pagein') { const buf = new ArrayBuffer(m.args.bytes); new Uint8Array(buf)[0] = 7; if (m.args.transfer) port.postMessage({ id: m.id, ok: true, value: buf }, [buf]); else port.postMessage({ id: m.id, ok: true, value: buf }); }
  };
}
self.onmessage = async (e) => { const m = e.data;
  if (m.type === 'port') handleSyscall(m.port);
  else if (m.type === 'sab') { const a = new Int32Array(m.sab); // pong loop
    for (let i = 0; i < m.n; i++) { Atomics.wait(a, 0, 0); Atomics.store(a, 0, 0); Atomics.store(a, 1, 1); Atomics.notify(a, 1); }
    self.postMessage({ type: 'sabdone' }); }
  else if (m.type === 'respawn') { const lat = []; let w = null;
    for (let i = 0; i < m.n; i++) { const t0 = performance.now(); w = new Worker('./executor.js', { type: 'module' });
      await new Promise(r => { w.onmessage = (ev) => { if (ev.data === 'ready') r(); }; });
      lat.push(performance.now() - t0);
      w.postMessage('spin'); await new Promise(r => setTimeout(r, 30)); // runaway now busy
      const t1 = performance.now(); w.terminate(); lat.push(-(performance.now() - t1)); }
    const spawn = lat.filter(x => x >= 0), term = lat.filter(x => x < 0).map(x => -x);
    self.postMessage({ type: 'respawn', spawnMs: stats(spawn), terminateCallMs: stats(term) }); }
  else if (m.type === 'opfs') { const out = { hasSyncHandle: typeof FileSystemFileHandle !== 'undefined' && 'createSyncAccessHandle' in FileSystemFileHandle.prototype };
    try { const root = await navigator.storage.getDirectory(); const fh = await root.getFileHandle('swap-5mb.bin', { create: true }); const h = await fh.createSyncAccessHandle();
      const page = new Uint8Array(5 * 1024 * 1024); for (let i = 0; i < page.length; i += 4096) page[i] = i & 255;
      const w = [], r = []; for (let i = 0; i < m.n; i++) { let t = performance.now(); h.truncate(0); h.write(page, { at: 0 }); h.flush(); const d1 = await crypto.subtle.digest('SHA-256', page); w.push(performance.now() - t);
        t = performance.now(); const buf = new Uint8Array(h.getSize()); h.read(buf, { at: 0 }); const d2 = await crypto.subtle.digest('SHA-256', buf); const same = new Uint8Array(d1).every((b, j) => b === new Uint8Array(d2)[j]); if (!same) throw new Error('checksum'); r.push(performance.now() - t); }
      h.close(); out.pageOut5MB_ms = stats(w); out.pageIn5MB_verify_ms = stats(r); } catch (err) { out.error = String(err); }
    self.postMessage({ type: 'opfs', ...out }); }
};
