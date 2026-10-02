/**
 * VFS-01 … VFS-08 through the system-call layer: every call below is a `{id, call, args}` frame on
 * an executor port, through all dispatcher stages, the fs handlers, the vfs planners and the memory
 * store adapter.
 */
import type { RetOf, Stat } from '@plotinium/protocol';
import { INO, WELL_KNOWN_DIRS } from '@plotinium/protocol';
import type { InodeRec } from '@plotinium/vfs';
import { describe, expect, it, vi } from 'vitest';

import { MemStore } from '../mem-store.ts';
import { UID, boot, bytes, snapshot, testTreeFactory, text } from './harness.ts';

const stat = (s: unknown): Stat => s as Stat;

describe('VFS-01 hierarchy in the dsa n-ary tree', () => {
  it('VFS-01 the kernel file system keeps its hierarchy in the tree the factory builds', async () => {
    const factory = vi.fn(testTreeFactory);
    const w = await boot({ treeFactory: factory });
    expect(factory).toHaveBeenCalledTimes(1);
    const made = factory.mock.results[0]?.value as { root: { id: string } } | undefined;
    expect(w.fs.tree.tree).toBe(made);
    expect(w.fs.tree.tree.root.id).toBe(INO.ROOT);
    await w.alice.ok('mkdir', { path: '/home/alice/docs' });
    const nary = w.fs.tree.tree;
    const home = w.fs.tree.node(w.fs.tree.user(UID.alice)?.homeIno ?? '');
    expect(home !== undefined && nary.isDir(home)).toBe(true);
    if (home === undefined || !nary.isDir(home)) return;
    expect(nary.lookup(home, 'docs')?.payload.type).toBe('d');
    expect(nary.pathOf(home)).toBe('/home/alice');
  });

  it('VFS-01 resolving and listing a loaded path reads nothing from the store', async () => {
    const w = await boot();
    await w.alice.ok('mkdir', { path: '/home/alice/a/b/c', parents: true });
    const get = vi.spyOn(w.store, 'get');
    const scan = vi.spyOn(w.store, 'scan');
    const many = vi.spyOn(w.store, 'getMany');
    await w.alice.ok('stat', { path: '/home/alice/a/b/c' });
    await w.alice.ok('readdir', { path: '/home/alice/a/b' });
    expect(get).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(many).not.toHaveBeenCalled();
  });
});

describe('VFS-02 standard hierarchy and first-boot mkfs', () => {
  it('VFS-02 mkfs creates the standard hierarchy with the specified owners and modes', async () => {
    const w = await boot({ users: false });
    for (const d of WELL_KNOWN_DIRS) {
      const s = stat(await w.root.ok('stat', { path: d.path }));
      expect(s, d.path).toMatchObject({ ino: d.ino, type: 'd', mode: d.mode, uid: 0, gid: 0 });
    }
    expect(stat(await w.root.ok('stat', { path: '/' })).mode).toBe(0o755);
    expect(stat(await w.root.ok('stat', { path: '/tmp' })).mode).toBe(0o1777);
    expect(stat(await w.root.ok('stat', { path: '/root' })).mode).toBe(0o700);
  });

  it('VFS-02 mkfs is idempotent and writes no outbox op', async () => {
    const store = new MemStore();
    const first = await boot({ store, users: false });
    expect(first.logs.some((l) => l.includes('mkfs: standard hierarchy created'))).toBe(true);
    expect(store.count('outbox')).toBe(0);
    const inodes = store.count('inodes');
    const second = await boot({ store, users: false });
    expect(second.logs.some((l) => l.includes('mkfs:'))).toBe(false);
    expect(store.count('inodes')).toBe(inodes);
    expect(store.count('outbox')).toBe(0);
  });
});

