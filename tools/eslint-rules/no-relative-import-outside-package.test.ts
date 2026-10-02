import { describe, expect, it } from 'vitest';

import { lintWithRule } from './test-utils.ts';

const RULE = 'no-relative-import-outside-package';
const ID = `local/${RULE}`;

function messageIds(code: string, repoPath: string): string[] {
  return lintWithRule(RULE, code, repoPath)
    .filter((message) => message.ruleId === ID)
    .map((message) => message.messageId ?? '');
}

describe('local/no-relative-import-outside-package', () => {
  it('ARC-01 reports a relative import from one package into another', () => {
    expect(
      messageIds("import '../../kernel/src/core/index.ts';", 'apps/terminal/test-snippet.ts'),
    ).toEqual(['crossPackage']);
  });

  it('ARC-01 accepts relative imports that stay inside the package, even into same-named folders', () => {
    const code = "import '../vfs/tx.ts'; import '../db/client.ts'; export * from './index.ts';";
    expect(messageIds(code, 'server/src/sync/test-snippet.ts')).toEqual([]);
  });

  it('ARC-01 reports re-exports and dynamic imports that leave the package', () => {
    const code = "export * from '../../vfs/src/index.ts'; void import('../../wm/src/index.ts');";
    expect(messageIds(code, 'ai/src/test-snippet.ts')).toEqual(['crossPackage', 'crossPackage']);
  });

  it('ARC-01 reports any import of the pilot evidence, from packages and from tools', () => {
    expect(
      messageIds("import '../../../docs/evidence/pilot/kbench/heap.js';", 'dsa/src/heap/x.ts'),
    ).toEqual(['pilot']);
    expect(
      messageIds("import '../docs/evidence/pilot/zt/t.mjs';", 'tools/test-snippet.ts'),
    ).toEqual(['pilot']);
  });

  it('ARC-01 lets cross-package suites under tests/ use relative paths', () => {
    expect(messageIds("import '../../kernel/src/index.ts';", 'tests/integration/x.ts')).toEqual([]);
  });
});
