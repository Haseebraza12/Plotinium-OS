/**
 * Files controller fixes of the polish wave (docs/design/bug-hunt/BUGS.md, fix-files-editor):
 * UI-048 (search fallback), UI-104 (a file already open in an Editor), UI-105 (stale rows),
 * UI-107 (Trash: Undo, Put Back, title), UI-110 (Go-menu places that do not exist), UI-115
 * (Home is called Home).
 */
import type { SemsearchResult } from '@plotinium/protocol';
import { describe, expect, it } from 'vitest';

import { FilesController } from '../lib/controller.ts';
import type { EntryView } from '../lib/model.ts';
import { demoWorld, type FakeWorld } from './fake-sys.ts';

interface Harness {
  world: FakeWorld;
  files: FilesController;
  launched: { app: string; argv: readonly string[] }[];
}

async function open(
  start?: string,
  reveal?: (path: string, line?: number) => Promise<boolean> | undefined,
): Promise<Harness> {
  const w = demoWorld();
  const launched: Harness['launched'] = [];
  const files = new FilesController({
    sys: w.alice,
    now: () => w.world.now,
    launch: (app, argv) => launched.push({ app, argv }),
    aiAvailable: true,
    ...(reveal === undefined ? {} : { reveal }),
  });
  await files.start(start);
  return { world: w.world, files, launched };
}

function row(files: FilesController, name: string): EntryView {
  const found = files.state.rows.find((r) => r.name === name);
  if (found === undefined) throw new Error(`no row ${name} in ${files.state.path}`);
  return found;
}

/** An index that answers nothing: its model state as given, `indexed` files in it. */
function emptyIndex(world: FakeWorld, state: 'ready' | 'loading', indexed: number): void {
  world.indexedFiles = indexed;
  world.semsearch = (_q, _scope, mode): SemsearchResult => ({
    mode: mode === 'keyword' ? 'keyword' : 'semantic',
    model: { key: 'mdbr-leaf-ir-q8@4262131b-384', state },
    results: [],
    notices: [],
    timings: { embedMs: 0, filterMs: 0, scanMs: 0, verifyMs: 0, totalMs: 3 },
  });
}

describe('Files search fallback (UI-048)', () => {
  it('UI-048 an empty index answers with keyword matches and the RAG-06 notice', async () => {
    const h = await open();
    h.world.writeAbs('/home/alice/notes/plan.md', '# Plan\n\n- ship the pager\n', h.world.users[1]);
    emptyIndex(h.world, 'ready', 0);
    await h.files.search('plan', '/home/alice');
    const s = h.files.state.search;
    expect(s?.loading).toBe(false);
    expect(s?.mode).toBe('keyword');
    expect(s?.notices).toEqual([{ kind: 'unavailable' }]);
    expect(s?.hits.map((x) => x.name)).toContain('plan.md');
  });

  it('UI-048 while the model loads the fallback says so, with its progress', async () => {
    const h = await open();
    emptyIndex(h.world, 'loading', 0);
    await h.files.search('pager', '/home/alice');
    const s = h.files.state.search;
    expect(s?.notices[0]).toMatchObject({ kind: 'model-loading' });
    expect(s?.hits.map((x) => x.name)).toEqual(['week6-standup.md']);
  });

  it('UI-048 Keyword mode finds by name even when the index has files but no match', async () => {
    const h = await open();
    h.world.writeAbs('/home/alice/notes/plan.md', 'nothing to see', h.world.users[1]);
    emptyIndex(h.world, 'ready', 12);
    h.files.setSearchMode('keyword');
    await h.files.search('plan', '/home/alice');
    const s = h.files.state.search;
    expect(s?.hits.map((x) => x.name)).toEqual(['plan.md']);
    // The user chose Keyword: no fallback notice.
    expect(s?.notices).toEqual([]);
  });

  it('UI-048 a ready index with files keeps its own empty semantic answer', async () => {
    const h = await open();
    emptyIndex(h.world, 'ready', 12);
    await h.files.search('quantum chromodynamics', '/home/alice');
    const s = h.files.state.search;
    expect(s?.mode).toBe('semantic');
    expect(s?.hits).toEqual([]);
    expect(s?.notices).toEqual([]);
  });
});

