import { render } from '@solidjs/testing-library';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CodeEditor } from './CodeEditor.tsx';

/**
 * Under the production CSP the browser refuses CodeMirror's run-time `<style>` (in `<head>`) and
 * gives it no sheet. happy-dom has no CSP, so this file stands one in: every `<style>` reports
 * `sheet === null`, as a refused element does. Its own file, because the head mirror installs
 * once per document (module state).
 */
describe('UI-EditorStyles', () => {
  const proto = HTMLStyleElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'sheet');
  beforeAll(() => {
    Object.defineProperty(proto, 'sheet', { configurable: true, get: () => null });
  });
  afterAll(() => {
    if (original === undefined) Reflect.deleteProperty(proto, 'sheet');
    else Object.defineProperty(proto, 'sheet', original);
  });

  const cmRules = (): string[] =>
    document.adoptedStyleSheets.flatMap((s) =>
      [...s.cssRules].map((r) => r.cssText).filter((t) => t.includes('.cm-')),
    );

  it('UI-EditorStyles CodeMirror styles the CSP refused apply through one adopted sheet', () => {
    expect(document.querySelector('style')?.sheet ?? null).toBeNull();
    const before = document.adoptedStyleSheets.length;
    const first = render(() => <CodeEditor doc="# notes" language="markdown" label="a.md" />);
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
    const rules = cmRules().join('\n');
    // CodeMirror's base theme (layout) and ours (the D15 mono face) both arrive.
    expect(rules).toMatch(/\.cm-scroller/u);
    expect(rules).toContain('var(--pl-font-mono)');

    // A second editor shares style-mod's element, so it shares the mirror too.
    const second = render(() => <CodeEditor doc="let a = 1;" language="typescript" label="b.ts" />);
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
    first.unmount();
    second.unmount();
    // style-mod never removes its element, so the mirror stays for the page.
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
  });
});
