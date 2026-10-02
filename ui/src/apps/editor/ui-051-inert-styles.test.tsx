import { render } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { INERT_STYLE_TAG } from '../../primitives/internal/csp-styles.ts';
import { CodeEditor } from './CodeEditor.tsx';

/**
 * UI-051: under the production CSP a `<style>` made at run time is refused and reported as a
 * `securitypolicyviolation`, even when its CSS is mirrored afterwards. CodeMirror's style-mod
 * makes one such element, in `<head>`, when the first editor of the page mounts. It must be an
 * inert stand-in instead (csp-styles.ts `withInertStyles`), with its CSS in an adopted sheet.
 * Its own file: style-mod keeps its element for the life of the document (module state).
 */
describe('UI-051 CodeMirror styles without a run-time <style>', () => {
  it('UI-051 the first editor makes no <style> element; its CSS arrives through an adopted sheet', () => {
    expect(document.querySelectorAll('style')).toHaveLength(0);
    const before = document.adoptedStyleSheets.length;
    const first = render(() => <CodeEditor doc="# notes" language="markdown" label="a.md" />);
    // No <style> anywhere, so the browser has nothing to refuse and nothing to report.
    expect(document.querySelectorAll('style')).toHaveLength(0);
    const standIn = document.head.querySelector(INERT_STYLE_TAG);
    expect(standIn).not.toBeNull();
    expect((standIn as HTMLElement).hidden).toBe(true);
    expect(standIn?.textContent).toMatch(/\.cm-/u);
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
    const rules = document.adoptedStyleSheets
      .flatMap((s) => [...s.cssRules].map((r) => r.cssText))
      .join('\n');
    expect(rules).toMatch(/\.cm-scroller/u);
    expect(rules).toContain('var(--pl-font-mono)');

    // A second editor (and a theme change) reuse the stand-in: still no <style>, one sheet.
    const second = render(() => (
      <CodeEditor doc="let a = 1;" language="typescript" label="b.ts" scheme="dark" />
    ));
    expect(document.querySelectorAll('style')).toHaveLength(0);
    expect(document.adoptedStyleSheets).toHaveLength(before + 1);
    first.unmount();
    second.unmount();
    // The page's own createElement is back.
    expect(document.createElement('style').localName).toBe('style');
  });
});
