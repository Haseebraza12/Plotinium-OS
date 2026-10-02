import { describe, expect, it } from 'vitest';

import {
  citation,
  formatAgo,
  formatDate,
  formatSize,
  highlightRuns,
  kindLabel,
  modeString,
  permissionString,
  quotaLevel,
  quotaText,
  sortEntries,
  spokenMode,
} from './format.ts';
import { collectionIntent, type KeyInput } from './keys.ts';
import { denyReason, fileMenuItems, menuLabel, openWithItems, type MenuContext } from './menu.ts';
import {
  clickSelect,
  contextSelect,
  EMPTY_SELECTION,
  keySelect,
  pruneSelection,
  selectAll,
  toggleFocused,
} from './selection.ts';
import type { FileEntry } from './types.ts';

const NOW = new Date(2026, 8, 24, 10, 42).getTime();

function entry(partial: Partial<FileEntry> & Pick<FileEntry, 'id' | 'name'>): FileEntry {
  return {
    path: `/home/student/Documents/${partial.name}`,
    type: 'file',
    mode: 0o644,
    size: 1024,
    mtime: NOW,
    owner: 'student',
    ...partial,
  };
}

const ENTRIES: FileEntry[] = [
  entry({ id: 'os', name: 'os-report.md', size: 24 * 1024 }),
  entry({ id: 'pdf', name: 'capstone-proposal.pdf', size: 1.8 * 1024 * 1024 }),
  entry({ id: 'design', name: 'design', type: 'dir', mode: 0o755 }),
  entry({ id: 'kn', name: 'kernel-notes.txt', mode: 0o600, size: 8 * 1024 }),
  entry({ id: 'run', name: 'run.sh', mode: 0o755, size: 1024 }),
];
const ORDER = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe('UI-FilesFormat', () => {
  it('UI-FilesFormat sizes use base 1024 with one decimal below 10', () => {
    expect(formatSize(0)).toBe('0 bytes');
    expect(formatSize(1)).toBe('1 byte');
    expect(formatSize(24 * 1024)).toBe('24 KB');
    expect(formatSize(4.2 * 1024)).toBe('4.2 KB');
    expect(formatSize(1.8 * 1024 * 1024)).toBe('1.8 MB');
    expect(formatSize(2 * 1024 ** 3)).toBe('2 GB');
  });

  it('UI-FilesFormat dates read Today, Yesterday, then day month year', () => {
    expect(formatDate(new Date(2026, 8, 24, 9, 18).getTime(), NOW)).toBe('Today, 09:18');
    expect(formatDate(new Date(2026, 8, 23, 17, 40).getTime(), NOW)).toBe('Yesterday, 17:40');
    expect(formatDate(new Date(2026, 8, 22, 12, 0).getTime(), NOW)).toBe('22 Sep 2026');
    expect(formatAgo(NOW - 2 * 60_000, NOW)).toBe('2 min ago');
    expect(formatAgo(NOW - 10_000, NOW)).toBe('just now');
  });

  it('VFS-04 modes render symbolically, including setuid, setgid and sticky', () => {
    expect(modeString('file', 0o644)).toBe('-rw-r--r--');
    expect(modeString('dir', 0o755)).toBe('drwxr-xr-x');
    expect(modeString('file', 0o600)).toBe('-rw-------');
    expect(modeString('file', 0o4755)).toBe('-rwsr-xr-x');
    expect(modeString('dir', 0o1777)).toBe('drwxrwxrwt');
    expect(modeString('file', 0o2644)).toBe('-rw-r-Sr--');
    expect(permissionString(0o750)).toBe('rwxr-x---');
  });

  it('DSN-08 the mode is spelled out for screen readers', () => {
    expect(spokenMode(0o644)).toBe('owner read write, group read, others read');
    expect(spokenMode(0o750)).toBe(
      'owner read write execute, group read execute, others no access',
    );
  });

  it('UI-FilesFormat kinds come from the type and extension', () => {
    expect(kindLabel({ type: 'dir', name: 'design' })).toBe('Folder');
    expect(kindLabel({ type: 'file', name: 'capstone-proposal.pdf' })).toBe('PDF Document');
    expect(kindLabel({ type: 'file', name: 'run.sh' })).toBe('Shell Script');
    expect(kindLabel({ type: 'file', name: 'blob' })).toBe('Document');
    expect(kindLabel({ type: 'file', name: 'x.md', kind: 'Notes' })).toBe('Notes');
  });

  it('VFS-07 sorting puts folders first in both directions and is total', () => {
    const asc = sortEntries(ENTRIES, { key: 'name', direction: 'ascending' }).map((e) => e.id);
    expect(asc).toEqual(['design', 'pdf', 'kn', 'os', 'run']);
    const desc = sortEntries(ENTRIES, { key: 'name', direction: 'descending' }).map((e) => e.id);
    expect(desc).toEqual(['design', 'run', 'os', 'kn', 'pdf']);
    const bySize = sortEntries(ENTRIES, { key: 'size', direction: 'descending' }).map((e) => e.id);
    expect(bySize[0]).toBe('design');
    expect(bySize[1]).toBe('pdf');
    const byMode = sortEntries(ENTRIES, { key: 'permissions', direction: 'ascending' });
    expect(byMode.map((e) => e.id)).toEqual(['design', 'kn', 'pdf', 'os', 'run']);
  });

  it('UI-FilesFormat quota levels switch at 80 and 95 percent', () => {
    const total = 2 * 1024 ** 3;
    expect(quotaLevel({ used: total * 0.6, total })).toBe('normal');
    expect(quotaLevel({ used: total * 0.8, total })).toBe('warning');
    expect(quotaLevel({ used: total * 0.96, total })).toBe('danger');
    expect(quotaText({ used: 1.2 * 1024 ** 3, total })).toBe('1.2 GB of 2 GB');
  });

  it('RAG-06 citations use path:start-end and snippets split into marked runs', () => {
    expect(citation('notes/week6-standup.md', 42, 51)).toBe('notes/week6-standup.md:42-51');
    expect(citation('notes/bugs.log', 7, 7)).toBe('notes/bugs.log:7');
    expect(highlightRuns('a leak in b', [[2, 6]])).toEqual([
      { text: 'a ', mark: false },
      { text: 'leak', mark: true },
      { text: ' in b', mark: false },
    ]);
    expect(highlightRuns('abc', [[5, 9]])).toEqual([{ text: 'abc', mark: false }]);
    expect(
      highlightRuns('abcdef', [
        [3, 5],
        [0, 4],
      ]),
    ).toEqual([
      { text: 'abcd', mark: true },
      { text: 'e', mark: true },
      { text: 'f', mark: false },
    ]);
  });
});

