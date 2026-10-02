/**
 * UI-145: text on two primitives fell below 4.5:1 (WCAG 1.4.3). The white initials of an Avatar
 * sat on bright gradients (about 2.5:1 on teal, orange and green), and the danger Button's label
 * ("Clear telemetry") measured 4.1:1 in dark. The fixes are a shade layer per avatar gradient and a
 * danger label mixed toward the text colour. This test recomputes both from the CSS and the tokens.
 */
import { describe, expect, it } from 'vitest';

import tokensCss from '../tokens/tokens.css?raw';
import avatarCss from './avatar/Avatar.module.css?raw';
import buttonCss from './button/Button.module.css?raw';

type Rgb = [number, number, number];

function hex(value: string): Rgb {
  const m = /^#([0-9a-f]{6})$/iu.exec(value.trim());
  if (m?.[1] === undefined) throw new Error(`not a hex colour: ${value}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(value: string): [Rgb, number] {
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/u.exec(value.trim());
  if (m === null) throw new Error(`not rgb(r g b / a): ${value}`);
  return [[Number(m[1]), Number(m[2]), Number(m[3])], Number(m[4])];
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => (fg[i] ?? 0) * alpha + (bg[i] ?? 0) * (1 - alpha)) as Rgb;
}

/** The first declaration of `name` inside the block that starts at `selector`. */
function tokenIn(selector: string, name: string): string {
  const start = tokensCss.indexOf(selector);
  if (start < 0) throw new Error(`missing ${selector}`);
  const m = new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(tokensCss.slice(start));
  if (m?.[1] === undefined) throw new Error(`missing ${name}`);
  return m[1].replace(/\s+/gu, ' ').trim();
}

const LIGHT = ":root,\n  [data-theme='light'] {";
const DARK = ":root:not([data-theme='light'])";

describe('UI-145 primitive text contrast', () => {
  it('UI-145 white avatar initials reach 4.5:1 over the whole glyph band of every gradient', () => {
    const onTint = hex(tokenIn(LIGHT, '--pl-on-tint'));
    const failures: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const gradient = tokenIn(LIGHT, `--pl-avatar-${i}`);
      const stops = [...gradient.matchAll(/#[0-9a-f]{6}/giu)].map((m) => hex(m[0]));
      const [from, to] = stops;
      if (from === undefined || to === undefined) throw new Error(`avatar ${i}: ${gradient}`);
      const shade = new RegExp(
        `\\.c${i} \\{\\s*background: linear-gradient\\(rgb\\(0 0 0 / ([\\d.]+)\\)`,
        'u',
      ).exec(avatarCss);
      expect(shade, `.c${i} has a shade layer`).not.toBeNull();
      const alpha = Number(shade?.[1]);
      // The initials are 0.42 of the disc, centred: the gradient runs 25 % to 75 % under them.
      for (let t = 0.25; t <= 0.75 + 1e-9; t += 0.05) {
        const base = over(to, t, from);
        const c = ratio(onTint, over([0, 0, 0], alpha, base));
        if (c < 4.5) failures.push(`avatar ${i} at ${Math.round(t * 100)}%: ${c.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('UI-145 the danger button label reaches 4.5:1 on its tint in both themes', () => {
    const rule =
      /\.danger \{\s*color: color-mix\(in srgb, var\(--pl-danger\) (\d+)%, var\(--pl-text\)\);/u.exec(
        buttonCss,
      );
    expect(rule).not.toBeNull();
    const p = Number(rule?.[1]) / 100;
    for (const [theme, selector] of [
      ['light', LIGHT],
      ['dark', DARK],
    ] as const) {
      const danger = hex(tokenIn(selector, '--pl-danger'));
      const [text, textA] = rgba(tokenIn(selector, '--pl-text'));
      const [tint, tintA] = rgba(tokenIn(selector, '--pl-danger-subtle'));
      // color-mix in srgb interpolates premultiplied colours and the alphas.
      const a = p + textA * (1 - p);
      const mixed = [0, 1, 2].map(
        (i) => ((danger[i] ?? 0) * p + (text[i] ?? 0) * textA * (1 - p)) / a,
      ) as Rgb;
      for (const surface of ['--pl-surface', '--pl-surface-2', '--pl-bg']) {
        const bg = over(tint, tintA, hex(tokenIn(selector, surface)));
        const c = ratio(over(mixed, a, bg), bg);
        expect(c, `${theme} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
