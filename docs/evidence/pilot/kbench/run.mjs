import { chromium } from 'playwright-core'; import { start } from './server.mjs';
const server = await start(8765);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: [] });
const page = await browser.newPage(); page.on('console', m => console.error('PAGE', m.type(), m.text().slice(0,400)));
page.on('pageerror', e => console.error('PAGEERR', e));
await page.goto('http://localhost:8765/'); await page.waitForFunction(() => window.__done, null, { timeout: 120000 });
const err = await page.evaluate(() => window.__err); if (err) console.error('ERR', err);
console.log(JSON.stringify(await page.evaluate(() => window.__R), null, 1));
await browser.close(); server.close();
