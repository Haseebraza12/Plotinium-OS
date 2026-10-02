// Open addressing, linear probing, Fibonacci hashing, backward-shift deletion (no tombstones), load factor <= 0.5
class PidTable {
  constructor(cap = 16) { this.init(cap); }
  init(cap) { this.cap = cap; this.mask = cap - 1; this.shift = 32 - Math.log2(cap); this.keys = new Int32Array(cap).fill(-1); this.vals = new Array(cap).fill(undefined); this.size = 0; }
  slot(k) { return (Math.imul(k, 0x9E3779B1) >>> this.shift) & this.mask; }
  get(k) { let i = this.slot(k); for (;;) { const kk = this.keys[i]; if (kk === k) return this.vals[i]; if (kk === -1) return undefined; i = (i + 1) & this.mask; } }
  set(k, v) { if ((this.size + 1) * 2 > this.cap) this.grow(); let i = this.slot(k); for (;;) { const kk = this.keys[i]; if (kk === k) { this.vals[i] = v; return; } if (kk === -1) { this.keys[i] = k; this.vals[i] = v; this.size++; return; } i = (i + 1) & this.mask; } }
  delete(k) { let i = this.slot(k); for (;;) { const kk = this.keys[i]; if (kk === -1) return false; if (kk === k) break; i = (i + 1) & this.mask; }
    let j = i; for (;;) { j = (j + 1) & this.mask; const kj = this.keys[j]; if (kj === -1) break; const h = this.slot(kj); // can kj move to i?
      if ((i <= j) ? (h <= i || h > j) : (h <= i && h > j)) { this.keys[i] = kj; this.vals[i] = this.vals[j]; i = j; } }
    this.keys[i] = -1; this.vals[i] = undefined; this.size--; return true; }
  grow() { const ok = this.keys, ov = this.vals; this.init(this.cap * 2); for (let i = 0; i < ok.length; i++) if (ok[i] !== -1) this.set(ok[i], ov[i]); }
}
// correctness vs Map (differential test)
{ const t = new PidTable(), m = new Map(); let x = 1; for (let i = 0; i < 200000; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; const k = x % 5000; const op = x % 3; if (op === 0) { t.set(k, i); m.set(k, i); } else if (op === 1) { if (t.delete(k) !== m.delete(k)) throw 'del'; } else if (t.get(k) !== m.get(k)) throw 'get ' + k; } if (t.size !== m.size) throw 'size'; console.log('differential test vs Map: OK, size', t.size); }
for (const n of [256, 10000, 100000]) {
  const t = new PidTable(), m = new Map(); for (let i = 1; i <= n; i++) { t.set(i, { pid: i }); m.set(i, { pid: i }); }
  const OPS = 2e6; let next = n + 1, s = 0;
  const bench = (tab) => { let pidLo = 1, nx = next; const t0 = performance.now(); for (let i = 0; i < OPS; i++) { const k = pidLo + ((i * 7919) % n); const v = tab.get(k); if (v) s++; if ((i & 7) === 0) { tab.delete(pidLo); tab.set(nx, { pid: nx }); pidLo++; nx++; } } return (performance.now() - t0) * 1e6 / OPS; };
  const a = bench(t); const b = bench(m);
  console.log(n, 'own PidTable ns/op', a.toFixed(1), ' Map ns/op', b.toFixed(1));
}