describe('VFS-03 path resolution', () => {
  it('VFS-03 absolute and relative paths resolve from / and from the cwd', async () => {
    const w = await boot();
    const sh = w.spawn(UID.alice, { cwdPath: '/home/alice' });
    await sh.ok('mkdir', { path: 'docs' });
    await sh.ok('writeFile', { path: 'docs/a.txt', data: bytes('A') });
    expect(stat(await w.alice.ok('stat', { path: '/home/alice/docs/a.txt' })).size).toBe(1);
    expect(stat(await sh.ok('stat', { path: 'docs/../docs/./a.txt' })).size).toBe(1);
    expect(stat(await sh.ok('stat', { path: '//home///alice//docs/' })).type).toBe('d');
  });

  it('VFS-03 .. at / stays at / and a trailing slash on a regular file gives ENOTDIR', async () => {
    const w = await boot();
    expect(stat(await w.alice.ok('stat', { path: '/../../home' })).ino).toBe(INO.HOME);
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('x') });
    expect(await w.alice.errno('stat', { path: '/home/alice/f/' })).toBe('ENOTDIR');
    expect(await w.alice.errno('stat', { path: '/home/alice/f/g' })).toBe('ENOTDIR');
    expect(await w.alice.errno('stat', { path: '/home/alice/missing/g' })).toBe('ENOENT');
  });

  it('VFS-03 mutating calls on /, . and .. give EEXIST, EBUSY or EINVAL from the handler', async () => {
    const w = await boot();
    expect(await w.root.errno('mkdir', { path: '/' })).toBe('EEXIST');
    expect(await w.alice.errno('mkdir', { path: '/home/alice/.' })).toBe('EEXIST');
    expect(await w.root.errno('rmdir', { path: '/' })).toBe('EBUSY');
    expect(await w.alice.errno('rmdir', { path: '/home/alice/.' })).toBe('EINVAL');
    // No w on carol's home: a create is EACCES, but writeFile with create: false is ENOENT.
    expect(await w.alice.errno('writeFile', { path: '/home/carol/new', data: bytes('x') })).toBe(
      'EACCES',
    );
    expect(
      await w.alice.errno('writeFile', {
        path: '/home/carol/new',
        data: bytes('x'),
        create: false,
      }),
    ).toBe('ENOENT');
  });

  it('VFS-03 search permission is required on every directory traversed', async () => {
    const w = await boot();
    await w.carol.ok('mkdir', { path: '/home/carol/priv', mode: 0o700 });
    await w.carol.ok('writeFile', { path: '/home/carol/priv/secret', data: bytes('s') });
    expect(await w.alice.errno('stat', { path: '/home/carol/priv' })).toBe('ok');
    expect(await w.alice.errno('stat', { path: '/home/carol/priv/secret' })).toBe('EACCES');
    expect(await w.alice.errno('stat', { path: '/home/bob' })).toBe('ok');
    expect(await w.alice.errno('readdir', { path: '/home/bob' })).toBe('EACCES');
  });

  it('VFS-03 a chain of 40 symlinks resolves and a chain of 41 gives ELOOP', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/target', data: bytes('t') });
    await w.alice.ok('symlink', { target: 'target', path: '/home/alice/l1' });
    for (let i = 2; i <= 41; i++) {
      await w.alice.ok('symlink', {
        target: `l${String(i - 1)}`,
        path: `/home/alice/l${String(i)}`,
      });
    }
    expect(stat(await w.alice.ok('stat', { path: '/home/alice/l40' })).type).toBe('f');
    expect(await w.alice.errno('stat', { path: '/home/alice/l41' })).toBe('ELOOP');
    expect(stat(await w.alice.ok('lstat', { path: '/home/alice/l41' })).type).toBe('l');
  });

  it('VFS-03 ln -s a b; ln -s b a; open a gives ELOOP', async () => {
    const w = await boot();
    await w.alice.ok('symlink', { target: 'b', path: '/home/alice/a' });
    await w.alice.ok('symlink', { target: 'a', path: '/home/alice/b' });
    expect(await w.alice.errno('open', { path: '/home/alice/a', flags: 'r' })).toBe('ELOOP');
  });

  it('VFS-03 relative symlink targets resolve against the link directory and unlink stops one step early', async () => {
    const w = await boot();
    await w.alice.ok('mkdir', { path: '/home/alice/d' });
    await w.alice.ok('writeFile', { path: '/home/alice/d/f', data: bytes('F') });
    await w.alice.ok('symlink', { target: 'd/f', path: '/home/alice/lnk' });
    expect(stat(await w.alice.ok('stat', { path: '/home/alice/lnk' })).size).toBe(1);
    await w.alice.ok('unlink', { path: '/home/alice/lnk' });
    expect(await w.alice.errno('lstat', { path: '/home/alice/lnk' })).toBe('ENOENT');
    expect(await w.alice.errno('stat', { path: '/home/alice/d/f' })).toBe('ok');
  });
});

