/*
 * Captures every specimen section at 1x and 2x device scale factor, light and dark, with
 * Playwright on the installed Chrome (channel 'chrome'), and records which faces
 * document.fonts reports as loaded.
 *
 *   python3 -m http.server 4791 --bind 127.0.0.1        # from the repository root
 *   node docs/design/fonts/specimen/shoot.mjs http://127.0.0.1:4791 docs/design/polish/fonts/specimen
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../../../../package.json'));
const { chromium } = require('@playwright/test');

const [origin = 'http://127.0.0.1:4791', out = 'docs/design/polish/fonts/specimen'] =
  process.argv.slice(2);
const SECTIONS = ['chrome', 'window', 'table', 'legible', 'clock', 'heads', 'mono'];
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const report = {};
for (const scheme of ['light', 'dark']) {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({
      viewport: { width: 1500, height: 1000 },
      deviceScaleFactor: dpr,
      colorScheme: scheme,
    });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('requestfailed', (r) => problems.push(`failed ${r.url()}`));
    await page.goto(`${origin}/docs/design/fonts/specimen/index.html`);
    await page.waitForSelector('html[data-ready="true"]', { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    report[`${scheme}@${dpr}x`] = {
      problems,
      loaded: await page.evaluate(() =>
        [...document.fonts]
          .filter((f) => f.status === 'loaded')
          .map((f) => f.family.replaceAll('"', '')),
      ),
    };
    for (const id of SECTIONS) {
      await page.locator(`#${id}`).screenshot({ path: `${out}/${id}-${scheme}@${dpr}x.png` });
    }
    await context.close();
  }
}
await browser.close();
writeFileSync(`${out}/fonts-loaded.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
