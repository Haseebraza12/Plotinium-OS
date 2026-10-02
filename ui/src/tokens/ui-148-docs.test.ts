/**
 * UI-148: the specs and docs described the old two-orbit logo and fonts that no longer ship.
 * These checks tie the documents to the code: every font package that fonts.css points at is
 * listed in THIRD_PARTY.md as shipped, the typography specs name the shipped families, and the
 * logo specs describe the Bohr P (docs/design/logo/DECISION.md). UI-164: the old mark's second
 * orbit colour token is gone.
 */
import { existsSync, readFileSync } from 'node:fs';
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

const repo = repoRoot();
const read = (path: string): string => readFileSync(join(repo, path), 'utf8');

/** The text of one Markdown section, from its heading to the next heading of the same level. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  if (start < 0) throw new Error(`missing ${heading}`);
  const level = /^#+/u.exec(heading)?.[0] ?? '#';
  const rest = doc.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n${level} `, 'u'));
  return next < 0 ? rest : rest.slice(0, next);
}

const shippedPackages = [
  ...new Set([...fontsCss.matchAll(/url\('(@fontsource[^/]*\/[^/]+)\//gu)].map((m) => m[1] ?? '')),
];
const families = [...new Set([...fontsCss.matchAll(/font-family: '([^']+)'/gu)].map((m) => m[1]))];

describe('UI-148 docs describe the shipped fonts and logo', () => {
  it('UI-148 fonts.css ships exactly Inter and JetBrains Mono, both variable', () => {
    expect(shippedPackages.sort()).toEqual([
      '@fontsource-variable/inter',
      '@fontsource-variable/jetbrains-mono',
    ]);
    expect(families.sort()).toEqual(['Inter Variable', 'JetBrains Mono Variable']);
  });

  it('UI-148 THIRD_PARTY.md marks every shipped font package as shipped, and only those', () => {
    const fonts = section(read('THIRD_PARTY.md'), '### 2.2 Fonts');
    const rows = fonts.split('\n').filter((l) => l.startsWith('| `@fontsource'));
    const shipped = rows
      .filter((l) => (l.split('|')[5] ?? '').includes('yes'))
      .map((l) => /`([^`]+)`/u.exec(l)?.[1]);
    expect(shipped.sort()).toEqual(shippedPackages);
    for (const row of rows) expect(row).toContain('OFL-1.1');
  });

  it('UI-148 the typography specs name the shipped families and no font preload', () => {
    const visual = section(read('specs/05-wm/visual-language-macos.md'), '### 3.5 Typography');
    const guide = section(read('specs/05-wm/ui-implementation-guide.md'), '#### 3.8.1 Fonts');
    for (const text of [visual, guide]) {
      expect(text).toContain('@fontsource-variable/inter');
      expect(text).toContain('@fontsource-variable/jetbrains-mono');
      expect(text).not.toMatch(/'cv11', 'ss01'`\s*\(/u);
      expect(text).not.toContain('@fontsource/jetbrains-mono/latin');
      expect(text).toMatch(/no font preload|No preload/iu);
    }
  });

  it('UI-148 the logo specs describe the Bohr P, not the two-orbit atom', () => {
    const identity = section(
      read('specs/00-product/identity-and-branding.md'),
      '### 3.6 Logo brief (SVG)',
    );
    const visual = section(read('specs/05-wm/visual-language-macos.md'), '#### 3.6.2');
    for (const text of [identity, visual]) {
      expect(text).toContain('Bohr P');
      expect(text).toContain('docs/design/logo/DECISION.md');
      expect(text).not.toMatch(/rx 10\.5|Ring stroke width|stroke 1\.5\)/u);
    }
    expect(read('ui/gallery/pages/tokens.tsx')).not.toContain('luminous atom');
  });

  it('UI-164 the old mark’s second orbit colour is no longer a token', () => {
    expect(tokensCss).not.toContain('--pl-logo-orbit-b');
    for (const token of ['--pl-logo-orbit-a', '--pl-logo-core', '--pl-logo-electron'])
      expect(tokensCss).toContain(`${token}:`);
  });
});