describe('UI-FilesSelection', () => {
  it('UI-FilesSelection click selects one, Ctrl toggles, Shift extends from the anchor', () => {
    let s = clickSelect(EMPTY_SELECTION, ORDER, 'b');
    expect([...s.selected]).toEqual(['b']);
    s = clickSelect(s, ORDER, 'e', { shift: true });
    expect([...s.selected]).toEqual(['b', 'c', 'd', 'e']);
    s = clickSelect(s, ORDER, 'c', { toggle: true });
    expect([...s.selected].sort()).toEqual(['b', 'd', 'e']);
    s = clickSelect(s, ORDER, 'a', { shift: true });
    expect([...s.selected]).toEqual(['a', 'b', 'c']);
  });

  it('UI-FilesSelection arrows move and select, Shift extends, Ctrl moves focus only', () => {
    let s = keySelect(EMPTY_SELECTION, ORDER, 'ArrowDown');
    expect(s.focus).toBe('a');
    s = keySelect(s, ORDER, 'ArrowDown', { shift: true });
    s = keySelect(s, ORDER, 'ArrowDown', { shift: true });
    expect([...s.selected]).toEqual(['a', 'b', 'c']);
    s = keySelect(s, ORDER, 'ArrowDown', { toggle: true });
    expect(s.focus).toBe('d');
    expect(s.selected.has('d')).toBe(false);
    s = toggleFocused(s);
    expect(s.selected.has('d')).toBe(true);
    expect(keySelect(s, ORDER, 'End').focus).toBe('g');
    expect(keySelect(s, ORDER, 'ArrowLeft')).toBe(s);
  });

  it('UI-FilesSelection the icon view moves in two dimensions and clamps at the edges', () => {
    const start = clickSelect(EMPTY_SELECTION, ORDER, 'b');
    expect(keySelect(start, ORDER, 'ArrowDown', {}, { columns: 3 }).focus).toBe('e');
    expect(keySelect(start, ORDER, 'ArrowRight', {}, { columns: 3 }).focus).toBe('c');
    expect(keySelect(start, ORDER, 'ArrowUp', {}, { columns: 3 }).focus).toBe('a');
    expect(keySelect(start, ORDER, 'PageDown', {}, { columns: 3, page: 5 }).focus).toBe('g');
  });

  it('UI-FilesSelection select all, context select and pruning', () => {
    const s = selectAll(EMPTY_SELECTION, ORDER);
    expect(s.selected.size).toBe(ORDER.length);
    expect(contextSelect(s, 'c').selected.size).toBe(ORDER.length);
    expect([...contextSelect(clickSelect(s, ORDER, 'a'), 'c').selected]).toEqual(['c']);
    const pruned = pruneSelection(
      { selected: new Set(['a', 'z']), focus: 'z', anchor: 'a' },
      ORDER,
    );
    expect([...pruned.selected]).toEqual(['a']);
    expect(pruned.focus).toBeUndefined();
  });

  it('UI-FilesSelection keys map to selection, actions and the context menu', () => {
    const s = clickSelect(EMPTY_SELECTION, ORDER, 'a');
    expect(collectionIntent(key('Enter'), s, ORDER)).toEqual({ type: 'action', action: 'open' });
    expect(collectionIntent(key('o', { ctrlKey: true }), s, ORDER)).toEqual({
      type: 'action',
      action: 'open',
    });
    expect(collectionIntent(key('I', { metaKey: true }), s, ORDER)).toEqual({
      type: 'action',
      action: 'get-info',
    });
    expect(collectionIntent(key('F2'), s, ORDER)).toEqual({ type: 'action', action: 'rename' });
    expect(collectionIntent(key('Delete'), s, ORDER)).toEqual({ type: 'action', action: 'trash' });
    expect(collectionIntent(key('Backspace', { metaKey: true }), s, ORDER)).toEqual({
      type: 'action',
      action: 'trash',
    });
    expect(collectionIntent(key('F10', { shiftKey: true }), s, ORDER)).toEqual({ type: 'menu' });
    expect(collectionIntent(key('ContextMenu'), s, ORDER)).toEqual({ type: 'menu' });
    const all = collectionIntent(key('a', { ctrlKey: true }), s, ORDER);
    expect(all?.type === 'select' && all.selection.selected.size).toBe(ORDER.length);
    expect(collectionIntent(key('w', { ctrlKey: true }), s, ORDER)).toBeUndefined();
    expect(collectionIntent(key('x'), s, ORDER)).toBeUndefined();
  });
});

