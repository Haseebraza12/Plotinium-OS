import { test, expect } from 'vitest';
import { Trie } from './trie';
function rng(seed: number) { return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32); }
function words(n: number, r = rng(7)) { const out: string[] = []; const a = 'abcdefghijklmnopqrstuvwxyz-_./';
  for (let i = 0; i < n; i++) { let s = '/home/u' + (i % 50) + '/'; const L = 4 + Math.floor(r() * 16); for (let j = 0; j < L; j++) s += a[Math.floor(r() * a.length)]; out.push(s); } return out; }
const pct = (a: Float64Array, p: number) => { const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
for (const n of [1e3, 1e4, 1e5]) {
  test(`trie complete() budget at n=${n}`, async ({ bench }) => {
    const t = new Trie(); const ws = words(n); ws.forEach(w => t.insert(w));
    const prefixes = ws.slice(0, 1000).map(w => w.slice(0, 12));
    // (1) per-op samples for a p95 budget (SYS-03: p95 <= 1 ms)
    const samples = new Float64Array(prefixes.length);
    for (let i = 0; i < prefixes.length; i++) { const s = performance.now(); t.complete(prefixes[i], 10); samples[i] = performance.now() - s; }
    const p95 = pct(samples, 95);
    console.log(`n=${n} per-op p50=${(pct(samples,50)*1000).toFixed(1)}us p95=${(p95*1000).toFixed(1)}us`);
    expect(p95).toBeLessThanOrEqual(1);
    // (2) tinybench-backed fixture for the complexity curve (mean / p99 printed in the report)
    let i = 0; const r = await bench(`complete n=${n}`, () => { t.complete(prefixes[i++ % prefixes.length], 10); }).run();
    expect(r).toBeDefined();
  });
}
