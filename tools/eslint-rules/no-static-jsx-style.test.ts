/**
 * local/no-static-jsx-style (UI-147). The rule cases lint with the rule module directly; the
 * scoping case lints with the repository configs (configs.js), exactly as CI does.
 */
import path from 'node:path';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import rule from './no-static-jsx-style.js';
import { lintAs, REPO_ROOT, ruleIds } from './test-utils.ts';

const linter = new Linter({ cwd: REPO_ROOT });
const configs: Linter.Config[] = [
  {
    files: ['**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { local: { rules: { 'no-static-jsx-style': rule } } },
    rules: { 'local/no-static-jsx-style': 'error' },
  },
];

function reported(code: string): number {
  return linter
    .verify(code, configs, path.join(REPO_ROOT, 'ui/src/primitives/probe.tsx'))
    .filter((m) => m.ruleId === 'local/no-static-jsx-style').length;
}

describe('local/no-static-jsx-style', () => {
  it('UI-147 reports all-literal style objects, including negative numbers and empty objects', () => {
    expect(reported(`export const a = <div style={{ display: 'contents' }} />;`)).toBe(1);
    expect(reported(`export const a = <div style={{ 'min-width': 0, 'z-index': -1 }} />;`)).toBe(1);
    expect(reported('export const a = <div style={{ gap: `4px` }} />;')).toBe(1);
    expect(reported(`export const a = <div style={{}} />;`)).toBe(1);
  });

  it('UI-147 reports string styles', () => {
    expect(reported(`export const a = <div style="display: flex" />;`)).toBe(1);
    expect(reported(`export const a = <div style={'display: flex'} />;`)).toBe(1);
    expect(reported('export const a = <div style={`display: flex`} />;')).toBe(1);
  });

  it('UI-147 accepts run-time values, spreads and hoisted style objects', () => {
    const code = `declare const w: () => number; declare const HOST: Record<string, string>; declare const i: number;
      export const a = <div style={{ width: \`\${w()}px\` }} />;
      export const b = <div style={{ display: 'grid', '--pl-stagger-index': String(i) }} />;
      export const c = <div style={{ ...HOST }} />;
      export const d = <div style={HOST} />;
      export const e = <div class="x" data-style="display: flex" />;`;
    expect(reported(code)).toBe(0);
  });
});

describe('local/no-static-jsx-style scoping (configs.js)', () => {
  const code = `export const a = <div style={{ display: 'flex' }} />;`;
  const fires = (repoPath: string): boolean =>
    ruleIds(lintAs(code, repoPath)).includes('local/no-static-jsx-style');

  it('UI-147 is on for JSX served under the CSP: ui, wm, apps and web', () => {
    for (const p of [
      'ui/src/primitives/x.tsx',
      'wm/src/shell/x.tsx',
      'apps/files/x.tsx',
      'web/src/x.tsx',
    ])
      expect(fires(p), p).toBe(true);
  });

  it('UI-147 is off for the dev-only ui gallery, for tests and for other packages', () => {
    expect(fires('ui/gallery/pages/x.tsx')).toBe(false);
    expect(fires('ui/src/primitives/dialog/Dialog.test.tsx')).toBe(false);
    expect(fires('wm/tests/shell/x.tsx')).toBe(false);
    expect(fires('kernel/src/x.tsx')).toBe(false);
  });
});
