import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GitFacts } from './build-id.ts';
import {
  buildIdOf,
  contentHash,
  envLines,
  resolveBuildId,
  sourceFiles,
  versionOf,
} from './build-id.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A small repository tree: two packages, a lockfile, and generated files that must not count. */
function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'plt-build-id-'));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const BASE: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'plotinium', version: '0.1.0' }),
  'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  'kernel/src/kernel.ts': 'export const k = 1;\n',
  'web/src/main.ts': 'console.log(1);\n',
};

const hashOf = (root: string): string => contentHash(root, sourceFiles(root));

describe('tools/build-id.ts (UI-008)', () => {
  it('UI-008 the source-tree hash is deterministic and independent of file creation order', () => {
    const a = tree(BASE);
    const reversed = Object.fromEntries(Object.entries(BASE).reverse());
    const b = tree(reversed);
    expect(hashOf(a)).toBe(hashOf(a));
    expect(hashOf(a)).toBe(hashOf(b));
    expect(hashOf(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('UI-008 any change to a source byte, a path or the lockfile changes the hash', () => {
    const h = hashOf(tree(BASE));
    expect(hashOf(tree({ ...BASE, 'kernel/src/kernel.ts': 'export const k = 2;\n' }))).not.toBe(h);
    expect(hashOf(tree({ ...BASE, 'pnpm-lock.yaml': 'lockfileVersion: 10\n' }))).not.toBe(h);
    const moved: Record<string, string> = {
      ...BASE,
      'kernel/src/renamed.ts': 'export const k = 1;\n',
    };
    delete moved['kernel/src/kernel.ts'];
    expect(hashOf(tree(moved))).not.toBe(h);
  });

  it('UI-008 installed, generated and secret files are not part of the hash', () => {
    const h = hashOf(tree(BASE));
    const noisy = tree({
      ...BASE,
      'web/node_modules/x/index.js': 'x',
      'web/dist/index.html': '<!doctype html>',
      'kernel/coverage/lcov.info': 'TN:',
      'server/.env.local': 'SECRET=1',
      'ui/build.log': 'log',
      'docs/notes.md': '# not an image input',
      'tests/e2e/a.spec.ts': 'test',
    });
    expect(sourceFiles(noisy)).toEqual([
      'kernel/src/kernel.ts',
      'package.json',
      'pnpm-lock.yaml',
      'web/src/main.ts',
    ]);
    expect(hashOf(noisy)).toBe(h);
  });

  it('UI-008 without git the id is the first 7 hex digits of the tree hash and a dev version', () => {
    const root = tree(BASE);
    const id = buildIdOf(root, {});
    expect(id.BUILD_SHA).toBe(hashOf(root).slice(0, 7));
    expect(id.BUILD_VERSION).toBe('0.1.0-dev.0');
    expect(id.BUILD_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(id.SOURCE_DATE_EPOCH).toMatch(/^\d+$/);
    expect(buildIdOf(root, {})).toEqual(id);
  });

  it('UI-008 a clean git checkout uses its short SHA and commit time; a dirty one the tree hash', () => {
    const clean: GitFacts = { sha: 'abc1234', dirty: false, epoch: 1_790_000_000, describe: null };
    const input = {
      pkgVersion: '0.1.0',
      env: {},
      tree: () => ({ hash: 'f'.repeat(64), newest: 1_700_000_000 }),
    };
    expect(resolveBuildId({ ...input, git: clean })).toEqual({
      BUILD_SHA: 'abc1234',
      BUILD_VERSION: '0.1.0-dev.0',
      BUILD_DATE: '2026-09-21',
      SOURCE_DATE_EPOCH: '1790000000',
    });
    const dirty = resolveBuildId({ ...input, git: { ...clean, dirty: true } });
    expect(dirty.BUILD_SHA).toBe('fffffff');
    expect(dirty.SOURCE_DATE_EPOCH).toBe('1700000000');
  });

  it('UI-008 valid values from the environment win; invalid ones are ignored', () => {
    const input = {
      pkgVersion: '0.1.0',
      git: null,
      tree: () => ({ hash: '0123456789abcdef'.repeat(4), newest: 1_790_000_000 }),
    };
    const given = resolveBuildId({
      ...input,
      env: { BUILD_SHA: 'DEADBEEF12', BUILD_VERSION: '0.2.0', SOURCE_DATE_EPOCH: '1790100000' },
    });
    expect(given).toEqual({
      BUILD_SHA: 'deadbee',
      BUILD_VERSION: '0.2.0',
      BUILD_DATE: '2026-09-22',
      SOURCE_DATE_EPOCH: '1790100000',
    });
    // The release pipeline passes a full ISO time as BUILD_DATE: both values follow it.
    const released = resolveBuildId({ ...input, env: { BUILD_DATE: '2026-10-01T10:20:30Z' } });
    expect(released.BUILD_DATE).toBe('2026-10-01');
    expect(released.SOURCE_DATE_EPOCH).toBe('1790850030');
    const bad = resolveBuildId({
      ...input,
      env: {
        BUILD_SHA: 'unknown',
        BUILD_VERSION: '',
        BUILD_DATE: 'unknown',
        SOURCE_DATE_EPOCH: 'x',
      },
    });
    expect(bad.BUILD_SHA).toBe('0123456');
    expect(bad.BUILD_VERSION).toBe('0.1.0-dev.0');
    expect(bad.SOURCE_DATE_EPOCH).toBe('1790000000');
  });

  it('UI-008 the version is the tag on a clean tagged commit, else a dev version with the distance', () => {
    const g = (describe: string | null, dirty = false): GitFacts => ({
      sha: 'abc1234',
      dirty,
      epoch: 1,
      describe,
    });
    expect(versionOf('0.2.0', g('v0.2.0-0-gabc1234'))).toBe('0.2.0');
    expect(versionOf('0.2.0', g('v0.2.0-0-gabc1234', true))).toBe('0.2.0-dev.0');
    expect(versionOf('0.2.0', g('v0.2.0-5-gabc1234'))).toBe('0.2.0-dev.5');
    expect(versionOf('0.1.0', g(null))).toBe('0.1.0-dev.0');
    expect(versionOf('0.1.0', null)).toBe('0.1.0-dev.0');
  });

  it('UI-008 the env lines are plain KEY=value pairs a POSIX shell can source', () => {
    const text = envLines({
      BUILD_SHA: 'abc1234',
      BUILD_VERSION: '0.1.0-dev.0',
      BUILD_DATE: '2026-09-27',
      SOURCE_DATE_EPOCH: '1790000000',
    });
    expect(text).toBe(
      'BUILD_SHA=abc1234\nBUILD_VERSION=0.1.0-dev.0\nBUILD_DATE=2026-09-27\nSOURCE_DATE_EPOCH=1790000000\n',
    );
    for (const line of text.trim().split('\n')) expect(line).toMatch(/^[A-Z_]+=[0-9A-Za-z.-]+$/);
  });
});
