import { INO, deriveIno } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { contentOfText } from '../src/content.ts';
import { planChmod, planChown, planUtimes } from '../src/ops/attr.ts';
import { fingerprintOf, planBatch } from '../src/ops/batch.ts';
import { isBulk } from '../src/ops/commit.ts';
import { forRemove } from '../src/ops/common.ts';
import { planCopy } from '../src/ops/copy.ts';
import { planCreateFile, planMkdir, planSymlink } from '../src/ops/create.ts';
import { readdir, statPath } from '../src/ops/read.ts';
import { planRename } from '../src/ops/rename.ts';
import { planRemoveTree, planRmdir, planUnlink } from '../src/ops/unlink.ts';
import { planTruncate, planWriteFile } from '../src/ops/write.ts';
import { parseModeSpec } from '../src/perm.ts';
import type { ModeSpec } from '../src/perm.ts';
import { ALICE, BOB, ROOT, World, errnoOf, ok } from './doubles/world.ts';

const read = (w: World, cred = ROOT) => ({ view: w.tree, cred, cwd: INO.ROOT });
const spec = (s: string): ModeSpec => {
  const p = parseModeSpec(s);
  if (p === 'EINVAL') throw new Error(s);
  return p;
};

function tree(): World {
  const w = new World();
  const put = (path: string, text: string): void => {
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, path, contentOfText(text, 0))));
  };
  ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/src/sub', undefined, true)));
  ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/empty')));
  ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/full')));
  put('/home/alice/full/x', 'x');
  put('/home/alice/src/a.txt', 'aaa');
  put('/home/alice/src/sub/b.txt', 'bb');
  put('/home/alice/file', 'file');
  put('/home/alice/other', 'other');
  ok(w.run(ALICE, 'create', (b) => planSymlink(b, 'file', '/home/alice/link')));
  return w;
}

