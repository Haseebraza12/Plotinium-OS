import * as protocol from '@plotinium/protocol';
import { INO } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { contentOfText } from '../src/content.ts';
import { planMkdir, planSymlink } from '../src/ops/create.ts';
import { planRemoveTree, planRmdir } from '../src/ops/unlink.ts';
import { forRemove } from '../src/ops/common.ts';
import { planWriteFile } from '../src/ops/write.ts';
import {
  NAME_MAX,
  PATH_MAX,
  SYMLOOP_MAX,
  basename,
  dirname,
  joinPath,
  normalizeLexical,
  resolve,
  resolveAsync,
  splitPath,
  utf8Length,
  validateName,
  validatePath,
  validateSymlinkTarget,
} from '../src/path.ts';
import type { ResolveOpts, Resolution } from '../src/path.ts';
import type { Cred } from '../src/perm.ts';
import type { InodeRec, Uuid } from '../src/store/records.ts';
import { cwdNode, viewSource } from '../src/view.ts';
import { ALICE, BOB, HOME, ROOT, World, errnoOf, ok } from './doubles/world.ts';

function build(): World {
  const w = new World();
  ok(w.run(ROOT, 'create', (b) => planMkdir(b, '/a/b', undefined, true)));
  ok(w.run(ROOT, 'write', (b) => planWriteFile(b, '/a/b/c', contentOfText('c', 0))));
  ok(w.run(ROOT, 'write', (b) => planWriteFile(b, '/a/f', contentOfText('f', 0))));
  ok(w.run(ROOT, 'create', (b) => planSymlink(b, 'a/b', '/lnk')));
  ok(w.run(ROOT, 'create', (b) => planSymlink(b, 'c', '/a/b/rel')));
  ok(w.run(ROOT, 'create', (b) => planSymlink(b, '/nowhere', '/dangling')));
  return w;
}

function res(
  w: World,
  cred: Cred,
  path: string,
  opts: ResolveOpts,
  cwd: Uuid = INO.ROOT,
): Resolution<InodeRec> {
  return resolve(viewSource(w.tree), cred, cwdNode(w.tree, cwd), path, opts);
}

function pathOf(r: Resolution<InodeRec>): string {
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.path;
}

function errOf(r: Resolution<InodeRec>): string {
  return r.kind === 'err' ? r.errno : r.kind;
}

function inoAt(w: World, path: string): Uuid {
  const r = res(w, ROOT, path, { follow: false });
  if (r.kind !== 'ok' || r.node === null) throw new Error(`no ${path}`);
  return r.node.ino;
}

