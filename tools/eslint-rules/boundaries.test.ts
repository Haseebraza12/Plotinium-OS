import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { lintAs, ruleIds } from './test-utils.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface Fixture {
  code: string;
  lintAs: string;
  expect: string;
}

function readFixture(name: string): Fixture {
  const code = readFileSync(path.join(FIXTURES, name), 'utf8');
  const target = /^\/\/ lint-as: (\S+)$/m.exec(code)?.[1];
  const expected = /^\/\/ expect: (\S+)$/m.exec(code)?.[1];
  if (target === undefined || expected === undefined) {
    throw new Error(`${name} needs "// lint-as: <path>" and "// expect: <rule id>" header lines`);
  }
  return { code, lintAs: target, expect: expected };
}

/** Lint a fixture as its declared path and return the rule ids that fired (never parse errors). */
function lintFixture(name: string): { expected: string; fired: (string | null)[] } {
  const fixture = readFixture(name);
  const messages = lintAs(fixture.code, fixture.lintAs);
  const fatal = messages.filter((message) => message.fatal === true);
  expect(fatal.map((message) => message.message)).toEqual([]);
  return { expected: fixture.expect, fired: ruleIds(messages) };
}

function expectFixtureFails(name: string): void {
  const { expected, fired } = lintFixture(name);
  expect(fired).toContain(expected);
}

describe('package boundaries: every fixture must fail (architecture.md §3.7)', () => {
  it('SYS-01 rejects an app importing the kernel package instead of @plotinium/kernel/sys', () => {
    expectFixtureFails('apps-imports-kernel-internals.ts');
  });

  it('SYS-01 rejects an app reaching into vfs through a relative path', () => {
    expectFixtureFails('apps-relative-import-into-vfs.ts');
  });

  it('SYS-01 rejects an app opening IndexedDB directly', () => {
    expectFixtureFails('apps-uses-indexeddb.ts');
  });

  it('SYS-01 rejects an app using navigator.storage (OPFS) directly', () => {
    expectFixtureFails('apps-uses-navigator-storage.ts');
  });

  it('ARC-01 rejects protocol importing a Node built-in', () => {
    expectFixtureFails('protocol-imports-node.ts');
  });

  it('ARC-01 rejects a value import from protocol inside dsa', () => {
    expectFixtureFails('dsa-value-import-from-protocol.ts');
  });

  it('ARC-01 rejects a dsa test importing a package that provides the structure', () => {
    expectFixtureFails('dsa-test-imports-npm-structure.ts');
  });

  it('ARC-01 rejects Node globals in dsa source files', () => {
    expectFixtureFails('dsa-source-uses-process.ts');
  });

  it('ARC-01 rejects kernel/src/core touching self', () => {
    expectFixtureFails('kernel-core-uses-self.ts');
  });

  it('ARC-01 rejects the kernel importing the ai package (litmus build, C12)', () => {
    expectFixtureFails('kernel-imports-ai.ts');
  });

  it('ARC-01 rejects the compositor importing Solid', () => {
    expectFixtureFails('compositor-imports-solid.ts');
  });

  it('ARC-01 rejects the server importing the vfs package root', () => {
    expectFixtureFails('server-imports-vfs-root.ts');
  });

  it('ARC-01 rejects ai importing vfs internals', () => {
    expectFixtureFails('ai-imports-vfs.ts');
  });

  it('ARC-01 rejects DOM storage globals in the isomorphic vfs/src/perm.ts', () => {
    expectFixtureFails('vfs-perm-uses-indexeddb.ts');
  });

  it('ARC-01 rejects the web bundle importing server code', () => {
    expectFixtureFails('web-imports-server.ts');
  });

  it('ARC-01 rejects the wm desktop shell importing the apps package', () => {
    expectFixtureFails('wm-shell-imports-apps.ts');
  });

  it('SYS-01 rejects ui importing the system-call client', () => {
    expectFixtureFails('ui-imports-kernel-sys.ts');
  });

  it('ARC-01 rejects any import of the pilot evidence (C16)', () => {
    expectFixtureFails('pilot-import.ts');
  });

  it('PROC-03 rejects a yield-less loop in a scheduled program', () => {
    expectFixtureFails('yieldless-loop.ts');
  });

  it('DB-02 rejects an await inside an IndexedDB transaction builder', () => {
    expectFixtureFails('await-in-idb-builder.ts');
  });

  it('AGT-06 rejects rendering untrusted text through innerHTML', () => {
    expectFixtureFails('html-sink.tsx');
  });

  it('ARC-01 every file in tools/eslint-rules/fixtures fails with the rule named in its header', () => {
    const names = readdirSync(FIXTURES).filter((name) => /\.tsx?$/.test(name));
    expect(names.length).toBeGreaterThanOrEqual(21);
    for (const name of names) {
      const { expected, fired } = lintFixture(name);
      expect(fired, name).toContain(expected);
    }
  });
});

