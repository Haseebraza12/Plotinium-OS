#!/usr/bin/env node
// @ts-check
/**
 * Writes the vector files of the Plotinium identity kit (docs/identity) for the "Bohr P" mark
 * (DECISION.md), then copies the served ones into web/public. Run from the repository root:
 *
 *   node docs/design/logo/build-identity.mjs     # then: node docs/identity/render-png.mjs
 *
 * The mark's path data is read from ui/src/icons/atom-logo.ts (the in-app source), so the kit,
 * the menu bar, the boot splash and About draw one mark; the favicon's own 16-pixel drawing
 * comes from mark-geometry.mjs. Every file is hand-written markup around those paths: plain
 * vector, gradients and at most one blur filter, no fonts, raster images or scripts.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAVICON_16, mark } from './mark-geometry.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const kit = join(repo, 'docs/identity');

/** @type {{ atomLogo: { children: ReadonlyArray<readonly [string, Record<string, string | number>]> } }} */
const icons = await import(join(repo, 'ui/src/icons/atom-logo.ts'));

/** The master mark's four shapes, by pl-logo-* class. */
const parts = Object.fromEntries(
  icons.atomLogo.children.map(([, a]) => [String(a['class']).replace('pl-logo-', ''), a]),
);
const STEM = String(parts['stem']?.['d']);
const SHELL = String(parts['shell']?.['d']);
const core = /** @type {Record<string, string | number>} */ (parts['core']);
const el = /** @type {Record<string, string | number>} */ (parts['electron']);
const CORE = `cx="${core['cx']}" cy="${core['cy']}" r="${core['r']}"`;
const ELECTRON = `cx="${el['cx']}" cy="${el['cy']}" r="${el['r']}"`;

/** Light and dark colours (tokens.css --pl-logo-*; the standalone files cannot read them). */
const LIGHT = { body: '#5856D6', core: '#4F4DC9', electron: '#5856D6' };
const DARK = { body: '#B3B1FF', core: '#FFFFFF', electron: '#CFCEFF' };

/**
 * Colour rules for a standalone file: inlined in a Plotinium page the var() reads the tokens;
 * as an image it uses the light colours, or the dark ones under prefers-color-scheme: dark.
 * @param {string} p class prefix
 */
const colourStyle = (p) =>
  `    .${p}-b{fill:var(--pl-logo-orbit-a,${LIGHT.body})}.${p}-c{fill:var(--pl-logo-core,${LIGHT.core})}.${p}-e{fill:var(--pl-logo-electron,${LIGHT.electron})}\n` +
  `    @media (prefers-color-scheme:dark){.${p}-b{fill:var(--pl-logo-orbit-a,${DARK.body})}.${p}-c{fill:var(--pl-logo-core,${DARK.core})}.${p}-e{fill:var(--pl-logo-electron,${DARK.electron})}}`;

/** @param {string} p class prefix */
const colourShapes = (p) =>
  `  <path class="${p}-b" fill="${LIGHT.body}" d="${STEM}"/>\n` +
  `  <path class="${p}-b" fill="${LIGHT.body}" d="${SHELL}"/>\n` +
  `  <circle class="${p}-e" fill="${LIGHT.electron}" ${ELECTRON}/>\n` +
  `  <circle class="${p}-c" fill="${LIGHT.core}" ${CORE}/>\n`;

const monoShapes = `  <path d="${STEM}"/>\n  <path d="${SHELL}"/>\n  <circle ${ELECTRON}/>\n  <circle ${CORE}/>\n`;

/** @type {Record<string, string>} */
const files = {};

files['glyph.svg'] =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img" aria-labelledby="plt-glyph-t">
  <title id="plt-glyph-t">Plotinium</title>
  <!-- The Plotinium mark ("Bohr P"): an electron shell around a dense nucleus, open at 1:30 where
       the one electron sits; the shell's stem makes it the P of Plotinium. 24-unit grid, fills
       only, edges on multiples of 1.5 units (whole pixels at 16, 32 and 48 px). Same drawing as
       ui/src/icons/atom-logo.ts. Light colours, dark ones under prefers-color-scheme: dark. -->
  <style>
${colourStyle('plt-g')}
  </style>
${colourShapes('plt-g')}</svg>
`;

files['glyph-mono.svg'] =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="currentColor" role="img" aria-labelledby="plt-glyph-mono-t">
  <title id="plt-glyph-mono-t">Plotinium</title>
  <!-- The Plotinium mark in one colour (currentColor): fills only, no gradient or filter. -->
${monoShapes}</svg>
`;