describe('path resolution (VFS-03)', () => {
  const w = build();
  const follow = { follow: true } as const;

  it('VFS-03 absolute and relative paths resolve from / and from the cwd', () => {
    expect(pathOf(res(w, ROOT, '/a/b/c', follow))).toBe('/a/b/c');
    expect(pathOf(res(w, ROOT, 'b/c', follow, inoAt(w, '/a')))).toBe('/a/b/c');
    expect(pathOf(res(w, ROOT, 'c', follow, inoAt(w, '/a/b')))).toBe('/a/b/c');
  });

  it('VFS-03 . stays, .. moves to the parent, and .. at / stays at /', () => {
    expect(pathOf(res(w, ROOT, '/a/./b/../f', follow))).toBe('/a/f');
    expect(pathOf(res(w, ROOT, '/../../a', follow))).toBe('/a');
    expect(pathOf(res(w, ROOT, '..', follow))).toBe('/');
    expect(pathOf(res(w, ROOT, 'a/./b/../f', follow))).toBe('/a/f');
  });

  it('VFS-03 //a///b// equals /a/b for a directory b', () => {
    const r1 = res(w, ROOT, '//a///b//', follow);
    const r2 = res(w, ROOT, '/a/b', follow);
    expect(r1.kind === 'ok' && r2.kind === 'ok' && r1.node?.ino === r2.node?.ino).toBe(true);
    expect(pathOf(r1)).toBe('/a/b');
  });

  it('VFS-03 a trailing slash on a regular file gives ENOTDIR', () => {
    expect(errOf(res(w, ROOT, '/a/f/', follow))).toBe('ENOTDIR');
    expect(errOf(res(w, ROOT, '/a/f/', { follow: false, parent: 'remove' }))).toBe('ENOTDIR');
    expect(pathOf(res(w, ROOT, '/lnk/', { follow: false }))).toBe('/a/b');
  });

  it('VFS-03 a missing component gives ENOENT and a file used as a directory gives ENOTDIR', () => {
    expect(errOf(res(w, ROOT, '/a/zz/c', follow))).toBe('ENOENT');
    expect(errOf(res(w, ROOT, '/a/f/x', follow))).toBe('ENOTDIR');
    expect(errOf(res(w, ROOT, '', follow))).toBe('ENOENT');
  });

  it('VFS-03 search permission is required on every directory including the cwd', () => {
    expect(errOf(res(w, BOB, `/home/alice/x`, follow))).toBe('EACCES');
    expect(errOf(res(w, BOB, 'x', follow, HOME.alice))).toBe('EACCES');
    expect(errOf(res(w, BOB, '.', follow, HOME.alice))).toBe('EACCES');
    expect(pathOf(res(w, ALICE, '.', follow, HOME.alice))).toBe('/home/alice');
  });

  it("VFS-03 relative symlink targets resolve against the link's own directory", () => {
    const r = res(w, ROOT, '/a/b/rel', follow);
    expect(pathOf(r)).toBe('/a/b/c');
    expect(pathOf(res(w, ROOT, '/lnk/c', follow))).toBe('/a/b/c');
  });

  it('VFS-03 .. after a symlink to a directory is physical', () => {
    expect(pathOf(res(w, ROOT, '/lnk/..', follow))).toBe('/a');
  });

  it('VFS-03 a chain of 40 symlinks resolves and a chain of 41 gives ELOOP', () => {
    const x = build();
    for (let i = 1; i <= SYMLOOP_MAX + 1; i++) {
      const target = i === 1 ? '/a/f' : `/l${i - 1}`;
      ok(x.run(ROOT, 'create', (b) => planSymlink(b, target, `/l${i}`)));
    }
    expect(pathOf(res(x, ROOT, `/l${SYMLOOP_MAX}`, follow))).toBe('/a/f');
    expect(errOf(res(x, ROOT, `/l${SYMLOOP_MAX + 1}`, follow))).toBe('ELOOP');
  });

  it('VFS-03 ln -s a b; ln -s b a; resolving a gives ELOOP', () => {
    const x = build();
    ok(x.run(ROOT, 'create', (b) => planSymlink(b, 'b', '/la')));
    ok(x.run(ROOT, 'create', (b) => planSymlink(b, 'la', '/b')));
    expect(errOf(res(x, ROOT, '/la', follow))).toBe('ELOOP');
    expect(res(x, ROOT, '/la', { follow: false }).kind).toBe('ok');
  });

  it('VFS-03 lstat, unlink and readlink stop one step early', () => {
    const early = res(w, ROOT, '/lnk', { follow: false });
    expect(early.kind === 'ok' && early.node?.type).toBe('l');
    const parent = res(w, ROOT, '/lnk', { follow: false, parent: 'remove' });
    expect(
      parent.kind === 'ok' &&
        parent.name === 'lnk' &&
        parent.parent?.ino === INO.ROOT &&
        parent.node?.type === 'l',
    ).toBe(true);
    const created = res(w, ROOT, '/a/new', { follow: false, parent: 'create' });
    expect(created.kind === 'ok' && created.node === null && created.name === 'new').toBe(true);
  });

  it("VFS-03 create and remove of '.', '..' and '/' give EEXIST, EINVAL and EBUSY", () => {
    expect(errOf(res(w, ROOT, '/', { follow: false, parent: 'create' }))).toBe('EEXIST');
    expect(errOf(res(w, ROOT, '/a/.', { follow: false, parent: 'create' }))).toBe('EEXIST');
    expect(errOf(res(w, ROOT, '/a/..', { follow: false, parent: 'remove' }))).toBe('EINVAL');
    expect(errOf(res(w, ROOT, '/', { follow: false, parent: 'remove' }))).toBe('EBUSY');
  });

  it('VFS-03 a removed cwd gives ENOENT for relative paths', () => {
    const x = build();
    const dir = inoAt(x, '/a/b');
    ok(x.run(ROOT, 'unlink', (b) => planRemoveTree(b, forRemove(b, '/a/b'))));
    expect(errOf(res(x, ROOT, 'c', follow, dir))).toBe('ENOENT');
    expect(pathOf(res(x, ROOT, '/a', follow, dir))).toBe('/a');
  });

  it('VFS-03 an unloaded directory asks to be loaded and resolveAsync loads it', async () => {
    const x = build();
    const a = inoAt(x, '/a');
    const saved = x.tree.entries(a);
    x.tree.unload(a);
    const r = res(x, ROOT, '/a/f', follow);
    expect(r.kind === 'load' && r.dir.ino === a).toBe(true);
    let loads = 0;
    const done = await resolveAsync(
      viewSource(x.tree),
      ROOT,
      cwdNode(x.tree, INO.ROOT),
      '/a/f',
      follow,
      (dir) => {
        loads++;
        const ents = typeof saved === 'string' ? [] : saved;
        x.tree.load(
          dir.ino,
          ents,
          ents.map((e) => x.tree.inode(e.ino)),
        );
        return Promise.resolve();
      },
    );
    expect(loads).toBe(1);
    expect(pathOf(done)).toBe('/a/f');
    x.tree.unload(a);
    const never = await resolveAsync(
      viewSource(x.tree),
      ROOT,
      cwdNode(x.tree, INO.ROOT),
      '/a/f',
      follow,
      () => Promise.resolve(),
      1,
    );
    expect(errOf(never)).toBe('EIO');
  });

  it('PVFS-18 an unmirrored directory answers EAGAIN offline, never ENOENT', () => {
    const x = build();
    const a = x.tree.inode(inoAt(x, '/a'));
    if (a === undefined) throw new Error('no /a');
    x.tree.apply([{ store: 'inodes', op: 'put', value: { ...a, mir: 0 } }]);
    x.tree.online = false;
    expect(errOf(res(x, ROOT, '/a/missing', follow))).toBe('EAGAIN');
    expect(pathOf(res(x, ROOT, '/a/f', follow))).toBe('/a/f');
    expect(errOf(res(x, ROOT, '/a/missing', { follow: false, parent: 'create' }))).toBe('EAGAIN');
    x.tree.online = true;
    expect(errOf(res(x, ROOT, '/a/missing', follow))).toBe('ENOENT');
  });
});

