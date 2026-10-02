import { INO } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { contentOfText } from '../src/content.ts';
import { forRemove } from '../src/ops/common.ts';
import { planMkdir, planSymlink } from '../src/ops/create.ts';
import { planLink } from '../src/ops/link.ts';
import { readlink, realpath, statPath } from '../src/ops/read.ts';
import { planRemoveTree, planUnlink } from '../src/ops/unlink.ts';
import { planWriteFile } from '../src/ops/write.ts';
import { ALICE, BOB, ROOT, World, errnoOf, ok } from './doubles/world.ts';

function reader(w: World, cred = ROOT): { view: World['tree']; cred: typeof ROOT; cwd: string } {
  return { view: w.tree, cred, cwd: INO.ROOT };
}

describe('soft links (VFS-05)', () => {
  it('VFS-05 ln -s stores the target verbatim and readlink returns it', () => {
    const w = new World();
    for (const [i, target] of ['../x', '/abs/y', 'café z', 'a//b/./c'].entries()) {
      const name = `/tmp/l${i}`;
      ok(w.run(ROOT, 'create', (b) => planSymlink(b, target, name)));
      expect(readlink(reader(w), name)).toBe(target);
      const st = statPath(reader(w), name, false);
      expect(st.type).toBe('l');
      expect(st.mode).toBe(0o777);
      expect(st.nlink).toBe(1);
      expect(st.size).toBe(new TextEncoder().encode(target).length);
    }
  });

  it('VFS-05 readlink on a regular file gives EINVAL', () => {
    const w = new World();
    ok(w.run(ROOT, 'write', (b) => planWriteFile(b, '/tmp/f', contentOfText('x', 0))));
    expect(() => readlink(reader(w), '/tmp/f')).toThrow('EINVAL');
  });

  it('VFS-05 stat follows a link and lstat does not', () => {
    const w = new World();
    ok(w.run(ROOT, 'write', (b) => planWriteFile(b, '/tmp/f', contentOfText('hello', 0))));
    ok(w.run(ROOT, 'create', (b) => planSymlink(b, 'f', '/tmp/l')));
    expect(statPath(reader(w), '/tmp/l').type).toBe('f');
    expect(statPath(reader(w), '/tmp/l').size).toBe(5);
    expect(statPath(reader(w), '/tmp/l', false).type).toBe('l');
    expect(realpath(reader(w), '/tmp/l')).toBe('/tmp/f');
  });

  it('VFS-05 a dangling link: stat gives ENOENT, lstat succeeds', () => {
    const w = new World();
    ok(w.run(ROOT, 'create', (b) => planSymlink(b, '/no/such', '/tmp/d')));
    expect(() => statPath(reader(w), '/tmp/d')).toThrow('ENOENT');
    expect(statPath(reader(w), '/tmp/d', false).target).toBe('/no/such');
  });

  it('VFS-05 rm -r never follows symlinks into directories', () => {
    const w = new World();
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/keep')));
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/keep/k', contentOfText('k', 0))));
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/gone')));
    ok(w.run(ALICE, 'create', (b) => planSymlink(b, '../keep', '/home/alice/gone/link')));
    const r = ok(
      w.run(ALICE, 'unlink', (b) => planRemoveTree(b, forRemove(b, '/home/alice/gone'))),
    );
    expect(r.removed).toBe(2);
    expect(statPath(reader(w, ALICE), '/home/alice/keep/k').size).toBe(1);
    // A symlink to a directory is itself unlinked, never its target.
    ok(w.run(ALICE, 'create', (b) => planSymlink(b, 'keep', '/home/alice/lk')));
    ok(w.run(ALICE, 'unlink', (b) => planUnlink(b, '/home/alice/lk', true)));
    expect(statPath(reader(w, ALICE), '/home/alice/keep').type).toBe('d');
  });

  it("VFS-05 a symlink's size is its target's UTF-8 length, charged to quota", () => {
    const w = new World();
    const before = w.user(ALICE.uid);
    ok(w.run(ALICE, 'create', (b) => planSymlink(b, 'éé', '/home/alice/l')));
    const after = w.user(ALICE.uid);
    expect(after.usedBytes - before.usedBytes).toBe(4);
    expect(after.usedInodes - before.usedInodes).toBe(1);
  });
});

describe('hard links (VFS-05)', () => {
  it('VFS-05 a hard link raises nlink to 2 and the inode survives the first unlink', () => {
    const w = new World();
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/a', contentOfText('data', 0))));
    const bytesBefore = w.user(ALICE.uid).usedBytes;
    const r = ok(w.run(ALICE, 'link', (b) => planLink(b, '/home/alice/a', '/home/alice/b')));
    expect(r.nlink).toBe(2);
    expect(w.user(ALICE.uid).usedBytes).toBe(bytesBefore);
    ok(w.run(ALICE, 'unlink', (b) => planUnlink(b, '/home/alice/a')));
    const st = statPath(reader(w, ALICE), '/home/alice/b');
    expect(st.nlink).toBe(1);
    expect(st.ino).toBe(r.ino);
    expect(w.user(ALICE.uid).usedBytes).toBe(bytesBefore);
    ok(w.run(ALICE, 'unlink', (b) => planUnlink(b, '/home/alice/b')));
    expect(w.user(ALICE.uid).usedBytes).toBe(bytesBefore - 4);
  });

  it('VFS-05 hard links to directories and across /tmp give EPERM and EXDEV', () => {
    const w = new World();
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/d')));
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/f', contentOfText('f', 0))));
    ok(w.run(ALICE, 'create', (b) => planSymlink(b, 'f', '/home/alice/s')));
    expect(
      errnoOf(w.run(ALICE, 'link', (b) => planLink(b, '/home/alice/d', '/home/alice/d2'))),
    ).toBe('EPERM');
    expect(
      errnoOf(w.run(ALICE, 'link', (b) => planLink(b, '/home/alice/s', '/home/alice/s2'))),
    ).toBe('EPERM');
    expect(errnoOf(w.run(ALICE, 'link', (b) => planLink(b, '/home/alice/f', '/tmp/f')))).toBe(
      'EXDEV',
    );
    expect(
      errnoOf(w.run(ALICE, 'link', (b) => planLink(b, '/home/alice/f', '/home/alice/d'))),
    ).toBe('EEXIST');
  });

  it("VFS-05 linking another user's file without r and w gives EPERM", () => {
    const w = new World();
    ok(w.run(BOB, 'write', (b) => planWriteFile(b, '/tmp/bobs', contentOfText('b', 0))));
    expect(errnoOf(w.run(ALICE, 'link', (b) => planLink(b, '/tmp/bobs', '/tmp/mine')))).toBe(
      'EPERM',
    );
    ok(w.run(ROOT, 'link', (b) => planLink(b, '/tmp/bobs', '/tmp/roots')));
  });

  it('VFS-05 rm -r of a subtree keeps an inode that is also linked outside it', () => {
    const w = new World();
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/sub')));
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/sub/f', contentOfText('ff', 0))));
    ok(w.run(ALICE, 'link', (b) => planLink(b, '/home/alice/sub/f', '/home/alice/sub/g')));
    ok(w.run(ALICE, 'link', (b) => planLink(b, '/home/alice/sub/f', '/home/alice/out')));
    const r = ok(w.run(ALICE, 'unlink', (b) => planRemoveTree(b, forRemove(b, '/home/alice/sub'))));
    expect(r.removed).toBe(1);
    expect(statPath(reader(w, ALICE), '/home/alice/out').nlink).toBe(1);
  });
});
