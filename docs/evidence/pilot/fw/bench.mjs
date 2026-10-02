// Same-workload UI framework benchmark for a WebOS compositor (10 windows x 150 rows).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright-core';
const DIST = path.resolve('dist'); const PORT = 5199;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = path.join(DIST, decodeURIComponent(u.pathname));
  if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    const ext = path.extname(p);
    res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
    res.end(buf);
  });
}).listen(PORT);
const apps = (process.env.APPS ?? 'vanilla,lit,solid,svelte,preact,vapor,vue,reactnc,react').split(',');
const CPU = Number(process.env.CPU ?? 4);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--enable-gpu-rasterization'] });

async function newPage(ctx, { net = false } = {}) {
  const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await cdp.send('Performance.enable');
  if (net) { await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 1_250_000, uploadThroughput: 625_000 }); }
  return { page, cdp };
}
const metrics = async (cdp) => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const readyTime = (page) => page.waitForFunction(() => window.__ready).then(() => page.evaluate(() => performance.getEntriesByName('desktop-interactive')[0].startTime));

async function boot(app) {
  const cold = [], warm = [];
  for (let i = 0; i < Number(process.env.BOOT_RUNS ?? 5); i++) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const { page } = await newPage(ctx, { net: true });
    await page.goto(`http://localhost:${PORT}/${app}/index.html`); cold.push(await readyTime(page));
    await page.goto(`http://localhost:${PORT}/${app}/index.html?w=${i}`); warm.push(await readyTime(page));
    await ctx.close();
  }
  return { coldMedian: q(cold, 0.5), coldP90: q(cold, 0.9), warmMedian: q(warm, 0.5), warmP90: q(warm, 0.9), n: cold.length };
}

async function drag(app, mode, load) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const { page, cdp } = await newPage(ctx);
  await page.goto(`http://localhost:${PORT}/${app}/index.html?drag=${mode}`); await readyTime(page);
  if (load) await page.evaluate(() => { const src = 'onmessage=()=>{for(;;){Math.sqrt(Math.random())}}'; const u = URL.createObjectURL(new Blob([src])); window.__w = []; for (let i = 0; i < Math.max(1, navigator.hardwareConcurrency - 2); i++) { const w = new Worker(u); w.postMessage(0); window.__w.push(w); } });
  await page.waitForTimeout(300);
  const box = await page.locator('[data-win="4"] [data-drag]').boundingBox();
  await page.evaluate(() => {
    window.__f = []; window.__loaf = []; window.__rec = true; window.__moves = 0;
    const loop = (t) => { if (!window.__rec) return; window.__f.push(t); requestAnimationFrame(loop); }; requestAnimationFrame(loop);
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (window.__rec) window.__loaf.push(e.duration); }).observe({ type: 'long-animation-frame', buffered: false });
  });
  const m0 = await metrics(cdp);
  let x = box.x + 40, y = box.y + 10; await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 0; i < 200; i++) { x += (i < 100 ? 3 : -3); y += (i % 50 < 25 ? 1.5 : -1.5); await page.mouse.move(x, y); await page.waitForTimeout(6); }
  await page.mouse.up();
  await page.waitForTimeout(100);
  const m1 = await metrics(cdp);
  const r = await page.evaluate(() => { window.__rec = false; if (window.__w) window.__w.forEach((w) => w.terminate()); return { f: window.__f, loaf: window.__loaf, moves: window.__moves }; });
  const d = r.f.slice(1).map((t, i) => t - r.f[i]);
  await ctx.close();
  return { frames: d.length, p50: q(d, 0.5), p95: q(d, 0.95), max: Math.max(...d), over16_7: d.filter((x) => x > 17.5).length,
    loaf50: r.loaf.filter((x) => x > 50).length, moves: r.moves,
    mainMsPerFrame: ((m1.TaskDuration - m0.TaskDuration) * 1000) / d.length, scriptMsPerFrame: ((m1.ScriptDuration - m0.ScriptDuration) * 1000) / d.length };
}

async function isolation(app, qs = '') {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const { page, cdp } = await newPage(ctx);
  await page.goto(`http://localhost:${PORT}/${app}/index.html${qs}`); await readyTime(page); await page.waitForTimeout(300);
  const before = await page.evaluate(() => [...window.__renders.win]);
  const m0 = await metrics(cdp);
  await page.evaluate(async () => { for (let i = 0; i < 100; i++) { window.__app.tick(3); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); } });
  const m1 = await metrics(cdp);
  const after = await page.evaluate(() => [...window.__renders.win]);
  const ok = await page.evaluate(() => document.querySelector('[data-win="3"] .tick').textContent);
  await ctx.close();
  const renderedOthers = after.map((v, i) => v - before[i]).filter((v, i) => i !== 3 && v > 0).length;
  return { taskMsPerUpdate: ((m1.TaskDuration - m0.TaskDuration) * 1000) / 100, scriptMsPerUpdate: ((m1.ScriptDuration - m0.ScriptDuration) * 1000) / 100, otherWindowsRerendered: renderedOthers, tickText: ok };
}

async function heap(app) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const { page, cdp } = await newPage(ctx);
  await page.goto(`http://localhost:${PORT}/${app}/index.html`); await readyTime(page); await page.waitForTimeout(300);
  await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage');
  const h = await cdp.send('Runtime.getHeapUsage'); const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
  await ctx.close(); return { usedHeapMB: h.usedSize / 1048576, domNodes: nodes };
}
const out = {};
if (process.env.PASS2) {
  for (const app of apps) {
    const res = { boot: await boot(app), heap: await heap(app), load: [] };
    for (let k = 0; k < 3; k++) res.load.push(await drag(app, 'imperative', true));
    out[app] = res; console.error(app, JSON.stringify(res.boot), JSON.stringify(res.heap), res.load.map((l) => l.p95.toFixed(1) + '/' + l.over16_7 + '/' + l.frames).join(' '));
  }
  fs.writeFileSync(`results-pass2-cpu${CPU}.json`, JSON.stringify(out, null, 2)); await browser.close(); server.close(); process.exit(0);
}
for (const app of apps) {
  const res = { boot: await boot(app) };
  res.isolation = await isolation(app);
  res.isolationHeavy = await isolation(app, '?n=20&rows=400');
  res.dragImperative = await drag(app, 'imperative', false);
  res.dragReactive = await drag(app, 'reactive', false);
  res.dragImperativeLoad = await drag(app, 'imperative', true);
  out[app] = res; console.error(app, JSON.stringify(res));
}
fs.writeFileSync(`results-cpu${CPU}.json`, JSON.stringify(out, null, 2));
await browser.close(); server.close();