describe('VFS-04 permissions', () => {
  it('VFS-04 umask 022 gives 0644 files and 0755 directories, umask 077 gives 0600 and 0700', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('') });
    await w.alice.ok('mkdir', { path: '/home/alice/d' });
    expect(stat(await w.alice.ok('stat', { path: '/home/alice/f' })).mode).toBe(0o644);
    expect(stat(await w.alice.ok('stat', { path: '/home/alice/d' })).mode).toBe(0o755);
    const strict = w.spawn(UID.alice, { umask: 0o077 });
    await strict.ok('open', { path: '/home/alice/g', flags: 'w', create: true });
    await strict.ok('mkdir', { path: '/home/alice/e' });
    expect(stat(await w.alice.ok('stat', { path: '/home/alice/g' })).mode).toBe(0o600);
    expect(stat(await w.alice.ok('stat', { path: '/home/alice/e' })).mode).toBe(0o700);
  });

  it('VFS-04 chmod by a non-owner and chown by a non-root user give EPERM', async () => {
    const w = await boot();
    await w.carol.ok('writeFile', { path: '/home/carol/f', data: bytes('c') });
    const chmod = await w.alice.call('chmod', {
      path: '/home/carol/f',
      mode: { op: 'set', bits: 0o777 },
    });
    expect(chmod).toMatchObject({ ok: false, errno: 'EPERM', detail: { reason: 'owner' } });
    const chown = await w.carol.call('chown', { path: '/home/carol/f', uid: UID.alice });
    expect(chown).toMatchObject({ ok: false, errno: 'EPERM', detail: { reason: 'root-only' } });
    await w.root.ok('chown', { path: '/home/carol/f', uid: UID.alice });
    expect(stat(await w.carol.ok('stat', { path: '/home/carol/f' })).uid).toBe(UID.alice);
    await w.carol.ok('chmod', { path: '/home/carol', mode: { op: 'delta', add: 0, clear: 0o005 } });
    expect(stat(await w.carol.ok('stat', { path: '/home/carol' })).mode).toBe(0o750);
  });

  it('VFS-04 chmod rejects setuid and setgid bits with EINVAL', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('') });
    expect(
      await w.alice.errno('chmod', { path: '/home/alice/f', mode: { op: 'set', bits: 0o4755 } }),
    ).toBe('EINVAL');
  });

  it("VFS-04 sticky /tmp: bob cannot unlink or rename alice's file, root can", async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/tmp/a', data: bytes('a') });
    expect(await w.bob.call('unlink', { path: '/tmp/a' })).toMatchObject({
      ok: false,
      errno: 'EPERM',
      detail: { reason: 'sticky' },
    });
    expect(await w.bob.errno('rename', { from: '/tmp/a', to: '/tmp/b' })).toBe('EPERM');
    await w.alice.ok('rename', { from: '/tmp/a', to: '/tmp/b' });
    await w.root.ok('unlink', { path: '/tmp/b' });
    expect(await w.alice.errno('stat', { path: '/tmp/b' })).toBe('ENOENT');
  });

  it('VFS-04 rm -r needs r, w and x on every directory of the subtree and changes nothing otherwise', async () => {
    const w = await boot();
    await w.alice.ok('mkdir', { path: '/home/alice/t/a/b', parents: true });
    await w.alice.ok('writeFile', { path: '/home/alice/t/a/b/f', data: bytes('f') });
    await w.alice.ok('chmod', { path: '/home/alice/t/a', mode: { op: 'set', bits: 0o500 } });
    const before = snapshot(w.store);
    expect(await w.alice.errno('unlink', { path: '/home/alice/t', recursive: true })).toBe(
      'EACCES',
    );
    expect(snapshot(w.store)).toBe(before);
    expect(await w.alice.errno('stat', { path: '/home/alice/t/a/b/f' })).toBe('ok');
    await w.alice.ok('chmod', { path: '/home/alice/t/a', mode: { op: 'set', bits: 0o700 } });
    const r = await w.alice.ok<RetOf<'unlink'>>('unlink', {
      path: '/home/alice/t',
      recursive: true,
    });
    expect(r).toMatchObject({ removed: 4, bytes: 1, sync: 'pending' });
    expect(await w.alice.errno('stat', { path: '/home/alice/t' })).toBe('ENOENT');
  });

  it('VFS-04 moving a directory to a new parent needs w on the directory itself', async () => {
    const w = await boot();
    await w.alice.ok('mkdir', { path: '/home/alice/src/d', parents: true });
    await w.alice.ok('mkdir', { path: '/home/alice/dst' });
    await w.alice.ok('chmod', { path: '/home/alice/src/d', mode: { op: 'set', bits: 0o555 } });
    expect(
      await w.alice.errno('rename', { from: '/home/alice/src/d', to: '/home/alice/dst/d' }),
    ).toBe('EACCES');
    expect(
      await w.alice.errno('rename', { from: '/home/alice/src/d', to: '/home/alice/src/e' }),
    ).toBe('ok');
  });
});

