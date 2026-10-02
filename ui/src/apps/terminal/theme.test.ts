import { describe, expect, it, vi } from 'vitest';

import tokensCss from '../../tokens/tokens.css?raw';
import {
  buildTerminalTheme,
  contrastRatio,
  flatten,
  monoFontFamily,
  parseColour,
  TERMINAL_FONT_FALLBACK,
  terminalOptions,
  toHex,
  whenFontLoaded,
  type TokenResolver,
} from './theme.ts';

/** Token values as the browser computes them (tokens.css, dark and light). */
const DARK: Record<string, string> = {
  '--pl-surface': 'rgb(30, 30, 38)',
  '--pl-text': 'rgba(255, 255, 255, 0.92)',
  '--pl-text-muted': 'rgba(255, 255, 255, 0.66)',
  '--pl-text-tertiary': 'rgba(255, 255, 255, 0.55)',
  '--pl-surface-3': 'rgb(49, 49, 60)',
  '--pl-accent': 'rgb(94, 92, 230)',
  '--pl-accent-text': 'rgb(165, 164, 255)',
  '--pl-text-selection': 'rgba(94, 92, 230, 0.4)',
  '--pl-danger': 'rgb(255, 105, 97)',
  '--pl-success': 'rgb(48, 209, 88)',
  '--pl-warning': 'rgb(255, 159, 10)',
  '--pl-info': 'rgb(100, 210, 255)',
  '--pl-tint-teal': 'rgb(63, 195, 220)',
  '--pl-tint-red': 'rgb(255, 90, 80)',
  '--pl-tint-green': 'rgb(48, 209, 88)',
  '--pl-tint-yellow': 'rgb(255, 214, 10)',
  '--pl-tint-blue': 'rgb(31, 140, 255)',
  '--pl-tint-purple': 'rgb(191, 90, 242)',
};
const LIGHT: Record<string, string> = {
  ...DARK,
  '--pl-surface': '#ffffff',
  '--pl-text': 'rgb(0 0 0 / 0.86)',
  '--pl-text-muted': 'rgb(0 0 0 / 0.64)',
  '--pl-text-tertiary': 'rgb(0 0 0 / 0.56)',
  '--pl-text-disabled': 'rgb(0 0 0 / 0.36)',
  '--pl-danger': '#c4000f',
  '--pl-success': '#1e7d34',
  '--pl-warning': '#9a4f00',
  '--pl-info': '#00679a',
  '--pl-accent-text': '#4f4dc9',
};
const resolver =
  (map: Record<string, string>): TokenResolver =>
  (token) =>
    map[token] ?? '';

