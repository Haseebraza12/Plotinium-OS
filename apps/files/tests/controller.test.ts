import type { KEvent, SemsearchResult } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { FilesController, touchesFolder } from '../lib/controller.ts';
import type { EntryView } from '../lib/model.ts';
import { demoWorld, type FakeSys, type FakeWorld } from './fake-sys.ts';

interface Harness {
  world: FakeWorld;
  sys: FakeSys;
  files: FilesController;
  launched: { app: string; argv: readonly string[] }[];
}

async function open(as: 'alice' | 'bob' = 'alice', start?: string, ai = true): Promise<Harness> {
  const w = demoWorld();
  const sys = as === 'alice' ? w.alice : w.bob;
  const launched: Harness['launched'] = [];
  const files = new FilesController({
    sys,
    now: () => w.world.now,
    launch: (app, argv) => launched.push({ app, argv }),
    aiAvailable: ai,
  });
  await files.start(start);
  return { world: w.world, sys, files, launched };
}

function row(files: FilesController, name: string): EntryView {
  const found = files.state.rows.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no row ${name} in ${files.state.path}`);
  return found;
}

function names(files: FilesController): string[] {
  return files.state.rows.map((r) => r.name).sort();
}

/** Every call the app made that changes the file system. */
function mutations(world: FakeWorld): string[] {
  const kinds = new Set([
    'mkdir',
    'rename',
    'copy',
    'unlink',
    'rmdir',
    'chmod',
    'writeFile',
    'open',
  ]);
  return world.calls.filter((c) => kinds.has(c.call)).map((c) => c.call);
}

describe('Files controller (VFS-07)', () => {
  it('VFS-07 opens the home folder listed through readdir and lstat, hidden files left out', async () => {
    const { files, world } = await open();
    const s = files.state;
    expect(s.ready).toBe(true);
    expect(s.path).toBe('/home/alice');
    expect(s.title).toBe('alice');
    expect(names(files)).toEqual(['Documents', 'notes']);
    expect(row(files, 'Documents')).toMatchObject({ type: 'dir', owner: 'alice', mode: 0o755 });
    expect(s.folderWritable).toBe(true);
    expect(s.favourites.map((p) => p.id)).toEqual(['home', 'documents', 'shared']);
    expect(s.quota?.total).toBe(100 * 1_048_576);
    expect(world.calls.some((c) => c.call === 'readdir')).toBe(true);
    await files.toggleHidden();
    await files.navigate('/home/alice/notes');
    expect(names(files)).toContain('.hidden');
  });

  it('VFS-07 navigates into folders, Back, Forward and Up, and a symlink to a folder opens it', async () => {
    const { files, world } = await open();
    world.symlinkAbs('/home/alice/to-notes', 'notes', {
      uid: 1001,
      gid: 1001,
      name: 'alice',
      home: '/home/alice',
    });
    await files.refresh();
    await files.open(row(files, 'Documents'));
    expect(files.state.path).toBe('/home/alice/Documents');
    expect(names(files)).toEqual(['report.md']);
    await files.back();
    expect(files.state.path).toBe('/home/alice');
    expect(files.state.history.forward).toEqual(['/home/alice/Documents']);
    await files.forward();
    expect(files.state.path).toBe('/home/alice/Documents');
    await files.up();
    expect(files.state.path).toBe('/home/alice');
    await files.open(row(files, 'to-notes'));
    expect(files.state.path).toBe('/home/alice/to-notes');
    expect(names(files)).toEqual(['week6-standup.md']);
  });

  it('VFS-07 opening a file launches the Editor with its path', async () => {
    const { files, launched } = await open('alice', '/home/alice/Documents');
    await files.open(row(files, 'report.md'));
    expect(launched).toEqual([{ app: 'editor', argv: ['/home/alice/Documents/report.md'] }]);
  });

  it('VFS-07 shows the EACCES folder message for a folder the user cannot read', async () => {
    const { files, world } = await open('alice');
    world.mkdirAbs('/home/bob/secret', 0o700, 1002, 1002);
    await files.navigate('/home/bob/secret');
    expect(files.state.error).toEqual({
      errno: 'EACCES',
      message: 'You do not have permission to open this folder',
    });
    expect(files.state.rows).toEqual([]);
  });

  it('VFS-07 creates a folder, renames it, and refuses a clashing name without overwriting', async () => {
    const { files, world } = await open();
    const path = await files.newFolder('Projects');
    expect(path).toBe('/home/alice/Projects');
    expect(names(files)).toContain('Projects');
    expect(await files.rename(row(files, 'Projects'), 'Work')).toBe(true);
    expect(names(files)).toEqual(['Documents', 'Work', 'notes']);
    expect(await files.rename(row(files, 'Work'), 'notes')).toBe(false);
    expect(files.state.toast).toMatchObject({ tone: 'error', errno: 'EEXIST' });
    expect(world.names('/home/alice')).toEqual(['Documents', 'Work', 'notes']);
    expect(await files.newFolder('Work')).toBeUndefined();
    expect(files.state.toast?.errno).toBe('EEXIST');
  });

  it('VFS-07 creates an empty file and never replaces an existing one', async () => {
    const { files, world } = await open('alice', '/home/alice/Documents');
    expect(await files.newFile('todo.txt')).toBe('/home/alice/Documents/todo.txt');
    expect(world.text('/home/alice/Documents/todo.txt')).toBe('');
    expect(await files.newFile('report.md')).toBeUndefined();
    expect(world.text('/home/alice/Documents/report.md')).toContain('# Report');
  });

  it('VFS-07 copy and paste into the same folder makes “name copy.ext”; into another keeps the name', async () => {
    const { files, world } = await open('alice', '/home/alice/Documents');
    files.copy([row(files, 'report.md')]);
    expect(files.state.clipboard).toEqual({
      mode: 'copy',
      paths: ['/home/alice/Documents/report.md'],
    });
    await files.paste();
    expect(names(files)).toEqual(['report copy.md', 'report.md']);
    await files.paste();
    expect(names(files)).toContain('report copy 2.md');
    await files.paste('/home/alice/notes');
    expect(world.names('/home/alice/notes')).toContain('report.md');
    expect(world.text('/home/alice/notes/report.md')).toContain('Kernel scheduling');
  });

  it('VFS-07 cut marks the rows and paste moves them (rename), then clears the clipboard', async () => {
    const { files, world } = await open('alice', '/home/alice/Documents');
    files.cut([row(files, 'report.md')]);
    expect(row(files, 'report.md').cut).toBe(true);
    await files.navigate('/home/alice/notes');
    await files.paste();
    expect(world.names('/home/alice/Documents')).toEqual([]);
    expect(world.names('/home/alice/notes')).toContain('report.md');
    expect(files.state.clipboard).toBeUndefined();
    expect(world.calls.filter((c) => c.call === 'rename')).toHaveLength(1);
  });

  it('VFS-07 drag and drop moves into a folder, and a folder cannot be moved into itself', async () => {
    const { files, world } = await open();
    await files.drop(['/home/alice/Documents'], '/home/alice/notes', false);
    expect(world.names('/home/alice/notes')).toContain('Documents');
    await files.drop(['/home/alice/notes'], '/home/alice/notes/Documents', false);
    expect(world.names('/home/alice')).toContain('notes');
  });

  it('VFS-07 a move out of /tmp falls back to copy and delete on EXDEV', async () => {
    const { files, world } = await open('alice', '/tmp');
    world.writeAbs('/tmp/scratch.txt', 'tmp bytes', {
      uid: 1001,
      gid: 1001,
      name: 'alice',
      home: '/home/alice',
    });
    await files.refresh();
    files.cut([row(files, 'scratch.txt')]);
    await files.paste('/home/alice/Documents');
    expect(world.text('/home/alice/Documents/scratch.txt')).toBe('tmp bytes');
    expect(world.names('/tmp')).toEqual([]);
    expect(world.calls.map((c) => c.call)).toEqual(
      expect.arrayContaining(['rename', 'copy', 'unlink']),
    );
  });

  it('VFS-07 Move to Trash uses /home/<user>/.Trash with unique names; Delete in the Trash removes for good', async () => {
    const { files, world } = await open('alice', '/home/alice/Documents');
    world.writeAbs('/home/alice/notes/report.md', 'second', {
      uid: 1001,
      gid: 1001,
      name: 'alice',
      home: '/home/alice',
    });
    await files.trash([row(files, 'report.md')]);
    const trashed = (): string[] =>
      world.names('/home/alice/.Trash').filter((n) => !n.startsWith('.'));
    expect(world.names('/home/alice/Documents')).toEqual([]);
    expect(trashed()).toEqual(['report.md']);
    expect(world.node('/home/alice/.Trash')?.mode).toBe(0o700 & ~0o022);
    await files.navigate('/home/alice/notes');
    await files.trash([row(files, 'report.md')]);
    expect(trashed()).toEqual(['report 2.md', 'report.md']);
    expect(files.state.toast).toMatchObject({ tone: 'success', text: 'Moved 1 item to the Trash' });
    await files.goPlace('trash');
    expect(files.state.inTrash).toBe(true);
    expect(files.state.title).toBe('Trash');
    expect(names(files)).toEqual(['report 2.md', 'report.md']);
    await files.trash([row(files, 'report.md')]);
    expect(files.state.toast?.text).toContain('Already in the Trash');
    await files.deleteForever([row(files, 'report.md'), row(files, 'report 2.md')]);
    expect(trashed()).toEqual([]);
    // Their Put Back records went with them.
    expect(world.names('/home/alice/.Trash/.trashinfo')).toEqual([]);
    expect(files.state.toast?.text).toBe('Deleted 2 items');
  });

  it('VFS-04 Change Permissions sets the mode for the owner and reports EPERM for others', async () => {
    const { files, world } = await open('alice', '/home/shared');
    world.writeAbs('/home/shared/bobs.md', 'b', {
      uid: 1002,
      gid: 1002,
      name: 'bob',
      home: '/home/bob',
    });
    await files.refresh();
    await files.chmod([row(files, 'plan.md')], 0o640);
    expect(world.node('/home/shared/plan.md')?.mode).toBe(0o640);
    expect(row(files, 'plan.md').mode).toBe(0o640);
    await files.chmod([row(files, 'bobs.md')], 0o777);
    expect(files.state.toast).toMatchObject({ tone: 'error', errno: 'EPERM' });
    expect(world.node('/home/shared/bobs.md')?.mode).toBe(0o644);
  });

  it('VFS-07 every create, rename, copy, move, delete and chmod is a system call', async () => {
    const { files, world } = await open();
    await files.newFolder('A');
    await files.rename(row(files, 'A'), 'B');
    files.copy([row(files, 'B')]);
    await files.paste();
    await files.chmod([row(files, 'B')], 0o700);
    await files.trash([row(files, 'B copy')]);
    await files.navigate('/home/alice/.Trash');
    await files.deleteForever([row(files, 'B copy')]);
    expect(mutations(world)).toEqual([
      'mkdir',
      'rename',
      'copy',
      'chmod',
      'mkdir', // ~/.Trash
      'rename',
      'mkdir', // ~/.Trash/.trashinfo (Put Back records, UI-107)
      'writeFile',
      'unlink',
      'unlink', // the record goes with the item
    ]);
  });

  it('VFS-07 dropped host files are written under a free name', async () => {
    const { files, world } = await open('alice', '/home/alice/Documents');
    const data = new TextEncoder().encode('dropped').buffer;
    await files.upload([
      { name: 'report.md', data },
      { name: 'new.txt', data },
    ]);
    expect(world.names('/home/alice/Documents')).toEqual(['new.txt', 'report 2.md', 'report.md']);
    expect(world.text('/home/alice/Documents/report.md')).toContain('# Report');
    expect(files.state.toast?.text).toBe('Added 2 files');
  });

  it('VFS-07 a vfs event about the shown folder re-lists it; others are ignored', async () => {
    const { files, world } = await open('alice', '/home/alice/Documents');
    const dirIno = files.state.dirIno ?? '';
    const ev = (parent: string): KEvent => ({
      topic: 'vfs.create',
      seq: 1,
      t: 0,
      data: {
        ino: world.newId(),
        parent,
        name: 'x',
        type: 'f',
        uid: 1001,
        version: 1,
        origin: 'remote',
      },
    });
    expect(touchesFolder(ev(dirIno), dirIno, new Set())).toBe(true);
    expect(touchesFolder(ev('other'), dirIno, new Set())).toBe(false);
    world.writeAbs('/home/alice/Documents/remote.md', 'from bob', undefined);
    files.onEvents([ev(dirIno)]);
    await new Promise((r) => setTimeout(r, 0));
    await files.poll();
    expect(names(files)).toContain('remote.md');
  });
});

describe('Files locks (VFS-09)', () => {
  it('VFS-09 Lock for Editing takes an X lease; another user sees the holder and cannot lock', async () => {
    const a = await open('alice', '/home/shared');
    await a.files.lock(row(a.files, 'plan.md'));
    expect(a.files.state.leases['/home/shared/plan.md']).toBeDefined();
    expect(row(a.files, 'plan.md').lock).toMatchObject({ mine: true });
    // bob, same world
    const launched: string[] = [];
    const bobFiles = new FilesController({
      sys: a.world.client({ uid: 1002, gid: 1002, name: 'bob', home: '/home/bob' }),
      now: () => a.world.now,
      launch: (app) => launched.push(app),
      aiAvailable: false,
    });
    await bobFiles.start('/home/shared');
    await bobFiles.inspect(row(bobFiles, 'plan.md'));
    expect(row(bobFiles, 'plan.md').lock).toMatchObject({ holder: 'alice@lab-pc' });
    expect(row(bobFiles, 'plan.md').lock?.mine).toBeUndefined();
    await bobFiles.lock(row(bobFiles, 'plan.md'));
    expect(bobFiles.state.toast).toMatchObject({
      tone: 'error',
      errno: 'EBUSY',
      text: '“plan.md” is locked by someone else',
    });
    await a.files.unlock(row(a.files, 'plan.md'));
    expect(a.world.leases.size).toBe(0);
    expect(row(a.files, 'plan.md').lock).toBeUndefined();
  });
});

describe('Files search (RAG-06)', () => {
  it('RAG-06 without ai.semsearch falls back to keyword search with the unavailable notice', async () => {
    const { files, launched } = await open('alice', undefined, true);
    files.setQuery('LRU pager');
    await files.search();
    const s = files.state.search;
    expect(files.state.semanticAvailable).toBe(false);
    expect(s?.mode).toBe('keyword');
    expect(s?.notices).toEqual([{ kind: 'unavailable' }]);
    expect(s?.hits[0]).toMatchObject({
      path: '~/notes/week6-standup.md',
      name: 'week6-standup.md',
      lineStart: 3,
      lineEnd: 3,
      owner: 'alice',
    });
    expect(s?.hits[0]?.highlights.length).toBeGreaterThan(0);
    const first = s?.hits[0];
    if (first === undefined) throw new Error('no hit');
    files.openHit(first);
    expect(launched.at(-1)).toEqual({
      app: 'editor',
      argv: ['/home/alice/notes/week6-standup.md', '+3'],
    });
    files.clearSearch();
    expect(files.state.search).toBeUndefined();
  });

  it('RAG-06 maps ai.semsearch results, scores and the model-loading notice', async () => {
    const h = await open('alice');
    h.world.semsearch = (q, scope, mode): SemsearchResult => ({
      mode: mode === 'keyword' ? 'keyword' : 'semantic',
      model: { key: 'mdbr-leaf-ir-q8@4262131b-384', state: 'loading' },
      results: [
        {
          path: '/home/alice/notes/week6-standup.md',
          ino: h.world.node('/home/alice/notes/week6-standup.md')?.ino ?? '',
          lineStart: 3,
          lineEnd: 4,
          score: 0.83,
          snippet: `We discussed the LRU pager (${q} in ${scope})`,
          verified: 'own',
        },
      ],
      notices: ['1 shared result hidden while offline'],
      timings: { embedMs: 1, filterMs: 1, scanMs: 1, verifyMs: 1, totalMs: 12 },
    });
    await h.files.search('memory paging', '/home/alice');
    const s = h.files.state.search;
    expect(s?.mode).toBe('semantic');
    expect(s?.elapsedMs).toBe(12);
    expect(s?.indexedFiles).toBe(42);
    expect(s?.notices).toEqual([
      { kind: 'model-loading', progress: 0 },
      { kind: 'shared-hidden', count: 1 },
    ]);
    expect(s?.hits[0]).toMatchObject({
      path: '~/notes/week6-standup.md',
      score: 0.83,
      lineStart: 3,
      lineEnd: 4,
    });
    expect(h.files.state.selectedHit).toBe(s?.hits[0]?.id);
    await h.files.selectHit(s?.hits[0]?.id ?? '');
    expect(Object.values(h.files.state.hitEntries)[0]).toMatchObject({ name: 'week6-standup.md' });
    h.files.onEvents([{ topic: 'ai.model', seq: 1, t: 0, data: { state: 'ready' } }]);
    expect(h.files.state.search?.notices[0]).toEqual({ kind: 'model-ready' });
    const call = h.world.calls.find((c) => c.call === 'ai.semsearch');
    expect(call?.args).toMatchObject({ q: 'memory paging', scope: '/home/alice', mode: 'auto' });
  });

  it('RAG-06 the AI-off build searches by keyword without calling ai.semsearch', async () => {
    const h = await open('alice', undefined, false);
    expect(h.files.state.semanticAvailable).toBe(false);
    expect(h.files.state.searchMode).toBe('keyword');
    await h.files.search('swap tiers');
    expect(h.world.calls.some((c) => c.call === 'ai.semsearch')).toBe(false);
    expect(h.files.state.search?.hits[0]?.name).toBe('week6-standup.md');
  });
});
