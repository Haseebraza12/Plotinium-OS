import { describe, expect, it } from 'vitest';

import { contentOfText } from '../src/content.ts';
import { planChmod, planChown } from '../src/ops/attr.ts';
import { forRemove } from '../src/ops/common.ts';
import { planMkdir } from '../src/ops/create.ts';
import { planRename } from '../src/ops/rename.ts';
import { planRemoveTree, planUnlink } from '../src/ops/unlink.ts';
import { planWriteFile } from '../src/ops/write.ts';
import { access, statPath } from '../src/ops/read.ts';
import {
  R,
  W,
  X,
  applyModeSpec,
  checkChmod,
  checkChown,
  checkCopySource,
  checkCreate,
  checkLink,
  checkOpen,
  checkReaddir,
  checkRemove,
  checkRename,
  checkSubtreeDir,
  checkUtimes,
  createMode,
  evaluateMode,
  formatMode,
  fromModeChange,
  may,
  parseModeSpec,
  toWireMode,
} from '../src/perm.ts';
import type { Cred, InodeKind, PermSubject } from '../src/perm.ts';
import { ALICE, BOB, CAROL, ROOT, World, errnoOf, ok } from './doubles/world.ts';

const OWNER: Cred = { uid: 10, gid: 20, groups: [20] };
const MEMBER: Cred = { uid: 11, gid: 30, groups: [30, 20] };
const OTHER: Cred = { uid: 12, gid: 40, groups: [40] };
const SUPER: Cred = { uid: 0, gid: 0, groups: [0] };
const MODES = [0o000, 0o400, 0o200, 0o100, 0o444, 0o555, 0o644, 0o700, 0o750, 0o755, 0o777, 0o1777];

/** Independent oracle of Spec §9.3 (written separately from perm.ts). */
function oracle(cred: Cred, type: InodeKind, mode: number, want: number): boolean {
  const r = (want & 4) !== 0;
  const w = (want & 2) !== 0;
  const x = (want & 1) !== 0;
  if (cred.uid === 0) return !x || type === 'd' || (mode & 0o111) !== 0;
  let bits: number;
  if (cred.uid === 10) bits = (mode >> 6) & 7;
  else if (cred.groups.includes(20)) bits = (mode >> 3) & 7;
  else bits = mode & 7;
  return (!r || (bits & 4) !== 0) && (!w || (bits & 2) !== 0) && (!x || (bits & 1) !== 0);
}

const node = (type: InodeKind, mode: number): PermSubject => ({ type, mode, uid: 10, gid: 20 });