describe('rename (VFS-07, §3.12.4)', () => {
  const R = (w: World, from: string, to: string, noReplace = false) =>
    errnoOf(
      w.run(ALICE, 'rename', (b) =>
        planRename(b, `/home/alice/${from}`, `/home/alice/${to}`, noReplace),
      ),
    );

  it('VFS-07 the rename matrix of 3.12.4 holds for every source and target type', () => {
    expect(R(tree(), 'file', 'new')).toBe('ok');
    expect(R(tree(), 'file', 'other')).toBe('ok');
    expect(R(tree(), 'link', 'other')).toBe('ok');
    expect(R(tree(), 'file', 'empty')).toBe('EISDIR');
    expect(R(tree(), 'file', 'full')).toBe('EISDIR');
    expect(R(tree(), 'src', 'new')).toBe('ok');
    expect(R(tree(), 'src', 'file')).toBe('ENOTDIR');
    expect(R(tree(), 'src', 'empty')).toBe('ok');
    expect(R(tree(), 'src', 'full')).toBe('ENOTEMPTY');
    expect(R(tree(), 'file', 'other', true)).toBe('EEXIST');
    expect(R(tree(), 'missing', 'x')).toBe('ENOENT');
  });

  it('VFS-07 replacing a file frees it and moves the charge; nlink follows directory moves', () => {
    const w = tree();
    const bytes = w.user(ALICE.uid).usedBytes;
    const inodes = w.user(ALICE.uid).usedInodes;
    const r = ok(
      w.run(ALICE, 'rename', (b) => planRename(b, '/home/alice/file', '/home/alice/other')),
    );
    expect(r.replaced).toBeDefined();
    expect(w.user(ALICE.uid).usedBytes).toBe(bytes - 5);
    expect(w.user(ALICE.uid).usedInodes).toBe(inodes - 1);
    const home = w.tree.inode(w.user(ALICE.uid).homeIno ?? '');
    const nlink = home?.nlink ?? 0;
    ok(w.run(ALICE, 'rename', (b) => planRename(b, '/home/alice/src', '/home/alice/empty/src')));
    expect(w.tree.inode(w.user(ALICE.uid).homeIno ?? '')?.nlink).toBe(nlink - 1);
    expect(statPath(read(w, ALICE), '/home/alice/empty').nlink).toBe(3);
    // The moved inode keeps its version (§3.2); only the parents' versions move.
    const moved = statPath(read(w, ALICE), '/home/alice/empty/src');
    expect(moved.version).toBe(2);
  });

  it('VFS-07 moving a directory into its own subtree gives EINVAL', () => {
    expect(R(tree(), 'src', 'src/sub/x')).toBe('EINVAL');
    expect(R(tree(), 'src', 'src/x')).toBe('EINVAL');
  });

  it('VFS-07 renaming an entry onto itself or onto another link of the same inode is a no-op', () => {
    const w = tree();
    const r = w.plan(ALICE, 'rename', (b) => planRename(b, '/home/alice/file', '/home/alice/file'));
    expect(r.plan.writes).toHaveLength(0);
  });

  it('PVFS-10 rename and link across /tmp give EXDEV', () => {
    const w = tree();
    expect(
      errnoOf(w.run(ALICE, 'rename', (b) => planRename(b, '/home/alice/file', '/tmp/file'))),
    ).toBe('EXDEV');
  });

  it('PVFS-09 well-known directories cannot be removed or renamed and synthesised files never change', () => {
    const w = tree();
    expect(errnoOf(w.run(ROOT, 'rename', (b) => planRename(b, '/bin', '/bin2')))).toBe('EBUSY');
    expect(errnoOf(w.run(ROOT, 'unlink', (b) => planUnlink(b, '/system', true)))).toBe('EBUSY');
    expect(errnoOf(w.run(ROOT, 'unlink', (b) => planRmdir(b, '/mnt')))).toBe('EBUSY');
    expect(errnoOf(w.run(ROOT, 'unlink', (b) => planUnlink(b, '/system/log', true)))).toBe('EBUSY');
    expect(errnoOf(w.run(ROOT, 'unlink', (b) => planUnlink(b, '/system/release')))).toBe('EPERM');
    expect(
      errnoOf(
        w.run(ROOT, 'write', (b) => planWriteFile(b, '/system/release', contentOfText('x', 0))),
      ),
    ).toBe('EPERM');
    expect(errnoOf(w.run(ROOT, 'chmod', (b) => planChmod(b, '/system/release', spec('777'))))).toBe(
      'EPERM',
    );
    expect(errnoOf(w.run(ROOT, 'create', (b) => planMkdir(b, '/system/release')))).toBe('EEXIST');
    expect(statPath(read(w), '/system/log/audit.log').mode).toBe(0o400);
    expect(statPath(read(w), '/system/release').synth).toBe(true);
    expect(errnoOf(w.run(ROOT, 'unlink', (b) => planUnlink(b, '/', true)))).toBe('EBUSY');
  });

  it('PVFS-03 recovery mode refuses every mutation with EPERM', () => {
    const w = tree();
    expect(errnoOf(w.run(ROOT, 'create', (b) => planMkdir(b, '/tmp/x'), { readOnly: true }))).toBe(
      'EPERM',
    );
  });

  it('VFS-09 a lease held elsewhere makes mutations EBUSY', () => {
    const w = tree();
    const f = statPath(read(w, ALICE), '/home/alice/src/sub/b.txt').ino;
    const busy = (ino: string): boolean => ino === f;
    expect(
      errnoOf(w.run(ALICE, 'unlink', (b) => planUnlink(b, '/home/alice/src/sub/b.txt'), { busy })),
    ).toBe('EBUSY');
    expect(
      errnoOf(w.run(ALICE, 'unlink', (b) => planUnlink(b, '/home/alice/src', true), { busy })),
    ).toBe('EBUSY');
    expect(
      errnoOf(
        w.run(
          ALICE,
          'write',
          (b) => planWriteFile(b, '/home/alice/src/sub/b.txt', contentOfText('z', 0)),
          { busy },
        ),
      ),
    ).toBe('EBUSY');
  });
});

