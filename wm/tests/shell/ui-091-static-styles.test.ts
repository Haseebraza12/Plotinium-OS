/**
 * UI-091 (docs/design/bug-hunt/BUGS.md): Solid compiles a `style={{…}}` whose values are all
 * literals into the element's template HTML (`<div style="…">`), which the strict CSP drops
 * (`style-src-attr`, contract C5). Only computed values may use `style`: those go through the
 * CSSOM. This scans the desktop shell's sources (the menu bar, Dock, Control Centre, notifications,
 * the overlays and wm/src/shell) for all-literal style objects.
 */
import { describe, expect, it } from 'vitest';

/**
 * The shell's sources, as text. The window frame (`ui/src/shell/window`) and the window layer
 * belong to fix-windows and have their own checks.
 */
const SOURCES = import.meta.glob<string>(
  [
    '../../../ui/src/shell/**/*.tsx',
    '../../../ui/src/overlays/**/*.tsx',
    '../../src/shell/**/*.tsx',
    '!**/window/**',
    '!**/*.test.tsx',
    '!**/WindowLayer.tsx',
  ],
  { query: '?raw', import: 'default', eager: true },
);

/** The text of the object literal that starts at `open` (the index of its `{`). */
function objectAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/** Top-level `key: value` entries of an object literal's body. */
function entries(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((e) => e.trim()).filter((e) => e !== '');
}

const LITERAL = /^(?:'[^']*'|"[^"]*"|`[^`$]*`|-?\d+(?:\.\d+)?)$/u;

/** Style objects in `src` whose every value is a literal (so Solid inlines them). */
function staticStyles(src: string): string[] {
  const found: string[] = [];
  const re = /style=\{\{/gu;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const body = objectAt(src, m.index + 'style={'.length);
    const values = entries(body).map((e) => {
      const colon = e.search(/:(?!\/)/u);
      return colon < 0 ? e : e.slice(colon + 1).trim();
    });
    if (values.length > 0 && values.every((v) => LITERAL.test(v))) found.push(body.trim());
  }
  return found;
}

describe('UI-091 static style literals in the desktop shell', () => {
  it('UI-091 the scanner flags all-literal style objects and accepts computed ones', () => {
    expect(staticStyles(`<div style={{ height: '100%' }} />`)).toEqual([`height: '100%'`]);
    expect(staticStyles(`<i style={{ '--pl-stagger-index': 3, gap: \`8px\` }} />`)).toHaveLength(1);
    expect(staticStyles(`<i style={{ '--pl-stagger-index': String(i()) }} />`)).toEqual([]);
    expect(staticStyles(`<i style={{ width: \`\${w}%\` }} />`)).toEqual([]);
    expect(staticStyles(`<i style={local.style} />`)).toEqual([]);
  });

  it('UI-091 no shell or overlay source has a static style={{…}} (the CSP drops it)', () => {
    const files = Object.entries(SOURCES);
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.flatMap(([file, src]) => staticStyles(src).map((s) => `${file}: ${s}`));
    expect(offenders).toEqual([]);
  });
});