describe('UI-FilesMenu', () => {
  const student: MenuContext = { viewer: { user: 'student' }, folderWritable: true };
  const kn = ENTRIES[3] ?? entry({ id: 'kn', name: 'kernel-notes.txt' });

  it('VFS-07 the context menu has every item of the design, in order, with Trash last and red', () => {
    const items = fileMenuItems([kn], student);
    const labels = items.map((i) => (i.kind === 'separator' ? '—' : 'label' in i ? i.label : ''));
    expect(labels).toEqual([
      'Open',
      'Open With…',
      '—',
      'Get Info',
      'Rename',
      'Copy',
      '—',
      'Change Permissions…',
      'Lock for Editing',
      '—',
      'Move to Trash',
    ]);
    const trash = items[items.length - 1];
    expect(trash !== undefined && 'danger' in trash && trash.danger).toBe(true);
    expect(menuLabel([kn])).toBe('Actions for kernel-notes.txt');
    expect(menuLabel(ENTRIES)).toBe('Actions for 5 items');
  });

  it('VFS-04 Change Permissions is only for the owner or root, with the reason otherwise', () => {
    const bob: MenuContext = { viewer: { user: 'bob' }, folderWritable: true };
    expect(denyReason('chmod', [kn], bob)).toBe('Only the owner can change permissions');
    expect(denyReason('chmod', [kn], { ...bob, viewer: { user: 'root', root: true } })).toBe(
      undefined,
    );
    const chmod = fileMenuItems([kn], bob).find((i) => 'id' in i && i.id === 'chmod');
    expect(chmod !== undefined && 'disabled' in chmod && chmod.disabled).toBe(true);
  });

  it('VFS-09 Lock for Editing: disabled while someone else holds it, Unlock when it is mine', () => {
    const lockedByAlice = { ...kn, lock: { holder: 'alice', since: NOW } };
    expect(denyReason('lock', [lockedByAlice], student)).toBe('Locked by alice');
    const mine = { ...kn, lock: { holder: 'student', since: NOW, mine: true } };
    const items = fileMenuItems([mine], student);
    expect(items.some((i) => 'id' in i && i.id === 'unlock')).toBe(true);
    expect(denyReason('lock', [{ ...kn, writable: false }], student)).toBe(
      'You can read this file but not write it',
    );
    expect(denyReason('lock', ENTRIES, student)).toBe('Select one file to lock');
  });

  it('VFS-07 rename and trash need write access to the folder', () => {
    const readOnlyFolder = { ...student, folderWritable: false };
    expect(denyReason('trash', [kn], readOnlyFolder)).toBe('You can’t change items in this folder');
    expect(denyReason('rename', ENTRIES, student)).toBe('Select one item to rename');
    expect(denyReason('open', [{ ...kn, readable: false }], student)).toBe('Permission denied');
    expect(fileMenuItems([kn], { ...student, mac: true })[0]).toMatchObject({
      shortcut: ['⌘', 'O'],
    });
  });

  it('UI-FilesMenu Open With offers Terminal only for shell scripts', () => {
    const run = ENTRIES[4] ?? kn;
    const ids = (list: ReturnType<typeof openWithItems>): string[] =>
      list.flatMap((i) =>
        'id' in i && i.kind !== 'separator' && i.kind !== 'header' ? [i.id ?? ''] : [],
      );
    expect(ids(openWithItems([run]))).toEqual(['editor', 'terminal', 'choose']);
    expect(ids(openWithItems([kn]))).toEqual(['editor', 'choose']);
  });
});
