import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { chromium } from 'playwright-core';
const DIST = path.resolve('d'); const PORT = 5197;
const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); const p = path.join(DIST, decodeURIComponent(u.pathname));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } const ext = path.extname(p); res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] ?? 'application/octet-stream' }); res.end(b); }); }).listen(PORT);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
for (const lib of ['textarea', 'cmbasic', 'monacocore', 'xterm']) {
  const vals = [];
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext(); const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
    const t0 = Date.now(); await page.goto(`http://localhost:${PORT}/${lib}/index.html`); await page.waitForFunction(() => window.__ready, null, { timeout: 60000 }); const loadMs = Date.now() - t0;
    await page.waitForTimeout(1000); await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage');
    const h = await cdp.send('Runtime.getHeapUsage'); const workers = page.workers().length; vals.push({ heapMB: +(h.usedSize / 1048576).toFixed(2), loadMs, workers }); await ctx.close();
  }
  console.log(lib, JSON.stringify(vals));
}
await browser.close(); server.close();
