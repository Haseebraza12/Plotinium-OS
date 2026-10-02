// @ts-check
/**
 * Where each local rule applies. Imported by eslint.config.js and by the rule tests, so the tests
 * lint fixtures with exactly the scoping that CI uses.
 */
import local from './index.js';

export { boundaryConfigs } from './boundaries.js';

const TS_FILES = ['**/*.{ts,tsx,mts,cts}'];
const JS_FILES = ['**/*.{js,mjs,cjs}'];

/** Packages whose programs run as scheduled, pre-emptible generators (PROC-03). */
const SCHEDULED_CODE = ['kernel', 'vfs', 'services', 'apps', 'ai'].map(
  (dir) => `${dir}/**/*.{ts,tsx}`,
);

/** Packages that build IndexedDB transactions (C4, DB-02). */
const IDB_CODE = ['kernel', 'vfs'].map((dir) => `${dir}/**/*.{ts,tsx}`);

/**
 * Code served under the strict CSP (CLAUDE.md standing decision 1, UI-147). The ui gallery is a
 * dev-only page that Caddy never serves, and tests render in happy-dom, so neither is checked.
 */
const CSP_SERVED_JSX = ['ui', 'wm', 'apps', 'web'].map((dir) => `${dir}/**/*.tsx`);

/** @type {import('eslint').Linter.Config[]} */
export const localRuleConfigs = [
  {
    name: 'plotinium/local-everywhere',
    files: [...TS_FILES, ...JS_FILES],
    plugins: { local },
    rules: {
      'local/no-relative-import-outside-package': 'error',
      'local/no-html-sinks': 'error',
    },
  },
  {
    name: 'plotinium/local-scheduled-code',
    files: SCHEDULED_CODE,
    plugins: { local },
    rules: { 'local/no-yieldless-loop-in-generator': 'error' },
  },
  {
    name: 'plotinium/local-idb-code',
    files: IDB_CODE,
    plugins: { local },
    rules: { 'local/no-await-in-idb-builder': 'error' },
  },
  {
    name: 'plotinium/local-csp-styles',
    files: CSP_SERVED_JSX,
    ignores: ['ui/gallery/**', '**/*.test.tsx', '**/tests/**'],
    plugins: { local },
    rules: { 'local/no-static-jsx-style': 'error' },
  },
];
