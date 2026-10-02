import { chromium } from 'playwright-core'; import { start } from './server.mjs';
const server = await start(8766, false);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage(); page.on('pageerror', e => console.error('PAGEERR', e));
await page.goto('http://localhost:8766/go.html'); await page.waitForFunction(() => window.__done, null, { timeout: 120000 });
console.log(JSON.stringify(await page.evaluate(() => window.__R)));
await browser.close(); server.close();
