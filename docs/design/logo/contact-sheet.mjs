#!/usr/bin/env node
// @ts-check
/**
 * Renders the logo contact sheet in real Chrome (Playwright, channel 'chrome') at one device
 * pixel per CSS pixel, so small sizes show exactly what a browser paints:
 *
 *   node docs/design/logo/contact-sheet.mjs [before-dir]
 *
 * docs/design/logo/contact-sheet.png       the in-app mark (AtomLogo's drawing for each size,
 *                                           token colours) at 16, 17, 20, 24, 32, 64 and 256 px
 *                                           on light and dark, the favicon at 16 and 32 px, the
 *                                           mono glyph, and the app icon at 64, 128 and 512 px
 * docs/design/logo/contact-sheet-zoom.png  the small-size rows enlarged 4x, pixel for pixel
 *
 * With a before-dir (a copy of the old docs/identity), a "before" row is added for comparison.
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const kit = join(repo, 'docs/identity');
const before = process.argv[2];

/** @typedef {readonly [string, Record<string, string | number>]} Node */
/** @type {{ atomLogoFor: (size: number) => { viewBox: string, children: readonly Node[] } }} */
const icons = await import(join(repo, 'ui/src/icons/atom-logo.ts'));

const THEMES = {
  light: { bg: '#EEF0F8', text: '#1C1C24', body: '#5856D6', core: '#4F4DC9', electron: '#5856D6' },
  dark: { bg: '#0B0D1F', text: '#F4F4FA', body: '#B3B1FF', core: '#FFFFFF', electron: '#CFCEFF' },
};

