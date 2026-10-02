// Round-robin boot timing (interleaved across apps to cancel time-correlated noise).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright-core'; import zlib from 'node:zlib';
const DIST = path.resolve('dist'); const PORT = 5198;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = path.join(DIST, decodeURIComponent(u.pathname));
  fs.readFile(p, (err, buf) => { if (err) { res.writeHead(404); return res.end(); }
    const ext = path.extname(p); const gz = !!process.env.GZIP && /gzip/.test(req.headers['accept-encoding'] ?? '') && ext !== '.html';
    const h = { vary: 'accept-encoding', 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext], 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' };
    if (gz) h['content-encoding'] = 'gzip';
    res.writeHead(200, h); res.end(gz ? zlib.gzipSync(buf, { level: 9 }) : buf); });
}).listen(PORT);
const apps = 'vanilla,lit,solid,svelte,preact,vapor,vue,reactnc,react'.split(',');
const ITER = Number(process.env.ITER ?? 15), CPU = Number(process.env.CPU ?? 4);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const res = Object.fromEntries(apps.map((a) => [a, { cold: [], warm: [], fcp: [], js: 0 }]));
for (let i = 0; i < ITER; i++) for (const app of (i % 2 ? [...apps].reverse() : apps)) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } }); const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU }); await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 1_250_000, uploadThroughput: 625_000 });
  const t = async () => { await page.waitForFunction(() => window.__ready); return page.evaluate(() => ({ ready: performance.getEntriesByName('desktop-interactive')[0].startTime, js: performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'script' || e.name.endsWith('.js')).reduce((s, e) => s + e.transferSize, 0) })); };
  await page.goto(`http://localhost:${PORT}/${app}/index.html`); const c = await t();
  await page.goto(`http://localhost:${PORT}/${app}/index.html?warm`); const w = await t();
  res[app].cold.push(c.ready); res[app].warm.push(w.ready); res[app].js = c.js; await ctx.close();
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1) + 0.5)]; };
const out = {}; for (const a of apps) out[a] = { coldP50: q(res[a].cold, 0.5), coldP90: q(res[a].cold, 0.9), warmP50: q(res[a].warm, 0.5), warmP90: q(res[a].warm, 0.9), jsTransferBytes: res[a].js, n: res[a].cold.length };
console.log(JSON.stringify(out, null, 1)); fs.writeFileSync(`boot-rr-cpu${CPU}${process.env.GZIP ? '-gzip' : ''}.json`, JSON.stringify({ out, raw: res }, null, 1));
await browser.close(); server.close();
