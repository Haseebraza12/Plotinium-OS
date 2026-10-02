import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { createSignal, Show, type JSX } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';

import { FileGrid } from './FileGrid.tsx';
import { FileList, VIRTUALIZE_AT } from './FileList.tsx';
import { FilesSidebar } from './FilesSidebar.tsx';
import { FilesStatusBar, itemsText, searchText } from './FilesStatusBar.tsx';
import { FilesSearch } from './FilesToolbar.tsx';
import { FilesView, type FilesIntent, type FilesResults } from './FilesView.tsx';
import { sortEntries } from './format.ts';
import { Inspector, lockText, type InspectorAction } from './Inspector.tsx';
import type { FileAction } from './menu.ts';
import { PathBar, pathSegments } from './PathBar.tsx';
import { EMPTY_SELECTION, type Selection } from './selection.ts';
import { hitLabel, noticeText, SemanticResults } from './SemanticResults.tsx';
import type { FileEntry, FileSort, SemanticHit } from './types.ts';

const NOW = new Date(2026, 8, 24, 10, 42).getTime();
const day = (d: number, h = 12, m = 0): number => new Date(2026, 8, d, h, m).getTime();

function file(id: string, name: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    id,
    name,
    path: `/home/student/Documents/${name}`,
    type: 'file',
    mode: 0o644,
    size: 4096,
    mtime: day(20),
    owner: 'student',
    uid: 1001,
    group: 'capstone',
    version: 7,
    ...extra,
  };
}

const DOCS: FileEntry[] = [
  file('os', 'os-report.md', { size: 24 * 1024, mtime: day(24, 9, 18) }),
  file('pdf', 'capstone-proposal.pdf', { size: 1.8 * 1024 * 1024, mtime: day(23, 17, 40) }),
  file('design', 'design', { type: 'dir', mode: 0o755, mtime: day(22) }),
  file('kn', 'kernel-notes.txt', {
    mode: 0o600,
    size: 8 * 1024,
    mtime: day(21),
    lock: { holder: 'alice', since: NOW - 120_000 },
  }),
  file('run', 'run.sh', { mode: 0o755, size: 1024, mtime: day(10), sync: 'pending' }),
];

const HITS: SemanticHit[] = [
  {
    id: 'h1',
    path: 'notes/week6-standup.md',
    name: 'week6-standup.md',
    lineStart: 42,
    lineEnd: 51,
    score: 0.94,
    snippet:
      '…Bob found a memory leak in the WindowFrame UI component; listeners were never removed…',
    highlights: [[13, 56]],
    owner: 'student',
    verified: 'own',
  },
  {
    id: 'h2',
    path: 'notes/bugs.log',
    name: 'bugs.log',
    lineStart: 7,
    lineEnd: 7,
    score: 0.76,
    snippet: '…fixed: UI component leak, detached ResizeObserver in taskbar…',
    owner: 'alice',
    verified: 'server',
  },
];

function ListHarness(props: {
  entries?: readonly FileEntry[];
  onAction?: (action: FileAction, ids: readonly string[]) => void;
  onMenu?: (ids: readonly string[]) => void;
  grid?: boolean;
}): JSX.Element {
  const [selection, setSelection] = createSignal<Selection>(EMPTY_SELECTION);
  const [sort, setSort] = createSignal<FileSort>({ key: 'name', direction: 'ascending' });
  const sorted = (): FileEntry[] => sortEntries(props.entries ?? DOCS, sort());
  const common = {
    get entries() {
      return sorted();
    },
    get selection() {
      return selection();
    },
    onSelection: setSelection,
    onAction: (a: FileAction, ids: readonly string[]) => props.onAction?.(a, ids),
    onMenu: (ids: readonly string[]) => props.onMenu?.(ids),
    label: 'Documents, 5 items',
    now: NOW,
  };
  return (
    <Show
      when={props.grid === true}
      fallback={<FileList {...common} sort={sort()} onSort={setSort} />}
    >
      <FileGrid {...common} />
    </Show>
  );
}

const bodyRows = (): HTMLElement[] =>
  screen.getAllByRole('row').filter((r) => r.getAttribute('aria-rowindex') !== '1');
