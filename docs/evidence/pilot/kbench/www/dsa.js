// Idiomatic TS-style structures (types erased). Heap keyed (prio, seq) + index map for changePriority.
export class ObjHeap {
  constructor() { this.a = []; this.idx = new Map(); }
  get size() { return this.a.length; }
  less(x, y) { return x.prio < y.prio || (x.prio === y.prio && x.seq < y.seq); }
  swap(i, j) { const a = this.a; const t = a[i]; a[i] = a[j]; a[j] = t; this.idx.set(a[i].item, i); this.idx.set(a[j].item, j); }
  up(i) { const a = this.a; while (i > 0) { const p = (i - 1) >> 1; if (!this.less(a[i], a[p])) break; this.swap(i, p); i = p; } }
  down(i) { const a = this.a, n = a.length; for (;;) { const l = 2 * i + 1; if (l >= n) break; const r = l + 1; let c = l; if (r < n && this.less(a[r], a[l])) c = r; if (!this.less(a[c], a[i])) break; this.swap(i, c); i = c; } }
  push(item, prio, seq) { const e = { item, prio, seq }; this.a.push(e); this.idx.set(item, this.a.length - 1); this.up(this.a.length - 1); }
  pop() { const a = this.a; if (a.length === 0) return undefined; const top = a[0]; const last = a.pop(); this.idx.delete(top.item); if (a.length) { a[0] = last; this.idx.set(last.item, 0); this.down(0); } return top.item; }
  changePriority(item, prio) { const i = this.idx.get(item); if (i === undefined) return; const old = this.a[i].prio; this.a[i].prio = prio; if (prio < old) this.up(i); else this.down(i); }
}
export class Trie {
  constructor() { this.root = { c: new Map(), end: false }; this.count = 0; }
  insert(w) { let n = this.root; for (const ch of w) { let nx = n.c.get(ch); if (!nx) { nx = { c: new Map(), end: false }; n.c.set(ch, nx); } n = nx; } if (!n.end) { n.end = true; this.count++; } }
  complete(prefix, k) { let n = this.root; for (const ch of prefix) { n = n.c.get(ch); if (!n) return []; } const out = []; const stack = [[n, prefix]]; while (stack.length && out.length < k) { const [node, s] = stack.pop(); if (node.end) out.push(s); for (const [ch, nx] of node.c) stack.push([nx, s + ch]); } return out; }
}
export function stats(arr) { const s = Float64Array.from(arr).sort(); const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, p50: +q(0.5).toFixed(4), p95: +q(0.95).toFixed(4), p99: +q(0.99).toFixed(4), max: +s[s.length - 1].toFixed(4) }; }
export function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
// Struct-of-arrays TS heap (still TypeScript, no WASM): keys in Float64Array, pids in Int32Array, pos index by pid.
export class SoaHeap {
  constructor(cap) { this.k = new Float64Array(cap); this.p = new Int32Array(cap); this.pos = new Int32Array(cap).fill(-1); this.n = 0; }
  set(i, k, p) { this.k[i] = k; this.p[i] = p; this.pos[p] = i; }
  push(pid, prio, seq) { const k = prio * 4294967296 + seq; let i = this.n++; while (i > 0) { const par = (i - 1) >> 1; const pk = this.k[par]; if (k >= pk) break; this.set(i, pk, this.p[par]); i = par; } this.set(i, k, pid); }
  pop() { if (this.n === 0) return -1; const top = this.p[0]; this.pos[top] = -1; const n = --this.n; if (n === 0) return top; const k = this.k[n], p = this.p[n]; let i = 0; for (;;) { const l = 2 * i + 1; if (l >= n) break; const r = l + 1; const c = (r < n && this.k[r] < this.k[l]) ? r : l; if (this.k[c] >= k) break; this.set(i, this.k[c], this.p[c]); i = c; } this.set(i, k, p); return top; }
}