describe('permissions (VFS-04)', () => {
  it('VFS-04 permission matrix: owner, group, other and root across 12 modes and every operation', () => {
    let cases = 0;
    for (const cred of [OWNER, MEMBER, OTHER, SUPER]) {
      for (const mode of MODES) {
        for (const type of ['f', 'd'] as const) {
          const n = node(type, mode);
          for (let want = 1; want <= 7; want++) {
            expect(may(cred, n, want), `${cred.uid} ${type} ${mode.toString(8)} want ${want}`).toBe(
              oracle(cred, type, mode, want),
            );
            cases++;
          }
          const can = (want: number): boolean => oracle(cred, type, mode, want);
          expect(checkOpen(cred, n, true, false)).toBe(can(R) ? null : 'EACCES');
          expect(checkOpen(cred, n, false, true)).toBe(can(W) ? null : 'EACCES');
          expect(checkOpen(cred, n, true, true)).toBe(can(R | W) ? null : 'EACCES');
          expect(checkReaddir(cred, n, false)).toBe(can(R) ? null : 'EACCES');
          expect(checkReaddir(cred, n, true)).toBe(can(R | X) ? null : 'EACCES');
          expect(checkCreate(cred, n)).toBe(can(W | X) ? null : 'EACCES');
          expect(checkSubtreeDir(cred, n)).toBe(can(R | W | X) ? null : 'EACCES');
          expect(checkChmod(cred, n)).toBe(cred.uid === 0 || cred.uid === 10 ? null : 'EPERM');
          expect(checkChown(cred)).toBe(cred.uid === 0 ? null : 'EPERM');
          expect(checkUtimes(cred, n, true)).toBe(
            cred.uid === 0 || cred.uid === 10 ? null : 'EPERM',
          );
          expect(checkUtimes(cred, n, false)).toBe(cred.uid === 10 || can(W) ? null : 'EACCES');
          expect(checkCopySource(cred, n)).toBe(can(type === 'd' ? R | X : R) ? null : 'EACCES');
          // Removing a child owned by someone else from this directory: w+x, then the sticky rule.
          const child = { type: 'f' as const, mode: 0o644, uid: 99, gid: 99 };
          const sticky = (mode & 0o1000) !== 0 && cred.uid !== 0 && cred.uid !== 10;
          expect(checkRemove(cred, { ...n, type: 'd' }, child)).toBe(
            !oracle(cred, 'd', mode, W | X) ? 'EACCES' : sticky ? 'EPERM' : null,
          );
        }
      }
    }
    expect(cases).toBe(4 * MODES.length * 2 * 7);
  });

  it('VFS-04 root gets x on a file only if some x bit is set', () => {
    expect(may(SUPER, node('f', 0o644), X)).toBe(false);
    expect(may(SUPER, node('f', 0o644), R | X)).toBe(false);
    expect(may(SUPER, node('f', 0o001), R | X)).toBe(true);
    expect(may(SUPER, node('d', 0o000), R | W | X)).toBe(true);
    expect(may(SUPER, node('f', 0o000), R | W)).toBe(true);
  });

  it('VFS-04 the owner class alone applies even when group bits grant more', () => {
    expect(may(OWNER, node('f', 0o077), R)).toBe(false);
    expect(may(MEMBER, node('f', 0o707), R)).toBe(false);
    expect(may({ uid: 50, gid: 20, groups: [] }, node('f', 0o040), R)).toBe(true);
  });

  it('VFS-04 umask 022 gives 0644 files and 0755 directories, umask 077 gives 0600 and 0700', () => {
    expect(createMode('f', undefined, 0o022)).toBe(0o644);
    expect(createMode('d', undefined, 0o022)).toBe(0o755);
    expect(createMode('f', undefined, 0o077)).toBe(0o600);
    expect(createMode('d', undefined, 0o077)).toBe(0o700);
    expect(createMode('d', 0o1777, 0o022)).toBe(0o1755);
    expect(createMode('l', 0o600, 0o077)).toBe(0o777);
  });

  it('VFS-04 chmod parses octal and symbolic modes as in the table of 5.4', () => {
    const rows: [number | string, number, boolean, number][] = [
      ['644', 0o777, false, 0o644],
      ['1777', 0o755, true, 0o1777],
      ['777', 0o1777, true, 0o777],
      ['o-w', 0o666, false, 0o664],
      ['a+X', 0o644, true, 0o755],
      ['a+X', 0o644, false, 0o644],
      ['u=rw,go=r', 0o777, false, 0o644],
      ['+t', 0o777, true, 0o1777],
      ['+w', 0o444, false, 0o644],
      ['g=', 0o777, false, 0o707],
      ['a-t', 0o1777, true, 0o777],
      ['=r', 0o1777, true, 0o1444],
      [0o640, 0o777, false, 0o640],
    ];
    for (const [spec, from, dir, to] of rows)
      expect(evaluateMode(spec, from, dir, 0o022), String(spec)).toBe(to);
  });

  it('VFS-04 chmod rejects setuid and setgid bits with EINVAL', () => {
    for (const bad of ['u+s', 'g+s', '4755', '2755', 'g=u', '', 'u+q', ',', '99999'])
      expect(parseModeSpec(bad), bad).toBe('EINVAL');
    expect(parseModeSpec(0o4755)).toBe('EINVAL');
    expect(parseModeSpec(-1)).toBe('EINVAL');
    expect(fromModeChange({ op: 'set', bits: 0o2755 })).toBe('EINVAL');
    expect(fromModeChange({ op: 'delta', add: 0o4000, clear: 0 })).toBe('EINVAL');
    const d = fromModeChange({ op: 'delta', add: 0o011, clear: 0o200 });
    expect(d !== 'EINVAL' && applyModeSpec(d, 0o644, false, 0o022)).toBe(0o455);
  });

  it("VFS-04 the wire form of a mode evaluates like the local one under the caller's umask", () => {
    const specs = ['+w', '=rX', '-x', '+t', 'u+x,+r', '=', 'go-w', '+X', 'a=rwx', '=rwt'];
    for (const umask of [0o022, 0o077, 0o002, 0o000]) {
      for (const text of specs) {
        const spec = parseModeSpec(text);
        if (spec === 'EINVAL') throw new Error(text);
        const wire = toWireMode(spec, umask);
        const wireSpec =
          'symbolic' in wire ? parseModeSpec(wire.symbolic) : parseModeSpec(wire.absolute);
        if (wireSpec === 'EINVAL') throw new Error(`bad wire ${JSON.stringify(wire)}`);
        for (const from of [0o000, 0o644, 0o755, 0o1777, 0o100]) {
          for (const dir of [false, true]) {
            // The server evaluates the wire form with no umask of its own.
            expect(
              applyModeSpec(wireSpec, from, dir, 0o777),
              `${text} umask ${umask.toString(8)}`,
            ).toBe(applyModeSpec(spec, from, dir, umask));
          }
        }
      }
    }
    expect(toWireMode({ kind: 'octal', bits: 0o640 }, 0o022)).toEqual({ absolute: 0o640 });
    const delta = { kind: 'delta', add: 0o1011, clear: 0o222 } as const;
    const wd = toWireMode(delta, 0o022);
    const back = 'symbolic' in wd ? parseModeSpec(wd.symbolic) : 'EINVAL';
    if (back === 'EINVAL') throw new Error('delta wire');
    expect(applyModeSpec(back, 0o666, false, 0o777)).toBe(
      applyModeSpec(delta, 0o666, false, 0o022),
    );
    expect(toWireMode({ kind: 'delta', add: 0, clear: 0 }, 0)).toEqual({ symbolic: 'u+' });
  });

  it('VFS-04 ls -l shows the sticky bit as t or T', () => {
    expect(formatMode('d', 0o1777)).toBe('drwxrwxrwt');
    expect(formatMode('d', 0o1776)).toBe('drwxrwxrwT');
    expect(formatMode('f', 0o644)).toBe('-rw-r--r--');
    expect(formatMode('l', 0o777)).toBe('lrwxrwxrwx');
  });

  it('VFS-04 rename, link and remove checks test EACCES before EPERM', () => {
    const dir = { type: 'd' as const, mode: 0o1777, uid: 0, gid: 0 };
    const theirs = { type: 'f' as const, mode: 0o644, uid: 99, gid: 99 };
    expect(checkRename(OWNER, dir, theirs, dir, null, true)).toBe('EPERM');
    expect(checkRename(OWNER, { ...dir, mode: 0o755 }, theirs, dir, null, false)).toBe('EACCES');
    const movedDir = { type: 'd' as const, mode: 0o555, uid: 10, gid: 20 };
    expect(
      checkRename(
        OWNER,
        { ...dir, uid: 10, mode: 0o755 },
        movedDir,
        { ...dir, uid: 10, mode: 0o755 },
        null,
        false,
      ),
    ).toBe('EACCES');
    expect(
      checkRename(
        OWNER,
        { ...dir, uid: 10, mode: 0o755 },
        movedDir,
        { ...dir, uid: 10, mode: 0o755 },
        null,
        true,
      ),
    ).toBe(null);
    expect(
      checkRename(
        OWNER,
        { ...dir, uid: 10, mode: 0o755 },
        theirs,
        { ...dir, mode: 0o1777 },
        theirs,
        false,
      ),
    ).toBe('EPERM');
    expect(checkLink(OWNER, theirs, dir)).toBe('EPERM');
    expect(checkLink(OWNER, { ...theirs, mode: 0o666 }, dir)).toBe(null);
    expect(checkLink(OWNER, { ...theirs, type: 'l', uid: 10 }, dir)).toBe('EPERM');
    expect(checkLink(OWNER, theirs, { ...dir, mode: 0o755 })).toBe('EACCES');
    expect(checkLink(SUPER, theirs, dir)).toBe(null);
  });
});

