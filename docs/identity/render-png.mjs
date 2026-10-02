#!/usr/bin/env node
/**
 * Renders the PNG exports of the Plotinium identity kit from its SVG sources, in real Chrome
 * (Playwright, channel 'chrome'), one device pixel per CSS pixel, transparent where the SVG is.
 *
 *   node docs/identity/render-png.mjs          (run from the repository root)
 *
 * Output: docs/identity/icons/*.png. The SVGs are the source of truth; re-run this after any
 * change to favicon.svg, app-icon.svg or maskable-icon.svg. The PNGs are rendered with the
 * light colour scheme, because a PNG cannot follow prefers-color-scheme.
 */
import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'icons');

/** @type {ReadonlyArray<{ src: string; out: string; size: number }>} */
const jobs = [
  { src: 'favicon.svg', out: 'favicon-16.png', size: 16 },
  { src: 'favicon.svg', out: 'favicon-32.png', size: 32 },
  // iOS masks the touch icon itself and fills transparency with black, so it uses the
  // full-bleed maskable artwork.
  { src: 'maskable-icon.svg', out: 'apple-touch-icon.png', size: 180 },
  { src: 'app-icon.svg', out: 'icon-192.png', size: 192 },
  { src: 'app-icon.svg', out: 'icon-512.png', size: 512 },
  { src: 'maskable-icon.svg', out: 'maskable-192.png', size: 192 },
  { src: 'maskable-icon.svg', out: 'maskable-512.png', size: 512 },
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1, colorScheme: 'light' });
  for (const job of jobs) {
    const svg = await readFile(join(here, job.src));
    const src = `data:image/svg+xml;base64,${svg.toString('base64')}`;
    await page.setViewportSize({ width: job.size, height: job.size });
    await page.setContent(
      `<!doctype html><html style="background:transparent"><body style="margin:0;background:transparent">` +
        `<img id="i" alt="" src="${src}" style="display:block;width:${job.size}px;height:${job.size}px">` +
        `</body></html>`,
    );
    await page.waitForFunction(() => {
      const img = document.getElementById('i');
      return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
    });
    await page.screenshot({
      path: join(outDir, job.out),
      clip: { x: 0, y: 0, width: job.size, height: job.size },
      omitBackground: true,
    });
    console.log(`${job.out} (${job.size} px) from ${job.src}`);
  }
} finally {
  await browser.close();
}
