// Pilot: exact (brute-force) cosine top-k over N x 384 unit vectors in plain JS,
// filter-then-rank with a per-query "permitted file" bitmap (current rwx computed by the kernel).
import { performance } from 'node:perf_hooks';
const D = 384, K = 5;
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) - 0.5;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function build(n) {
  const M = new Float32Array(n * D);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < D; j++) { const v = rnd(); M[i * D + j] = v; s += v * v; } s = 1 / Math.sqrt(s); for (let j = 0; j < D; j++) M[i * D + j] *= s; }
  const rowIno = new Int32Array(n); for (let i = 0; i < n; i++) rowIno[i] = Math.floor(i / 10); // ~10 chunks per file
  return { M, rowIno, n };
}
// fixed-size min-heap top-k (stand-in for dsa/heap)
function search(ix, q, permitted) {
  const hs = new Float32Array(K).fill(-Infinity), hi = new Int32Array(K).fill(-1);
  const { M, rowIno, n } = ix;
  for (let i = 0; i < n; i++) {
    if (!permitted[rowIno[i]]) continue;
    let s = 0; const o = i * D;
    for (let j = 0; j < D; j += 4) s += M[o + j] * q[j] + M[o + j + 1] * q[j + 1] + M[o + j + 2] * q[j + 2] + M[o + j + 3] * q[j + 3];
    if (s > hs[0]) { // replace root, sift down
      let p = 0; hs[0] = s; hi[0] = i;
      for (;;) { const l = 2 * p + 1, r = l + 1; let m = p; if (l < K && hs[l] < hs[m]) m = l; if (r < K && hs[r] < hs[m]) m = r; if (m === p) break;
        const ts = hs[p]; hs[p] = hs[m]; hs[m] = ts; const ti = hi[p]; hi[p] = hi[m]; hi[m] = ti; p = m; }
    }
  }
  return hi;
}
for (const n of [10000, 50000, 100000]) {
  const ix = build(n);
  const files = Math.ceil(n / 10);
  const lat = [];
  for (let r = 0; r < 300; r++) {
    const q = new Float32Array(D); let s = 0; for (let j = 0; j < D; j++) { q[j] = rnd(); s += q[j] * q[j]; } s = 1 / Math.sqrt(s); for (let j = 0; j < D; j++) q[j] *= s;
    const a = performance.now();
    const permitted = new Uint8Array(files); for (let f = 0; f < files; f++) permitted[f] = (f % 3 !== 0) ? 1 : 0; // ~2/3 readable
    search(ix, q, permitted);
    lat.push(performance.now() - a);
  }
  console.log(JSON.stringify({ chunks: n, dims: D, MB: +(n * D * 4 / 1048576).toFixed(1), p50ms: +pct(lat, .5).toFixed(2), p95ms: +pct(lat, .95).toFixed(2) }));
}