describe('Files open (UI-104)', () => {
  it('UI-104 a file an Editor window already shows is revealed there, not launched again', async () => {
    const shown: string[] = [];
    const h = await open('/home/alice/notes', (path, line) => {
      if (path !== '/home/alice/notes/week6-standup.md') return undefined;
      shown.push(`${path}:${String(line ?? 0)}`);
      return Promise.resolve(true);
    });
    await h.files.open(row(h.files, 'week6-standup.md'));
    expect(shown).toEqual(['/home/alice/notes/week6-standup.md:0']);
    expect(h.launched).toEqual([]);
    expect(h.files.state.toast).toBeUndefined();
    // Another file still opens a new Editor.
    h.world.writeAbs('/home/alice/notes/other.md', 'x', h.world.users[1]);
    await h.files.refresh();
    await h.files.open(row(h.files, 'other.md'));
    expect(h.launched).toEqual([{ app: 'editor', argv: ['/home/alice/notes/other.md'] }]);
  });
});

describe('Files listing freshness (UI-105)', () => {
  it('UI-105 a file whose content changed shows its new size after the next poll', async () => {
    const h = await open('/home/alice/notes');
    const before = row(h.files, 'week6-standup.md');
    const version = h.files.state.dirVersion;
    h.world.now += 120_000;
    h.world.writeAbs(
      '/home/alice/notes/week6-standup.md',
      `${'much longer text '.repeat(40)}\n`,
      h.world.users[1],
    );
    await h.files.poll();
    const after = row(h.files, 'week6-standup.md');
    // The folder's version did not move (no entry came or went), the row did.
    expect(h.files.state.dirVersion).toBe(version);
    expect(after.size).toBeGreaterThan(before.size);
    expect(after.mtime).toBeGreaterThan(before.mtime);
    // An unchanged row keeps its object, so the list does not re-render it.
    const again = h.files.state.rows;
    await h.files.poll();
    expect(h.files.state.rows).toBe(again);
  });
});

describe('Files Trash (UI-107)', () => {
  it('UI-107 Move to Trash offers Undo, which puts the items back where they were', async () => {
    const h = await open('/home/alice/notes');
    await h.files.trash([row(h.files, 'week6-standup.md')]);
    expect(h.world.names('/home/alice/notes')).not.toContain('week6-standup.md');
    expect(h.files.state.toast).toMatchObject({
      tone: 'success',
      text: 'Moved 1 item to the Trash',
      action: { id: 'undo-trash', label: 'Undo' },
    });
    await h.files.undoTrash();
    expect(h.world.names('/home/alice/notes')).toContain('week6-standup.md');
    expect(h.files.state.toast?.text).toBe('Put back 1 item');
  });

  it('UI-107 the Trash is titled Trash and Put Back returns an item to its folder', async () => {
    const h = await open('/home/alice/Documents');
    await h.files.trash([row(h.files, 'report.md')]);
    await h.files.goPlace('trash');
    expect(h.files.state.title).toBe('Trash');
    expect(h.files.state.inTrash).toBe(true);
    expect(h.files.state.selectedPlace).toBe('trash');
    await h.files.putBack([row(h.files, 'report.md')]);
    expect(h.world.names('/home/alice/Documents')).toEqual(['report.md']);
    expect(h.files.state.rows.map((r) => r.name)).toEqual([]);
  });
});

describe('Files Trash for a fresh user (UI-084)', () => {
  it('UI-084 a Trash that was never made opens empty instead of a "does not exist" error', async () => {
    const h = await open();
    expect(h.world.names('/home/alice')).not.toContain('.Trash');
    await h.files.goPlace('trash');
    expect(h.files.state.path).toBe('/home/alice/.Trash');
    expect(h.files.state.title).toBe('Trash');
    expect(h.files.state.inTrash).toBe(true);
    expect(h.files.state.error).toBeUndefined();
    expect(h.files.state.rows).toEqual([]);
  });

  it('UI-084 any other missing folder still reports ENOENT', async () => {
    const h = await open();
    await h.files.navigate('/home/alice/no-such-folder');
    expect(h.files.state.error).toMatchObject({ errno: 'ENOENT' });
  });
});

describe('Files places (UI-110, UI-115)', () => {
  it('UI-110 a Go-menu place whose folder does not exist says so', async () => {
    const h = await open();
    const path = h.files.state.path;
    await h.files.goPlace('downloads');
    expect(h.files.state.path).toBe(path);
    expect(h.files.state.toast).toMatchObject({
      text: 'There is no Downloads folder',
      errno: 'ENOENT',
    });
  });

  it('UI-115 the home place is called Home, not by the account name', async () => {
    const h = await open();
    expect(h.files.state.favourites[0]).toMatchObject({
      id: 'home',
      label: 'Home',
      path: '/home/alice',
    });
    // Rows carry the owner's uid, so ownership never depends on a (possibly stale) name.
    expect(row(h.files, 'notes').uid).toBe(1001);
  });
});