describe('VFS-05 links', () => {
  it('VFS-05 ln -s stores the target verbatim and readlink returns it', async () => {
    const w = await boot();
    const target = '../weird//path/./x';
    await w.alice.ok('symlink', { target, path: '/home/alice/l' });
    expect(await w.alice.ok('readlink', { path: '/home/alice/l' })).toEqual({ target });
    expect(stat(await w.alice.ok('lstat', { path: '/home/alice/l' }))).toMatchObject({
      type: 'l',
      mode: 0o777,
      size: target.length,
      target,
    });
  });

  it('VFS-05 readlink on a regular file gives EINVAL not-a-link', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('') });
    expect(await w.alice.call('readlink', { path: '/home/alice/f' })).toMatchObject({
      ok: false,
      errno: 'EINVAL',
      detail: { reason: 'not-a-link' },
    });
  });

  it('VFS-05 a dangling link: stat gives ENOENT and lstat succeeds', async () => {
    const w = await boot();
    await w.alice.ok('symlink', { target: '/nowhere/at/all', path: '/home/alice/dangling' });
    expect(await w.alice.errno('stat', { path: '/home/alice/dangling' })).toBe('ENOENT');
    expect(stat(await w.alice.ok('lstat', { path: '/home/alice/dangling' })).type).toBe('l');
    expect(
      stat(await w.alice.ok('stat', { path: '/home/alice/dangling', follow: false })).type,
    ).toBe('l');
  });

  it('VFS-05 rm -r never follows symlinks into directories', async () => {
    const w = await boot();
    await w.alice.ok('mkdir', { path: '/home/alice/keep' });
    await w.alice.ok('writeFile', { path: '/home/alice/keep/file', data: bytes('keep me') });
    await w.alice.ok('mkdir', { path: '/home/alice/t' });
    await w.alice.ok('symlink', { target: '/home/alice/keep', path: '/home/alice/t/link' });
    await w.alice.ok('unlink', { path: '/home/alice/t', recursive: true });
    expect(stat(await w.alice.ok('stat', { path: '/home/alice/keep/file' })).size).toBe(7);
  });

  it('VFS-05 a hard link raises nlink to 2 and the inode survives the first unlink', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/a', data: bytes('data') });
    expect(
      await w.alice.ok('link', { existing: '/home/alice/a', path: '/home/alice/b' }),
    ).toMatchObject({ nlink: 2 });
    await w.alice.ok('unlink', { path: '/home/alice/a' });
    expect(stat(await w.alice.ok('stat', { path: '/home/alice/b' }))).toMatchObject({
      nlink: 1,
      size: 4,
    });
    expect(await w.alice.errno('link', { existing: '/home/alice/b', path: '/tmp/b' })).toBe(
      'EXDEV',
    );
    await w.alice.ok('mkdir', { path: '/home/alice/d' });
    expect(await w.alice.errno('link', { existing: '/home/alice/d', path: '/home/alice/d2' })).toBe(
      'EPERM',
    );
  });
});

