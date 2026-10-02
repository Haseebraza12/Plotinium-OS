import { describe, expect, it, vi } from 'vitest';

import { INERT_STYLE_TAG, mirrorBlockedStyles, withInertStyles } from './csp-styles.ts';

describe('UI-050 csp-styles', () => {
  it('UI-050 withInertStyles answers createElement("style") with a hidden stand-in, only during the call', () => {
    const made = withInertStyles(document, () => ({
      style: document.createElement('style'),
      upper: document.createElement('STYLE'),
      div: document.createElement('div'),
    }));
    for (const el of [made.style, made.upper]) {
      expect(el.localName).toBe(INERT_STYLE_TAG);
      expect(el.hidden).toBe(true);
      expect(el).not.toBeInstanceOf(HTMLStyleElement);
    }
    expect(made.div).toBeInstanceOf(HTMLDivElement);
    expect(document.createElement('style')).toBeInstanceOf(HTMLStyleElement);
    expect(Object.getOwnPropertyDescriptor(document, 'createElement')).toBeUndefined();
  });

  it('UI-050 withInertStyles restores createElement when the call throws, and returns its value', () => {
    expect(() =>
      withInertStyles(document, () => {
        throw new Error('open failed');
      }),
    ).toThrow('open failed');
    expect(document.createElement('style')).toBeInstanceOf(HTMLStyleElement);
    expect(withInertStyles(document, () => 42)).toBe(42);
  });

  it('UI-050 withInertStyles keeps an own createElement a host had installed', () => {
    const own = vi.fn((tag: string) => Document.prototype.createElement.call(document, tag));
    Object.defineProperty(document, 'createElement', {
      configurable: true,
      writable: true,
      value: own,
    });
    try {
      withInertStyles(document, () => document.createElement('span'));
      expect(own).toHaveBeenCalledWith('span', undefined);
      expect(Object.getOwnPropertyDescriptor(document, 'createElement')?.value).toBe(own);
    } finally {
      Reflect.deleteProperty(document, 'createElement');
    }
  });

  it('UI-050 the mirror adopts a stand-in’s CSS, follows its rewrites and drops it on removal', async () => {
    const root = document.createElement('div');
    const screen = document.createElement('div');
    root.append(screen);
    document.body.append(root);
    const standIn = withInertStyles(document, () => document.createElement('style'));
    standIn.textContent = '.owner-7 .xterm-rows { font-family: "Geist Mono Variable"; }';
    screen.append(standIn);
    const before = document.adoptedStyleSheets.length;
    // Even a test that says "nothing is blocked" mirrors stand-ins: the browser never applies them.
    const dispose = mirrorBlockedStyles(root, () => false);
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
    const sheet = document.adoptedStyleSheets.at(-1);
    expect(sheet?.cssRules[0]?.cssText).toContain('Geist Mono Variable');
    standIn.textContent = '.owner-7 .xterm-fg-2 { color: rgb(48, 209, 88); }';
    await vi.waitFor(() => expect(sheet?.cssRules[0]?.cssText).toContain('xterm-fg-2'));
    standIn.remove();
    await vi.waitFor(() => expect(document.adoptedStyleSheets).toHaveLength(before));
    dispose();
    root.remove();
  });
});
