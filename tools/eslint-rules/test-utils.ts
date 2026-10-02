/**
 * Helpers for the local ESLint rule tests. The tests lint code strings with ESLint's `Linter` and
 * the typescript-eslint parser (no type information needed), using file names under the repository
 * root so that the `files` globs in configs.js and boundaries.js match exactly as they do in CI.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import { boundaryConfigs, localRuleConfigs } from './configs.js';
import local from './index.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const linter = new Linter({ cwd: REPO_ROOT });

const parserConfig: Linter.Config = {
  name: 'test/parser',
  files: ['**/*.{ts,tsx,mts,cts}'],
  languageOptions: {
    parser: tseslint.parser,
    sourceType: 'module',
  },
};

/** The repository's local-rule scoping plus the package boundaries, without type information. */
export const repoConfigs: Linter.Config[] = [parserConfig, ...localRuleConfigs, ...boundaryConfigs];

/** Lint `code` as if it were the file at `repoPath` (relative to the repository root). */
export function lintAs(
  code: string,
  repoPath: string,
  configs: Linter.Config[] = repoConfigs,
): Linter.LintMessage[] {
  return linter.verify(code, configs, path.join(REPO_ROOT, repoPath));
}

/**
 * Lint `code` with a single local rule switched on, for rule unit tests.
 * Fails loudly on parse errors so a broken test snippet can never pass as "no violations".
 */
export function lintWithRule(
  rule: string,
  code: string,
  repoPath = 'kernel/src/core/test-snippet.ts',
  options: unknown[] = [],
): Linter.LintMessage[] {
  const messages = lintAs(code, repoPath, [
    parserConfig,
    { name: 'test/rule', plugins: { local }, rules: { [`local/${rule}`]: ['error', ...options] } },
  ]);
  const fatal = messages.filter((message) => message.fatal === true);
  if (fatal.length > 0) {
    throw new Error(`Test snippet does not parse: ${fatal.map((m) => m.message).join('; ')}`);
  }
  return messages;
}

/** The rule ids reported for `code`, in order. */
export function ruleIds(messages: Linter.LintMessage[]): (string | null)[] {
  return messages.map((message) => message.ruleId);
}
