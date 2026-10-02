import { Terminal } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';

import { addStyleViaCssom, cspSafeRowStyles } from './csp-rows.ts';
import { createXterm } from './TerminalHost.tsx';

interface Internals {
  _core: { _renderService: { _renderer: { value: { _rowFactory: { _addStyle: unknown } } } } };
}

const factoryOf = (t: Terminal): { _addStyle: unknown } =>
  (t as unknown as Internals)._core._renderService._renderer.value._rowFactory;

describe('UI-050 xterm cell colours without a style attribute', () => {
  it('UI-050 the real xterm row factory is found after open and set to write through the CSSOM', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const terminal = new Terminal({ cols: 20, rows: 4 });
    // Before open there is no renderer: nothing to patch, nothing changed.
    expect(cspSafeRowStyles(terminal)).toBe(false);
    terminal.open(parent);
    expect(typeof factoryOf(terminal)._addStyle).toBe('function');
    expect(factoryOf(terminal)._addStyle).not.toBe(addStyleViaCssom);
    expect(cspSafeRowStyles(terminal)).toBe(true);
    expect(factoryOf(terminal)._addStyle).toBe(addStyleViaCssom);
    expect(cspSafeRowStyles(terminal)).toBe(true);
    terminal.dispose();
    parent.remove();
  });

  /**
   * Renders a selection and returns the `style` attribute values xterm's own `_addStyle` wrote:
   * its raw form, `…color:#rrggbb;` (happy-dom also reflects CSSOM writes through setAttribute,
   * but serialised: `background-color: rgb(…);`).
   */
  async function rawStyleWrites(
    open: (parent: HTMLElement) => {
      dispose(): void;
      selectAll(): void;
      write(d: string, cb: () => void): void;
    },
  ): Promise<{ raw: string[]; coloured: number }> {
    const parent = document.createElement('div');
    document.body.append(parent);
    const raw: string[] = [];
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'setAttribute')?.value as (
      this: Element,
      name: string,
      value: string,
    ) => void;
    const spy = vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (
      this: Element,
      name: string,
      value: string,
    ) {
      if (name === 'style' && /color:#[0-9a-f]{6};$/u.test(value)) raw.push(value);
      original.call(this, name, value);
    });
    try {
      const terminal = open(parent);
      await new Promise<void>((resolve) => terminal.write('select me\r\nand me', resolve));
      terminal.selectAll();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const coloured = [...parent.querySelectorAll<HTMLElement>('.xterm-rows span')].filter(
        (el) => el.style.backgroundColor !== '',
      ).length;
      terminal.dispose();
      return { raw, coloured };
    } finally {
      spy.mockRestore();
      parent.remove();
    }
  }

  it('UI-050 a selection in a createXterm terminal is coloured without a style attribute', async () => {
    // Control: a plain xterm writes the selected cells' colours as a style attribute.
    const plain = await rawStyleWrites((parent) => {
      const t = new Terminal({ minimumContrastRatio: 4.5 });
      t.open(parent);
      return t;
    });
    expect(plain.coloured).toBeGreaterThan(0);
    expect(plain.raw.length).toBeGreaterThan(0);
    // The Terminal's xterm colours the same cells through the CSSOM.
    const ours = await rawStyleWrites((parent) => {
      const { terminal } = createXterm({ minimumContrastRatio: 4.5 });
      terminal.open(parent);
      return terminal;
    });
    expect(ours.coloured).toBe(plain.coloured);
    expect(ours.raw).toEqual([]);
  });

  it('UI-050 the CSSOM helper appends declarations as xterm does, keeping earlier ones', () => {
    const span = document.createElement('span');
    span.style.letterSpacing = '1px';
    addStyleViaCssom(span, 'background-color:#112233');
    addStyleViaCssom(span, 'color:#ffffff');
    expect(span.style.letterSpacing).toBe('1px');
    expect(span.style.backgroundColor).toMatch(/^(#112233|rgb\(17, 34, 51\))$/u);
    expect(span.style.color).toMatch(/^(#ffffff|rgb\(255, 255, 255\))$/u);
  });

  it('UI-050 an object without xterm internals is left alone', () => {
    expect(cspSafeRowStyles(null)).toBe(false);
    expect(cspSafeRowStyles({})).toBe(false);
    expect(cspSafeRowStyles({ _core: { _renderService: {} } })).toBe(false);
  });
});
