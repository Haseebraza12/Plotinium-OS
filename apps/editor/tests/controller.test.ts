import { describe, expect, it } from 'vitest';

import { demoWorld, type FakeSys, type FakeWorld } from '../../files/tests/fake-sys.ts';
import { EditorController } from '../lib/controller.ts';
import { bannerTitle, lockViewOf, parseEditorArgs } from '../lib/model.ts';

async function editor(
  sys: FakeSys,
  world: FakeWorld,
  argv: readonly string[],
): Promise<EditorController> {
  const ed = new EditorController({ sys, now: () => world.now });
  await ed.start(parseEditorArgs(argv));
  return ed;
}

function current(ed: EditorController) {
  const d = ed.doc();
  if (d === undefined) throw new Error('no document');
  return d;
}

describe('Editor arguments', () => {
  it('VFS-07 parses paths with +N and --line N citations', () => {
    expect(parseEditorArgs(['/a.md', '+42'])).toEqual([{ path: '/a.md', line: 42 }]);
    expect(parseEditorArgs(['+7', '/a.md', '/b.md'])).toEqual([
      { path: '/a.md', line: 7 },
      { path: '/b.md' },
    ]);
    expect(parseEditorArgs(['editor', '/a.md', '--line', '3'])).toEqual([
      { path: '/a.md', line: 3 },
    ]);
    expect(parseEditorArgs(['/a.md', '--line=9', '+0'])).toEqual([{ path: '/a.md', line: 9 }]);
    expect(parseEditorArgs([])).toEqual([]);
  });
});