describe('VFS-06 quotas', () => {
  it('VFS-06 cp -r over the inode quota fails with EDQUOT and creates nothing', async () => {
    const w = await boot({ quotaInodes: 10 });
    await w.alice.ok('mkdir', { path: '/home/alice/d' });
    for (let i = 0; i < 5; i++)
      await w.alice.ok('writeFile', { path: `/home/alice/d/f${String(i)}`, data: bytes('x') });
    const before = snapshot(w.store);
    expect(
      await w.alice.errno('copy', { from: '/home/alice/d', to: '/home/alice/d2', recursive: true }),
    ).toBe('EDQUOT');
    expect(snapshot(w.store)).toBe(before);
    expect(await w.alice.errno('stat', { path: '/home/alice/d2' })).toBe('ENOENT');
  });

  it('VFS-06 root is exempt from quota', async () => {
    const w = await boot({ quotaBytes: 10 });
    await w.root.ok('writeFile', { path: '/root/big', data: new ArrayBuffer(50_000) });
    expect(stat(await w.root.ok('stat', { path: '/root/big' })).size).toBe(50_000);
    expect(await w.root.ok('quota', {})).toMatchObject({
      uid: 0,
      quotaBytes: null,
      quotaInodes: null,
    });
  });

  it('VFS-06 chown to a user without headroom gives EDQUOT', async () => {
    const w = await boot({ quotaBytes: 1_000 });
    await w.root.ok('writeFile', { path: '/root/big', data: new ArrayBuffer(3_000) });
    expect(await w.root.errno('chown', { path: '/root/big', uid: UID.alice })).toBe('EDQUOT');
    expect(stat(await w.root.ok('stat', { path: '/root/big' })).uid).toBe(0);
  });

  it('VFS-06 QuotaExceededError from the store becomes EDQUOT with no partial data', async () => {
    const w = await boot();
    const before = snapshot(w.store);
    w.store.writeFault = (store) => (store === 'inodes' ? 'QuotaExceededError' : null);
    expect(await w.alice.errno('mkdir', { path: '/home/alice/x' })).toBe('EDQUOT');
    w.store.writeFault = null;
    expect(snapshot(w.store)).toBe(before);
    expect(await w.alice.errno('stat', { path: '/home/alice/x' })).toBe('ENOENT');
  });

  it('VFS-06 quota and statfs report usage; another uid needs root', async () => {
    const w = await boot({ quotaBytes: 5_000, quotaInodes: 50 });
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: new ArrayBuffer(1_234) });
    expect(await w.alice.ok('quota', {})).toEqual({
      uid: UID.alice,
      usedBytes: 1_234,
      quotaBytes: 5_000,
      usedInodes: 2,
      quotaInodes: 50,
      source: 'mirror',
    });
    expect(await w.bob.call('quota', { uid: UID.alice })).toMatchObject({
      ok: false,
      errno: 'EPERM',
      detail: { reason: 'root-only' },
    });
    expect(await w.root.ok('quota', { uid: UID.alice })).toMatchObject({ usedBytes: 1_234 });
    expect(await w.root.errno('quota', { uid: 4_242 })).toBe('EINVAL');
    const fsInfo = await w.alice.ok<{ fsId: string; inodes: number }>('statfs', {});
    expect(fsInfo.fsId).toBe('plotinium');
    expect(fsInfo.inodes).toBe(w.store.count('inodes'));
    expect(await w.alice.errno('statfs', { path: '/nope' })).toBe('ENOENT');
  });
});

