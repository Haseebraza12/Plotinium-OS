import { describe, expect, it } from 'vitest';

import type { AccentId } from '../apps/settings/models.ts';

import motionCss from './motion.css?raw';
import tokensCss from './tokens.css?raw';

/** Component CSS and the tokens it may use (DSN-02). */
const moduleCss = import.meta.glob<string>('../**/*.module.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * Custom properties that components set at run time (inline style) or define locally as inputs
 * to a calculation; they are not design tokens.
 */
const COMPONENT_INPUTS = new Set([
  '--pl-seg-count',
  '--pl-seg-index',
  '--pl-tab-count',
  '--pl-tab-index',
  '--pl-slider-pct',
  '--pl-progress-ratio',
  '--pl-progress-color',
  '--pl-table-cols',
  '--pl-tile-tint',
  '--pl-knob-x',
  '--pl-knob-sx',
  '--pl-pill-fg',
  '--pl-pill-bg',
  '--pl-avatar-size',
  '--pl-spinner-size',
  '--pl-genie-x',
  '--pl-genie-y',
  '--pl-flip-x',
  '--pl-flip-y',
  '--pl-flip-sx',
  '--pl-flip-sy',
  '--pl-stagger-index',
  '--pl-stack-index',
  '--pl-sweep-count',
  '--pl-knob-mid',
]);

function block(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`missing ${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed ${selector}`);
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const clean = body.replace(/\/\*[\s\S]*?\*\//gu, '');
  for (const match of clean.matchAll(/(--pl-[\w-]+)\s*:\s*([^;]+);/gu)) {
    const [, name, value] = match;
    if (name === undefined || value === undefined) continue;
    // Prettier may wrap long values across lines; compare them in one canonical spelling.
    const canonical = value
      .trim()
      .replace(/\s+/gu, ' ')
      .replace(/\(\s+/gu, '(')
      .replace(/\s+\)/gu, ')');
    out.set(name, canonical);
  }
  return out;
}

const light = declarations(block(tokensCss, ":root,\n  [data-theme='light'] {"));
const darkMedia = declarations(block(tokensCss, ":root:not([data-theme='light'])"));
const darkForced = declarations(
  block(tokensCss, ":root[data-theme='dark'],\n  [data-theme='dark'] {"),
);
const dark = new Map([...light, ...darkMedia]);
const defined = new Set(declarations(tokensCss).keys());

type Rgba = [number, number, number, number];

function parseColour(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/iu.exec(value);
  if (hex?.[1] !== undefined) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/u.exec(value);
  if (rgb !== null)
    return [
      Number(rgb[1]),
      Number(rgb[2]),
      Number(rgb[3]),
      rgb[4] === undefined ? 1 : Number(rgb[4]),
    ];
  throw new Error(`not a plain colour: ${value}`);
}

function resolve(theme: Map<string, string>, name: string): string {
  const value = theme.get(name);
  if (value === undefined) throw new Error(`undefined token ${name}`);
  const ref = /^var\((--pl-[\w-]+)\)$/u.exec(value);
  if (ref?.[1] !== undefined) return resolve(theme, ref[1]);
  // The accent overrides derive their tints: color-mix(in srgb, var(--pl-accent) 14%, transparent).
  const mix = /^color-mix\(in srgb, var\((--pl-[\w-]+)\) (\d+)%, (transparent|#000|#fff)\)$/u.exec(
    value,
  );
  if (mix?.[1] === undefined || mix[2] === undefined) return value;
  const [r, g, b] = parseColour(resolve(theme, mix[1]));
  const p = Number(mix[2]) / 100;
  if (mix[3] === 'transparent') return `rgb(${r} ${g} ${b} / ${p})`;
  const o = mix[3] === '#fff' ? 255 : 0;
  const ch = (c: number): number => Math.round(c * p + o * (1 - p));
  return `rgb(${ch(r)} ${ch(g)} ${ch(b)})`;
}

function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

function luminance(c: Rgba): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

function contrast(
  theme: Map<string, string>,
  fgToken: string,
  bgToken: string,
  base?: string,
): number {
  let bg = parseColour(resolve(theme, bgToken));
  if (bg[3] < 1) bg = over(bg, parseColour(resolve(theme, base ?? '--pl-surface')));
  const fg = over(parseColour(resolve(theme, fgToken)), bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ['--pl-surface', '--pl-surface-2', '--pl-bg'];
const TEXT_ROLES = [
  '--pl-text',
  '--pl-text-muted',
  '--pl-text-tertiary',
  '--pl-accent-text',
  '--pl-danger',
  '--pl-warning',
  '--pl-success',
  '--pl-info',
];
const UI_ROLES = ['--pl-border', '--pl-focus-color'];
const PAIRS: readonly [fg: string, bg: string, min: number][] = [
  ['--pl-on-accent', '--pl-accent', 4.5],
  ['--pl-on-accent', '--pl-danger-fill', 4.5],
  ['--pl-on-selection', '--pl-selection', 4.5],
  ['--pl-on-menu-hover', '--pl-menu-hover', 4.5],
  ['--pl-tooltip-text', '--pl-tooltip-bg', 4.5],
  ['--pl-accent-text', '--pl-accent-subtle', 4.5],
  ['--pl-danger', '--pl-danger-subtle', 4.5],
  ['--pl-warning', '--pl-warning-subtle', 4.5],
  ['--pl-success', '--pl-success-subtle', 4.5],
  ['--pl-info', '--pl-info-subtle', 4.5],
  ['--pl-text', '--pl-glass-window-bg', 4.5],
  ['--pl-text-muted', '--pl-glass-window-bg', 4.5],
];

describe('UI-tokens', () => {
  it('DSN-02 every var(--pl-*) used by component CSS and motion.css is a defined token', () => {
    const missing: string[] = [];
    for (const [file, css] of [...Object.entries(moduleCss), ['motion.css', motionCss] as const]) {
      const local = new Set(declarations(css).keys());
      for (const match of css.matchAll(/var\((--pl-[\w-]+)/gu)) {
        const name = match[1] ?? '';
        if (!defined.has(name) && !local.has(name) && !COMPONENT_INPUTS.has(name))
          missing.push(`${file}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('DSN-02 component CSS uses no raw hex colours', () => {
    const offenders = Object.entries(moduleCss)
      .filter(([, css]) => /#[0-9a-f]{3,8}\b/iu.test(css.replace(/\/\*[\s\S]*?\*\//gu, '')))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('DSN-23 the system-dark and forced-dark blocks define identical values', () => {
    expect(Object.fromEntries(darkForced)).toEqual(Object.fromEntries(darkMedia));
  });

  it('PLT-ID-06 no token is declared twice inside one theme block', () => {
    const duplicates = (body: string): string[] => {
      const names = [...body.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/(--pl-[\w-]+)\s*:/gu)].map(
        (m) => m[1] ?? '',
      );
      return names.filter((name, i) => names.indexOf(name) !== i);
    };
    expect(duplicates(block(tokensCss, ":root,\n  [data-theme='light'] {"))).toEqual([]);
    expect(duplicates(block(tokensCss, ":root:not([data-theme='light'])"))).toEqual([]);
    expect(
      duplicates(block(tokensCss, ":root[data-theme='dark'],\n  [data-theme='dark'] {")),
    ).toEqual([]);
  });

  it('PLT-ID-06 every dark override exists in the light base', () => {
    expect([...darkMedia.keys()].filter((k) => !light.has(k))).toEqual([]);
  });

  it('DSN-39 tokens.css, minified, stays within 5 KB gzip (it is inlined on the boot path)', async () => {
    const minified = tokensCss
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/\s+/gu, ' ')
      .replace(/\s*([{};:,>])\s*/gu, '$1');
    const stream = new Blob([minified]).stream().pipeThrough(new CompressionStream('gzip'));
    const gzipped = await new Response(stream).arrayBuffer();
    expect(gzipped.byteLength).toBeLessThanOrEqual(5 * 1024);
  });

  it('DSN-26 the accent is violet #5856D6 in light and #5E5CE6 in dark', () => {
    expect(light.get('--pl-accent')).toBe('#5856d6');
    expect(darkMedia.get('--pl-accent')).toBe('#5e5ce6');
  });

  it('DSN-05 reduced motion zeroes every duration token and the press scale', () => {
    const reduced = declarations(block(tokensCss, ":root[data-motion='reduce']"));
    for (const name of [
      '--pl-motion-press',
      '--pl-motion-fast',
      '--pl-motion-med',
      '--pl-motion-slow',
      '--pl-motion-xslow',
    ]) {
      expect(reduced.get(name)).toBe('0ms');
    }
    expect(reduced.get('--pl-k')).toBe('0');
    expect(reduced.get('--pl-press-scale')).toBe('1');
  });

  it('DSN-25 reduced transparency removes every glass backdrop filter', () => {
    const reduced = declarations(block(tokensCss, ":root[data-transparency='reduce']"));
    const filters = [...light.keys()].filter(
      (k) => k.startsWith('--pl-glass-') && k.endsWith('-filter'),
    );
    expect(filters.length).toBeGreaterThanOrEqual(5);
    for (const name of filters) expect(reduced.get(name)).toBe('none');
  });

  for (const [themeName, theme] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`DSN-03 text roles reach 4.5:1 on every opaque surface (${themeName})`, () => {
      const failures: string[] = [];
      for (const fg of TEXT_ROLES) {
        for (const bg of SURFACES) {
          const ratio = contrast(theme, fg, bg);
          if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it(`DSN-03 control borders and the focus ring reach 3:1 (${themeName})`, () => {
      const failures: string[] = [];
      for (const fg of UI_ROLES) {
        for (const bg of SURFACES) {
          const ratio = contrast(theme, fg, bg);
          if (ratio < 3) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it(`DSN-03 filled controls, chips and glass pairs reach 4.5:1 (${themeName})`, () => {
      const failures: string[] = [];
      for (const [fg, bg, min] of PAIRS) {
        const ratio = contrast(theme, fg, bg);
        if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    });
  }
});

/** Every accent Settings › Appearance offers (AccentId); violet is the base theme. */
const ACCENTS = [
  'violet',
  'blue',
  'purple',
  'pink',
  'red',
  'orange',
  'yellow',
  'green',
  'graphite',
] as const satisfies readonly AccentId[];

describe('UI-039 accent colours', () => {
  const lightMix = declarations(
    block(tokensCss, ":root[data-accent]:not([data-accent='violet']) {"),
  );
  const darkMixMedia = declarations(
    block(tokensCss, ":root:not([data-theme='light'])[data-accent]:not([data-accent='violet']) {"),
  );
  const darkMixForced = declarations(
    block(tokensCss, ":root[data-theme='dark'][data-accent]:not([data-accent='violet']) {"),
  );

  it('UI-039 the system-dark and forced-dark accent rules define identical values', () => {
    expect(Object.fromEntries(darkMixForced)).toEqual(Object.fromEntries(darkMixMedia));
    for (const accent of ACCENTS.filter((a) => a !== 'violet')) {
      const media = declarations(
        block(tokensCss, `:root:not([data-theme='light'])[data-accent='${accent}'] {`),
      );
      const forced = declarations(
        block(tokensCss, `:root[data-theme='dark'][data-accent='${accent}'] {`),
      );
      expect(Object.fromEntries(forced), accent).toEqual(Object.fromEntries(media));
    }
  });

  it('UI-039 violet is the base theme and every other accent changes the fill and the text', () => {
    expect(tokensCss).not.toContain("[data-accent='violet'] {");
    for (const accent of ACCENTS.filter((a) => a !== 'violet')) {
      const lightAccent = declarations(block(tokensCss, `:root[data-accent='${accent}'] {`));
      expect(lightAccent.get('--pl-accent'), accent).toMatch(/^#[0-9a-f]{6}$/u);
      expect(lightAccent.get('--pl-accent-text'), accent).toMatch(/^#[0-9a-f]{6}$/u);
      expect(lightAccent.get('--pl-accent'), accent).not.toBe(light.get('--pl-accent'));
    }
  });

  for (const accent of ACCENTS.filter((a) => a !== 'violet')) {
    const lightAccent = declarations(block(tokensCss, `:root[data-accent='${accent}'] {`));
    const darkAccent = declarations(
      block(tokensCss, `:root:not([data-theme='light'])[data-accent='${accent}'] {`),
    );
    const themes = [
      ['light', new Map([...light, ...lightMix, ...lightAccent])],
      ['dark', new Map([...dark, ...lightMix, ...darkMixMedia, ...darkAccent])],
    ] as const;
    for (const [themeName, theme] of themes) {
      it(`UI-039 ${accent} keeps text, focus ring and filled controls at WCAG AA (${themeName})`, () => {
        const failures: string[] = [];
        for (const bg of SURFACES) {
          const text = contrast(theme, '--pl-accent-text', bg);
          if (text < 4.5) failures.push(`--pl-accent-text on ${bg}: ${text.toFixed(2)}`);
          const ring = contrast(theme, '--pl-focus-color', bg);
          if (ring < 3) failures.push(`--pl-focus-color on ${bg}: ${ring.toFixed(2)}`);
        }
        for (const [fg, bg, min] of PAIRS) {
          const ratio = contrast(theme, fg, bg);
          if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
        }
        expect(failures).toEqual([]);
      });
    }
  }
});