describe('Editor open and save (VFS-10)', () => {
  it('VFS-07 opens a file through open/read/close at the cited line and saves with expectedVersion', async () => {
    const { world, alice } = demoWorld();
    const ed = await editor(alice, world, ['/home/alice/notes/week6-standup.md', '+3']);
    const d = current(ed);
    expect(d).toMatchObject({
      name: 'week6-standup.md',
      loading: false,
      writable: true,
      line: 3,
      version: 1,
    });
    expect(d.text).toContain('LRU pager');
    expect(ed.state.files.map((f) => f.name)).toEqual(['week6-standup.md']);
    ed.edit(d.id, `${d.text}\nMore.`);
    expect(current(ed).save).toEqual({ kind: 'edited' });
    await ed.save();
    expect(current(ed).save).toEqual({ kind: 'saved', version: 2 });
    expect(world.text('/home/alice/notes/week6-standup.md')).toContain('More.');
    const write = world.calls.find((c) => c.call === 'writeFile');
    expect(write?.args).toMatchObject({
      path: '/home/alice/notes/week6-standup.md',
      expectedVersion: 1,
    });
    expect(world.calls.map((c) => c.call)).toEqual(
      expect.arrayContaining(['open', 'read', 'close']),
    );
  });

  it('VFS-10 a stale save shows the conflict banner and the conflicted copy exists; nothing is overwritten', async () => {
    const { world, alice, bob } = demoWorld();
    const ed = await editor(alice, world, ['/home/shared/plan.md']);
    const id = current(ed).id;
    // bob saves first (version 1 -> 2)
    await bob.call('writeFile', {
      path: '/home/shared/plan.md',
      data: new TextEncoder().encode('# Plan\n\n- bob was here\n').buffer,
      expectedVersion: 1,
    });
    ed.edit(id, '# Plan\n\n- alice offline edit\n');
    await ed.save(id);
    const d = current(ed);
    const copyName = 'plan (conflict from alice, 2026-09-26).md';
    expect(d.conflict).toEqual({
      kind: 'conflict',
      copyName,
      copyPath: `/home/shared/${copyName}`,
    });
    // The banner's exact strings come from ui ConflictBanner: "This file changed on the server."
    // and "Your version was saved as “plan (conflict from alice, 2026-09-26).md”."
    expect(world.text(`/home/shared/${copyName}`)).toBe('# Plan\n\n- alice offline edit\n');
    expect(world.text('/home/shared/plan.md')).toBe('# Plan\n\n- bob was here\n');
    expect(d.text).toBe('# Plan\n\n- bob was here\n');
    expect(d.version).toBe(2);
    expect(ed.state.files.find((f) => f.name === copyName)?.conflict).toBe(true);
    await ed.conflictAction(id, 'open-copy');
    expect(current(ed)).toMatchObject({ name: copyName, text: '# Plan\n\n- alice offline edit\n' });
    ed.select(id);
    ed.dismissConflict(id);
    expect(current(ed).conflict).toBeUndefined();
  });

  it('VFS-10 “changed by another window” on a dirty buffer; Keep mine makes a conflicted copy, Reload takes theirs', async () => {
    const { world, alice } = demoWorld();
    const ed = await editor(alice, world, ['/home/alice/Documents/report.md']);
    const id = current(ed).id;
    ed.edit(id, 'mine');
    world.writeAbs('/home/alice/Documents/report.md', 'theirs', {
      uid: 1001,
      gid: 1001,
      name: 'alice',
      home: '/home/alice',
    });
    await ed.poll();
    expect(current(ed).banner).toEqual({ kind: 'changed', name: 'report.md' });
    expect(bannerTitle({ kind: 'changed', name: 'report.md' })).toBe(
      'report.md was changed by another window.',
    );
    await ed.bannerAction(id, 'keep-mine');
    expect(current(ed).conflict?.kind).toBe('conflict');
    expect(world.text('/home/alice/Documents/report.md')).toBe('theirs');
    expect(world.names('/home/alice/Documents')).toContain(
      'report (conflict from alice, 2026-09-26).md',
    );
    // A clean buffer simply reloads.
    world.writeAbs('/home/alice/Documents/report.md', 'newer', {
      uid: 1001,
      gid: 1001,
      name: 'alice',
      home: '/home/alice',
    });
    await ed.poll();
    expect(current(ed).text).toBe('newer');
  });

  it('VFS-10 Save As never overwrites an existing file', async () => {
    const { world, alice } = demoWorld();
    const ed = await editor(alice, world, []);
    const id = current(ed).id;
    expect(current(ed)).toMatchObject({ name: 'Untitled', path: undefined });
    ed.edit(id, 'draft');
    expect(await ed.save(id)).toBe(false);
    expect(await ed.saveAs(id, '/home/alice/Documents/report.md')).toBe(false);
    expect(ed.state.toast?.errno).toBe('EEXIST');
    expect(world.text('/home/alice/Documents/report.md')).toContain('# Report');
    expect(await ed.saveAs(id, 'Documents/draft.txt')).toBe(true);
    expect(world.text('/home/alice/Documents/draft.txt')).toBe('draft');
    expect(current(ed)).toMatchObject({
      name: 'draft.txt',
      path: '/home/alice/Documents/draft.txt',
      save: { kind: 'saved', version: 1 },
    });
  });

  it('VFS-06 a save over quota shows the quota banner and writes nothing; EACCES opens read-only', async () => {
    const { world, alice } = demoWorld();
    world.quotaBytes = 4;
    const ed = await editor(alice, world, [
      '/home/alice/Documents/report.md',
      '/home/bob/private.txt',
      '/home/shared/plan.md',
    ]);
    const report = ed.state.docs[0];
    if (report === undefined) throw new Error('no doc');
    ed.select(report.id);
    ed.edit(report.id, 'far too long for the quota');
    await ed.save(report.id);
    expect(current(ed).save).toEqual({ kind: 'failed' });
    expect(current(ed).banner?.kind).toBe('quota');
    expect(world.text('/home/alice/Documents/report.md')).toContain('# Report');
    const priv = ed.state.docs.find((d) => d.name === 'private.txt');
    expect(priv?.error?.errno).toBe('EACCES');
    world.writeAbs(
      '/home/shared/ro.md',
      'read only',
      { uid: 1002, gid: 1002, name: 'bob', home: '/home/bob' },
      0o644,
    );
    await ed.open('/home/shared/ro.md');
    expect(current(ed)).toMatchObject({ writable: false, banner: { kind: 'permission' } });
    expect(bannerTitle({ kind: 'permission' })).toBe('You can read this file but not write it.');
  });
});