describe('names and limits (VFS-08, PVFS-12)', () => {
  it('VFS-08 path limits mirror the protocol constants', () => {
    expect(NAME_MAX).toBe(protocol.NAME_MAX);
    expect(PATH_MAX).toBe(protocol.PATH_MAX);
    expect(SYMLOOP_MAX).toBe(protocol.SYMLOOP_MAX);
  });

  it('VFS-08 a 255-byte name works and a 256-byte name gives ENAMETOOLONG', () => {
    const w = new World();
    const n255 = 'x'.repeat(255);
    ok(w.run(ROOT, 'create', (b) => planMkdir(b, `/tmp/${n255}`)));
    expect(errnoOf(w.run(ROOT, 'create', (b) => planMkdir(b, `/tmp/${'x'.repeat(256)}`)))).toBe(
      'ENAMETOOLONG',
    );
    expect(errOf(res(w, ROOT, `/tmp/${'y'.repeat(256)}`, { follow: true }))).toBe('ENAMETOOLONG');
    expect(validateName(n255).ok).toBe(true);
  });

  it('VFS-08 multibyte names are measured in UTF-8 bytes after NFC', () => {
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('😀')).toBe(4);
    expect(utf8Length('語')).toBe(3);
    // 85 × 3 bytes = 255 fits; one more code point does not.
    expect(validateName('語'.repeat(85)).ok).toBe(true);
    expect(validateName('語'.repeat(86))).toEqual({ ok: false, errno: 'ENAMETOOLONG' });
    // NFD "e + combining acute" becomes one NFC code point of 2 bytes.
    const v = validateName('é');
    expect(v.ok && v.value).toBe('é');
    expect(validateName('\ud800').ok).toBe(false);
    expect(validateName('a/b')).toEqual({ ok: false, errno: 'EINVAL' });
    expect(validateName('..')).toEqual({ ok: false, errno: 'EINVAL' });
  });

  it('VFS-08 a 4096-byte path works and a 4097-byte path gives ENAMETOOLONG', () => {
    const comps = Array.from({ length: 16 }, () => 'z'.repeat(255));
    const p4096 = `/${comps.join('/')}`.padEnd(PATH_MAX, 'q');
    expect(utf8Length(p4096)).toBe(PATH_MAX);
    expect(validatePath(p4096).ok).toBe(true);
    expect(validatePath(`${p4096}q`)).toEqual({ ok: false, errno: 'ENAMETOOLONG' });
    expect(validatePath('a\u0000b')).toEqual({ ok: false, errno: 'EINVAL' });
    const w = new World();
    expect(errOf(res(w, ROOT, `${p4096}q`, { follow: true }))).toBe('ENAMETOOLONG');
  });

  it('VFS-08 a symlink target over 4096 bytes gives ENAMETOOLONG', () => {
    const w = new World();
    expect(errnoOf(w.run(ROOT, 'create', (b) => planSymlink(b, 'x'.repeat(4097), '/tmp/l')))).toBe(
      'ENAMETOOLONG',
    );
    expect(errnoOf(w.run(ROOT, 'create', (b) => planSymlink(b, '', '/tmp/l')))).toBe('ENOENT');
    expect(validateSymlinkTarget('x'.repeat(4096)).ok).toBe(true);
    expect(validateSymlinkTarget('a\u0000').ok).toBe(false);
    ok(w.run(ROOT, 'create', (b) => planSymlink(b, `${'x'.repeat(300)}/y`, '/tmp/long')));
    expect(errOf(res(w, ROOT, '/tmp/long', { follow: true }))).toBe('ENAMETOOLONG');
  });

  it('VFS-08 32 levels of nesting can be created, resolved and removed', () => {
    const w = new World();
    const deep = `/home/alice/${Array.from({ length: 32 }, (_, i) => `d${i}`).join('/')}`;
    const made = ok(w.run(ALICE, 'create', (b) => planMkdir(b, deep, undefined, true)));
    expect(made.created).toBe(32);
    expect(pathOf(res(w, ALICE, deep, { follow: true }))).toBe(deep);
    ok(w.run(ALICE, 'unlink', (b) => planRmdir(b, deep)));
    expect(errOf(res(w, ALICE, deep, { follow: true }))).toBe('ENOENT');
    ok(w.run(ALICE, 'unlink', (b) => planRemoveTree(b, forRemove(b, '/home/alice/d0'))));
    expect(errOf(res(w, ALICE, '/home/alice/d0', { follow: true }))).toBe('ENOENT');
  });

  it('PVFS-12 NFD input finds the NFC entry', () => {
    const w = new World();
    ok(w.run(ROOT, 'create', (b) => planMkdir(b, '/tmp/café')));
    expect(pathOf(res(w, ROOT, '/tmp/café', { follow: true }))).toBe('/tmp/café');
  });

  it('VFS-03 lexical helpers split, join and normalise like the resolver', () => {
    expect(splitPath('//a///b//')).toEqual(['a', 'b']);
    expect(normalizeLexical('/a/./b/../c')).toBe('/a/c');
    expect(normalizeLexical('/..')).toBe('/');
    expect(dirname('/a/b')).toBe('/a');
    expect(dirname('/a')).toBe('/');
    expect(basename('/a/b/')).toBe('b');
    expect(basename('/')).toBe('');
    expect(joinPath('/', 'x')).toBe('/x');
    expect(joinPath('/a', 'x')).toBe('/a/x');
  });
});
