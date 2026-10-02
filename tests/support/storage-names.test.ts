import { describe, expect, it } from 'vitest';

import { PRODUCTION_NAMES, repoRelative, testStorageNames } from './storage-names.ts';

const SELF_FILE = 'file:///work/plotinium/tests/support/storage-names.ts';
const SELF_HTTP = 'http://localhost:63315/tests/support/storage-names.ts';

describe('TST-11 per-file storage names', () => {
  it('TST-11 two browser test files never share an IndexedDB or OPFS name', async () => {
    const a = await testStorageNames(
      'file:///work/plotinium/vfs/src/store/tx.browser.test.ts',
      SELF_FILE,
    );
    const b = await testStorageNames(
      'file:///work/plotinium/vfs/src/store/blob.browser.test.ts',
      SELF_FILE,
    );
    expect(a.idb).not.toBe(b.idb);
    expect(a.swap).not.toBe(b.swap);
    expect(a.opfsDir).not.toBe(b.opfsDir);
  });

  it('TST-11 names have the documented shape and never equal the production names', async () => {
    const n = await testStorageNames(
      'file:///work/plotinium/kernel/src/mm/swap.browser.test.ts',
      SELF_FILE,
    );
    expect(n.idb).toMatch(/^plotinium-test-[0-9a-f]{8}$/);
    expect(n.swap).toMatch(/^plotinium-swap-test-[0-9a-f]{8}$/);
    expect(n.opfsDir).toMatch(/^test-[0-9a-f]{8}$/);
    for (const prod of PRODUCTION_NAMES) expect(Object.values(n)).not.toContain(prod);
  });

  it('TST-11 the same file gets the same names under Node and under the browser server', async () => {
    const node = await testStorageNames(
      'file:///work/plotinium/vfs/src/a.browser.test.ts',
      SELF_FILE,
    );
    const browser = await testStorageNames(
      'http://localhost:63315/vfs/src/a.browser.test.ts?v=123',
      SELF_HTTP,
    );
    expect(browser).toEqual(node);
  });

  it('TST-11 repository-relative paths strip the root, Vite /@fs/ prefixes and percent-encoding', () => {
    expect(repoRelative('file:///work/plotinium/vfs/src/a%20b.test.ts', SELF_FILE)).toBe(
      'vfs/src/a b.test.ts',
    );
    expect(
      repoRelative('http://localhost:1/@fs/work/plotinium/ui/x.browser.test.tsx', SELF_FILE),
    ).toBe('ui/x.browser.test.tsx');
    expect(repoRelative('file:///elsewhere/y.ts', SELF_FILE)).toBe('elsewhere/y.ts');
  });

  it('TST-11 the default self URL resolves this repository', () => {
    expect(repoRelative(new URL('./storage-names.test.ts', import.meta.url).href)).toBe(
      'tests/support/storage-names.test.ts',
    );
  });
});