files['logo-mono.svg'] = files['glyph-mono.svg']
  .replaceAll('plt-glyph-mono-t', 'plt-logo-mono-t')
  .replace('width="24" height="24"', 'width="160" height="160"');

files['logo.svg'] =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="160" height="160" role="img" aria-labelledby="plt-logo-t">
  <title id="plt-logo-t">Plotinium</title>
  <!-- The full-colour Plotinium mark: the glyph (glyph.svg) plus, from 48 px up, a soft glow in
       the shell around the nucleus. Inlined in a Plotinium page the colours read the
       pl-logo tokens; as an image it uses the light palette, or the dark one under
       prefers-color-scheme: dark. Inline code should use the UI's AtomLogo instead. -->
  <style>
${colourStyle('plt-logo')}
    .plt-logo-h0{stop-color:#5856D6;stop-opacity:.22}.plt-logo-h1{stop-color:#5856D6;stop-opacity:0}
    @media (prefers-color-scheme:dark){.plt-logo-h0{stop-color:#A5A4FF;stop-opacity:.5}.plt-logo-h1{stop-color:#8C8AFF}}
    @media (max-width:47.99px){.plt-logo-halo{display:none}}
  </style>
  <defs>
    <radialGradient id="plt-logo-hg" cx="12" cy="9" r="4.6" gradientUnits="userSpaceOnUse">
      <stop offset=".55" class="plt-logo-h0" stop-color="#5856D6" stop-opacity=".22"/>
      <stop offset="1" class="plt-logo-h1" stop-color="#5856D6" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle class="plt-logo-halo" cx="12" cy="9" r="4.6" fill="url(#plt-logo-hg) none"/>
${colourShapes('plt-logo')}</svg>
`;

// ---------- favicon: its own 16-pixel drawing ----------
const fav = mark(FAVICON_16);
files['favicon.svg'] =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <title>Plotinium</title>
  <!-- The mark redrawn on a 16-pixel grid for browser tabs: 2 px shell and stem on whole pixels,
       a 3.5 px nucleus, a 2.6 px electron and at least 1 px of clear space between shapes.
       Geometry: docs/design/logo/mark-geometry.mjs (FAVICON_16). -->
  <style>
    .b{fill:${LIGHT.body}}.c{fill:${LIGHT.core}}.e{fill:${LIGHT.electron}}
    @media (prefers-color-scheme:dark){.b{fill:${DARK.body}}.c{fill:${DARK.core}}.e{fill:${DARK.electron}}}
  </style>
  <path class="b" d="${fav.stem}"/>
  <path class="b" d="${fav.shell}"/>
  <circle class="e" cx="${fav.electron.cx}" cy="${fav.electron.cy}" r="${fav.electron.r}"/>
  <circle class="c" cx="${fav.nucleus.cx}" cy="${fav.nucleus.cy}" r="${fav.nucleus.r}"/>
</svg>
`;

// ---------- app icon and maskable icon: the white mark on the violet field ----------
/** The macOS-style tile: 824 units on the 1024 canvas, continuous corners. */
const TILE =
  'M627.36 100c103.83 0 155.75 0 195.41 20.21a185.4 185.4 0 0 1 81.02 81.02c20.21 39.66 20.21 91.58 20.21 195.41L924 627.36c0 103.83 0 155.75 -20.21 195.41a185.4 185.4 0 0 1 -81.02 81.02c-39.66 20.21 -91.58 20.21 -195.41 20.21L396.64 924c-103.83 0 -155.75 0 -195.41 -20.21a185.4 185.4 0 0 1 -81.02 -81.02c-20.21 -39.66 -20.21 -91.58 -20.21 -195.41L100 396.64c0 -103.83 0 -155.75 20.21 -195.41a185.4 185.4 0 0 1 81.02 -81.02c39.66 -20.21 91.58 -20.21 195.41 -20.21Z';

/**
 * The white mark with depth, in 24-unit mark space (the caller scales it): a soft violet
 * shadow under the body and the electron, a glow in the shell, a gently shaded body and the
 * brightest shape, the nucleus.
 * @param {string} p id prefix
 */
const markDefs = (
  p,
) => `    <linearGradient id="${p}-ink" x1="0" y1="1.5" x2="0" y2="22.5" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#ECEBFF"/>
    </linearGradient>
    <radialGradient id="${p}-core" cx="11.3" cy="8.2" r="3.7" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset=".62" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#F1F0FF"/>
    </radialGradient>
    <radialGradient id="${p}-glow" cx="12" cy="9" r="5.4" gradientUnits="userSpaceOnUse">
      <stop offset=".5" stop-color="#FFFFFF" stop-opacity=".5"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <filter id="${p}-drop" x="-30%" y="-20%" width="160%" height="150%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation=".42"/>
    </filter>`;

/** @param {string} p id prefix */
const markBody = (
  p,
) => `      <g fill="#150C52" opacity=".34" filter="url(#${p}-drop)" transform="translate(0 .5)">
        <path d="${STEM}"/><path d="${SHELL}"/><circle ${ELECTRON}/>
      </g>
      <circle cx="12" cy="9" r="5.4" fill="url(#${p}-glow) none"/>
      <path fill="url(#${p}-ink) #FFFFFF" d="${STEM}"/>
      <path fill="url(#${p}-ink) #FFFFFF" d="${SHELL}"/>
      <circle fill="#FFFFFF" ${ELECTRON}/>
      <circle fill="url(#${p}-core) #FFFFFF" ${CORE}/>`;

files['app-icon.svg'] =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-labelledby="plt-app-t">
  <title id="plt-app-t">Plotinium</title>
  <!-- macOS-style app icon: an 824-unit continuous-corner tile on the 1024 canvas with a violet
       gradient, a magenta bloom, a top gloss, a specular rim and a soft drop shadow; the white
       Bohr P mark (glyph.svg scaled 24.5x) with its own soft shadow, a glow in the shell and a
       bright nucleus. -->
  <defs>
    <path id="plt-app-tile" d="${TILE}"/>
    <clipPath id="plt-app-clip"><use href="#plt-app-tile"/></clipPath>
    <linearGradient id="plt-app-bg" x1="200" y1="120" x2="820" y2="930" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#8E8CFF"/>
      <stop offset=".5" stop-color="#5E5CE6"/>
      <stop offset="1" stop-color="#3B2A9E"/>
    </linearGradient>
    <radialGradient id="plt-app-lift" cx="330" cy="250" r="560" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity=".3"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="plt-app-deep" cx="760" cy="900" r="520" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#C040AA" stop-opacity=".32"/>
      <stop offset="1" stop-color="#C040AA" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="plt-app-gloss" x1="0" y1="100" x2="0" y2="560" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity=".22"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="plt-app-rim" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity=".6"/>
      <stop offset=".4" stop-color="#FFFFFF" stop-opacity=".16"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity=".1"/>
    </linearGradient>
    <filter id="plt-app-shadow" x="-10%" y="-10%" width="120%" height="125%" color-interpolation-filters="sRGB">
      <feGaussianBlur stdDeviation="14"/>
    </filter>
${markDefs('plt-app')}
  </defs>
  <use href="#plt-app-tile" transform="translate(0 12)" fill="#0B0A2A" opacity=".3" filter="url(#plt-app-shadow)"/>
  <use href="#plt-app-tile" fill="url(#plt-app-bg) #5E5CE6"/>
  <g clip-path="url(#plt-app-clip)">
    <rect x="100" y="100" width="824" height="824" fill="url(#plt-app-deep) none"/>
    <rect x="100" y="100" width="824" height="824" fill="url(#plt-app-lift) none"/>
    <rect x="100" y="100" width="824" height="460" fill="url(#plt-app-gloss) none"/>
    <g transform="translate(218 218) scale(24.5)">
${markBody('plt-app')}
    </g>
    <use href="#plt-app-tile" fill="none" stroke="url(#plt-app-rim) #FFFFFF" stroke-opacity=".9" stroke-width="6"/>
  </g>
</svg>
`;

files['maskable-icon.svg'] =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-labelledby="plt-mask-t">
  <title id="plt-mask-t">Plotinium</title>
  <!-- Maskable icon: a full-bleed violet field; the mark (glyph.svg scaled 21x, its farthest
       point about 259 units from the centre) stays inside the central safe circle of radius 409.6, so
       any platform mask keeps it whole. -->
  <defs>
    <linearGradient id="plt-mask-bg" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#8E8CFF"/>
      <stop offset=".5" stop-color="#5E5CE6"/>
      <stop offset="1" stop-color="#3B2A9E"/>
    </linearGradient>
    <radialGradient id="plt-mask-lift" cx="280" cy="180" r="700" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity=".28"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="plt-mask-deep" cx="820" cy="980" r="620" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#C040AA" stop-opacity=".3"/>
      <stop offset="1" stop-color="#C040AA" stop-opacity="0"/>
    </radialGradient>
${markDefs('plt-mask')}
  </defs>
  <rect width="1024" height="1024" fill="url(#plt-mask-bg) #5E5CE6"/>
  <rect width="1024" height="1024" fill="url(#plt-mask-deep) none"/>
  <rect width="1024" height="1024" fill="url(#plt-mask-lift) none"/>
  <g transform="translate(260 260) scale(21)">
${markBody('plt-mask')}
  </g>
</svg>
`;

// ---------- lock-up: mark + the outlined wordmark (wordmark.svg, unchanged) ----------
const wordmark = readFileSync(join(kit, 'wordmark.svg'), 'utf8');
const wordPath = /<path class="plt-wm" fill="#1C1C24" d="([^"]+)"\/>/u.exec(wordmark)?.[1];
if (wordPath === undefined) throw new Error('wordmark.svg: outline path not found');
// Wordmark units: font size 100, baseline y = 0, cap height 72.75, ink from x 6.1 to 404.2.
const CAP = 72.75;
const markH = 1.25 * CAP; // identity-and-branding.md §3.5
const s = markH / 21; // the mark's ink is 21 units tall (y 1.5 to 22.5)
const gap = markH / 2;
const inkRight = 6.1 - gap;
const inkLeft = inkRight - 15 * s; // ink is 15 units wide (x 4.5 to 19.5)
const tx = inkLeft - 4.5 * s;
const ty = -CAP / 2 - 12 * s; // centred on the cap height
const top = ty + 1.5 * s;
const bottom = ty + 22.5 * s;
const pad = 6;
const vb = [inkLeft - pad, top - pad, 404.2 - inkLeft + 2 * pad, bottom - top + 2 * pad];
const fmt = (/** @type {number} */ v) => String(Math.round(v * 100) / 100);
files['lockup.svg'] =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map(fmt).join(' ')}" width="${fmt(vb[2] * 0.6)}" height="${fmt(vb[3] * 0.6)}" role="img" aria-labelledby="plt-lu-t">
  <title id="plt-lu-t">Plotinium</title>
  <!-- Horizontal lock-up: the mark, then the outlined wordmark (wordmark.svg). The mark's ink is
       1.25 x the wordmark's cap height and centred on it (the stem drops below the baseline like
       a descender); the gap is half the mark's height. Keep clear space of at least one
       x-height (51.56 units) on every side. -->
  <style>
