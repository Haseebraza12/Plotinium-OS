import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from 'playwright-core';
const root = process.cwd();
const srv = http.createServer((q, s) => { fs.readFile(path.join(root, new URL(q.url, 'http://x').pathname), (e, d) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': 'text/html' }); s.end(d); }); });
await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
const udd = fs.mkdtempSync(path.join(root, 'profq-'));
for (const headless of [true]) {
const ctx = await chromium.launchPersistentContext(udd, { executablePath: '/usr/bin/google-chrome', headless });
const page = await ctx.newPage(); await page.goto(`http://localhost:${port}/q.html`);
await page.waitForFunction(() => window.__result, null, { timeout: 30000 });
console.log(JSON.stringify(await page.evaluate(() => window.__result)));
await ctx.close(); }
srv.close();
