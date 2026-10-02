/**
 * Files presentation fixes of the polish wave (docs/design/bug-hunt/BUGS.md, fix-files-editor):
 * UI-009, UI-010, UI-052, UI-097, UI-098, UI-107, UI-109, UI-113, UI-114, UI-115, UI-157, UI-158.
 *
 * happy-dom does no layout, so the width rules are checked where they live (the CSS modules,
 * read as text) and the behaviour where the DOM shows it; the screenshots at 640, 720 and
 * 960 px are in docs/design/wave3/fix-files-editor/.
 */
import { fireEvent, render, screen, within } from '@solidjs/testing-library';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import fileListCss from './FileList.module.css?raw';
import filesCss from './Files.module.css?raw';
import { FileGrid } from './FileGrid.tsx';
import { FileList, FILE_COLUMNS } from './FileList.tsx';
import { FilesSidebar } from './FilesSidebar.tsx';
import { FilesToolbar } from './FilesToolbar.tsx';
import { Inspector } from './Inspector.tsx';
import { denyReason, fileMenuItems, openWithItems, ownsEntry } from './menu.ts';
import { foldPath, PathBar, pathSegments, type PathMetrics } from './PathBar.tsx';
import { EMPTY_SELECTION } from './selection.ts';
import type { FileEntry } from './types.ts';

const NOW = new Date(2026, 8, 30, 10, 0).getTime();

function entry(id: string, name: string, extra: Partial<FileEntry> = {}): FileEntry {
  return {
    id,
    name,
    path: `/home/demo/Projects/${name}`,
    type: 'file',
    mode: 0o644,
    size: 2048,
    mtime: NOW - 3_600_000,
    owner: 'demo',
    uid: 1000,
    ...extra,
  };
}

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const m = new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css);
  if (m === null) throw new Error(`no rule ${selector}`);
  return m[1] ?? '';
}

/** Widths: every crumb 60 px, separators 12, the "…" 28, gaps 2. */
const M = (n: number): PathMetrics => ({
  crumbs: Array.from({ length: n }, () => 60),
  separator: 12,
  ellipsis: 28,
  gap: 2,
});

