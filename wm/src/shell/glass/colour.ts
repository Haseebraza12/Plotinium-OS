/**
 * Colour maths for adaptive glass (RFC 0006 §5.2; DSN-40). sRGB triples in 0..255, WCAG 2.x
 * relative luminance and contrast ratio, source-over compositing, and the CSS `saturate()`
 * matrix (Filter Effects §13.1.1). Pure and framework-free, so the worker, the main thread and
 * the tests share one implementation.
 */

/** An sRGB colour in 0..255 per channel. */
export type Rgb = readonly [r: number, g: number, b: number];
/** An sRGB colour with straight (not premultiplied) alpha in 0..1. */
export type Rgba = readonly [r: number, g: number, b: number, a: number];

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Linearises one 0..255 sRGB channel. */
function linear(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance, 0..1. */
export function luminance(c: Rgb | Rgba): number {
  return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
}

/** WCAG 2.x contrast ratio of two opaque colours, 1..21. */
export function contrastRatio(a: Rgb | Rgba, b: Rgb | Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
}

/** `fg` composited over the opaque `bg` (source-over in sRGB, as browsers blend). */
export function over(fg: Rgba, bg: Rgb | Rgba): Rgb {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
}

/** The same colour with another alpha. */
export function withAlpha(c: Rgba, a: number): Rgba {
  return [c[0], c[1], c[2], a];
}

/** CSS `saturate(s)` applied to one sRGB colour (the feColorMatrix "saturate" matrix). */
export function saturate(c: Rgb, s: number): Rgb {
  const [r, g, b] = c;
  return [
    clamp255((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b),
    clamp255((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b),
    clamp255((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b),
  ];
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const FUNC = /^rgba?\(\s*([^)]*)\)$/iu;
const SRGB = /^color\(\s*srgb\s+([^)]*)\)$/iu;

function alphaOf(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 1;
  const v = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : Number.NaN;
}

/**
 * Parses the colour spellings `getComputedStyle` and our tokens use: `#rgb`, `#rrggbb`,
 * `#rrggbbaa`, `rgb(r g b / a)`, `rgb(r, g, b)`, `rgba(r, g, b, a)` and `color(srgb r g b / a)`
 * (what Chrome returns for `color-mix()`). Anything else (a keyword, `var()`) is undefined.
 */
export function parseColour(value: string): Rgba | undefined {
  const v = value.trim();
  const hex = HEX.exec(v)?.[1];
  if (hex !== undefined) {
    const full =
      hex.length === 3
        ? [...hex].map((ch) => ch + ch).join('')
        : hex.length === 8
          ? hex.slice(0, 6)
          : hex;
    const n = Number.parseInt(full, 16);
    const a = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  const fn = FUNC.exec(v)?.[1];
  const srgb = fn === undefined ? SRGB.exec(v)?.[1] : undefined;
  const body = fn ?? srgb;
  if (body === undefined) return undefined;
  const [channels = '', slashAlpha] = body.split('/');
  const parts = channels
    .split(/[\s,]+/u)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length < 3 || parts.length > 4) return undefined;
  const scale = srgb === undefined ? 1 : 255;
  const channel = (p: string): number =>
    p.endsWith('%') ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p) * scale;
  const rgb = parts.slice(0, 3).map(channel);
  const a = alphaOf(slashAlpha?.trim() ?? parts[3]);
  if (rgb.some((c) => !Number.isFinite(c)) || !Number.isFinite(a)) return undefined;
  return [clamp255(rgb[0] ?? 0), clamp255(rgb[1] ?? 0), clamp255(rgb[2] ?? 0), a];
}