describe('VFS-07 CRUD, bulk operations and batch', () => {
  it('VFS-07 CRUD through the syscall layer: create, read, rename, copy and delete', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/notes.txt', data: bytes('hello') });
    const { fd } = await w.alice.ok<{ fd: number }>('open', {
      path: '/home/alice/notes.txt',
      flags: 'r',
    });
    expect(text(await w.alice.ok<ArrayBuffer>('read', { fd, len: 100 }))).toBe('hello');
    await w.alice.ok('close', { fd });
    await w.alice.ok('rename', { from: '/home/alice/notes.txt', to: '/home/alice/n2.txt' });
    expect(
      await w.alice.ok('copy', { from: '/home/alice/n2.txt', to: '/home/alice/n3.txt' }),
    ).toMatchObject({
      copied: 1,
      bytes: 5,
    });
    await w.alice.ok('unlink', { path: '/home/alice/n2.txt' });
    const list = await w.alice.ok<RetOf<'readdir'>>('readdir', { path: '/home/alice' });
    expect(list.entries.map((e) => e.name)).toEqual(['n3.txt']);
    expect(stat(await w.alice.ok('stat', { path: '/home/alice/n3.txt' })).size).toBe(5);
  });

  it('VFS-07 mkdir -p creates every missing component in one op', async () => {
    const w = await boot();
    const ops = w.store.count('outbox');
    const r = await w.alice.ok<RetOf<'mkdir'>>('mkdir', {
      path: '/home/alice/a/b/c',
      parents: true,
    });
    expect(r.created).toBe(3);
    expect(w.store.count('outbox')).toBe(ops + 1);
    const again = await w.alice.ok<RetOf<'mkdir'>>('mkdir', {
      path: '/home/alice/a/b/c',
      parents: true,
    });
    expect(again).toMatchObject({ created: 0, sync: 'applied' });
    expect(await w.alice.errno('mkdir', { path: '/home/alice/a/b/c' })).toBe('EEXIST');
  });

  it('VFS-07 the rename matrix holds and a directory cannot move into its own subtree', async () => {
    const w = await boot();
    await w.alice.ok('mkdir', { path: '/home/alice/d/sub', parents: true });
    await w.alice.ok('mkdir', { path: '/home/alice/e' });
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('f') });
    await w.alice.ok('writeFile', { path: '/home/alice/g', data: bytes('g') });
    expect(
      await w.alice.errno('rename', { from: '/home/alice/d', to: '/home/alice/d/sub/x' }),
    ).toBe('EINVAL');
    expect(await w.alice.errno('rename', { from: '/home/alice/f', to: '/home/alice/e' })).toBe(
      'EISDIR',
    );
    expect(await w.alice.errno('rename', { from: '/home/alice/e', to: '/home/alice/f' })).toBe(
      'ENOTDIR',
    );
    expect(await w.alice.errno('rename', { from: '/home/alice/e', to: '/home/alice/d' })).toBe(
      'ENOTEMPTY',
    );
    expect(
      await w.alice.errno('rename', {
        from: '/home/alice/f',
        to: '/home/alice/g',
        noReplace: true,
      }),
    ).toBe('EEXIST');
    expect(
      await w.alice.ok('rename', { from: '/home/alice/f', to: '/home/alice/g' }),
    ).toMatchObject({
      replaced: expect.any(String) as unknown,
    });
    expect(await w.alice.errno('rename', { from: '/home/alice/g', to: '/tmp/g' })).toBe('EXDEV');
    // Stage 5 (w+x on /) refuses alice first; root reaches the well-known-directory rule.
    expect(await w.alice.errno('rename', { from: '/home', to: '/h' })).toBe('EACCES');
    expect(await w.root.errno('rename', { from: '/home', to: '/h' })).toBe('EBUSY');
  });

  it('VFS-07 recursive copy and rmdir follow the spec semantics', async () => {
    const w = await boot();
    await w.alice.ok('mkdir', { path: '/home/alice/src/in', parents: true });
    await w.alice.ok('writeFile', { path: '/home/alice/src/in/a', data: bytes('aa') });
    await w.alice.ok('writeFile', { path: '/home/alice/src/b', data: bytes('bbb') });
    expect(await w.alice.errno('copy', { from: '/home/alice/src', to: '/home/alice/dst' })).toBe(
      'EISDIR',
    );
    expect(
      await w.alice.ok('copy', { from: '/home/alice/src', to: '/home/alice/dst', recursive: true }),
    ).toMatchObject({ copied: 4, bytes: 5 });
    expect(stat(await w.alice.ok('stat', { path: '/home/alice/dst/in/a' })).size).toBe(2);
    expect(
      await w.alice.errno('copy', {
        from: '/home/alice/src/b',
        to: '/home/alice/dst/b',
        noReplace: true,
      }),
    ).toBe('EEXIST');
    expect(await w.alice.errno('rmdir', { path: '/home/alice/dst' })).toBe('ENOTEMPTY');
    expect(await w.alice.errno('rmdir', { path: '/home/alice/src/b' })).toBe('ENOTDIR');
    expect(await w.alice.errno('unlink', { path: '/home/alice/src' })).toBe('EISDIR');
    await w.alice.ok('unlink', { path: '/home/alice/dst/in/a' });
    await w.alice.ok('rmdir', { path: '/home/alice/dst/in' });
    expect(await w.alice.errno('stat', { path: '/home/alice/dst/in' })).toBe('ENOENT');
  });

  it('VFS-07 batch applies its ops as one transaction and a failing op changes nothing', async () => {
    const w = await boot();
    const ops = w.store.count('outbox');
    const ok = await w.alice.ok<{ applied: number; txnId: string }>('batch', {
      txnId: '01920000-0000-7000-8000-00000000b001',
      ops: [
        { op: 'mkdir', path: '/home/alice/proj' },
        { op: 'write', path: '/home/alice/proj/a.txt', text: 'draft' },
        { op: 'rename', from: '/home/alice/proj/a.txt', to: '/home/alice/proj/final.txt' },
      ],
      expectedVersions: [],
    });
    expect(ok).toMatchObject({ applied: 3, txnId: '01920000-0000-7000-8000-00000000b001' });
    expect(w.store.count('outbox')).toBe(ops + 1);
    expect(stat(await w.alice.ok('stat', { path: '/home/alice/proj/final.txt' })).size).toBe(5);
    const before = snapshot(w.store);
    const bad = await w.alice.call('batch', {
      txnId: '01920000-0000-7000-8000-00000000b002',
      ops: [
        { op: 'mkdir', path: '/home/alice/other' },
        { op: 'unlink', path: '/home/alice/missing' },
      ],
      expectedVersions: [],
    });
    expect(bad).toMatchObject({ ok: false, errno: 'ENOENT', detail: { step: 1 } });
    expect(snapshot(w.store)).toBe(before);
    expect(await w.alice.errno('stat', { path: '/home/alice/other' })).toBe('ENOENT');
  });

  it('VFS-07 a stale batch fingerprint gives EAGAIN stale-plan and changes nothing', async () => {
    const w = await boot();
    await w.alice.ok('writeFile', { path: '/home/alice/f', data: bytes('1') });
    const s = stat(await w.alice.ok('stat', { path: '/home/alice/f' }));
    const res = await w.alice.call('batch', {
      txnId: '01920000-0000-7000-8000-00000000b003',
      ops: [{ op: 'unlink', path: '/home/alice/f' }],
      expectedVersions: [{ ino: s.ino, version: s.version + 7 }],
    });
    expect(res).toMatchObject({ ok: false, errno: 'EAGAIN', detail: { reason: 'stale-plan' } });
    expect(await w.alice.errno('stat', { path: '/home/alice/f' })).toBe('ok');
  });

  it('VFS-07 an injected fault in rm -r rolls back and the tree and store are unchanged (DB-02)', async () => {
    const w = await boot();
    await w.alice.ok('mkdir', { path: '/home/alice/old' });
    for (let i = 0; i < 4; i++)
      await w.alice.ok('writeFile', { path: `/home/alice/old/f${String(i)}`, data: bytes('x') });
    const before = snapshot(w.store);
    w.fs.faults.armFor('unlink', 3, w.fs.now());
    expect(
      await w.alice.call('unlink', { path: '/home/alice/old', recursive: true }),
    ).toMatchObject({
      ok: false,
      errno: 'EIO',
      detail: { reason: 'injected' },
    });
    expect(snapshot(w.store)).toBe(before);
    const list = await w.alice.ok<RetOf<'readdir'>>('readdir', { path: '/home/alice/old' });
    expect(list.entries).toHaveLength(4);
    expect(
      (await w.alice.ok<RetOf<'unlink'>>('unlink', { path: '/home/alice/old', recursive: true }))
        .removed,
    ).toBe(5);
  });
});

