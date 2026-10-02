import { chromium } from 'playwright-core';
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:4173/');
await page.waitForFunction(() => navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true));
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
await page.waitForFunction(() => window.state.wsOpen === true);
console.log('online  :', await page.evaluate(() => ({ ...window.state, controlled: !!navigator.serviceWorker.controller })));
// Frame timing baseline and under CDP CPU throttle x4 with a main-thread busy loop injected
const cdp = await ctx.newCDPSession(page);
for (const rate of [1, 4]) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.evaluate(() => { window.frames_.length = 0; });
  await page.waitForTimeout(2000);
  const f = await page.evaluate(() => window.frames_.slice(1));
  console.log(`rAF frame deltas, CPU throttle x${rate}: n=${f.length} p50=${pct(f,50).toFixed(1)}ms p95=${pct(f,95).toFixed(1)}ms`);
}
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
// Offline emulation
await ctx.setOffline(true);
const apiOffline = await page.evaluate(() => fetch('/api/ping').then(r => 'ok ' + r.status, e => 'failed: ' + e.message));
await page.evaluate(() => window.ws.send('still-there?')); await page.waitForTimeout(300);
console.log('offline : api fetch ->', apiOffline, '| existing WS echo ->', await page.evaluate(() => window.state.echo), '| wsOpen', await page.evaluate(() => window.state.wsOpen));
let reloadResult;
try { await page.reload({ timeout: 5000 }); reloadResult = await page.textContent('#s'); } catch (e) { reloadResult = 'RELOAD FAILED: ' + e.message.split('\n')[0]; }
console.log('offline reload ->', reloadResult);
try { console.log('after offline reload:', await page.evaluate(() => ({ coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, mem: typeof performance.measureUserAgentSpecificMemory, controlled: !!navigator.serviceWorker.controller }))); } catch (e) { console.log('eval failed', e.message); }
// Fresh page load (new tab) while offline
const p2 = await ctx.newPage();
try { await p2.goto('http://127.0.0.1:4173/', { timeout: 5000 }); console.log('new tab offline goto ->', await p2.textContent('#s')); } catch (e) { console.log('new tab offline goto FAILED:', e.message.split('\n')[0]); }
if (await page.evaluate(() => self.crossOriginIsolated)) {
  const m = await page.evaluate(() => performance.measureUserAgentSpecificMemory().then(r => r.bytes).catch(e => 'err ' + e.message));
  console.log('measureUserAgentSpecificMemory bytes:', m);
}
await browser.close();
