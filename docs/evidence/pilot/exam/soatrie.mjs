import { rng, stats } from './dsa.mjs';
// Left-child/right-sibling trie in typed arrays (struct-of-arrays), grows by doubling.
class SoaTrie {
  constructor(cap = 1024) { this.cap = cap; this.ch = new Uint16Array(cap); this.fc = new Int32Array(cap).fill(-1); this.ns = new Int32Array(cap).fill(-1); this.end = new Uint8Array(cap); this.n = 1; this.count = 0; }
  grow() { const c = this.cap * 2; const g = (A, old, fill) => { const a = new A(c); if (fill !== undefined) a.fill(fill); a.set(old); return a; };
    this.ch = g(Uint16Array, this.ch); this.fc = g(Int32Array, this.fc, -1); this.ns = g(Int32Array, this.ns, -1); this.end = g(Uint8Array, this.end); this.cap = c; }
  child(n, c) { for (let x = this.fc[n]; x !== -1; x = this.ns[x]) if (this.ch[x] === c) return x; return -1; }
  insert(w) { let n = 0; for (let i = 0; i < w.length; i++) { const c = w.charCodeAt(i); let x = this.child(n, c); if (x === -1) { if (this.n === this.cap) this.grow(); x = this.n++; this.ch[x] = c; this.ns[x] = this.fc[n]; this.fc[n] = x; } n = x; } if (!this.end[n]) { this.end[n] = 1; this.count++; } }
  complete(prefix, k) { let n = 0; for (let i = 0; i < prefix.length; i++) { n = this.child(n, prefix.charCodeAt(i)); if (n === -1) return []; }
    const out = []; const st = [n], ss = [prefix]; while (st.length && out.length < k) { const x = st.pop(), s = ss.pop(); if (this.end[x]) out.push(s); for (let y = this.fc[x]; y !== -1; y = this.ns[y]) { st.push(y); ss.push(s + String.fromCharCode(this.ch[y])); } } return out; }
}
const words = ['home','docs','src','kernel','report','draft','notes','img','photo','music','video','lib','bin','tmp','proj','test','data','old','new','final'];
for (const n of [1000, 10000, 100000]) {
  global.gc(); const before = process.memoryUsage(); const rnd = rng(7); const t = new SoaTrie(); const all = [];
  while (t.count < n) { const d = 1 + ((rnd() * 5) | 0); let p = '/'; for (let j = 0; j < d; j++) p += words[(rnd() * 20) | 0] + ((rnd() * 50) | 0) + '/'; p += 'file' + ((rnd() * 1e6) | 0) + '.md'; t.insert(p); all.push(p); }
  const qs = []; for (let i = 0; i < 2000; i++) { const w = all[(rnd() * all.length) | 0]; qs.push(w.slice(0, 2 + ((rnd() * 8) | 0))); }
  for (const q of qs.slice(0, 200)) t.complete(q, 20);
  const s = []; for (const q of qs) { const t0 = performance.now(); t.complete(q, 20); s.push((performance.now() - t0) * 1000); }
  const bytes = t.cap * (2 + 4 + 4 + 1); const usedBytes = t.n * 11;
  console.log(n, 'nodes', t.n, 'typedArrayMB(cap)', (bytes / 1048576).toFixed(1), 'usedMB', (usedBytes/1048576).toFixed(1), 'complete_us', JSON.stringify(stats(s)));
  all.length = 0;
}
