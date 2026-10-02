import { describe, expect, it } from 'vitest';

import {
  accessFor,
  bestWindow,
  EMPTY_HISTORY,
  highlightRanges,
  isConflictedCopy,
  parseMode,
  placesFor,
  pushHistory,
  queryTerms,
  snippetOf,
  stepBack,
  stepForward,
  uniqueName,
  withBit,
} from '../lib/model.ts';
import { basename, dirname, nameProblem, normalize, relativeTo, tildePath } from '../lib/path.ts';

const ALICE = { uid: 1001, gid: 1001, groups: [1001], user: 'alice', home: '/home/alice' };

describe('Files model', () => {
  it('VFS-07 normalises paths and splits names', () => {
    expect(normalize('../x/./y//z', '/home/alice')).toBe('/home/x/y/z');
    expect(normalize('/..')).toBe('/');
    expect(dirname('/home/alice/a.md')).toBe('/home/alice');
    expect(dirname('/home')).toBe('/');
    expect(basename('/home/alice/a.md')).toBe('a.md');
    expect(tildePath('/home/alice/notes/a.md', '/home/alice')).toBe('~/notes/a.md');
    expect(tildePath('/tmp/x', '/home/alice')).toBe('/tmp/x');
    expect(relativeTo('/home/alice/notes/a.md', '/home/alice')).toBe('notes/a.md');
    expect(nameProblem('a/b')).toBe('A name cannot contain “/”.');
    expect(nameProblem('..')).toBe('That name is reserved.');
    expect(nameProblem('x'.repeat(256))).toBe('That name is too long.');
    expect(nameProblem('ok.md')).toBeUndefined();
  });

  it('VFS-07 gives Trash and paste names that never clash (Finder style)', () => {
    const taken = new Set(['report.md', 'report 2.md', 'notes', 'report copy.md']);
    expect(uniqueName('fresh.md', taken)).toBe('fresh.md');
    expect(uniqueName('report.md', taken)).toBe('report 3.md');
    expect(uniqueName('notes', taken)).toBe('notes 2');
    expect(uniqueName('report.md', taken, 'copy')).toBe('report copy 2.md');
    expect(uniqueName('.bashrc', new Set(['.bashrc']))).toBe('.bashrc 2');
  });

  it('VFS-04 parses octal and symbolic modes for Change Permissions and refuses setuid', () => {
    expect(parseMode('755')).toBe(0o755);
    expect(parseMode('0644')).toBe(0o644);
    expect(parseMode('1777')).toBe(0o1777);
    expect(parseMode('rwxr-x---')).toBe(0o750);
    expect(parseMode('drwxrwxrwt')).toBe(0o1777);
    expect(parseMode('4755')).toBeUndefined();
    expect(parseMode('rwsr-xr-x')).toBeUndefined();
    expect(parseMode('abc')).toBeUndefined();
    expect(withBit(0o644, 'group', 'w', true)).toBe(0o664);
    expect(withBit(0o644, 'owner', 'r', false)).toBe(0o244);
  });

  it('VFS-04 applies owner, group and others bits as the kernel does', () => {
    expect(accessFor({ mode: 0o640, uid: 1001, gid: 1001 }, ALICE)).toEqual({
      r: true,
      w: true,
      x: false,
    });
    expect(accessFor({ mode: 0o640, uid: 1002, gid: 1001 }, ALICE)).toEqual({
      r: true,
      w: false,
      x: false,
    });
    expect(accessFor({ mode: 0o600, uid: 1002, gid: 1002 }, ALICE)).toEqual({
      r: false,
      w: false,
      x: false,
    });
    expect(accessFor({ mode: 0o000, uid: 5, gid: 5 }, { ...ALICE, uid: 0 })).toEqual({
      r: true,
      w: true,
      x: false,
    });
  });

  it('VFS-07 keeps Back and Forward history like a browser', () => {
    let h = pushHistory(EMPTY_HISTORY, '/home/alice');
    h = pushHistory(h, '/home/alice/notes');
    const back = stepBack(h, '/home/alice/notes/os');
    expect(back?.path).toBe('/home/alice/notes');
    const fwd = back === undefined ? undefined : stepForward(back.history, back.path);
    expect(fwd?.path).toBe('/home/alice/notes/os');
    expect(stepForward(EMPTY_HISTORY, '/')).toBeUndefined();
    expect(pushHistory(back?.history ?? EMPTY_HISTORY, '/x').forward).toEqual([]);
  });

  it('VFS-07 lists optional places only when their folders exist', () => {
    const places = placesFor(ALICE, (p) => p === '/home/alice/Documents');
    // UI-115: Home is called Home (D-18), not by the account name.
    expect(places.favourites.map((p) => p.label)).toEqual(['Home', 'Documents']);
    expect(places.locations.map((p) => p.icon)).toEqual(['trash', 'tmp', 'root']);
    expect(places.locations.map((p) => p.path)).toEqual(['/home/alice/.Trash', '/tmp', '/']);
  });

  it('RAG-06 ranks the keyword fallback by the best 3-line window with a citation span', () => {
    const text = 'intro\nthe LRU pager\nevicts pages\nunrelated\nLRU again';
    const w = bestWindow(text, queryTerms('LRU pages'));
    expect(w?.lineStart).toBe(2);
    expect(w?.lineEnd).toBe(3);
    expect(w?.score).toBeGreaterThan(0.8);
    expect(bestWindow('nothing here', ['lru'])).toBeUndefined();
    expect(highlightRanges('The LRU pager', ['lru', 'pager'])).toEqual([
      [4, 7],
      [8, 13],
    ]);
    expect(
      snippetOf('x'.repeat(500) + ' needle ' + 'y'.repeat(500), ['needle']).length,
    ).toBeLessThanOrEqual(240);
    expect(snippetOf('a\n\n  b', [])).toBe('a b');
  });

  it('SYN-08 recognises conflicted copies by their name', () => {
    expect(isConflictedCopy('plan (conflict from alice, 2026-11-14).md')).toBe(true);
    expect(isConflictedCopy('plan.md')).toBe(false);
  });
});