const names = (): string[] =>
  bodyRows().map((r) => within(r).getAllByRole('gridcell')[0]?.textContent ?? '');

describe('UI-FileList', () => {
  it('VFS-07 renders an APG grid with the five sortable columns and folders first', () => {
    render(() => <ListHarness />);
    const grid = screen.getByRole('grid', { name: 'Documents, 5 items' });
    expect(grid.getAttribute('aria-multiselectable')).toBe('true');
    expect(grid.getAttribute('aria-rowcount')).toBe('6');
    const headers = screen.getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent)).toEqual([
      'Name',
      'Date Modified',
      'Size',
      'Kind',
      'Permissions',
    ]);
    expect(headers[0]?.getAttribute('aria-sort')).toBe('ascending');
    expect(names()[0]).toContain('design');
    const kernel = bodyRows().find((r) => r.textContent?.includes('kernel-notes.txt'));
    const cells = within(kernel as HTMLElement).getAllByRole('gridcell');
    expect(cells.map((c) => c.textContent)).toEqual([
      'kernel-notes.txt, locked by alice',
      '21 Sep 2026',
      '8 KB',
      'Plain Text',
      '-rw-------owner read write, group no access, others no access',
    ]);
  });

  it('VFS-07 clicking a header sorts, and again reverses', () => {
    render(() => <ListHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    expect(screen.getAllByRole('columnheader')[2]?.getAttribute('aria-sort')).toBe('ascending');
    expect(names()[1]).toContain('run.sh');
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    expect(screen.getAllByRole('columnheader')[2]?.getAttribute('aria-sort')).toBe('descending');
    expect(names()[1]).toContain('capstone-proposal.pdf');
  });

  it('UI-FileList keyboard: arrows select, Shift extends, Space toggles, Ctrl+A selects all', () => {
    render(() => <ListHarness />);
    const first = bodyRows()[0] as HTMLElement;
    expect(first.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const selected = (): number =>
      bodyRows().filter((r) => r.getAttribute('aria-selected') === 'true').length;
    expect(selected()).toBe(1);
    fireEvent.keyDown(first, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(first, { key: 'ArrowDown', shiftKey: true });
    expect(selected()).toBe(3);
    fireEvent.keyDown(first, { key: ' ' });
    expect(selected()).toBe(2);
    fireEvent.keyDown(first, { key: 'a', ctrlKey: true });
    expect(selected()).toBe(5);
  });

  it('UI-FileList Enter opens, F2 renames and Delete trashes the selection', () => {
    const onAction = vi.fn();
    render(() => <ListHarness onAction={onAction} />);
    const row = bodyRows()[1] as HTMLElement;
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: 'F2' });
    fireEvent.keyDown(row, { key: 'Delete' });
    expect(onAction.mock.calls).toEqual([
      ['open', ['pdf']],
      ['rename', ['pdf']],
      ['trash', ['pdf']],
    ]);
    fireEvent.dblClick(bodyRows()[0] as HTMLElement);
    expect(onAction).toHaveBeenLastCalledWith('open', ['design']);
  });

  it('UI-FileList right-click and Shift+F10 open the menu for the row under them', () => {
    const onMenu = vi.fn();
    render(() => <ListHarness onMenu={onMenu} />);
    const kernel = bodyRows().find((r) =>
      r.textContent?.includes('kernel-notes.txt'),
    ) as HTMLElement;
    fireEvent.contextMenu(kernel);
    expect(onMenu).toHaveBeenLastCalledWith(['kn']);
    expect(kernel.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(kernel, { key: 'F10', shiftKey: true });
    expect(onMenu).toHaveBeenLastCalledWith(['kn']);
  });

  it('DSN-19 lists over 2,000 rows render only the rows in view', () => {
    const many = Array.from({ length: VIRTUALIZE_AT + 500 }, (_, i) =>
      file(`f${i}`, `file-${String(i).padStart(5, '0')}.txt`),
    );
    render(() => <ListHarness entries={many} />);
    expect(screen.getByRole('grid').getAttribute('aria-rowcount')).toBe(String(many.length + 1));
    expect(bodyRows().length).toBeLessThan(200);
    expect(bodyRows()[0]?.getAttribute('aria-rowindex')).toBe('2');
  });
});

