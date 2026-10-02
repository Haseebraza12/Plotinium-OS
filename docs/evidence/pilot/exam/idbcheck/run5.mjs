import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright-core';
const root = process.cwd(); const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript' };
const srv = http.createServer((q, s) => { const p = path.join(root, decodeURIComponent(new URL(q.url, 'http://x').pathname)); fs.readFile(p, (e, d) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); s.end(d); }); });
await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
const mode = process.argv[2]; let ctx, browser, udd;
if (mode === 'incognito') { browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true }); ctx = await browser.newContext(); }
else { udd = fs.mkdtempSync(path.join(root, 'prof4-')); ctx = await chromium.launchPersistentContext(udd, { executablePath: '/usr/bin/google-chrome', headless: true, args: (process.env.FEAT ? ['--enable-features=' + process.env.FEAT] : []) }); }
const page = await ctx.newPage();
await page.goto(`http://localhost:${port}/index4.html`);
await page.waitForFunction(() => window.__result, null, { timeout: 600000, polling: 500 });
const r = await page.evaluate(() => window.__result);
await ctx.close(); if (browser) await browser.close(); srv.close();
r.mode = mode; r.load = fs.readFileSync('/proc/loadavg', 'utf8').trim();
if (udd) { const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name).replace(udd, '')]); r.idbDirs = [...new Set(walk(udd).filter((f) => /IndexedDB/i.test(f)).map((f) => f.split('/').slice(0, 5).join('/')))]; }
console.log(JSON.stringify(r));
