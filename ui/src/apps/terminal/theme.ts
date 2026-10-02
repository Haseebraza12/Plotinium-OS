/**
 * Plotinium's xterm.js themes, built from design tokens (ui-design-system.md §4.4, DSN-02,
 * DSN-13). xterm needs concrete colours, so a probe element resolves each `--pl-*` token in
 * the host's own theme scope (a `[data-theme]` subtree works too). Translucent tokens are
 * flattened over the background, so xterm's minimumContrastRatio (4.5) measures the colour
 * that is actually drawn.
 */
import type { ITerminalOptions, ITheme } from '@xterm/xterm';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp255 = (n: number): number => Math.min(255, Math.max(0, Math.round(n)));

function channel(part: string): number {
  const text = part.trim();
  return text.endsWith('%') ? (Number.parseFloat(text) / 100) * 255 : Number.parseFloat(text);
}
function alpha(part: string | undefined): number {
  if (part === undefined || part.trim() === '') return 1;
  const text = part.trim();
  const value = text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, and `rgb()`/`rgba()` in comma or space syntax. */
export function parseColour(input: string): Rgba | undefined {
  const text = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/u.exec(text)?.[1];
  if (hex !== undefined) {
    const full =
      hex.length <= 4
        ? [...hex].map((c) => c + c).join('')
        : hex.length === 6 || hex.length === 8
          ? hex
          : undefined;
    if (full === undefined) return undefined;
    const at = (i: number): number => Number.parseInt(full.slice(i, i + 2), 16);
    return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) / 255 : 1 };
  }
  const fn = /^rgba?\((.*)\)$/u.exec(text)?.[1];
  if (fn === undefined) return undefined;
  const [rgbPart = '', slashAlpha] = fn.split('/');
  const parts = rgbPart.includes(',')
    ? rgbPart.split(',')
    : rgbPart.trim().split(/\s+/u).filter(Boolean);
  if (parts.length < 3) return undefined;
  const [r = '', g = '', b = '', commaAlpha] = parts;
  const rgba = {
    r: clamp255(channel(r)),
    g: clamp255(channel(g)),
    b: clamp255(channel(b)),
    a: alpha(slashAlpha ?? commaAlpha),
  };
  return [rgba.r, rgba.g, rgba.b].some((n) => Number.isNaN(n)) ? undefined : rgba;
}

/** Composites a colour over an opaque background. */
export function flatten(colour: Rgba, background: Rgba): Rgba {
  const a = colour.a;
  return {
    r: clamp255(colour.r * a + background.r * (1 - a)),
    g: clamp255(colour.g * a + background.g * (1 - a)),
    b: clamp255(colour.b * a + background.b * (1 - a)),
    a: 1,
  };
}

export function toHex(colour: Rgba): string {
  const hex = (n: number): string => clamp255(n).toString(16).padStart(2, '0');
  const base = `#${hex(colour.r)}${hex(colour.g)}${hex(colour.b)}`;
  return colour.a >= 1 ? base : `${base}${hex(colour.a * 255)}`;
}