describe('Files list header (UI-009)', () => {
  it('UI-009 header labels truncate inside their column and the chevron stays outside the label', () => {
    render(() => (
      <FileList
        entries={[entry('a', 'kernel.ts')]}
        selection={EMPTY_SELECTION}
        onSelection={() => undefined}
        onAction={() => undefined}
        onMenu={() => undefined}
        label="Projects, 1 item"
        now={NOW}
        sort={{ key: 'name', direction: 'ascending' }}
        onSort={() => undefined}
      />
    ));
    const headers = screen.getAllByRole('columnheader');
    expect(headers.map((h) => h.getAttribute('data-col'))).toEqual(FILE_COLUMNS.map((c) => c.key));
    for (const h of headers) {
      const button = within(h).getByRole('button');
      // The label is its own element (it ellipsises); the chevron is a sibling, not inside it.
      const label = button.firstElementChild;
      expect(label?.textContent).toBe(h.textContent);
      expect(label?.querySelector('svg')).toBeNull();
      expect(button.title).toBe(label?.textContent);
    }
    expect(rule(fileListCss, '.sortLabel')).toMatch(/overflow:\s*hidden/u);
    expect(rule(fileListCss, '.sortLabel')).toMatch(/text-overflow:\s*ellipsis/u);
    expect(rule(fileListCss, '.headCell')).toMatch(/min-width:\s*0/u);
    expect(rule(fileListCss, '.cell')).toMatch(/text-overflow:\s*ellipsis/u);
  });

  it('UI-009 low-priority columns give way as the list narrows: Permissions, Kind, Size, Date', () => {
    const hidden = [
      ...fileListCss.matchAll(/@container files-list \(width < (\d+)px\)\s*\{([\s\S]*?)\n\}/gu),
    ].map((m) => ({
      below: Number(m[1]),
      col: /\[data-col='(\w+)'\]\s*\{\s*display:\s*none/u.exec(m[2] ?? '')?.[1],
    }));
    expect(hidden).toEqual([
      { below: 560, col: 'permissions' },
      { below: 460, col: 'kind' },
      { below: 360, col: 'size' },
      { below: 290, col: 'modified' },
    ]);
    // Name keeps a floor and takes the rest.
    expect(rule(fileListCss, '.list')).toMatch(/--files-cols:\s*minmax\(132px, 1fr\)/u);
  });
});

describe('Files path bar (UI-010, UI-098)', () => {
  const deep = pathSegments('/home/demo/Projects/a-very-long-folder-name');

  it('UI-010 the whole path shows when it fits', () => {
    const fold = foldPath(deep, 2_000, M(deep.length));
    expect(fold.hidden).toEqual([]);
    expect(fold.head.map((s) => s.label)).toEqual([
      '/',
      'home',
      'demo',
      'Projects',
      'a-very-long-folder-name',
    ]);
  });

  it('UI-010 middle folders fold into "…" before the current folder shrinks', () => {
    // Room for "/ › … › Projects › current" but not the whole path.
    const fold = foldPath(deep, 60 * 3 + 28 + 12 * 3 + 2 * 6, M(deep.length));
    expect(fold.head.map((s) => s.label)).toEqual(['/']);
    expect(fold.hidden.map((s) => s.label)).toEqual(['home', 'demo']);
    expect(fold.tail.map((s) => s.label)).toEqual(['Projects', 'a-very-long-folder-name']);
  });

  it('UI-010 the current folder is always drawn, even when nothing else fits', () => {
    for (const avail of [0, 40, 100, 150]) {
      const fold = foldPath(deep, avail, M(deep.length));
      expect(fold.tail.at(-1)?.label).toBe('a-very-long-folder-name');
    }
    expect(foldPath(deep, 0, M(deep.length)).head).toEqual([]);
    // Two segments ('/ › home') never fold.
    expect(foldPath(pathSegments('/home'), 0, M(2)).head.map((s) => s.label)).toEqual([
      '/',
      'home',
    ]);
    // The current crumb is the one that may shrink (with an ellipsis), never to nothing.
    expect(rule(filesCss, '.crumbLast')).toMatch(/flex:\s*0 1 auto/u);
    expect(rule(filesCss, '.crumbButton')).toMatch(/text-overflow:\s*ellipsis/u);
  });

  it('UI-098 the "…" menu opens at its button, not at the top-left of the screen', async () => {
    // happy-dom has no layout: give the page a 1440 × 900 viewport for the placement.
    const html = document.documentElement;
    Object.defineProperty(html, 'clientWidth', { configurable: true, value: 1440 });
    Object.defineProperty(html, 'clientHeight', { configurable: true, value: 900 });
    onTestFinished(() => {
      Reflect.deleteProperty(html, 'clientWidth');
      Reflect.deleteProperty(html, 'clientHeight');
    });
    render(() => (
      <PathBar path="/home/demo/Projects/app/src" onNavigate={() => undefined} maxVisible={3} />
    ));
    const more = screen.getByRole('button', { name: /more folders/u });
    more.getBoundingClientRect = () => DOMRect.fromRect({ x: 300, y: 100, width: 24, height: 20 });
    fireEvent.click(more);
    const menu = await screen.findByRole('menu', { name: 'Hidden folders' });
    expect(menu.style.left).toBe('300px');
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(120);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(document.activeElement).toBe(more);
  });
});

describe('Files toolbar and status bar (UI-052, UI-097, UI-113, UI-157)', () => {
  const toolbar = (): HTMLElement => {
    render(() => (
      <FilesToolbar
        title="Projects"
        path="/home/demo/Projects"
        onNavigate={() => undefined}
        canBack
        canForward={false}
        onBack={() => undefined}
        onForward={() => undefined}
        view="list"
        onView={() => undefined}
        search={{ query: '', onQuery: () => undefined, mode: 'semantic', scope: 'Projects' }}
      />
    ));
    return screen.getByRole('toolbar', { name: 'Files toolbar' });
  };

  it('UI-052 the view switcher keeps its size; the path bar and title give way', () => {
    toolbar();
    const group = screen.getByRole('radiogroup', { name: 'View' });
    expect(group.className).toMatch(/viewSwitch/u);
    expect(rule(filesCss, '.viewSwitch,\n.sortToggle')).toMatch(/flex:\s*none/u);
    expect(rule(filesCss, '.pathBar')).toMatch(/flex:\s*1 1 0/u);
    expect(rule(filesCss, '.title')).toMatch(/flex:\s*0 1 auto/u);
  });

  it('UI-113 the folder title is text, not a second heading beside the window’s', () => {
    const bar = toolbar();
    expect(within(bar).queryByRole('heading')).toBeNull();
    expect(bar.textContent).toContain('Projects');
  });

  it('UI-157 a long search placeholder ends in an ellipsis', () => {
    toolbar();
    expect(screen.getByRole('searchbox').getAttribute('placeholder')).toBe('Search Projects');
    expect(rule(filesCss, '.searchInput')).toMatch(/text-overflow:\s*ellipsis/u);
  });

  it('UI-097 status texts never overlap: the right side ellipsises, the quota gives way', () => {
    expect(rule(filesCss, '.statusEnd')).toMatch(/min-width:\s*0/u);
    expect(rule(filesCss, '.statusEnd')).toMatch(/text-overflow:\s*ellipsis/u);
    expect(rule(filesCss, '.statusStart')).toMatch(/overflow:\s*hidden/u);
    expect(filesCss).toMatch(/@container files-status \(width < 560px\)[\s\S]*?\.statusQuota/u);
  });
});

describe('Files list states and menus (UI-107, UI-109, UI-114, UI-115, UI-158)', () => {
  it('UI-109 a folder under a drag is highlighted as the drop target', () => {
    render(() => (
      <FileList
        entries={[entry('d', 'src', { type: 'dir', mode: 0o755 }), entry('f', 'a.ts')]}
        selection={EMPTY_SELECTION}
        onSelection={() => undefined}
        onAction={() => undefined}
        onMenu={() => undefined}
        label="Projects, 2 items"
        now={NOW}
        dropTarget="d"
        sort={{ key: 'name', direction: 'ascending' }}
        onSort={() => undefined}
      />
    ));
    const rows = document.querySelectorAll('[role="row"][data-id]');
    expect(rows[0]?.className).toMatch(/dropTarget/u);
    expect(rows[1]?.className).not.toMatch(/dropTarget/u);
    expect(fileListCss).toMatch(/\.row\.dropTarget[\s\S]*?box-shadow:\s*inset 0 0 0 2px/u);
  });

  it('UI-114 an empty list is still a grid of rows, and sort buttons are 24 px targets', () => {
    render(() => (
      <FileList
        entries={[]}
        selection={EMPTY_SELECTION}
        onSelection={() => undefined}
        onAction={() => undefined}
        onMenu={() => undefined}
        label="Empty, 0 items"
        now={NOW}
        empty={<h3>This folder is empty</h3>}
        sort={{ key: 'name', direction: 'ascending' }}
        onSort={() => undefined}
      />
    ));
    const grid = screen.getByRole('grid');
    // aria-required-children: every child of a rowgroup is a row, every child of a row a cell.
    for (const group of grid.querySelectorAll('[role="rowgroup"]'))
      for (const child of group.children) expect(child.getAttribute('role')).toBe('row');
    const heading = screen.getByRole('heading', { name: 'This folder is empty' });
    expect(heading.closest('[role="gridcell"]')?.getAttribute('aria-colspan')).toBe('5');
    const sort = rule(fileListCss, '.sortButton');
    expect(sort).toMatch(/min-width:\s*24px/u);
    expect(sort).toMatch(/min-height:\s*24px/u);
  });

  it('UI-107 inside the Trash the menu offers Put Back and Delete Immediately, not Move to Trash', () => {
    const items = fileMenuItems([entry('a', 'old.md')], {
      viewer: { user: 'demo', uid: 1000 },
      folderWritable: true,
      inTrash: true,
    });
    const labels = items.flatMap((i) => ('label' in i && i.label !== undefined ? [i.label] : []));
    expect(labels).toContain('Put Back');
    expect(labels).toContain('Delete Immediately…');
    expect(labels).not.toContain('Move to Trash');
    render(() => (
      <FilesSidebar
        favourites={[]}
        locations={[{ id: 'trash', label: 'Trash', icon: 'trash', path: '/home/demo/.Trash' }]}
        tags={[]}
        onPlace={() => undefined}
      />
    ));
    const trash = screen.getByRole('button', { name: 'Trash' });
    expect(trash.querySelector('svg')?.getAttribute('class')).toMatch(/lucide-trash/u);
  });

  it('UI-115 ownership is decided by uid, so Change Permissions works whatever the name says', () => {
    const mine = entry('a', 'notes.md', { owner: 'demo', uid: 1000 });
    const theirs = entry('b', 'x.md', { owner: 'u1000', uid: 1001 });
    const viewer = { user: 'u1000', uid: 1000 };
    expect(ownsEntry(viewer, mine)).toBe(true);
    expect(ownsEntry(viewer, theirs)).toBe(false);
    expect(denyReason('chmod', [mine], { viewer, folderWritable: true })).toBeUndefined();
    const onAction = vi.fn();
    render(() => <Inspector entries={[mine]} viewer={viewer} now={NOW} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
    expect(onAction).toHaveBeenCalledWith('chmod', mine);
  });

  it('UI-158 every Open With row has an icon, so "Choose…" lines up with the apps', () => {
    const rows = openWithItems([entry('a', 'run.sh')]).filter(
      (i) => i.kind === undefined || i.kind === 'item',
    );
    expect(rows.map((r) => ('label' in r ? r.label : ''))).toEqual([
      'Editor',
      'Terminal',
      'Choose…',
    ]);
    for (const r of rows) expect('icon' in r && r.icon !== undefined).toBe(true);
  });
});

describe('Files focus target for the window manager (UI-018)', () => {
  const props = {
    selection: EMPTY_SELECTION,
    onSelection: () => undefined,
    onAction: () => undefined,
    onMenu: () => undefined,
    label: 'Projects',
    now: NOW,
  };

  it('UI-018 the list marks only its tab-stop row with data-autofocus', () => {
    const { container } = render(() => (
      <FileList
        {...props}
        entries={[entry('a', 'a.md'), entry('b', 'b.md')]}
        sort={{ key: 'name', direction: 'ascending' }}
        onSort={() => undefined}
      />
    ));
    const marked = container.querySelectorAll('[data-autofocus]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.getAttribute('role')).toBe('row');
    expect(marked[0]?.getAttribute('tabindex')).toBe('0');
  });

  it('UI-018 an empty list marks its body, so focus lands in the list, not on a toolbar button', () => {
    const { container } = render(() => (
      <FileList
        {...props}
        entries={[]}
        sort={{ key: 'name', direction: 'ascending' }}
        onSort={() => undefined}
      />
    ));
    const marked = container.querySelectorAll('[data-autofocus]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.getAttribute('role')).toBe('rowgroup');
  });

  it('UI-018 the icon grid marks its tab-stop tile, or the empty listbox', () => {
    const full = render(() => (
      <FileGrid {...props} entries={[entry('a', 'a.md'), entry('b', 'b.md')]} />
    ));
    const tiles = full.container.querySelectorAll('[data-autofocus]');
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.getAttribute('role')).toBe('option');
    expect(tiles[0]?.getAttribute('tabindex')).toBe('0');
    full.unmount();
    const empty = render(() => <FileGrid {...props} entries={[]} />);
    const box = empty.container.querySelectorAll('[data-autofocus]');
    expect(box).toHaveLength(1);
    expect(box[0]?.getAttribute('role')).toBe('listbox');
  });
});