describe('UI-TerminalTheme', () => {
  it('UI-TerminalTheme parses hex and both rgb() syntaxes', () => {
    expect(parseColour('#5e5ce6')).toEqual({ r: 94, g: 92, b: 230, a: 1 });
    expect(parseColour('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColour('rgba(255, 255, 255, 0.5)')).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
    expect(parseColour('rgb(0 0 0 / 0.86)')).toEqual({ r: 0, g: 0, b: 0, a: 0.86 });
    expect(parseColour('var(--x)')).toBeUndefined();
    expect(toHex({ r: 94, g: 92, b: 230, a: 1 })).toBe('#5e5ce6');
    expect(toHex(flatten({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 }))).toBe(
      '#808080',
    );
  });

  it('DSN-13 the dark theme comes from tokens, flattened to opaque colours', () => {
    const { scheme, theme } = buildTerminalTheme(resolver(DARK));
    expect(scheme).toBe('dark');
    expect(theme.background).toBe('#1e1e26');
    expect(theme.red).toBe('#ff6961');
    expect(theme.green).toBe('#30d158');
    expect(theme.magenta).toBe('#a5a4ff');
    expect(theme.cursor).toBe('#5e5ce6');
    expect(theme.foreground).toMatch(/^#[0-9a-f]{6}$/u);
    // Selection keeps its alpha so xterm can draw it over text.
    expect(theme.selectionBackground).toMatch(/^#[0-9a-f]{8}$/u);
  });

  it('DSN-13 the light theme swaps the greys and keeps text readable', () => {
    const { scheme, theme } = buildTerminalTheme(resolver(LIGHT));
    expect(scheme).toBe('light');
    expect(theme.background).toBe('#ffffff');
    expect(theme.black).toBe(theme.foreground);
    const bg = parseColour(theme.background ?? '');
    const fg = parseColour(theme.foreground ?? '');
    expect(bg && fg && contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    for (const slot of ['red', 'green', 'yellow', 'blue', 'magenta'] as const) {
      const colour = parseColour(theme[slot] ?? '');
      expect(colour && bg && contrastRatio(colour, bg), slot).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('DSN-13 xterm options follow §3.8.10 and switch the blink off under reduced motion', () => {
    const options = terminalOptions({ theme: {}, fontFamily: "'Geist Mono Variable', monospace" });
    expect(options).toMatchObject({
      fontSize: 14,
      lineHeight: 1.2,
      cursorStyle: 'block',
      cursorBlink: true,
      scrollback: 5000,
      minimumContrastRatio: 4.5,
      screenReaderMode: false,
      fontFamily: "'Geist Mono Variable', monospace",
    });
    expect(terminalOptions({ theme: {}, reducedMotion: true }).cursorBlink).toBe(false);
    expect(terminalOptions({ theme: {} }).fontFamily).toBe(TERMINAL_FONT_FALLBACK);
  });

  it('UI-130 the fallback face is the one --pl-font-mono names first', () => {
    const token = /--pl-font-mono:\s*([^;]+);/u.exec(tokensCss)?.[1] ?? '';
    const firstFamily = (stack: string): string => (stack.split(',')[0] ?? '').trim();
    expect(firstFamily(token)).not.toBe('');
    expect(firstFamily(TERMINAL_FONT_FALLBACK)).toBe(firstFamily(token));
  });

  it('UI-TerminalTheme the mono stack is read as a custom property, not through the colour probe', () => {
    const el = document.createElement('div');
    el.style.setProperty('--pl-font-mono', "'Geist Mono Variable',\n    'Geist Mono', monospace");
    document.body.append(el);
    expect(monoFontFamily(el)).toBe("'Geist Mono Variable', 'Geist Mono', monospace");
    el.remove();
    // An injected resolver still wins; a colour or an empty answer means "not set".
    expect(monoFontFamily(el, () => "'Test Mono', monospace")).toBe("'Test Mono', monospace");
    expect(monoFontFamily(el, () => 'rgb(235, 235, 245)')).toBeUndefined();
    expect(monoFontFamily(el, () => '  ')).toBeUndefined();
  });

  it('UI-TerminalTheme whenFontLoaded fires only after a face that was missing has loaded', async () => {
    const font = "14px 'Geist Mono Variable', monospace";
    const face = {} as FontFace;
    const load = vi.fn((faces: FontFace[], _spec: string) => Promise.resolve(faces));
    const fakeDoc = (loaded: boolean, faces: FontFace[]): Document =>
      ({
        fonts: { check: () => loaded, load: (spec: string) => load(faces, spec) },
      }) as unknown as Document;

    const missing = vi.fn();
    whenFontLoaded(fakeDoc(false, [face]), font, missing);
    expect(missing).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(missing).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith([face], font);

    const ready = vi.fn();
    whenFontLoaded(fakeDoc(true, [face]), font, ready);
    const noFace = vi.fn();
    whenFontLoaded(fakeDoc(false, []), font, noFace);
    const noApi = vi.fn();
    whenFontLoaded({} as Document, font, noApi);
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    expect(noFace).not.toHaveBeenCalled();
    expect(noApi).not.toHaveBeenCalled();
  });
});