describe('remove, create, copy and attributes (VFS-07)', () => {
  it('VFS-07 unlink of a directory without recursive gives EISDIR and rmdir of a file ENOTDIR', () => {
    const w = tree();
    expect(errnoOf(w.run(ALICE, 'unlink', (b) => planUnlink(b, '/home/alice/src')))).toBe('EISDIR');
    expect(errnoOf(w.run(ALICE, 'unlink', (b) => planRmdir(b, '/home/alice/file')))).toBe(
      'ENOTDIR',
    );
    expect(errnoOf(w.run(ALICE, 'unlink', (b) => planRmdir(b, '/home/alice/full')))).toBe(
      'ENOTEMPTY',
    );
    expect(errnoOf(w.run(ALICE, 'unlink', (b) => planRmdir(b, '/home/alice/empty')))).toBe('ok');
    expect(errnoOf(w.run(ALICE, 'unlink', (b) => planRmdir(b, '/home/alice/.')))).toBe('EINVAL');
  });

  it('VFS-07 mkdir -p creates every missing component in one op', () => {
    const w = tree();
    const r = w.plan(ALICE, 'create', (b) => planMkdir(b, '/home/alice/p/q/r', 0o700, true));
    expect(r.value.created).toBe(3);
    expect(r.plan.wire?.op.kind).toBe('batch');
    expect(r.plan.events).toHaveLength(1);
    const c = ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/p/q/r', undefined, true)));
    expect(c.created).toBe(3);
    expect(statPath(read(w, ALICE), '/home/alice/p/q/r').mode).toBe(0o755);
    expect(
      ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/p/q', undefined, true))).created,
    ).toBe(0);
    expect(
      errnoOf(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/file/x', undefined, true))),
    ).toBe('ENOTDIR');
    expect(
      errnoOf(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/file', undefined, true))),
    ).toBe('EEXIST');
    expect(errnoOf(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/p')))).toBe('EEXIST');
    expect(
      errnoOf(w.run(BOB, 'create', (b) => planMkdir(b, '/home/alice/z', undefined, true))),
    ).toBe('EACCES');
  });

  it('VFS-07 open with create commits an empty file at once, excl sees an existing name', () => {
    const w = tree();
    const c = ok(
      w.run(ALICE, 'create', (b) => planCreateFile(b, '/home/alice/new', { mode: 0o600 })),
    );
    expect(c.created).toBe(true);
    expect(statPath(read(w, ALICE), '/home/alice/new').size).toBe(0);
    expect(ok(w.run(ALICE, 'create', (b) => planCreateFile(b, '/home/alice/link'))).created).toBe(
      false,
    );
    expect(
      errnoOf(w.run(ALICE, 'create', (b) => planCreateFile(b, '/home/alice/link', { excl: true }))),
    ).toBe('EEXIST');
    expect(errnoOf(w.run(ALICE, 'create', (b) => planCreateFile(b, '/home/alice/src')))).toBe(
      'EISDIR',
    );
  });

  it('VFS-07 cp -r copies a tree sharing blobs with derived ids, and refuses its own subtree', () => {
    const w = tree();
    const blobs = new Map([...w.blobs].map(([k, v]) => [k, v.refcount]));
    const r = w.plan(ALICE, 'copy', (b) =>
      planCopy(b, '/home/alice/src', '/home/alice/dst', { recursive: true }),
    );
    expect(r.value.created).toBe(4);
    expect(r.plan.wire?.op.kind).toBe('copy');
    expect(r.plan.wire?.base.kind).toBe('digest');
    const src = statPath(read(w, ALICE), '/home/alice/src');
    ok(
      w.run(ALICE, 'copy', (b) =>
        planCopy(b, '/home/alice/src', '/home/alice/dst', { recursive: true }),
      ),
    );
    const copied = statPath(read(w, ALICE), '/home/alice/dst/a.txt');
    expect(copied.blob).toBe(statPath(read(w, ALICE), '/home/alice/src/a.txt').blob);
    expect(copied.version).toBe(1);
    const sha = copied.blob ?? '';
    expect(w.blobs.get(sha)?.refcount).toBe((blobs.get(sha) ?? 0) + 1);
    expect(statPath(read(w, ALICE), '/home/alice/dst').ino).not.toBe(src.ino);
    expect(
      errnoOf(
        w.run(ALICE, 'copy', (b) =>
          planCopy(b, '/home/alice/src', '/home/alice/src/sub', { recursive: true }),
        ),
      ),
    ).toBe('EINVAL');
    expect(
      errnoOf(w.run(ALICE, 'copy', (b) => planCopy(b, '/home/alice/src', '/home/alice/x'))),
    ).toBe('EISDIR');
  });

  it('VFS-07 cp -r merges into an existing directory and reports overwrites and skips', () => {
    const w = tree();
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/dst')));
    ok(
      w.run(ALICE, 'copy', (b) =>
        planCopy(b, '/home/alice/src', '/home/alice/dst', { recursive: true }),
      ),
    );
    ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/alice/src/a.txt', contentOfText('changed', 0)),
      ),
    );
    ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/alice/src/new.txt', contentOfText('n', 0)),
      ),
    );
    const before = statPath(read(w, ALICE), '/home/alice/dst/src/a.txt');
    const merged = ok(
      w.run(ALICE, 'copy', (b) =>
        planCopy(b, '/home/alice/src', '/home/alice/dst', { recursive: true }),
      ),
    );
    expect(merged.overwritten).toEqual([
      '/home/alice/dst/src/a.txt',
      '/home/alice/dst/src/sub/b.txt',
    ]);
    expect(merged.created).toBe(1);
    const after = statPath(read(w, ALICE), '/home/alice/dst/src/a.txt');
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(7);
    expect(after.version).toBe(before.version + 1);
    const skip = ok(
      w.run(ALICE, 'copy', (b) =>
        planCopy(b, '/home/alice/src', '/home/alice/dst', { recursive: true, noClobber: true }),
      ),
    );
    expect(skip.skipped).toHaveLength(3);
    expect(
      errnoOf(
        w.run(ALICE, 'copy', (b) =>
          planCopy(b, '/home/alice/file', '/home/alice/dst/src', { recursive: false }),
        ),
      ),
    ).toBe('ok');
    expect(
      errnoOf(
        w.run(ALICE, 'copy', (b) =>
          planCopy(b, '/home/alice/src', '/home/alice/file', { recursive: true }),
        ),
      ),
    ).toBe('ENOTDIR');
    expect(
      errnoOf(w.run(ALICE, 'copy', (b) => planCopy(b, '/home/alice/file', '/home/alice/full/x/y'))),
    ).toBe('ENOTDIR');
  });

  it('VFS-07 cp into /tmp is local-only and cp of a symlink replaces the name', () => {
    const w = tree();
    const r = w.plan(ALICE, 'copy', (b) =>
      planCopy(b, '/home/alice/src', '/tmp/c', { recursive: true }),
    );
    expect(r.plan.wire).toBeNull();
    expect(r.plan.synced).toBe(false);
    ok(
      w.run(ALICE, 'copy', (b) =>
        planCopy(b, '/home/alice/link', '/home/alice/other', { recursive: true }),
      ),
    );
    expect(statPath(read(w, ALICE), '/home/alice/other', false).type).toBe('l');
    const opId = '01920000-0000-7000-8000-00000000c0de';
    const p = w.plan(
      ROOT,
      'copy',
      (b) => planCopy(b, '/home/alice/file', '/home/alice/cp', { preserve: true }),
      { opId },
    );
    const created = p.plan.writes.find((x) => x.store === 'inodes' && x.op === 'add');
    if (created === undefined || created.store !== 'inodes' || created.op === 'del')
      throw new Error('no inode add');
    expect(created.value.uid).toBe(ALICE.uid);
    expect(created.value.ino).toBe(deriveIno(opId, statPath(read(w), '/home/alice/file').ino));
  });

  it('VFS-07 chmod -R changes every non-symlink inode it owns, as one op with a digest base', () => {
    const w = tree();
    const r = ok(
      w.run(ALICE, 'chmod', (b) => planChmod(b, '/home/alice/src', spec('go-rwx'), true)),
    );
    expect(r.changed).toBe(4);
    expect(statPath(read(w, ALICE), '/home/alice/src/sub/b.txt').mode).toBe(0o600);
    expect(w.outbox.at(-1)?.base.kind).toBe('digest');
    expect(
      ok(w.run(ALICE, 'chmod', (b) => planChmod(b, '/home/alice/src', spec('go-rwx'), true)))
        .changed,
    ).toBe(0);
    ok(w.run(ROOT, 'chown', (b) => planChown(b, '/home/alice/src/a.txt', { uid: BOB.uid })));
    expect(
      errnoOf(w.run(ALICE, 'chmod', (b) => planChmod(b, '/home/alice/src', spec('777'), true))),
    ).toBe('EPERM');
  });

  it('VFS-07 chown -R is root only and moves every inode, symlinks included', () => {
    const w = tree();
    ok(w.run(ALICE, 'create', (b) => planSymlink(b, 'a.txt', '/home/alice/src/l')));
    const r = ok(
      w.run(ROOT, 'chown', (b) =>
        planChown(b, '/home/alice/src', { uid: BOB.uid, gid: 100, recursive: true }),
      ),
    );
    expect(r.changed).toBe(5);
    expect(statPath(read(w), '/home/alice/src/l', false).uid).toBe(BOB.uid);
    expect(
      errnoOf(
        w.run(ALICE, 'chown', (b) =>
          planChown(b, '/home/alice/src', { uid: 1000, recursive: true }),
        ),
      ),
    ).toBe('EPERM');
    expect(
      errnoOf(
        w.run(ROOT, 'chown', (b) => planChown(b, '/home/alice/src', { gid: 7 }), {
          groupExists: () => false,
        }),
      ),
    ).toBe('EINVAL');
  });

  it('VFS-07 utimes needs ownership for explicit times and never bumps the version', () => {
    const w = tree();
    const v = statPath(read(w, ALICE), '/home/alice/file').version;
    ok(w.run(ALICE, 'utimes', (b) => planUtimes(b, '/home/alice/file', { mtime: 1234 })));
    const st = statPath(read(w, ALICE), '/home/alice/file');
    expect(st.mtime).toBe(1234);
    expect(st.version).toBe(v);
    ok(w.run(ALICE, 'chmod', (b) => planChmod(b, '/home/alice', spec('755'))));
    expect(
      errnoOf(w.run(BOB, 'utimes', (b) => planUtimes(b, '/home/alice/file', { mtime: 1 }))),
    ).toBe('EPERM');
    expect(errnoOf(w.run(BOB, 'utimes', (b) => planUtimes(b, '/home/alice/file', {})))).toBe(
      'EACCES',
    );
    ok(
      w.run(ALICE, 'utimes', (b) =>
        planUtimes(b, '/home/alice/file', { atime: 'now', mtime: 'now', noFollow: true }),
      ),
    );
  });

  it('VFS-07 truncate and writeFile replace content with the version rule', () => {
    const w = tree();
    const r = ok(
      w.run(ALICE, 'write', (b) => planTruncate(b, '/home/alice/file', contentOfText('fi', 0))),
    );
    expect(r.version).toBe(2);
    expect(
      errnoOf(
        w.run(ALICE, 'write', (b) => planTruncate(b, '/home/alice/src', contentOfText('', 0))),
      ),
    ).toBe('EISDIR');
    expect(
      errnoOf(
        w.run(ALICE, 'write', (b) =>
          planWriteFile(b, '/home/alice/nope', contentOfText('', 0), { create: false }),
        ),
      ),
    ).toBe('ENOENT');
    expect(
      errnoOf(
        w.run(ALICE, 'write', (b) =>
          planWriteFile(b, '/home/alice/file', contentOfText('', 0), { excl: true }),
        ),
      ),
    ).toBe('EEXIST');
    const via = ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/alice/link', contentOfText('through', 0)),
      ),
    );
    expect(via.created).toBe(false);
    expect(statPath(read(w, ALICE), '/home/alice/file').size).toBe(7);
  });

  it('VFS-07 readdir lists in code-point order with paging and plus', () => {
    const w = new World();
    for (const n of ['b', 'a', '\u{1F600}', '～', 'B'])
      ok(w.run(ROOT, 'create', (b) => planMkdir(b, `/tmp/${n}`)));
    const all = readdir(read(w), '/tmp', { limit: 3 });
    expect(all.entries.map((e) => e.name)).toEqual(['B', 'a', 'b']);
    expect(all.next).toBe('b');
    const rest = readdir(read(w), '/tmp', { cursor: all.next ?? '', plus: true });
    // U+FF5E sorts before U+1F600 by code point although UTF-16 orders the surrogate pair first.
    expect(rest.entries.map((e) => e.name)).toEqual(['～', '\u{1F600}']);
    expect(rest.entries[0]?.stat?.type).toBe('d');
    expect(() => readdir(read(w), '/tmp/a/zz')).toThrow('ENOENT');
  });
});

