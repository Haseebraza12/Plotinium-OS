import { INO, deriveIno } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { contentOfText } from '../src/content.ts';
import { planChmod } from '../src/ops/attr.ts';
import { planMkdir } from '../src/ops/create.ts';
import { readdir, statPath } from '../src/ops/read.ts';
import { planRename } from '../src/ops/rename.ts';
import { planRemoveTree, planUnlink } from '../src/ops/unlink.ts';
import { forRemove } from '../src/ops/common.ts';
import { planContentWrite, planWriteFile } from '../src/ops/write.ts';
import { conflictName, isoDate, lostFoundName, splitExtension } from '../src/names.ts';
import { utf8Length } from '../src/path.ts';
import { ALICE, BOB, ROOT, World, ok } from './doubles/world.ts';

const read = (w: World, cred = ROOT) => ({ view: w.tree, cred, cwd: INO.ROOT });

describe('conflicted copies (VFS-10)', () => {
  it('VFS-10 conflicted-copy names handle extensions, dotfiles, counters and the 255-byte limit', () => {
    const none = (): boolean => false;
    expect(conflictName('report.md', 'alice', '2026-11-14', none)).toBe(
      'report (conflict from alice, 2026-11-14).md',
    );
    expect(conflictName('.bashrc', 'alice', '2026-11-14', none)).toBe(
      '.bashrc (conflict from alice, 2026-11-14)',
    );
    expect(conflictName('archive.tar.gz', 'bob', '2026-01-02', none)).toBe(
      'archive.tar (conflict from bob, 2026-01-02).gz',
    );
    expect(conflictName('Makefile', 'bob', '2026-01-02', none)).toBe(
      'Makefile (conflict from bob, 2026-01-02)',
    );
    const taken = new Set([
      'report (conflict from alice, 2026-11-14).md',
      'report (conflict from alice, 2026-11-14) 2.md',
    ]);
    expect(conflictName('report.md', 'alice', '2026-11-14', (c) => taken.has(c))).toBe(
      'report (conflict from alice, 2026-11-14) 3.md',
    );
    const long = conflictName(`${'語'.repeat(84)}.txt`, 'alice', '2026-11-14', none);
    expect(utf8Length(long)).toBeLessThanOrEqual(255);
    expect(long.endsWith(' (conflict from alice, 2026-11-14).txt')).toBe(true);
    const hugeExt = conflictName(`a.${'x'.repeat(250)}`, 'alice', '2026-11-14', none);
    expect(utf8Length(hugeExt)).toBeLessThanOrEqual(255);
    expect(splitExtension('.a.b')).toEqual({ stem: '.a', ext: '.b' });
    expect(isoDate(Date.UTC(2026, 10, 14, 23, 30), 'Asia/Karachi')).toBe('2026-11-15');
    expect(isoDate(Date.UTC(2026, 10, 14, 23, 30))).toBe('2026-11-14');
    expect(
      lostFoundName('0198abcd-ef01-7000-8000-000000000001', (c) => c === '#0198abcdef01'),
    ).toBe('#0198abcdef01-2');
  });

  it('VFS-10 two local writers of one file produce a local conflicted copy and the original is untouched', () => {
    const w = new World();
    ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/alice/report.md', contentOfText('v1', 0)),
      ),
    );
    const st = statPath(read(w, ALICE), '/home/alice/report.md');
    // Writer A opened at version 1; writer B commits first.
    ok(
      w.run(ALICE, 'write', (b) =>
        planContentWrite(b, st.ino, contentOfText('B wins', 0), 1, null),
      ),
    );
    const opId = '01920000-0000-7000-8000-00000000a001';
    const r = ok(
      w.run(
        ALICE,
        'write',
        (b) =>
          planContentWrite(b, st.ino, contentOfText('A late', 0), 1, {
            parent: w.user(ALICE.uid).homeIno ?? '',
            name: 'report.md',
          }),
        { opId },
      ),
    );
    expect(r.conflict?.keptAs.path).toBe('/home/alice/report (conflict from alice, 2026-11-14).md');
    expect(r.conflict?.keptAs.ino).toBe(deriveIno(opId, st.ino));
    const orig = statPath(read(w, ALICE), '/home/alice/report.md');
    expect(orig.size).toBe(6);
    expect(orig.version).toBe(2);
    expect(statPath(read(w, ALICE), r.conflict?.keptAs.path ?? '').size).toBe(6);
  });

  it('VFS-10 a stale expectedVersion on writeFile keeps the content as a copy (the Editor save path)', () => {
    const w = new World();
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/n.txt', contentOfText('1', 0))));
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/n.txt', contentOfText('2', 0))));
    const r = ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/alice/n.txt', contentOfText('mine', 0), { expectedVersion: 1 }),
      ),
    );
    expect(r.conflict).toBeDefined();
    expect(readdir(read(w, ALICE), '/home/alice').entries.map((e) => e.name)).toContain(
      'n (conflict from alice, 2026-11-14).txt',
    );
  });

  it('VFS-10 a file deleted while open keeps its session content as a conflicted copy', () => {
    const w = new World();
    ok(
      w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/d.txt', contentOfText('old', 0))),
    );
    const st = statPath(read(w, ALICE), '/home/alice/d.txt');
    ok(w.run(ALICE, 'unlink', (b) => planUnlink(b, '/home/alice/d.txt')));
    const home = w.user(ALICE.uid).homeIno ?? '';
    const r = ok(
      w.run(ALICE, 'write', (b) =>
        planContentWrite(b, st.ino, contentOfText('unsaved', 0), 1, {
          parent: home,
          name: 'd.txt',
        }),
      ),
    );
    expect(r.conflict?.keptAs.path).toBe('/home/alice/d (conflict from alice, 2026-11-14).txt');
  });

  it("VFS-10 without w on the directory the copy lands in the writer's ~/lost+found", () => {
    const w = new World();
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/shared/docs', 0o777)));
    ok(
      w.run(ALICE, 'write', (b) =>
        planWriteFile(b, '/home/shared/docs/plan.md', contentOfText('p', 0)),
      ),
    );
    ok(
      w.run(ALICE, 'chmod', (b) =>
        planChmod(b, '/home/shared/docs/plan.md', { kind: 'octal', bits: 0o666 }),
      ),
    );
    ok(
      w.run(ALICE, 'chmod', (b) =>
        planChmod(b, '/home/shared/docs', { kind: 'octal', bits: 0o755 }),
      ),
    );
    const st = statPath(read(w), '/home/shared/docs/plan.md');
    ok(
      w.run(ALICE, 'write', (b) => planContentWrite(b, st.ino, contentOfText('alice', 0), 1, null)),
    );
    const bob = { ...BOB, groups: [...BOB.groups, 200] };
    const r = ok(
      w.run(bob, 'write', (b) => planContentWrite(b, st.ino, contentOfText('bob', 0), 1, null)),
    );
    expect(r.conflict?.keptAs.path).toBe(
      '/home/bob/lost+found/plan (conflict from bob, 2026-11-14).md',
    );
    expect(statPath(read(w), '/home/bob/lost+found').mode).toBe(0o700);
  });

  it('VFS-10 every op carries the base of 3.15.1', () => {
    const w = new World();
    ok(w.run(ALICE, 'create', (b) => planMkdir(b, '/home/alice/t')));
    const create = w.outbox.at(-1);
    expect(create?.base).toEqual({ kind: 'versions', entries: [] });
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/t/f', contentOfText('1', 0))));
    const st = statPath(read(w, ALICE), '/home/alice/t/f');
    ok(w.run(ALICE, 'write', (b) => planWriteFile(b, '/home/alice/t/f', contentOfText('22', 0))));
    expect(w.outbox.at(-1)?.base).toEqual({
      kind: 'versions',
      entries: [{ ino: st.ino, version: 1 }],
    });
    ok(w.run(ALICE, 'rename', (b) => planRename(b, '/home/alice/t/f', '/home/alice/t/g')));
    expect(w.outbox.at(-1)?.base).toEqual({ kind: 'versions', entries: [] });
    ok(w.run(ALICE, 'unlink', (b) => planRemoveTree(b, forRemove(b, '/home/alice/t'))));
    expect(w.outbox.at(-1)?.base.kind).toBe('digest');
  });
});
