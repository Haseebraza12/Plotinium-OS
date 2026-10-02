// @ts-check
/**
 * ESLint 10 flat config for the Plotinium monorepo (C14). Run as `pnpm lint`
 * (`eslint . --max-warnings 0`), so a warning fails CI exactly like an error.
 *
 * Layers, in order:
 *   1. global ignores (docs, specs, pilot evidence, build output, lint fixtures);
 *   2. @eslint/js recommended for every file;
 *   3. typescript-eslint recommendedTypeChecked for TypeScript (TS 6 API via projectService);
 *   4. eslint-plugin-solid for wm/, apps/ and web/, every rule raised to error;
 *   5. Plotinium's local rules, scoped in tools/eslint-rules/configs.js;
 *   6. package boundaries (tools/eslint-rules/boundaries.js; architecture.md §3.7, ARC-01).
 * Layers 5 and 6 come from one module that the rule tests also use, so the tests lint the
 * fixtures with exactly the scoping CI uses.
 */
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import solidTypescript from 'eslint-plugin-solid/configs/typescript';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { boundaryConfigs, localRuleConfigs } from './tools/eslint-rules/configs.js';

const TS_FILES = ['**/*.{ts,tsx,mts,cts}'];
const JS_FILES = ['**/*.{js,mjs,cjs}'];
const SOLID_FILES = [
  'wm/**/*.{ts,tsx}',
  'apps/**/*.{ts,tsx}',
  'web/**/*.{ts,tsx}',
  'ui/**/*.{ts,tsx}',
];

/** eslint-plugin-solid's TypeScript preset with every rule it enables raised to error. */
/** @type {import('eslint').Linter.RulesRecord} */
const solidRules = Object.fromEntries(
  Object.entries(solidTypescript.rules ?? {}).map(([name, setting]) => {
    if (setting === 1 || setting === 'warn') return [name, 'error'];
    if (Array.isArray(setting) && (setting[0] === 1 || setting[0] === 'warn')) {
      return [name, ['error', ...setting.slice(1)]];
    }
    return [name, setting];
  }),
);

export default defineConfig(
  globalIgnores(
    [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      'docs/**',
      'docs/evidence/**',
      'specs/**',
      'test-results/',
      'playwright-report/',
      'tools/eslint-rules/fixtures/**',
      '**/*.gen.ts',
      // Static files served as they are, including the downloaded ONNX runtime glue (vendored).
      'web/public/**',
    ],
    'plotinium/ignores',
  ),

  {
    name: 'plotinium/javascript-recommended',
    extends: [js.configs.recommended],
  },

  {
    name: 'plotinium/node-scripts',
    files: JS_FILES,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },

  {
    name: 'plotinium/typescript',
    files: TS_FILES,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },

  {
    name: 'plotinium/solid',
    files: SOLID_FILES,
    plugins: solidTypescript.plugins,
    rules: solidRules,
  },

  ...localRuleConfigs,
  ...boundaryConfigs,
);