describe('package boundaries: allowed imports stay allowed', () => {
  const clean = (code: string, repoPath: string): (string | null)[] =>
    ruleIds(lintAs(code, repoPath));

  it('SYS-01 lets an app import @plotinium/protocol and @plotinium/kernel/sys', () => {
    const code = `import { PACKAGE_NAME } from '@plotinium/protocol';
      import { SYS_CLIENT_PLACEHOLDER } from '@plotinium/kernel/sys';
      export const ok = [PACKAGE_NAME, SYS_CLIENT_PLACEHOLDER];`;
    expect(clean(code, 'apps/terminal/test-snippet.ts')).toEqual([]);
  });

  it('ARC-01 lets dsa import protocol types with import type', () => {
    const code = `import type { PACKAGE_NAME } from '@plotinium/protocol';
      export type Name = typeof PACKAGE_NAME;`;
    expect(clean(code, 'dsa/src/heap/test-snippet.ts')).toEqual([]);
  });

  it('ARC-01 lets the server import the isomorphic vfs/path and vfs/perm modules', () => {
    const code = `import { PATH_MODULE_PLACEHOLDER } from '@plotinium/vfs/path';
      import { PERM_MODULE_PLACEHOLDER } from '@plotinium/vfs/perm';
      export const ok = [PATH_MODULE_PLACEHOLDER, PERM_MODULE_PLACEHOLDER];`;
    expect(clean(code, 'server/src/vfs/test-snippet.ts')).toEqual([]);
  });

  it('ARC-01 lets ai import the kernel hooks and wm import the sys client', () => {
    expect(clean("import '@plotinium/kernel/hooks';", 'ai/src/indexer/test-snippet.ts')).toEqual(
      [],
    );
    expect(clean("import '@plotinium/kernel/sys';", 'wm/src/shell/test-snippet.ts')).toEqual([]);
  });

  it('ARC-01 lets the wm desktop shell compose @plotinium/ui, dsa and protocol', () => {
    const code = `import '@plotinium/ui/tokens.css';
      import { Dock } from '@plotinium/ui';
      import { createZOrder } from '@plotinium/dsa';
      import type { Pid } from '@plotinium/protocol';
      export const ok = [Dock, createZOrder];
      export type P = Pid;`;
    expect(clean(code, 'wm/src/shell/test-snippet.tsx')).toEqual([]);
  });

  it('ARC-01 lets web compose the kernel host, the wm shell and compositor, and the apps registry', () => {
    const code = `import { startKernel } from '@plotinium/kernel/host/main';
      import { mountDesktop } from '@plotinium/wm/shell';
      import { createCompositor } from '@plotinium/wm/compositor';
      import { APPS } from '@plotinium/apps';
      import { BootScreen } from '@plotinium/ui/boot';
      export const ok = [startKernel, mountDesktop, createCompositor, APPS, BootScreen];`;
    expect(clean(code, 'web/src/desktop/test-snippet.tsx')).toEqual([]);
  });

  it('ARC-01 lets dsa and protocol tests import vitest, fast-check and node built-ins', () => {
    const code = `import { describe, it } from 'vitest';
      import fc from 'fast-check';
      import { performance } from 'node:perf_hooks';
      export const tools = [describe, it, fc, performance];`;
    expect(clean(code, 'dsa/src/heap/heap.test.ts')).toEqual([]);
    expect(clean(code, 'dsa/heap/bench/heap.bench.ts')).toEqual([]);
    expect(clean(code, 'protocol/src/errno.test.ts')).toEqual([]);
  });

  it('ARC-01 lets a dsa memory benchmark use Node globals', () => {
    const code = 'export const heapUsed = (): number => process.memoryUsage().heapUsed;';
    expect(clean(code, 'dsa/src/lru/lru.mem.ts')).toEqual([]);
    expect(clean(code, 'dsa/_shared/mem.ts')).toEqual([]);
  });

  it('ARC-01 lets the isomorphic modules import each other', () => {
    expect(clean("import './path.ts';", 'vfs/src/perm.ts')).toEqual([]);
  });
});