describe('VFS-08 limits', () => {
  it('VFS-08 a 255-byte name works and a 256-byte name gives ENAMETOOLONG', async () => {
    const w = await boot();
    await w.alice.ok('mkdir', { path: `/home/alice/${'n'.repeat(255)}` });
    expect(await w.alice.errno('mkdir', { path: `/home/alice/${'n'.repeat(256)}` })).toBe(
      'ENAMETOOLONG',
    );
    expect(await w.alice.errno('stat', { path: `/home/alice/${'n'.repeat(256)}/x` })).toBe(
      'ENAMETOOLONG',
    );
  });

  it('VFS-08 multibyte names are measured in UTF-8 bytes after NFC', async () => {
    const w = await boot();
    const nfd = 'é'.repeat(127); // 254 UTF-16 units; NFC: 127 × "é" = 254 bytes
    await w.alice.ok('writeFile', { path: `/home/alice/${nfd}`, data: bytes('') });
    const nfc = 'é'.repeat(127);
    expect(stat(await w.alice.ok('stat', { path: `/home/alice/${nfc}` })).type).toBe('f');
    expect(await w.alice.errno('mkdir', { path: `/home/alice/${'é'.repeat(128)}` })).toBe(
      'ENAMETOOLONG',
    );
  });

  it('VFS-08 a 4096-byte path works and a 4097-byte path gives ENAMETOOLONG', async () => {
    const w = await boot();
    const p4096 = `/home/alice${'/'.repeat(4096 - '/home/alice'.length)}`;
    expect(new TextEncoder().encode(p4096).length).toBe(4096);
    expect(stat(await w.alice.ok('stat', { path: p4096 })).type).toBe('d');
    expect(await w.alice.errno('stat', { path: `${p4096}/` })).toBe('ENAMETOOLONG');
    expect(
      await w.alice.errno('symlink', { target: 'x'.repeat(4097), path: '/home/alice/l' }),
    ).toBe('ENAMETOOLONG');
  });

  it('VFS-08 32 levels of nesting can be created, listed and removed', async () => {
    const w = await boot();
    const levels = Array.from({ length: 32 }, (_, i) => `l${String(i)}`);
    const deep = `/home/alice/${levels.join('/')}`;
    expect((await w.alice.ok<RetOf<'mkdir'>>('mkdir', { path: deep, parents: true })).created).toBe(
      32,
    );
    for (let i = 1; i <= 32; i++) {
      const p = `/home/alice/${levels.slice(0, i).join('/')}`;
      const list = await w.alice.ok<RetOf<'readdir'>>('readdir', { path: p });
      expect(list.entries.length).toBe(i === 32 ? 0 : 1);
    }
    expect(
      (await w.alice.ok<RetOf<'unlink'>>('unlink', { path: '/home/alice/l0', recursive: true }))
        .removed,
    ).toBe(32);
    const home = w.fs.tree.inode(w.fs.tree.user(UID.alice)?.homeIno ?? '') as InodeRec;
    expect(home.nlink).toBe(2);
  });
});