/** The in-app mark at `size`, coloured like the --pl-logo-* tokens of `theme`. */
function inApp(size, /** @type {keyof typeof THEMES} */ theme) {
  const t = THEMES[theme];
  const def = icons.atomLogoFor(size);
  const fill = (/** @type {string} */ cls) =>
    cls === 'pl-logo-core' ? t.core : cls === 'pl-logo-electron' ? t.electron : t.body;
  const kids = def.children
    .map(([tag, a]) => {
      const attrs = Object.entries(a)
        .filter(([k]) => k !== 'class' && k !== 'fill')
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<${tag} ${attrs} fill="${fill(String(a['class']))}"/>`;
    })
    .join('');
  return `<svg width="${size}" height="${size}" viewBox="${def.viewBox}">${kids}</svg>`;
}

const dataUrl = (/** @type {string} */ file) =>
  `data:image/svg+xml;base64,${readFileSync(file).toString('base64')}`;
const img = (/** @type {string} */ file, /** @type {number} */ size) =>
  `<img src="${dataUrl(file)}" width="${size}" height="${size}" alt="">`;

const SIZES = [16, 17, 20, 24, 32, 64];
const cell = (/** @type {string} */ inner, /** @type {string} */ label) =>
  `<figure>${inner}<figcaption>${label}</figcaption></figure>`;

function panel(/** @type {keyof typeof THEMES} */ theme) {
  const t = THEMES[theme];
  const rows = [
    `<div class="row small">${SIZES.map((s) => cell(inApp(s, theme), `${s}`)).join('')}</div>`,
    `<div class="row small">${cell(img(join(kit, 'favicon.svg'), 16), 'favicon 16')}${cell(img(join(kit, 'favicon.svg'), 32), 'favicon 32')}` +
      `<figure class="mono" data-theme="${theme}">${readFileSync(join(kit, 'glyph-mono.svg'), 'utf8').replace(/width="24" height="24"/u, 'width="24" height="24" class="m"')}<figcaption>mono 24</figcaption></figure>` +
      (before === undefined
        ? ''
        : `${cell(img(join(before, 'favicon.svg'), 16), 'before 16')}${cell(img(join(before, 'logo.svg'), 24), 'before 24')}${cell(img(join(before, 'logo.svg'), 64), 'before 64')}`) +
      `</div>`,
    `<div class="row">${cell(inApp(256, theme), '256')}${cell(img(join(kit, 'logo.svg'), 128), 'logo.svg 128')}</div>`,
  ];
  return `<section style="background:${t.bg};color:${t.text}"><h2>${theme}</h2>${rows.join('')}</section>`;
}

const tiles = [64, 128, 512]
  .map((s) => cell(img(join(kit, 'app-icon.svg'), s), `app icon ${s}`))
  .join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font:12px/1.3 system-ui,sans-serif;background:#fff}
  section{padding:16px 20px}
  h2{margin:0 0 10px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;opacity:.7}
  .row{display:flex;align-items:flex-end;gap:22px;flex-wrap:wrap;margin-bottom:14px}
  figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px}
  figcaption{font-size:11px;opacity:.65}
  svg,img{display:block}
  .mono[data-theme=light]{color:#1C1C24}.mono[data-theme=dark]{color:#F4F4FA}
  .tiles{display:flex;align-items:flex-end;gap:28px;padding:20px;background:linear-gradient(90deg,#EEF0F8 50%,#0B0D1F 50%)}
  .tiles figcaption{background:#fff;color:#1C1C24;opacity:1;padding:1px 8px;border-radius:6px}
</style></head><body>${panel('light')}${panel('dark')}<div class="tiles">${tiles}</div></body></html>`;

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({
    deviceScaleFactor: 1,
    viewport: { width: 1000, height: 600 },
  });
  await page.setContent(html);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  /** Screenshot of one block, in the colour scheme its standalone SVGs should follow. */
  const shoot = async (/** @type {string} */ selector, /** @type {'light' | 'dark'} */ scheme) => {
    await page.emulateMedia({ colorScheme: scheme });
    return (await page.locator(selector).screenshot()).toString('base64');
  };
  /** The small-size row of a panel (its first 460 px), for the 4x zoom. */
  const shootSmall = async (
    /** @type {string} */ selector,
    /** @type {'light' | 'dark'} */ scheme,
  ) => {
    await page.emulateMedia({ colorScheme: scheme });
    const row = page.locator(selector);
    await row.scrollIntoViewIfNeeded();
    const r = await row.boundingBox();
    if (r === null) throw new Error(`${selector} not laid out`);
    const clip = { x: r.x - 12, y: r.y - 8, width: 460, height: r.height + 16 };
    return (await page.screenshot({ clip })).toString('base64');
  };
  const blocks = [
    await shoot('section:nth-of-type(1)', 'light'),
    await shoot('section:nth-of-type(2)', 'dark'),
    await shoot('.tiles', 'light'),
  ];
  const small = [
    await shootSmall('section:nth-of-type(1) .row.small >> nth=0', 'light'),
    await shootSmall('section:nth-of-type(1) .row.small >> nth=1', 'light'),
    await shootSmall('section:nth-of-type(2) .row.small >> nth=0', 'dark'),
    await shootSmall('section:nth-of-type(2) .row.small >> nth=1', 'dark'),
  ];
  const compose = async (
    /** @type {string[]} */ pngs,
    /** @type {number} */ width,
    /** @type {string} */ file,
    pixelated = false,
  ) => {
    const sheet = await browser.newPage({ deviceScaleFactor: 1, viewport: { width, height: 400 } });
    await sheet.setContent(
      `<body style="margin:0">${pngs.map((b) => `<img src="data:image/png;base64,${b}" style="display:block;${pixelated ? `width:${width}px;image-rendering:pixelated` : ''}">`).join('')}</body>`,
    );
    await sheet.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    await sheet.screenshot({ path: file, fullPage: true });
    await sheet.close();
  };
  const out = join(here, 'contact-sheet.png');
  const zoomOut = join(here, 'contact-sheet-zoom.png');
  await compose(blocks, 1000, out);
  await compose(small, 1840, zoomOut, true);
  console.log(`${out}\n${zoomOut}`);
} finally {
  await browser.close();
}