describe('permissions through the planners (VFS-04, SYS-01)', () => {
  it('VFS-04 as bob, reading /home/alice/notes.md gives EACCES', () => {
    const w = new World();
    ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/alice/notes.md', contentOfText('secret', 0)),
      ),
    );
    const read = { view: w.tree, cred: BOB, cwd: w.tree.rootIno };
    expect(() => statPath(read, '/home/alice/notes.md')).toThrow('EACCES');
    expect(() => access({ ...read, cred: ALICE }, '/home/alice/notes.md', R)).not.toThrow();
    ok(w.run(ALICE, 'chmod', (b) => planChmod(b, '/home/alice', { kind: 'octal', bits: 0o755 })));
    ok(
      w.run(ALICE, 'chmod', (b) =>
        planChmod(b, '/home/alice/notes.md', { kind: 'octal', bits: 0o600 }),
      ),
    );
    expect(() => access(read, '/home/alice/notes.md', R)).toThrow('EACCES');
    ok(
      w.run(ALICE, 'chmod', (b) =>
        planChmod(b, '/home/alice/notes.md', { kind: 'octal', bits: 0o644 }),
      ),
    );
    expect(() => access(read, '/home/alice/notes.md', R)).not.toThrow();
    expect(() => access(read, '/home/alice/notes.md', W)).toThrow('EACCES');
  });

  it('VFS-04 chmod by a non-owner and chown by a non-root user give EPERM', () => {
    const w = new World();
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/f', contentOfText('x', 0))));
    ok(w.run(ALICE, 'chmod', (b) => planChmod(b, '/home/alice', { kind: 'octal', bits: 0o755 })));
    expect(
      errnoOf(
        w.run(BOB, 'chmod', (b) => planChmod(b, '/home/alice/f', { kind: 'octal', bits: 0o777 })),
      ),
    ).toBe('EPERM');
    expect(
      errnoOf(w.run(ALICE, 'chown', (b) => planChown(b, '/home/alice/f', { uid: 1001 }))),
    ).toBe('EPERM');
    expect(errnoOf(w.run(ROOT, 'chown', (b) => planChown(b, '/home/alice/f', {})))).toBe('EINVAL');
    expect(errnoOf(w.run(ROOT, 'chown', (b) => planChown(b, '/home/alice/f', { uid: 4242 })))).toBe(
      'EINVAL',
    );
    expect(
      ok(w.run(ROOT, 'chown', (b) => planChown(b, '/home/alice/f', { uid: 1001 }))).changed,
    ).toBe(1);
  });

  it("VFS-04 sticky /tmp: bob cannot unlink or rename alice's file, the directory owner and root can", () => {
    const w = new World();
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/tmp/a.txt', contentOfText('a', 0))));
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/tmp/b.txt', contentOfText('b', 0))));
    expect(errnoOf(w.run(BOB, 'unlink', (b) => planUnlink(b, '/tmp/a.txt')))).toBe('EPERM');
    expect(errnoOf(w.run(BOB, 'rename', (b) => planRename(b, '/tmp/a.txt', '/tmp/mine.txt')))).toBe(
      'EPERM',
    );
    ok(w.run(ROOT, 'unlink', (b) => planUnlink(b, '/tmp/a.txt')));
    ok(w.run(ALICE, 'unlink', (b) => planUnlink(b, '/tmp/b.txt')));
  });

  it('VFS-04 rm -r needs r, w and x on every directory of the subtree and changes nothing otherwise', () => {
    const w = new World();
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/shared/t/locked/deep', undefined, true)));
    ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/shared/t/locked/deep/f', contentOfText('f', 0)),
      ),
    );
    ok(
      w.run(ALICE, 'chmod', (b) => planChmod(b, '/home/shared/t', { kind: 'octal', bits: 0o777 })),
    );
    ok(
      w.run(ALICE, 'chmod', (b) =>
        planChmod(b, '/home/shared/t/locked', { kind: 'octal', bits: 0o755 }),
      ),
    );
    const before = w.tree.snapshot();
    const bobInShared: typeof BOB = { ...BOB, groups: [...BOB.groups, 200] };
    expect(
      errnoOf(
        w.run(bobInShared, 'unlink', (b) =>
          planRemoveTree(b, forRemove(b, '/home/shared/t/locked')),
        ),
      ),
    ).toBe('EACCES');
    expect(w.tree.snapshot()).toEqual(before);
    expect(
      ok(w.run(ALICE, 'unlink', (b) => planRemoveTree(b, forRemove(b, '/home/shared/t/locked'))))
        .removed,
    ).toBe(3);
  });

  it('VFS-04 moving a directory to a new parent needs w on the directory itself', () => {
    const w = new World();
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/ro', 0o555)));
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/dst')));
    expect(
      errnoOf(w.run(ALICE, 'rename', (b) => planRename(b, '/home/alice/ro', '/home/alice/dst/ro'))),
    ).toBe('EACCES');
    ok(w.run(ALICE, 'rename', (b) => planRename(b, '/home/alice/ro', '/home/alice/ro2')));
    expect(errnoOf(w.run(CAROL, 'unlink', (b) => planUnlink(b, '/home/alice/dst')))).toBe('EACCES');
  });
});
