import { ObjHeap, SoaHeap, Trie, stats, rng } from './dsa.js';
const R = {}; const log = (k, v) => { R[k] = v; console.log(k, JSON.stringify(v)); };
const once = (w, type) => new Promise(r => { const h = (e) => { if (e.data.type === type) { w.removeEventListener('message', h); r(e.data); } }; w.addEventListener('message', h); });
(async () => {
  log('env', { ua: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, measureMemory: typeof performance.measureUserAgentSpecificMemory, locks: !!navigator.locks, schedulerYield: typeof globalThis.scheduler?.yield });
  // ---------- 1. heap: TS-style object heap vs WASM heap (JS->WASM call per op)
  const { instance } = await WebAssembly.instantiateStreaming(fetch('./heap.wasm'));
  const W = instance.exports;
  { let x = 0; const N = 1e7; for (let i = 0; i < 1e6; i++) x += W.noop(i); const t = performance.now(); for (let i = 0; i < N; i++) x += W.noop(i); log('wasm_noop_call_ns', +((performance.now() - t) * 1e6 / N).toFixed(3)); }
  const heapRes = {};
  for (const n of [256, 1000, 10000, 100000]) { const OPS = 200000;
    const rnd = rng(42); const h = new ObjHeap(); let seq = 0; for (let i = 0; i < n; i++) h.push(i, (rnd() * 40) | 0, seq++);
    for (let i = 0; i < 20000; i++) { const p = h.pop(); h.push(p, (rnd() * 40) | 0, seq++); }
    let t = performance.now(); for (let i = 0; i < OPS; i++) { const p = h.pop(); h.push(p, (rnd() * 40) | 0, seq++); } const objNs = (performance.now() - t) * 1e6 / OPS;
    t = performance.now(); for (let i = 0; i < OPS; i++) { const it = (rnd() * n) | 0; h.changePriority(it, (rnd() * 40) | 0); } const chgNs = (performance.now() - t) * 1e6 / OPS;
    const rnd2 = rng(42); W.clear(); seq = 0; for (let i = 0; i < n; i++) W.push(i, (rnd2() * 40) | 0, seq++);
    for (let i = 0; i < 20000; i++) { const p = W.pop(); W.push(p, (rnd2() * 40) | 0, seq++); }
    t = performance.now(); for (let i = 0; i < OPS; i++) { const p = W.pop(); W.push(p, (rnd2() * 40) | 0, seq++); } const wNs = (performance.now() - t) * 1e6 / OPS;
    const rnd3 = rng(42); const S = new SoaHeap(n + 1); seq = 0; for (let i = 0; i < n; i++) S.push(i, (rnd3() * 40) | 0, seq++);
    for (let i = 0; i < 20000; i++) { const p = S.pop(); S.push(p, (rnd3() * 40) | 0, seq++); }
    t = performance.now(); for (let i = 0; i < OPS; i++) { const p = S.pop(); S.push(p, (rnd3() * 40) | 0, seq++); } const sNs = (performance.now() - t) * 1e6 / OPS;
    heapRes[n] = { ts_obj_heap_pop_push_ns: +objNs.toFixed(1), ts_changePriority_ns: +chgNs.toFixed(1), ts_soa_heap_pop_push_ns: +sNs.toFixed(1), wasm_heap_pop_push_ns: +wNs.toFixed(1) }; }
  log('heap', heapRes);
  // ---------- 2. trie completion + cost of marshalling strings across a WASM boundary
  const words = ['home','docs','src','kernel','report','draft','notes','img','photo','music','video','lib','bin','tmp','proj','test','data','old','new','final'];
  const trieRes = {}; const enc = new TextEncoder(), dec = new TextDecoder(); const mem = new Uint8Array(W.mem.buffer);
  for (const n of [1000, 10000, 100000]) { const rnd = rng(7); const t = new Trie(); const all = [];
    while (t.count < n) { const d = 1 + ((rnd() * 5) | 0); let p = '/'; for (let j = 0; j < d; j++) p += words[(rnd() * 20) | 0] + ((rnd() * 50) | 0) + '/'; p += 'file' + ((rnd() * 1e6) | 0) + '.md'; t.insert(p); all.push(p); }
    const qs = []; for (let i = 0; i < 2000; i++) { const w = all[(rnd() * all.length) | 0]; qs.push(w.slice(0, 2 + ((rnd() * 8) | 0))); }
    for (const q of qs.slice(0, 200)) t.complete(q, 20);
    const s = []; let res = []; for (const q of qs) { const t0 = performance.now(); res = t.complete(q, 20); s.push((performance.now() - t0) * 1000); }
    // marshalling: encode prefix into wasm memory, decode 20 result strings out of it
    const pre = res.map(r => enc.encode(r)); let off = 0; const offs = []; for (const b of pre) { mem.set(b, 4096 + off); offs.push([4096 + off, b.length]); off += b.length; }
    const ms = []; for (const q of qs) { const t0 = performance.now(); enc.encodeInto(q, mem.subarray(0, 4096)); const out = []; for (const [o, l] of offs) out.push(dec.decode(mem.subarray(o, o + l))); ms.push((performance.now() - t0) * 1000); }
    trieRes[n] = { ts_trie_complete_k20_us: stats(s), wasm_string_marshal_only_us: stats(ms) }; }
  W.clear(); log('trie', trieRes);
  { const root = { c: new Map(), size: 0 }; const rnd = rng(3); const nodes = [root]; for (let i = 0; i < 100000; i++) { const par = nodes[(rnd() * nodes.length) | 0]; const nd = { c: new Map(), size: (rnd() * 1e5) | 0 }; par.c.set('n' + i, nd); if (rnd() < 0.2) nodes.push(nd); }
    const du = (nd) => { let s = nd.size; for (const ch of nd.c.values()) s += du(ch); return s; }; du(root); const w = []; for (let i = 0; i < 20; i++) { const t = performance.now(); du(root); w.push(performance.now() - t); } log('vfs_du_walk_100k_nodes_ms', stats(w)); }
  // ---------- 3. IPC: kernel on main thread vs kernel in a worker, idle and under main-thread load
  const kw = new Worker('./kworker.js', { type: 'module' }); const aw = new Worker('./appworker.js', { type: 'module' });
  const inodes = new Map(); for (let i = 0; i < 10000; i++) inodes.set('/home/u/f' + i, { ino: i, type: 'file', mode: 0o644, uid: 1000, gid: 100, size: i * 10, mtime: 1790000000000 + i, version: 1 });
  const chMain = new MessageChannel(); chMain.port1.onmessage = (e) => { const m = e.data; const v = inodes.get(m.args.path); chMain.port1.postMessage({ id: m.id, ok: true, value: v }); };
  aw.postMessage({ type: 'port', name: 'main', port: chMain.port2 }, [chMain.port2]);
  const chK = new MessageChannel(); kw.postMessage({ type: 'port', port: chK.port1 }, [chK.port1]); aw.postMessage({ type: 'port', name: 'kernel', port: chK.port2 }, [chK.port2]);
  let loading = false, frames = 0; const busy = (ms) => { const t = performance.now(); while (performance.now() - t < ms) {} };
  const frame = () => { if (!loading) return; frames++; busy(10); requestAnimationFrame(frame); };
  const run = async (target, load) => { loading = load; frames = 0; if (load) requestAnimationFrame(frame); const t = performance.now(); aw.postMessage({ type: 'openloop', target, ms: 3000 }); const r = await once(aw, 'openloop'); const el = performance.now() - t; loading = false; return { ...r.us, framesDuring: frames, fps: +(frames / el * 1000).toFixed(1) }; };
  log('syscall_rtt_us', { kernel_main_idle: await run('main', false), kernel_main_loaded: await run('main', true), kernel_worker_idle: await run('kernel', false), kernel_worker_loaded: await run('kernel', true) });
  aw.postMessage({ type: 'burst', target: 'kernel', n: 10000 }); log('burst_kernel_worker', await once(aw, 'burst'));
  aw.postMessage({ type: 'burst', target: 'main', n: 10000 }); log('burst_kernel_main', await once(aw, 'burst'));
  aw.postMessage({ type: 'pagein', transfer: false, n: 30 }); const c = await once(aw, 'pagein');
  aw.postMessage({ type: 'pagein', transfer: true, n: 30 }); const tr = await once(aw, 'pagein');
  log('pagein_5MB_ms', { structuredClone: c.ms, transfer: tr.ms });
  if (self.crossOriginIsolated) { const sab = new SharedArrayBuffer(16); const n = 20000; const pa = once(aw, 'sab'), pk = once(kw, 'sabdone'); kw.postMessage({ type: 'sab', sab, n }); aw.postMessage({ type: 'sab', sab, n }); const r = await pa; await pk; log('sab_atomics', r); }
  { const p = once(kw, 'respawn'); kw.postMessage({ type: 'respawn', n: 10 }); log('nested_worker_respawn', await p); }
  { const p = once(kw, 'opfs'); kw.postMessage({ type: 'opfs', n: 20 }); log('opfs_kernel_worker', await p); }
  try { const sw = new SharedWorker('./shared.js'); log('sharedworker_caps', await new Promise(r => { sw.port.onmessage = (e) => r(e.data); })); } catch (err) { log('sharedworker_caps', String(err)); }
  if (false) { const t = performance.now(); try { const mm = await performance.measureUserAgentSpecificMemory(); log('measure_memory', { bytes: mm.bytes, breakdownEntries: mm.breakdown.length, ms: +(performance.now() - t).toFixed(1) }); } catch (err) { log('measure_memory', String(err)); } }
  window.__R = R; window.__done = true;
})().catch(e => { window.__err = String(e.stack || e); window.__done = true; });
