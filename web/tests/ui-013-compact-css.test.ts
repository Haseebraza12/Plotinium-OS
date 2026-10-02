/**
 * UI-013: the CSS inlined into index.html (tokens.css + ui boot.css) must keep every selector
 * and at-rule prelude of the source. The earlier compactor removed the space before `:`, so
 * `.plb :where(h1, …)` became `.plb:where(h1, …)` and six boot rules matched nothing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { compactCss } from '../src/boot/compact-css.ts';

const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const read = (file: string): string => readFileSync(resolve(repo, file), 'utf8');
const SHEETS = ['ui/src/tokens/tokens.css', 'ui/src/boot/boot.css'] as const;

/**
 * The text before every `{` (selector lists and at-rule preludes), in order, with the
 * whitespace CSS never needs removed: runs collapse, and none is kept around `, > + ~`, inside
 * parentheses or after `:`. A space before `:` (a descendant combinator) is kept.
 */
function preludes(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      const raw = text.slice(start, i);
      // A prelude follows the last `;` or `}` before the brace (nested rules, declarations).
      const cut = Math.max(raw.lastIndexOf(';'), raw.lastIndexOf('}'));
      out.push(
        raw
          .slice(cut + 1)
          .replace(/\s+/gu, ' ')
          .replace(/\s*([,>+~])\s*/gu, '$1')
          .replace(/\(\s+/gu, '(')
          .replace(/\s+\)/gu, ')')
          .replace(/:\s+/gu, ':')
          .trim(),
      );
      start = i + 1;
    } else if (c === '}' || c === ';') start = i + 1;
  }
  return out;
}

/** `property:value` pairs with whitespace collapsed the same way, in order. */
function declarations(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  return [...text.matchAll(/([\w-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/gu)].map(
    (m) => `${m[1] ?? ''}:${(m[2] ?? '').replace(/\s+/gu, ' ').replace(/\s*([,>])\s*/gu, '$1')}`,
  );
}

describe('UI-013 the inlined boot CSS keeps its selectors', () => {
  it('UI-013 descendant combinators before a pseudo-class survive compaction', () => {
    expect(compactCss('.plb :where(h1, p) {\n  margin: 0;\n}')).toBe(
      '.plb :where(h1,p){margin:0;}',
    );
    expect(compactCss('.plb-splash[data-exit] :is(.plb-col, .plb-hints) { opacity: 0 }')).toBe(
      '.plb-splash[data-exit] :is(.plb-col,.plb-hints){opacity:0}',
    );
    expect(compactCss('.a:hover > .b , .c { color : red ; }')).toBe('.a:hover>.b,.c{color :red;}');
    expect(compactCss('@media (prefers-reduced-motion: reduce) { .x { transform: none; } }')).toBe(
      '@media (prefers-reduced-motion:reduce){.x{transform:none;}}',
    );
  });

  it('UI-013 every selector and at-rule prelude of tokens.css and boot.css is unchanged', () => {
    for (const file of SHEETS) {
      const source = read(file);
      const compact = compactCss(source);
      const before = preludes(source);
      expect(before.length, file).toBeGreaterThan(20);
      expect(preludes(compact), file).toEqual(before);
      expect(compact.length, file).toBeLessThan(source.length * 0.9);
    }
  });

  it('UI-013 the six boot rules the old compactor broke keep their descendant space', () => {
    const compact = compactCss(read('ui/src/boot/boot.css'));
    for (const selector of [
      '.plb :where(h1,h2,p,ul,ol,pre)',
      '.plb-splash[data-verbose] :is(.plb-step,.plb-count)',
      '.plb-splash[data-exit] :is(.plb-col,.plb-hints,.plb-vpanel)',
      ".plb-row:not([data-l='info']) :is(.plb-sub,.plb-pfx,.plb-msg)",
      '.plb-rec :is(.plb-ot,.plb-od)',
    ])
      expect(compact, selector).toContain(`${selector}{`);
    expect(compact).not.toMatch(/\.plb:where\(|\]:is\(\.plb-(?:step|col|sub)|\.plb-rec:is\(/u);
  });

  it('UI-013 every declaration keeps its value', () => {
    for (const file of SHEETS) {
      const source = read(file);
      expect(declarations(compactCss(source)), file).toEqual(declarations(source));
    }
  });
});
