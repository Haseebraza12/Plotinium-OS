/**
 * UI-004: the mono role is JetBrains Mono (Geist Mono drew `r` like `ɪ` at 12–14 px on 1x
 * screens), with its contextual ligatures off so `->`, `!=` and `rwxr--r--` show the characters
 * that were typed. The evidence is docs/design/polish/fix-apps-settings-a11y/mono-specimen-*.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import fontsCss from './fonts.css?raw';
import tokensCss from './tokens.css?raw';

function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('pnpm-workspace.yaml not found');
    dir = up;
  }
  return dir;
}

const fromUi = createRequire(join(repoRoot(), 'ui/package.json'));

/** Every `@font-face` block, as { family, body }. */
function faces(css: string): { family: string; body: string }[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/gu)].map((m) => {
    const body = m[1] ?? '';
    const family = /font-family:\s*'([^']+)'/u.exec(body)?.[1] ?? '';
    return { family, body };
  });
}

describe('UI-004 monospace face', () => {
  const mono = faces(fontsCss).filter((f) => f.family === 'JetBrains Mono Variable');

  it('UI-004 --pl-font-mono leads with JetBrains Mono and keeps a system mono fallback', () => {
    const value = /--pl-font-mono:\s*([^;]+);/u.exec(tokensCss)?.[1]?.replace(/\s+/gu, ' ');
    expect(value).toMatch(/^'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, /u);
    expect(value).toMatch(/monospace$/u);
    expect(tokensCss).not.toMatch(/Geist Mono/u);
  });

  it('UI-004 Latin and Latin Extended faces are declared with ligatures off', () => {
    expect(mono).toHaveLength(2);
    for (const face of mono) {
      expect(face.body).toMatch(/font-feature-settings:\s*'calt' 0;/u);
      expect(face.body).toMatch(/font-weight:\s*100 800;/u);
      expect(face.body).toMatch(/font-display:\s*swap;/u);
    }
    expect(fontsCss).not.toMatch(/geist-mono/u);
  });

  it('UI-004 every font file fonts.css points at is installed', () => {
    const urls = [...fontsCss.matchAll(/url\('([^']+)'\)/gu)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThanOrEqual(4);
    for (const url of urls) expect(() => fromUi.resolve(url), url).not.toThrow();
  });
});