describe('batch (AGT-03, AGT-05)', () => {
  it('AGT-05 a batch fails as a whole on the first invalid op and reports its index', () => {
    const w = tree();
    const before = w.tree.snapshot();
    const r = w.run(ALICE, 'batch', (b) =>
      planBatch(b, [
        { op: 'mkdir', path: '/home/alice/b1' },
        { op: 'rename', from: '/home/alice/file', to: '/home/alice/b1/file' },
        { op: 'unlink', path: '/home/alice/missing' },
      ]),
    );
    expect(r.ok === false && r.errno === 'ENOENT' && r.index === 2).toBe(true);
    expect(w.tree.snapshot()).toEqual(before);
  });

  it('AGT-05 ops see the effects of earlier ops and the batch is one outbox op', () => {
    const w = tree();
    const r = ok(
      w.run(ALICE, 'batch', (b) =>
        planBatch(b, [
          { op: 'mkdir', path: '/home/alice/b1', parents: true },
          { op: 'write', path: '/home/alice/b1/n.txt', text: 'hi' },
          { op: 'rename', from: '/home/alice/b1/n.txt', to: '/home/alice/b1/m.txt' },
          { op: 'rename', from: '/home/alice/file', to: '/home/alice/b1/file' },
          { op: 'copy', from: '/home/alice/b1', to: '/home/alice/b2', recursive: true },
          { op: 'symlink', target: 'm.txt', path: '/home/alice/b1/s' },
          { op: 'chmod', path: '/home/alice/b1/m.txt', mode: { op: 'set', bits: 0o600 } },
          { op: 'utimes', path: '/home/alice/b1/m.txt', mtime: 5 },
          { op: 'unlink', path: '/home/alice/b2', recursive: true },
        ]),
      ),
    );
    expect(r.plan.wire?.op.kind).toBe('batch');
    expect(w.outbox).toHaveLength(10);
    expect(w.outbox.at(-1)?.call).toBe('batch');
    expect(statPath(read(w, ALICE), '/home/alice/b1/m.txt').mode).toBe(0o600);
    expect(isBulk(r.plan)).toBe(true);
  });

  it('AGT-03 a batch dry run reports overwrites, deletes, mode and owner changes and touched inodes', () => {
    const w = tree();
    const dry = w.plan(ROOT, 'batch', (b) =>
      planBatch(b, [
        { op: 'rename', from: '/home/alice/file', to: '/home/alice/other' },
        { op: 'write', path: '/home/alice/src/a.txt', text: 'new' },
        { op: 'unlink', path: '/home/alice/full', recursive: true },
        { op: 'chmod', path: '/home/alice/src', mode: { op: 'set', bits: 0o700 } },
        { op: 'chown', path: '/home/alice/src/sub', uid: BOB.uid },
      ]),
    ).value.dryRun;
    expect(dry.overwrites).toEqual(['/home/alice/other', '/home/alice/src/a.txt']);
    expect(dry.deletes).toEqual(['/home/alice/full', '/home/alice/full/x']);
    expect(dry.chmods).toEqual([{ path: '/home/alice/src', from: 0o755, to: 0o700 }]);
    expect(dry.chowns).toEqual([{ path: '/home/alice/src/sub', uid: BOB.uid, gid: 100 }]);
    expect(dry.moves).toEqual([{ from: '/home/alice/file', to: '/home/alice/other' }]);
    expect(dry.touchedInodes).toBeGreaterThan(5);
    expect(dry.quotaOk).toBe(true);
    expect(dry.fingerprint).toBe(
      fingerprintOf(new Map(dry.expectedVersions.map((e) => [e.ino, e.version]))),
    );
  });

  it('AGT-05 a batch whose fingerprint changed gives EAGAIN stale-plan and changes nothing', () => {
    const w = tree();
    const ops = [{ op: 'write' as const, path: '/home/alice/file', text: 'v2' }];
    const dry = w.plan(ALICE, 'batch', (b) => planBatch(b, ops)).value.dryRun;
    ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/alice/file', contentOfText('meanwhile', 0)),
      ),
    );
    const r = w.run(ALICE, 'batch', (b) => planBatch(b, ops, dry.expectedVersions));
    expect(r.ok === false && r.errno === 'EAGAIN' && r.detail === 'stale-plan').toBe(true);
    const fresh = w.plan(ALICE, 'batch', (b) => planBatch(b, ops)).value.dryRun;
    expect(errnoOf(w.run(ALICE, 'batch', (b) => planBatch(b, ops, fresh.expectedVersions)))).toBe(
      'ok',
    );
    expect(errnoOf(w.run(ALICE, 'batch', (b) => planBatch(b, [])))).toBe('EINVAL');
    expect(
      errnoOf(
        w.run(ALICE, 'batch', (b) =>
          planBatch(b, [
            { op: 'chmod', path: '/home/alice/file', mode: { op: 'set', bits: 0o4755 } },
          ]),
        ),
      ),
    ).toBe('EINVAL');
  });
});

describe('outbox, undo and tmpfs (OFF-02, PVFS-10)', () => {
  it('OFF-02 every synced mutation writes its outbox op and undo record with the same opId', () => {
    const w = tree();
    expect(w.outbox.length).toBe(w.undo.length);
    for (const [i, o] of w.outbox.entries()) {
      expect(o.opId).toBe(w.undo[i]?.opId);
      expect(o.state).toBe('pending');
      expect(o.touches.length).toBeGreaterThan(0);
    }
    const create = w.undo.find((u) => u.created.inodes.length > 0);
    expect(create?.created.dentries.length).toBeGreaterThan(0);
  });

  it('OFF-02 tmpfs changes never write an outbox op', () => {
    const w = new World();
    const n = w.outbox.length;
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/tmp/t/u', undefined, true)));
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/tmp/t/u/f', contentOfText('tmp', 0))));
    ok(w.run(ALICE, 'unlink', (b) => planRemoveTree(b, forRemove(b, '/tmp/t'))));
    expect(w.outbox.length).toBe(n);
    expect(w.tmpfs).toEqual({ bytes: 0, inodes: 0 });
    expect(w.tree.inode(INO.TMP)?.version).toBe(1);
  });
});