/** WCAG relative luminance. */
export function luminance(colour: Rgba): number {
  const lin = (n: number): number => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(colour.r) + 0.7152 * lin(colour.g) + 0.0722 * lin(colour.b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/**
 * Token for each xterm slot. Slots 0, 7, 8 and 15 (the greys) differ by scheme: on a light
 * background "black" is the text colour and "white" a mid grey; everything else is the same
 * token, which already changes with the theme.
 */
export const TERMINAL_TOKENS = {
  background: '--pl-surface',
  foreground: '--pl-text',
  cursor: '--pl-accent',
  selection: '--pl-text-selection',
  /** ANSI 1–6 and 9–14 (index → token); the greys come from ANSI_GREYS. */
  hues: {
    1: '--pl-danger',
    2: '--pl-success',
    3: '--pl-warning',
    4: '--pl-info',
    5: '--pl-accent-text',
    6: '--pl-tint-teal',
    9: '--pl-tint-red',
    10: '--pl-tint-green',
    11: '--pl-tint-yellow',
    12: '--pl-tint-blue',
    13: '--pl-tint-purple',
    14: '--pl-tint-teal',
  },
} as const;

export const ANSI_GREYS = {
  dark: { 0: '--pl-surface-3', 7: '--pl-text-muted', 8: '--pl-text-tertiary', 15: '--pl-text' },
  light: {
    0: '--pl-text',
    7: '--pl-text-tertiary',
    8: '--pl-text-muted',
    15: '--pl-text-disabled',
  },
} as const;

/** Returns the computed colour of a token, or '' when it is not defined. */
export type TokenResolver = (token: string) => string;

export type Scheme = 'light' | 'dark';

export interface PlotiniumTerminalTheme {
  scheme: Scheme;
  theme: ITheme;
}

const FALLBACK = {
  dark: { background: { r: 30, g: 30, b: 38, a: 1 }, foreground: { r: 235, g: 235, b: 245, a: 1 } },
  light: {
    background: { r: 255, g: 255, b: 255, a: 1 },
    foreground: { r: 28, g: 28, b: 30, a: 1 },
  },
} as const;

/**
 * Builds the xterm theme from tokens. The scheme is read from the background's luminance, so
 * the same code serves light, dark and any `[data-theme]` subtree.
 */
export function buildTerminalTheme(resolve: TokenResolver): PlotiniumTerminalTheme {
  const parsed = parseColour(resolve(TERMINAL_TOKENS.background));
  const scheme: Scheme = parsed === undefined || luminance(parsed) < 0.4 ? 'dark' : 'light';
  const background =
    parsed === undefined
      ? FALLBACK[scheme].background
      : flatten(parsed, FALLBACK[scheme].background);
  const colour = (token: string, fallback: Rgba = FALLBACK[scheme].foreground): string => {
    const value = parseColour(resolve(token));
    return toHex(flatten(value ?? fallback, background));
  };
  const selection = parseColour(resolve(TERMINAL_TOKENS.selection));
  const greys = ANSI_GREYS[scheme];
  const hues = TERMINAL_TOKENS.hues;
  return {
    scheme,
    theme: {
      background: toHex(background),
      foreground: colour(TERMINAL_TOKENS.foreground),
      cursor: colour(TERMINAL_TOKENS.cursor),
      cursorAccent: toHex(background),
      // Selection keeps its alpha: xterm draws it over the text.
      selectionBackground: selection === undefined ? undefined : toHex(selection),
      black: colour(greys[0]),
      red: colour(hues[1]),
      green: colour(hues[2]),
      yellow: colour(hues[3]),
      blue: colour(hues[4]),
      magenta: colour(hues[5]),
      cyan: colour(hues[6]),
      white: colour(greys[7]),
      brightBlack: colour(greys[8]),
      brightRed: colour(hues[9]),
      brightGreen: colour(hues[10]),
      brightYellow: colour(hues[11]),
      brightBlue: colour(hues[12]),
      brightMagenta: colour(hues[13]),
      brightCyan: colour(hues[14]),
      brightWhite: colour(greys[15]),
    },
  };
}

/**
 * Resolves tokens in the scope of `el` through a hidden probe (its computed `color` is the
 * token's colour in rgb()/rgba() form). Non-colour tokens (the font stack) are read with
 * getPropertyValue.
 */
export function createTokenResolver(el: HTMLElement): TokenResolver {
  return (token) => {
    const probe = el.ownerDocument.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.color = `var(${token})`;
    el.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value !== '' && !value.startsWith('var(')
      ? value
      : getComputedStyle(el).getPropertyValue(token).trim();
  };
}

/**
 * Used when `--pl-font-mono` cannot be read: the head of that token (UI-004 made the mono face
 * JetBrains Mono, because Geist Mono drew `r` like `ɪ` at 12–14 px on 1x screens; UI-130).
 */
export const TERMINAL_FONT_FALLBACK =
  "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace";

/**
 * The `--pl-font-mono` stack in the scope of `el`, on one line. A font list is not a colour, so
 * the probe of createTokenResolver would answer with the inherited text colour; without an
 * injected resolver the custom property is read directly. Undefined when it is not set.
 */
export function monoFontFamily(el: HTMLElement, resolve?: TokenResolver): string | undefined {
  const raw =
    resolve === undefined
      ? getComputedStyle(el).getPropertyValue('--pl-font-mono')
      : resolve('--pl-font-mono');
  const value = raw.replace(/\s+/gu, ' ').trim();
  return value === '' || /^rgba?\(/u.test(value) ? undefined : value;
}

/**
 * Calls `then` once the faces of `font` (a CSS font shorthand such as `14px 'JetBrains Mono'`) have
 * loaded, when they had not loaded yet. Nothing happens without the CSS Font Loading API, when
 * the faces are already there, or when no web font matches.
 */
export function whenFontLoaded(doc: Document, font: string, then: () => void): void {
  const fonts = (doc as { fonts?: FontFaceSet }).fonts;
  if (fonts === undefined || typeof fonts.check !== 'function') return;
  let loaded: boolean;
  try {
    loaded = fonts.check(font);
  } catch {
    return;
  }
  if (loaded) return;
  fonts.load(font).then(
    (faces) => {
      if (faces.length > 0) then();
    },
    () => undefined,
  );
}

export interface TerminalOptionInputs {
  theme: ITheme;
  /** The resolved `--pl-font-mono` stack. */
  fontFamily?: string;
  fontSize?: number;
  reducedMotion?: boolean;
  screenReaderMode?: boolean;
  scrollback?: number;
}

/** xterm options from ui-design-system.md §3.8.10. */
export function terminalOptions(inputs: TerminalOptionInputs): ITerminalOptions {
  return {
    theme: inputs.theme,
    fontFamily:
      inputs.fontFamily === undefined || inputs.fontFamily === ''
        ? TERMINAL_FONT_FALLBACK
        : inputs.fontFamily,
    fontSize: inputs.fontSize ?? 14,
    lineHeight: 1.2,
    cursorStyle: 'block',
    cursorInactiveStyle: 'outline',
    cursorBlink: inputs.reducedMotion !== true,
    scrollback: inputs.scrollback ?? 5000,
    minimumContrastRatio: 4.5,
    screenReaderMode: inputs.screenReaderMode === true,
    allowProposedApi: false,
    drawBoldTextInBrightColors: false,
    macOptionIsMeta: true,
  };
}