describe('Editor locks (VFS-09)', () => {
  it('VFS-09 the first edit takes an X lease; the other user opens read-only with the lock chip', async () => {
    const { world, alice, bob } = demoWorld();
    const a = await editor(alice, world, ['/home/shared/plan.md']);
    a.edit(current(a).id, '# Plan\n\nalice typing\n');
    await new Promise((r) => setTimeout(r, 0));
    expect(current(a).lock).toEqual({ kind: 'mine' });
    expect(world.leases.size).toBe(1);

    const b = await editor(bob, world, ['/home/shared/plan.md']);
    const lock = current(b).lock;
    expect(lock).toMatchObject({ kind: 'other', holder: 'alice', leaseMs: 30_000 });
    expect(current(b).banner).toEqual({ kind: 'locked', holder: 'alice', seconds: 30 });
    expect(bannerTitle({ kind: 'locked', holder: 'alice', seconds: 12 })).toBe(
      "Locked by alice — read-only. The lock expires in 12 s if alice's session stops.",
    );
    // A save attempt while locked writes nothing.
    b.edit(current(b).id, 'bob tries');
    await b.save();
    expect(world.text('/home/shared/plan.md')).toBe('# Plan\n\n- ship\n');

    // alice saves and closes: the lease goes, bob's chip turns "Editable".
    await a.save();
    await a.close(current(a).id);
    expect(world.leases.size).toBe(0);
    await b.poll();
    expect(current(b).lock).toEqual({ kind: 'released', holder: 'alice' });
    expect(current(b).banner).toBeUndefined();
  });

  it('VFS-09 lock chip states follow lock.status holders', () => {
    const now = 1_000_000;
    const holder = {
      path: '/p',
      holder: 'bob@lab-pc',
      mode: 'X' as const,
      expiresAt: now + 12_000,
      scope: 'server' as const,
    };
    expect(lockViewOf([holder], { user: 'alice', mine: false, now })).toEqual({
      kind: 'other',
      holder: 'bob',
      expiresAt: now + 12_000,
      leaseMs: 30_000,
    });
    expect(lockViewOf([], { user: 'alice', mine: true, now })).toEqual({ kind: 'mine' });
    expect(
      lockViewOf([{ ...holder, expiresAt: now - 1 }], { user: 'alice', mine: false, now }),
    ).toBeUndefined();
    expect(
      lockViewOf([], {
        user: 'alice',
        mine: false,
        previous: { kind: 'other', holder: 'bob', expiresAt: now, leaseMs: 30_000 },
        now,
      }),
    ).toEqual({
      kind: 'released',
      holder: 'bob',
    });
  });

  it('VFS-09 Toggle takes and gives back the lease explicitly', async () => {
    const { world, alice } = demoWorld();
    const ed = await editor(alice, world, ['/home/shared/plan.md']);
    await ed.toggleLease(current(ed).id);
    expect(world.leases.size).toBe(1);
    expect(current(ed).lock).toEqual({ kind: 'mine' });
    await ed.toggleLease(current(ed).id);
    expect(world.leases.size).toBe(0);
  });

  it('VFS-10 a vfs.conflict event for an open file shows the offline conflict banner', async () => {
    const { world, alice } = demoWorld();
    const ed = await editor(alice, world, ['/home/shared/plan.md']);
    const d = current(ed);
    ed.onEvents([
      {
        topic: 'vfs.conflict',
        seq: 1,
        t: 0,
        data: {
          ino: d.ino ?? '',
          keptAs: {
            ino: world.newId(),
            path: '/home/alice/lost+found/plan (conflict from alice, 2026-09-26).md',
          },
          by: 'bob',
        },
      },
    ]);
    expect(current(ed).conflict).toMatchObject({
      kind: 'conflict',
      offline: true,
      copyName: 'plan (conflict from alice, 2026-09-26).md',
    });
  });
});