${colourStyle('plt-lu')}
    .plt-wm{fill:var(--pl-text,#1C1C24)}
    @media (prefers-color-scheme:dark){.plt-wm{fill:var(--pl-text,#F4F4FA)}}
  </style>
  <g transform="translate(${fmt(tx)} ${fmt(ty)}) scale(${Math.round(s * 10000) / 10000})">
${colourShapes('plt-lu').replaceAll(/^ {2}/gmu, '    ')}  </g>
  <path class="plt-wm" fill="#1C1C24" d="${wordPath}"/>
</svg>
`;

for (const [name, text] of Object.entries(files)) {
  // XML forbids "--" inside a comment; a file that breaks it does not load as an image at all.
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/gu))
    if ((m[1] ?? '').includes('--')) throw new Error(`${name}: "--" inside an XML comment`);
  writeFileSync(join(kit, name), text);
  console.log(`docs/identity/${name} (${Buffer.byteLength(text)} bytes)`);
}

// web/public serves the kit: the favicon and icons at the root, every seeded file under branding/.
const pub = join(repo, 'web/public');
for (const name of ['favicon.svg', 'app-icon.svg', 'maskable-icon.svg'])
  copyFileSync(join(kit, name), join(pub, name));
for (const name of [
  'logo.svg',
  'logo-mono.svg',
  'lockup.svg',
  'favicon.svg',
  'app-icon.svg',
  'maskable-icon.svg',
  'usage.md',
])
  copyFileSync(join(kit, name), join(pub, 'branding', name));
console.log('copied into web/public and web/public/branding');
