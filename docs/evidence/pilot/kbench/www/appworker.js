import { stats } from './dsa.js';
const ports = {}; let seq = 0; const pending = new Map();
function wire(name, port) { ports[name] = port; port.onmessage = (e) => { const r = pending.get(e.data.id); if (r) { pending.delete(e.data.id); r(e.data); } }; }
function sys(target, call, args, transfer) { const id = ++seq; return new Promise(res => { pending.set(id, res); ports[target].postMessage({ id, call, args }); }); }
self.onmessage = async (e) => { const m = e.data;
  if (m.type === 'port') { wire(m.name, m.port); return; }
  if (m.type === 'rtt') { const s = []; for (let i = 0; i < 50; i++) await sys(m.target, 'stat', { path: '/home/u/f' + i });
    for (let i = 0; i < m.n; i++) { const t = performance.now(); const r = await sys(m.target, 'stat', { path: '/home/u/f' + (i % 10000) }); s.push((performance.now() - t) * 1000); if (!r.ok) throw 0; }
    self.postMessage({ type: 'rtt', us: stats(s) }); }
  if (m.type === 'openloop') { const s = []; const end = performance.now() + m.ms; let inflight = 0; let i = 0;
    await new Promise(done => { const tick = () => { if (performance.now() >= end) { const w = () => inflight ? setTimeout(w, 5) : done(); return w(); }
      const t = performance.now(); inflight++; sys(m.target, 'stat', { path: '/home/u/f' + (i++ % 10000) }).then(() => { s.push((performance.now() - t) * 1000); inflight--; }); setTimeout(tick, 2); }; tick(); });
    self.postMessage({ type: 'openloop', us: stats(s) }); }
  if (m.type === 'burst') { const t = performance.now(); const ps = []; for (let i = 0; i < m.n; i++) ps.push(sys(m.target, 'stat', { path: '/home/u/f' + (i % 10000) })); await Promise.all(ps); const ms = performance.now() - t; self.postMessage({ type: 'burst', calls: m.n, ms: +ms.toFixed(2), callsPerSec: Math.round(m.n / ms * 1000) }); }
  if (m.type === 'pagein') { const s = []; for (let i = 0; i < m.n; i++) { const t = performance.now(); const r = await sys('kernel', 'pagein', { bytes: 5 * 1024 * 1024, transfer: m.transfer }); if (r.value.byteLength !== 5 * 1024 * 1024) throw 0; s.push(performance.now() - t); } self.postMessage({ type: 'pagein', transfer: m.transfer, ms: stats(s) }); }
  if (m.type === 'sab') { const a = new Int32Array(m.sab); const t = performance.now();
    for (let i = 0; i < m.n; i++) { Atomics.store(a, 0, 1); Atomics.notify(a, 0); Atomics.wait(a, 1, 0); Atomics.store(a, 1, 0); }
    const us = (performance.now() - t) * 1000 / m.n;
    // cost of a yield-point pre-emption check
    let x = 0; const t2 = performance.now(); for (let i = 0; i < 1e7; i++) { if (Atomics.load(a, 2) !== 0) x++; } const nsCheck = (performance.now() - t2) * 1e6 / 1e7;
    self.postMessage({ type: 'sab', rttUs: +us.toFixed(3), atomicsLoadCheckNs: +nsCheck.toFixed(3), x }); }
};
