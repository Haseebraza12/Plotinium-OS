import { chromium } from 'playwright-core'; import { spawn } from 'node:child_process';
const p = spawn('npx', ['vite', 'preview', '--port', '5192', '--strictPort'], { stdio: 'ignore' }); await new Promise(r => setTimeout(r, 2500));
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--enable-blink-features=ForceEagerMeasureMemory'] });
for (const n of [0, 8, 32, 0, 8, 32]) { const pg = await b.newPage(); await pg.goto(`http://localhost:5192/mem.html?n=${n}`); await pg.waitForFunction(() => window.__done, null, { timeout: 90000 }); console.log(JSON.stringify(await pg.evaluate(() => window.__R))); await pg.close(); }
await b.close(); p.kill();
