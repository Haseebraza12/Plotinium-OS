import { describe, expect, it } from 'vitest';

import { deriveIno } from '@plotinium/protocol';
import type { Cred } from '@plotinium/vfs/perm';

import type { VfsError } from '../types.ts';
import {
  compareCodePoints,
  planCopyActions,
  type CopyEntry,
  type CopyInput,
  type CopyNode,
} from './copy.ts';

const OP = '0192f2a0-0000-7000-8000-00000000c0f1';
const ALICE: Cred = { uid: 1001, gid: 100, groups: [100] };
const ROOT: Cred = { uid: 0, gid: 0, groups: [0] };
const id = (n: number): string => `0192f2a0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

/** A tiny tree: node rows plus directory entries. */
class Tree {
  readonly nodes = new Map<string, CopyNode>();
  readonly entries = new Map<string, CopyEntry[]>();

  add(
    ino: string,
    type: 'f' | 'd' | 'l',
    over: Partial<CopyNode> = {},
    parent?: string,
    name?: string,
  ): string {
    this.nodes.set(ino, {
      ino,
      type,
      mode: type === 'd' ? 0o755 : type === 'l' ? 0o777 : 0o644,
      uid: 1001,
      gid: 100,
      version: 3,
      size: type === 'f' ? 10 : type === 'l' ? 4 : 0,
      nlink: type === 'd' ? 2 : 1,
      blobId: type === 'f' ? 7 : null,
      symlinkTarget: type === 'l' ? 'else' : null,
      mtimeMs: 1_000,
      ...over,
    });
    if (parent !== undefined && name !== undefined) this.link(parent, name, ino);
    return ino;
  }

  link(parent: string, name: string, ino: string): void {
    const list = this.entries.get(parent) ?? [];
    list.push({ name, ino });
    this.entries.set(parent, list);
  }

  input(over: Partial<CopyInput> & Pick<CopyInput, 'op'>, source: string): CopyInput {
    const inSource = new Set<string>();
    const walk = (ino: string): void => {
      if (inSource.has(ino)) return;
      inSource.add(ino);
      for (const e of this.entries.get(ino) ?? []) walk(e.ino);
    };
    walk(source);
    return {
      opId: OP,
      cred: ALICE,
      node: (ino) => this.nodes.get(ino),
      children: (dir) => this.entries.get(dir) ?? [],
      inSource: (ino) => inSource.has(ino),
      ...over,
    };
  }
}

function errnoOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as VfsError).errno;
  }
  return 'ok';
}

/** / (root 0755) with /home/alice (alice 0755) holding `src` and an empty `dst` directory. */
function world() {
  const t = new Tree();
  const home = t.add(id(1), 'd', { uid: 1001 });
  const src = t.add(id(10), 'd', {}, home, 'src');
  const dst = t.add(id(20), 'd', {}, home, 'dst');
  return { t, home, src, dst };
}

describe('VFS-10 cp -r on the server mirrors the client planner (virtual-file-system.md §3.12.3)', () => {
  it('VFS-10 new inodes are deriveIno(opId, srcIno) in pre-order and code-point order; a second name of one inode chains from the first id', () => {
    const { t, src, dst } = world();
    const b = t.add(id(11), 'f', {}, src, 'b.txt');
    const sub = t.add(id(12), 'd', {}, src, 'Z');
    t.add(id(13), 'f', {}, sub, 'deep.md');
    t.link(src, 'a-link', b); // a hard link: two names for b.txt, 'Z' < 'a-link' < 'b.txt'
    const a = planCopyActions(
      t.input({ op: { srcIno: src, toParentIno: dst, toName: 'copy', recursive: true } }, src),
    );
    const top = deriveIno(OP, src);
    const z = deriveIno(OP, sub);
    const first = deriveIno(OP, b);
    expect(a.creates.map((n) => [n.name, n.ino, n.parentIno])).toEqual([
      ['copy', top, dst],
      ['Z', z, top],
      ['deep.md', deriveIno(OP, id(13)), z],
      ['a-link', first, top],
      ['b.txt', deriveIno(OP, first), top],
    ]);
    // Directory nlink: 2 + the directories created inside; the destination gains one link.
    expect(a.creates.find((n) => n.ino === top)?.nlink).toBe(3);
    expect(a.creates.find((n) => n.ino === z)?.nlink).toBe(2);
    expect([...a.dirDeltas]).toEqual([[dst, 1]]);
    expect(a.overwrites).toEqual([]);
    expect(a.replaces).toEqual([]);
  });

  it('VFS-10 modes drop setuid/setgid/sticky and apply the default umask; symlinks are 0777; content and targets are shared', () => {
    const { t, home, dst } = world();
    const f = t.add(id(30), 'f', { mode: 0o4777, blobId: 42, size: 99 }, home, 'tool');
    const l = t.add(id(31), 'l', { symlinkTarget: '/etc/motd', size: 9 }, home, 'motd');
    const one = planCopyActions(
      t.input({ op: { srcIno: f, toParentIno: dst, toName: 'tool', recursive: false } }, f),
    );
    expect(one.creates[0]).toMatchObject({
      mode: 0o755,
      uid: 1001,
      gid: 100,
      size: 99,
      blobId: 42,
      mtimeMs: null,
    });
    const two = planCopyActions(
      t.input({ op: { srcIno: l, toParentIno: dst, toName: 'motd', recursive: false } }, l),
    );
    expect(two.creates[0]).toMatchObject({
      mode: 0o777,
      symlinkTarget: '/etc/motd',
      blobId: null,
      size: 9,
    });
  });

  it('VFS-10 preserve keeps mode and mtime; only root keeps the source owner', () => {
    const { t, home, dst } = world();
    const f = t.add(id(30), 'f', { mode: 0o640, uid: 1002, gid: 200, mtimeMs: 5_000 }, home, 'x');
    const byRoot = planCopyActions(
      t.input(
        {
          cred: ROOT,
          op: { srcIno: f, toParentIno: dst, toName: 'x', recursive: false, preserve: true },
        },
        f,
      ),
    );
    expect(byRoot.creates[0]).toMatchObject({ mode: 0o640, uid: 1002, gid: 200, mtimeMs: 5_000 });
    t.nodes.set(f, { ...(t.nodes.get(f) as CopyNode), mode: 0o644 });
    const byAlice = planCopyActions(
      t.input(
        { op: { srcIno: f, toParentIno: dst, toName: 'x', recursive: false, preserve: true } },
        f,
      ),
    );
    expect(byAlice.creates[0]).toMatchObject({ uid: 1001, gid: 100, mtimeMs: 5_000 });
  });

  it('VFS-10 a directory merges into an existing directory, a file overwrites a file in place, a symlink replaces the entry', () => {
    const { t, src, dst } = world();
    t.add(id(11), 'f', { blobId: 5, size: 50 }, src, 'same.txt');
    t.add(id(12), 'f', {}, src, 'new.txt');
    t.add(id(13), 'l', {}, src, 'link');
    const target = t.add(id(40), 'd', {}, dst, 'src');
    const old = t.add(id(41), 'f', { blobId: 6, size: 60, uid: 1001 }, target, 'same.txt');
    const oldLink = t.add(id(42), 'f', {}, target, 'link');
    const a = planCopyActions(
      t.input({ op: { srcIno: src, toParentIno: dst, toName: 'src', recursive: true } }, src),
    );
    expect(a.creates.map((n) => [n.name, n.parentIno])).toEqual([
      ['link', target],
      ['new.txt', target],
    ]);
    expect(a.overwrites).toEqual([
      {
        ino: old,
        parentIno: target,
        name: 'same.txt',
        uid: 1001,
        oldSize: 60,
        oldBlobId: 6,
        size: 50,
        blobId: 5,
      },
    ]);
    expect(a.replaces.map((r) => [r.name, r.node.ino])).toEqual([['link', oldLink]]);
    expect([...a.dirDeltas]).toEqual([[target, 0]]);
  });

  it('VFS-10 the whole op fails with the client errno: into itself EINVAL, directory without -r EISDIR, file onto directory EISDIR, directory onto file ENOTDIR', () => {
    const { t, src, dst } = world();
    const inner = t.add(id(11), 'd', {}, src, 'inner');
    const f = t.add(id(12), 'f', {}, src, 'f');
    t.add(id(50), 'f', {}, dst, 'taken');
    t.add(id(51), 'd', {}, dst, 'adir');
    const run = (op: CopyInput['op'], source = src) =>
      errnoOf(() => planCopyActions(t.input({ op }, source)));
    expect(run({ srcIno: src, toParentIno: inner, toName: 'x', recursive: true })).toBe('EINVAL');
    expect(run({ srcIno: src, toParentIno: src, toName: 'x', recursive: true })).toBe('EINVAL');
    expect(run({ srcIno: src, toParentIno: dst, toName: 'x', recursive: false })).toBe('EISDIR');
    expect(run({ srcIno: f, toParentIno: dst, toName: 'adir', recursive: false }, f)).toBe(
      'EISDIR',
    );
    expect(run({ srcIno: src, toParentIno: dst, toName: 'taken', recursive: true })).toBe(
      'ENOTDIR',
    );
    expect(run({ srcIno: f, toParentIno: f, toName: 'x', recursive: false }, f)).toBe('ENOTDIR');
    expect(run({ srcIno: id(999), toParentIno: dst, toName: 'x', recursive: false })).toBe(
      'ENOENT',
    );
  });

  it('VFS-10 permissions: r+x on source directories, r on source files, w+x where names are created (a read-only copied directory blocks its own children)', () => {
    const { t, src, dst } = world();
    const secret = t.add(id(11), 'f', { mode: 0o600, uid: 1002 }, src, 'secret');
    const run = (op: CopyInput['op'], source = src) =>
      errnoOf(() => planCopyActions(t.input({ op }, source)));
    expect(run({ srcIno: src, toParentIno: dst, toName: 'c', recursive: true })).toBe('EACCES');
    t.nodes.set(secret, { ...(t.nodes.get(secret) as CopyNode), mode: 0o644 });
    expect(run({ srcIno: src, toParentIno: dst, toName: 'c', recursive: true })).toBe('ok');
    t.nodes.set(dst, { ...(t.nodes.get(dst) as CopyNode), uid: 1002 }); // not alice's any more
    expect(run({ srcIno: src, toParentIno: dst, toName: 'c', recursive: true })).toBe('EACCES');
    t.nodes.set(dst, { ...(t.nodes.get(dst) as CopyNode), uid: 1001 });
    t.nodes.set(src, { ...(t.nodes.get(src) as CopyNode), mode: 0o555 });
    expect(run({ srcIno: src, toParentIno: dst, toName: 'c', recursive: true })).toBe('EACCES');
  });

  it('VFS-10 an overwrite needs w on the target, a replacement the remove right, and the node cap is EINVAL too-large', () => {
    const { t, home, src, dst } = world();
    const f = t.add(id(11), 'f', {}, home, 'f');
    t.add(id(60), 'f', { uid: 1002, mode: 0o644 }, dst, 'f');
    expect(
      errnoOf(() =>
        planCopyActions(
          t.input({ op: { srcIno: f, toParentIno: dst, toName: 'f', recursive: false } }, f),
        ),
      ),
    ).toBe('EACCES');
    for (let i = 0; i < 5; i++) t.add(id(100 + i), 'f', {}, src, `n${i}`);
    expect(
      errnoOf(() =>
        planCopyActions(
          t.input(
            { maxNodes: 3, op: { srcIno: src, toParentIno: dst, toName: 'big', recursive: true } },
            src,
          ),
        ),
      ),
    ).toBe('EINVAL');
  });

  it('VFS-10 compareCodePoints orders by code point, not UTF-16 unit', () => {
    const names = ['b', 'a', '\u{1F600}', '￿', 'B'];
    expect([...names].sort(compareCodePoints)).toEqual(['B', 'a', 'b', '￿', '\u{1F600}']);
    expect(compareCodePoints('ab', 'a')).toBeGreaterThan(0);
    expect(compareCodePoints('a', 'a')).toBe(0);
  });
});