describe('UI-FileGrid', () => {
  it('UI-FileGrid is a multi-select listbox of named options with kind and size', () => {
    const onAction = vi.fn();
    render(() => <ListHarness grid onAction={onAction} />);
    const box = screen.getByRole('listbox', { name: 'Documents, 5 items' });
    expect(box.getAttribute('aria-multiselectable')).toBe('true');
    const option = screen.getByRole('option', {
      name: 'capstone-proposal.pdf, PDF Document, 1.8 MB',
    });
    fireEvent.click(option);
    expect(option.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(option, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith('open', ['pdf']);
    expect(screen.getByRole('option', { name: 'design, Folder' })).toBeTruthy();
  });
});

describe('UI-SemanticResults', () => {
  it('RAG-06 cards show citation, marked snippet, relevance meter with number, and owner', () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    render(() => (
      <SemanticResults
        mode="semantic"
        hits={HITS}
        scope="notes"
        elapsedMs={184}
        selected="h1"
        onSelect={onSelect}
        onOpen={onOpen}
      />
    ));
    expect(screen.getByRole('heading', { name: 'Semantic results' })).toBeTruthy();
    expect(screen.getByText('2 files in notes · 184 ms')).toBeTruthy();
    const list = screen.getByRole('listbox', { name: 'Semantic results' });
    const first = screen.getByRole('option', {
      name: 'week6-standup.md, notes/week6-standup.md line 42 to 51, score 0.94, owner student',
    });
    expect(list.getAttribute('aria-activedescendant')).toBe(first.id);
    expect(first.textContent).toContain('notes/week6-standup.md:42-51');
    expect(first.querySelector('mark')?.textContent).toBe(
      'memory leak in the WindowFrame UI component',
    );
    const meter = within(first).getByRole('meter', { name: 'Relevance' });
    expect(meter.getAttribute('aria-valuetext')).toBe('94 percent relevant');
    expect(first.textContent).toContain('0.94');
    expect(hitLabel(HITS[1] as SemanticHit)).toBe(
      'bugs.log, notes/bugs.log line 7, score 0.76, owner alice, shared, verified',
    );
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenCalledWith('h2');
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(HITS[0]);
  });

  it('DSN-09 snippets are text nodes only, never HTML', () => {
    const evil: SemanticHit = {
      ...(HITS[0] as SemanticHit),
      snippet: '<img src=x onerror=alert(1)>',
    };
    render(() => (
      <SemanticResults
        mode="semantic"
        hits={[evil]}
        scope="notes"
        onSelect={() => undefined}
        onOpen={() => undefined}
      />
    ));
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText(/<img src=x/u)).toBeTruthy();
  });

  it('RAG-06 the keyword fallback notice uses the exact strings, with a determinate ring', () => {
    render(() => (
      <SemanticResults
        mode="keyword"
        hits={HITS}
        scope="notes"
        notices={[
          { kind: 'model-loading', progress: 0.6 },
          { kind: 'shared-hidden', count: 1 },
        ]}
        onSelect={() => undefined}
        onOpen={() => undefined}
      />
    ));
    expect(screen.getByRole('heading', { name: 'Keyword results' })).toBeTruthy();
    const status = screen.getAllByRole('status')[0] as HTMLElement;
    expect(status.textContent).toContain('semantic model loading — showing keyword matches');
    expect(status.textContent).toContain('1 shared result hidden while offline');
    const ring = within(status).getByRole('progressbar');
    expect(ring.getAttribute('aria-valuetext')).toBe('Loading search model, 60 percent');
    expect(noticeText({ kind: 'unavailable' })).toBe(
      'Semantic search unavailable — showing keyword matches',
    );
  });

  it('UI-SemanticResults empty, loading and error states', () => {
    const onRetry = vi.fn();
    const [state, setState] = createSignal<'empty' | 'loading' | 'error'>('empty');
    render(() => (
      <SemanticResults
        mode="semantic"
        hits={[]}
        scope="notes"
        loading={state() === 'loading'}
        error={
          state() === 'error'
            ? { code: 'EIO', message: 'The search index is being rebuilt' }
            : undefined
        }
        onRetry={onRetry}
        onSearchAll={() => undefined}
        onSelect={() => undefined}
        onOpen={() => undefined}
      />
    ));
    expect(screen.getByText('No matches in notes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search all of Home' })).toBeTruthy();
    setState('loading');
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    setState('error');
    expect(screen.getByRole('alert').textContent).toContain(
      'The search index is being rebuilt (EIO)',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('UI-FilesInspector', () => {
  it('VFS-09 shows permissions, owner, version and the lock in words', () => {
    const onAction = vi.fn<(action: InspectorAction, entry: FileEntry | undefined) => void>();
    const kn = DOCS[3] as FileEntry;
    render(() => (
      <Inspector entries={[kn]} viewer={{ user: 'student' }} now={NOW} onAction={onAction} />
    ));
    const aside = screen.getByRole('complementary', { name: 'File info' });
    expect(within(aside).getByRole('heading', { name: 'kernel-notes.txt' })).toBeTruthy();
    expect(aside.textContent).toContain('rw-------');
    expect(aside.textContent).toContain('student (uid 1001)');
    expect(aside.textContent).toContain('capstone');
    expect(within(aside).getByRole('status').textContent).toBe('Locked by alice · 2 min ago');
    fireEvent.click(screen.getByRole('button', { name: 'Open read-only' }));
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(['open-in-editor', 'history']);
    expect(lockText(undefined, NOW)).toBe('Unlocked — no editors');
    expect(lockText({ holder: 'student', since: NOW, mine: true }, NOW)).toBe('Locked by you');
  });

  it('UI-FilesInspector nothing selected and several selected', () => {
    const [entries, setEntries] = createSignal<readonly FileEntry[]>([]);
    render(() => (
      <Inspector
        entries={entries()}
        viewer={{ user: 'student' }}
        now={NOW}
        onAction={() => undefined}
      />
    ));
    expect(screen.getByText('Select a file to see its info')).toBeTruthy();
    setEntries(DOCS.slice(0, 2));
    expect(screen.getByRole('heading', { name: '2 items' })).toBeTruthy();
  });
});

describe('UI-FilesChrome', () => {
  it('UI-FilesChrome status bar: items, selection and quota in words and a progress bar', () => {
    render(() => (
      <FilesStatusBar
        items={42}
        quota={{ used: 1.2 * 1024 ** 3, total: 2 * 1024 ** 3 }}
        user="student"
        path="/home/student/Documents"
      />
    ));
    const bar = screen.getByRole('contentinfo');
    expect(bar.textContent).toContain('42 items · 1.2 GB of 2 GB quota used');
    expect(bar.textContent).toContain('student · /home/student/Documents');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe(
      '1.2 GB of 2 GB used',
    );
    expect(itemsText(42, 1, 1.8 * 1024 * 1024)).toBe('1 of 42 selected, 1.8 MB');
    expect(searchText({ results: 4, indexedFiles: 1284, indexer: { pid: 23, priority: 32 } })).toBe(
      '4 results · indexed 1,284 files · ai.indexer pid 23 (PRI 32)',
    );
  });

  it('UI-FilesChrome path bar: breadcrumb buttons, the last is the current location', () => {
    const onNavigate = vi.fn();
    render(() => <PathBar path="/home/student/notes" onNavigate={onNavigate} />);
    const nav = screen.getByRole('navigation', { name: 'Path' });
    const buttons = within(nav).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['/', 'home', 'student', 'notes']);
    expect(buttons[3]?.getAttribute('aria-current')).toBe('location');
    fireEvent.click(buttons[1] as HTMLElement);
    expect(onNavigate).toHaveBeenCalledWith('/home');
    expect(pathSegments('/').map((s) => s.path)).toEqual(['/']);
  });

  it('UI-FilesChrome long paths fold the middle folders into a menu', () => {
    render(() => <PathBar path="/a/b/c/d/e/f" onNavigate={() => undefined} maxVisible={4} />);
    const more = screen.getByRole('button', { name: '4 more folders' });
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    const labels = within(screen.getByRole('navigation'))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toEqual(['/', '…', 'e', 'f']);
  });

  it('RAG-06 search: warm-up on focus, Escape clears then returns focus, mode switch', () => {
    const onFocus = vi.fn();
    const onEscape = vi.fn();
    const onMode = vi.fn();
    const [query, setQuery] = createSignal('memory leak');
    render(() => (
      <FilesSearch
        query={query()}
        onQuery={setQuery}
        mode="semantic"
        onMode={onMode}
        onFocusChange={onFocus}
        onEscape={onEscape}
        scope="notes"
      />
    ));
    const input = screen.getByRole('searchbox', { name: 'Search notes by meaning' });
    fireEvent.focus(input);
    expect(onFocus).toHaveBeenCalledWith(true);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((input as HTMLInputElement).value).toBe('');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledOnce();
    const toggle = screen.getByRole('switch', { name: 'Semantic search' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(onMode).toHaveBeenCalledWith('keyword');
  });

  it('DSN-08 the sidebar pairs every tag dot with its name and toggles filters', () => {
    const onToggle = vi.fn();
    render(() => (
      <FilesSidebar
        favourites={[{ id: 'home', label: 'Home', icon: 'home', path: '/home/student' }]}
        locations={[{ id: 'mnt', label: '/mnt', icon: 'mnt', path: '/mnt', unmounted: true }]}
        tags={[{ id: 'urgent', label: 'urgent', tint: 'red' }]}
        selectedPlace="home"
        onPlace={() => undefined}
        activeTags={new Set(['urgent'])}
        onToggleTag={onToggle}
        quota={{ used: 1.9 * 1024 ** 3, total: 2 * 1024 ** 3 }}
      />
    ));
    const nav = screen.getByRole('navigation', { name: 'Places' });
    expect(within(nav).getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      within(nav).getByRole('button', { name: '/mnt (not mounted)' }).getAttribute('aria-disabled'),
    ).toBe('true');
    const tag = within(nav).getByRole('button', { name: 'urgent' });
    expect(tag.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tag);
    expect(onToggle).toHaveBeenCalledWith('urgent');
    expect(nav.textContent).toContain('Quota full soon');
  });
});

function ViewHarness(props: {
  results?: FilesResults;
  onAction?: (intent: FilesIntent, entries: readonly FileEntry[]) => void;
  error?: { code: string; message: string };
}): JSX.Element {
  const [view, setView] = createSignal<'list' | 'icons' | 'columns' | 'gallery'>('list');
  const [sort, setSort] = createSignal<FileSort>({ key: 'name', direction: 'ascending' });
  const [query, setQuery] = createSignal('');
  return (
    <FilesView
      title="Documents"
      path="/home/student/Documents"
      onNavigate={() => undefined}
      canBack
      canForward={false}
      onBack={() => undefined}
      onForward={() => undefined}
      favourites={[
        { id: 'docs', label: 'Documents', icon: 'documents', path: '/home/student/Documents' },
      ]}
      locations={[]}
      tags={[]}
      selectedPlace="docs"
      onPlace={() => undefined}
      entries={sortEntries(DOCS, sort())}
      error={props.error}
      view={view()}
      onView={setView}
      sort={sort()}
      onSort={setSort}
      viewer={{ user: 'student' }}
      folderWritable
      now={NOW}
      onAction={(intent, entries) => props.onAction?.(intent, entries)}
      query={query()}
      onQuery={setQuery}
      searchMode="semantic"
      onSearchMode={() => undefined}
      results={props.results}
      onOpenHit={() => undefined}
      user="student"
      quota={{ used: 1.2 * 1024 ** 3, total: 2 * 1024 ** 3 }}
    />
  );
}

describe('UI-FilesView', () => {
  it('VFS-07 composes toolbar, sidebar, list, inspector and status bar', () => {
    render(() => <ViewHarness />);
    const toolbar = screen.getByRole('toolbar', { name: 'Files toolbar' });
    // UI-113: the folder title is plain text; the window frame owns the window's heading.
    expect(toolbar.textContent).toContain('Documents');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.getByRole('button', { name: 'Forward' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.getByRole('grid', { name: 'Documents, 5 items' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'File info' })).toBeTruthy();
    fireEvent.click(bodyRows()[1] as HTMLElement);
    expect(screen.getByRole('contentinfo').textContent).toContain('1 of 5 selected, 1.8 MB');
    expect(
      within(screen.getByRole('complementary', { name: 'File info' })).getByRole('heading', {
        name: 'capstone-proposal.pdf',
      }),
    ).toBeTruthy();
  });

  it('VFS-07 the context menu acts on the row, and Lock for Editing names the holder', () => {
    const onAction = vi.fn();
    render(() => <ViewHarness onAction={onAction} />);
    const kernel = bodyRows().find((r) =>
      r.textContent?.includes('kernel-notes.txt'),
    ) as HTMLElement;
    fireEvent.contextMenu(kernel, { clientX: 300, clientY: 200 });
    const menu = screen.getByRole('menu', { name: 'Actions for kernel-notes.txt' });
    const lock = within(menu).getByRole('menuitem', { name: /Lock for Editing/u });
    expect(lock.getAttribute('aria-disabled')).toBe('true');
    expect(lock.textContent).toContain('Locked by alice');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Get Info/u }));
    expect(onAction).toHaveBeenCalledWith('get-info', [DOCS[3]]);
    expect(screen.queryByRole('menu', { name: 'Actions for kernel-notes.txt' })).toBeNull();
  });

  it('VFS-07 Open With opens a follow-up menu and emits the chosen app', () => {
    const onAction = vi.fn();
    render(() => <ViewHarness onAction={onAction} />);
    const run = bodyRows().find((r) => r.textContent?.includes('run.sh')) as HTMLElement;
    fireEvent.contextMenu(run);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open With…' }));
    const openWith = screen.getByRole('menu', { name: 'Open With' });
    fireEvent.click(within(openWith).getByRole('menuitem', { name: 'Terminal' }));
    expect(onAction).toHaveBeenCalledWith('open-with:terminal', [DOCS[4]]);
  });

  it('UI-111 the view switcher offers only the views that exist and swaps list and icons', () => {
    render(() => <ViewHarness />);
    const group = screen.getByRole('radiogroup', { name: 'View' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Icons', 'List']);
    expect(within(group).queryByRole('radio', { name: 'Columns' })).toBeNull();
    expect(within(group).queryByRole('radio', { name: 'Gallery' })).toBeNull();
    fireEvent.click(within(group).getByRole('radio', { name: 'Icons' }));
    expect(screen.getByRole('listbox', { name: 'Documents, 5 items' })).toBeTruthy();
  });

  it('RAG-06 results replace the listing, and the search box controls the results list', () => {
    render(() => (
      <ViewHarness
        results={{
          mode: 'semantic',
          hits: HITS,
          elapsedMs: 184,
          status: { results: 2, indexedFiles: 1284, indexer: { pid: 23, priority: 32 } },
        }}
      />
    ));
    expect(screen.queryByRole('grid')).toBeNull();
    const list = screen.getByRole('listbox', { name: 'Semantic results' });
    expect(screen.getByRole('searchbox').getAttribute('aria-controls')).toBe(list.id);
    expect(screen.getByRole('contentinfo').textContent).toContain(
      '2 results · indexed 1,284 files · ai.indexer pid 23 (PRI 32)',
    );
  });

  it('UI-FilesView aria-controls only points at a list that is on screen', () => {
    render(() => <ViewHarness results={{ mode: 'semantic', hits: [] }} />);
    expect(screen.getByRole('searchbox').hasAttribute('aria-controls')).toBe(false);
  });

  it('UI-FilesView the search box controls the file list when no search is shown', () => {
    render(() => <ViewHarness />);
    const grid = screen.getByRole('grid');
    expect(screen.getByRole('searchbox').getAttribute('aria-controls')).toBe(grid.id);
  });

  it('UI-FilesView a folder that cannot be listed shows an alert with Back', () => {
    render(() => (
      <ViewHarness
        error={{ code: 'EACCES', message: 'You do not have permission to open this folder' }}
      />
    ));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('You do not have permission to open this folder (EACCES)');
    expect(within(alert).getByRole('button', { name: 'Back' })).toBeTruthy();
  });
});
