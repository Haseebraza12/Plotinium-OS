import Check from 'lucide-solid/icons/check';
import ChevronLeft from 'lucide-solid/icons/chevron-left';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import Clock from 'lucide-solid/icons/clock';
import Download from 'lucide-solid/icons/download';
import FileCode from 'lucide-solid/icons/file-code';
import FileJson from 'lucide-solid/icons/file-json';
import FileText from 'lucide-solid/icons/file-text';
import Folder from 'lucide-solid/icons/folder';
import HardDrive from 'lucide-solid/icons/hard-drive';
import House from 'lucide-solid/icons/house';
import ImageIcon from 'lucide-solid/icons/image';
import LayoutGrid from 'lucide-solid/icons/layout-grid';
import List from 'lucide-solid/icons/list';
import Search from 'lucide-solid/icons/search';
import Sparkles from 'lucide-solid/icons/sparkles';
import Users from 'lucide-solid/icons/users';
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  type JSX,
} from 'solid-js';
import { createStore } from 'solid-js/store';

import { Button } from '../../src/primitives/button/Button.tsx';
import type { MenuEntry } from '../../src/primitives/menu/Menu.tsx';
import { SegmentedControl } from '../../src/primitives/segmented-control/SegmentedControl.tsx';
import { Toggle } from '../../src/primitives/toggle/Toggle.tsx';
import {
  ControlCentre,
  Dock,
  MenuBar,
  NotificationCenter,
  NotificationToasts,
  Wallpaper,
  WindowFrame,
  type DockApi,
  type DockItem,
  type MenuBarMenu,
  type NetView,
  type ResizeEdge,
  type ShellNotification,
  type StatusItemId,
  type SvcView,
  type ThemeChoice,
  type WindowOverlay,
  type WindowPhase,
  type WindowState,
} from '../../src/shell/index.ts';
import { Page, Section } from '../kit.tsx';
import type { GalleryPageMeta } from '../types.ts';
import styles from './shell.module.css';

export const meta: GalleryPageMeta = {
  id: 'shell',
  title: 'Desktop shell',
  group: 'Shell',
  order: 1,
  description:
    'Wallpaper, menu bar, dock, window chrome, Control Centre and notifications, composed as a working desktop in both themes.',
};

// ---------------------------------------------------------------------------------------------
// Sample data (the Stitch references: desktop-dark, desktop-light, control-centre-notifications)
// ---------------------------------------------------------------------------------------------

/** Thu 24 Sep 2026 10:42, shown in UTC so the gallery matches the references everywhere. */
const NOW = Date.UTC(2026, 8, 24, 10, 42, 0);
const CLOCK = { timeZone: 'UTC' } as const;
const MENUBAR_H = 28;
const DOCK_RESERVE = 84;
const THEMES: readonly ThemeChoice[] = ['dark', 'light'];

type AppId = 'files' | 'terminal' | 'editor' | 'task-manager' | 'settings' | 'search';

const DOCK_APPS: readonly { id: AppId; label: string }[] = [
  { id: 'files', label: 'Files' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'editor', label: 'Editor' },
  { id: 'task-manager', label: 'Task Manager' },
  { id: 'settings', label: 'Settings' },
  { id: 'search', label: 'Search' },
];

const SERVICE_NAMES = [
  'init',
  'sched',
  'vfs',
  'syncd',
  'lockd',
  'ai.indexer',
  'terminal',
  'files',
  'wm',
];
const HEALTHY: readonly SvcView[] = SERVICE_NAMES.map((name) => ({
  name,
  state: 'running',
  attempts: 0,
}));
const DEGRADED: readonly SvcView[] = [
  ...HEALTHY.filter((s) => s.name !== 'syncd' && s.name !== 'lockd'),
  {
    name: 'sync',
    state: 'degraded',
    reason: 'backend unreachable',
    attempts: 3,
    nextRetryAt: NOW + 4000,
  },
  { name: 'lockd', state: 'blocked', blockedBy: 'sync', attempts: 0 },
];

const NET_CYCLE: readonly NetView[] = [
  { state: 'LIVE' },
  { state: 'SYNCING', ops: 3 },
  { state: 'OFFLINE', queued: 3 },
  { state: 'RECONNECTING', retryAt: NOW + 4000 },
  { state: 'AUTH_REQUIRED', queued: 3 },
];

const NOTIFICATIONS: readonly ShellNotification[] = [
  {
    id: 'lock',
    level: 'info',
    title: 'Lock granted — report.md',
    body: 'You hold the edit lock now · alice released it',
    app: 'editor',
    appName: 'Editor',
    at: NOW - 10_000,
    unread: true,
  },
  {
    id: 'update',
    level: 'info',
    title: 'Restart to update',
    body: 'Plotinium 0.3.1 is ready. Your windows will be restored.',
    app: 'settings',
    appName: 'Settings',
    at: NOW - 2 * 60_000,
    unread: true,
    actions: [
      { id: 'later', label: 'Later' },
      { id: 'restart', label: 'Restart', kind: 'primary' },
    ],
  },
  {
    id: 'index',
    level: 'success',
    title: 'Semantic index up to date',
    body: '1,284 files in /home/student · 0 errors',
    app: 'search',
    appName: 'Search',
    at: NOW - 9 * 60_000,
  },
  {
    id: 'conflict',
    level: 'warning',
    title: 'Conflict saved as copy',
    body: 'Your version was kept as',
    code: 'report (conflict from bob).md',
    app: 'files',
    appName: 'Files',
    at: NOW - 14 * 60_000,
    actions: [{ id: 'show', label: 'Show in Files', kind: 'link' }],
  },
  {
    id: 'copied',
    level: 'success',
    title: 'Copied 3 items to /tmp',
    app: 'files',
    appName: 'Files',
    at: NOW - 20 * 60_000,
  },
  {
    id: 'moved',
    level: 'info',
    title: 'Moved lab3-paging.md to Trash',
    app: 'files',
    appName: 'Files',
    at: NOW - 26 * 60_000,
  },
];

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[…]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
}

const SHORTCUTS: Record<string, readonly string[]> = {
  'New Window': ['Ctrl', 'N'],
  'Close Window': ['Ctrl', 'W'],
  Undo: ['Ctrl', 'Z'],
  Cut: ['Ctrl', 'X'],
  Copy: ['Ctrl', 'C'],
  Paste: ['Ctrl', 'V'],
  'Select All': ['Ctrl', 'A'],
  Minimise: ['Alt', 'M'],
  Save: ['Ctrl', 'S'],
  Find: ['Ctrl', 'F'],
};

/** A menu from labels; '-' is a separator. */
function menu(id: string, label: string, labels: readonly string[]): MenuBarMenu {
  const items: MenuEntry[] = labels.map((item, index) =>
    item === '-'
      ? { kind: 'separator', id: `${id}-sep-${index}` }
      : { id: slug(item), label: item, shortcut: SHORTCUTS[item] },
  );
  return { id, label, items };
}

const EDIT = menu('edit', 'Edit', ['Undo', '-', 'Cut', 'Copy', 'Paste', 'Select All']);
const WINDOW = menu('window', 'Window', ['Minimise', 'Zoom', '-', 'Bring All to Front']);
const help = (app: string): MenuBarMenu =>
  menu('help', 'Help', [`${app} Help`, 'Keyboard Shortcuts']);

const MENUS: Record<AppId | 'desktop', readonly MenuBarMenu[]> = {
  desktop: [menu('file', 'File', ['New Window']), WINDOW, help('Plotinium')],
  files: [
    menu('file', 'File', ['New Window', 'New Folder', 'Open', '-', 'Close Window']),
    EDIT,
    menu('view', 'View', ['as List', 'as Grid', '-', 'Show Path Bar']),
    menu('go', 'Go', ['Home', 'Documents', 'Recent', '-', 'Go to Folder…']),
    WINDOW,
    help('Files'),
  ],
  terminal: [
    menu('shell', 'Shell', ['New Tab', 'New Window', '-', 'Close Window']),
    EDIT,
    menu('view', 'View', ['Bigger', 'Smaller', 'Reset Size']),
    WINDOW,
    help('Terminal'),
  ],
  editor: [
    menu('file', 'File', ['New Window', 'Open', 'Save', '-', 'Close Window']),
    EDIT,
    menu('format', 'Format', ['Bold', 'Italic', 'Code']),
    menu('view', 'View', ['Write', 'Split', 'Preview']),
    WINDOW,
    help('Editor'),
  ],
  'task-manager': [
    menu('file', 'File', ['Close Window']),
    menu('view', 'View', ['Processes', 'Memory', 'Predictions']),
    WINDOW,
    help('Task Manager'),
  ],
  settings: [
    EDIT,
    menu('view', 'View', ['Appearance', 'Privacy & AI', 'About']),
    WINDOW,
    help('Settings'),
  ],
  search: [WINDOW, help('Search')],
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Win extends Rect {
  id: string;
  app: AppId;
  appName: string;
  title: string;
  z: number;
  state: WindowState;
  open: boolean;
  phase?: WindowPhase;
  genie?: { x: number; y: number };
  flip?: { x: number; y: number; sx: number; sy: number };
  restore?: Rect;
}

const DARK_SCENE: readonly Win[] = [
  {
    id: 'w-tm',
    app: 'task-manager',
    appName: 'Task Manager',
    title: 'Task Manager',
    x: 640,
    y: 352,
    w: 430,
    h: 262,
    z: 1,
    state: 'normal',
    open: true,
  },
  {
    id: 'w-term',
    app: 'terminal',
    appName: 'Terminal',
    title: 'student — zsh — 80×24',
    x: 600,
    y: 44,
    w: 480,
    h: 292,
    z: 2,
    state: 'normal',
    open: true,
  },
  {
    id: 'w-files',
    app: 'files',
    appName: 'Files',
    title: 'notes',
    x: 36,
    y: 72,
    w: 640,
    h: 420,
    z: 3,
    state: 'normal',
    open: true,
  },
];

const LIGHT_SCENE: readonly Win[] = [
  {
    id: 'w-files',
    app: 'files',
    appName: 'Files',
    title: 'notes',
    x: 20,
    y: 44,
    w: 640,
    h: 360,
    z: 1,
    state: 'normal',
    open: true,
  },
  {
    id: 'w-settings',
    app: 'settings',
    appName: 'Settings',
    title: 'Appearance',
    x: 712,
    y: 44,
    w: 380,
    h: 470,
    z: 2,
    state: 'normal',
    open: true,
  },
  {
    id: 'w-editor',
    app: 'editor',
    appName: 'Editor',
    title: 'os-report.md',
    x: 220,
    y: 150,
    w: 620,
    h: 430,
    z: 3,
    state: 'normal',
    open: true,
  },
];

// ---------------------------------------------------------------------------------------------
// Sample app contents (placeholders for the apps' own views)
// ---------------------------------------------------------------------------------------------

const FILE_ROWS: readonly {
  name: string;
  size: string;
  kind: string;
  modified: string;
  icon: 'md' | 'pdf' | 'txt' | 'dir' | 'json' | 'png';
}[] = [
  { name: 'os-report.md', size: '18 KB', kind: 'Markdown', modified: 'Today 10:31', icon: 'md' },
  {
    name: 'scheduler-notes.md',
    size: '6 KB',
    kind: 'Markdown',
    modified: 'Yesterday 22:14',
    icon: 'md',
  },
  { name: 'vfs-design.pdf', size: '1.2 MB', kind: 'PDF', modified: '22 Sep', icon: 'pdf' },
  { name: 'boot-log.txt', size: '4 KB', kind: 'Text', modified: 'Today 09:58', icon: 'txt' },
  { name: 'dsa', size: '—', kind: 'Folder', modified: '21 Sep', icon: 'dir' },
  { name: 'screenshots', size: '—', kind: 'Folder', modified: '20 Sep', icon: 'dir' },
  { name: 'ai-index.json', size: '88 KB', kind: 'JSON', modified: 'Today 10:40', icon: 'json' },
  { name: 'lab3-paging.md', size: '9 KB', kind: 'Markdown', modified: '19 Sep', icon: 'md' },
  { name: 'kernel-panic.png', size: '240 KB', kind: 'PNG image', modified: '17 Sep', icon: 'png' },
  { name: 'todo.txt', size: '1 KB', kind: 'Text', modified: '16 Sep', icon: 'txt' },
];

function FileGlyph(props: { kind: (typeof FILE_ROWS)[number]['icon'] }): JSX.Element {
  return (
    <Switch fallback={<FileText size={15} aria-hidden="true" />}>
      <Match when={props.kind === 'dir'}>
        <Folder size={15} aria-hidden="true" />
      </Match>
      <Match when={props.kind === 'json'}>
        <FileJson size={15} aria-hidden="true" />
      </Match>
      <Match when={props.kind === 'png'}>
        <ImageIcon size={15} aria-hidden="true" />
      </Match>
      <Match when={props.kind === 'md'}>
        <FileCode size={15} aria-hidden="true" />
      </Match>
    </Switch>
  );
}

function FilesToolbar(): JSX.Element {
  return (
    <div class={styles.filesToolbar}>
      <span class={styles.capsule}>
        <button type="button" aria-label="Back">
          <ChevronLeft size={15} aria-hidden="true" />
        </button>
        <button type="button" aria-label="Forward" disabled>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </span>
      <span class={styles.path}>
        <b>notes</b>
        <span>/home/student/notes</span>
      </span>
      <span class={styles.spacer} />
      <span class={styles.capsule} aria-hidden="true">
        <button type="button" tabindex={-1}>
          <List size={15} />
        </button>
        <button type="button" tabindex={-1}>
          <LayoutGrid size={15} />
        </button>
      </span>
      <span class={styles.search}>
        <Search size={13} aria-hidden="true" />
        Search in notes
      </span>
    </div>
  );
}

function FilesContent(): JSX.Element {
  const side = (icon: JSX.Element, label: string, selected = false): JSX.Element => (
    <span class={styles.sideItem} classList={{ [styles.sideSelected ?? '']: selected }}>
      {icon}
      {label}
    </span>
  );
  return (
    <div class={styles.files}>
      <nav class={styles.sidebar} aria-label="Places">
        <span class={styles.sideHead}>Favourites</span>
        {side(<House size={15} aria-hidden="true" />, 'Home', true)}
        {side(<FileText size={15} aria-hidden="true" />, 'Documents')}
        {side(<Download size={15} aria-hidden="true" />, 'Downloads')}
        {side(<Clock size={15} aria-hidden="true" />, 'Recent')}
        <span class={styles.sideHead}>Locations</span>
        {side(<HardDrive size={15} aria-hidden="true" />, '/')}
        {side(<Folder size={15} aria-hidden="true" />, '/tmp')}
        {side(<Users size={15} aria-hidden="true" />, 'Shared')}
        <span class={styles.sideHead}>Tags</span>
        {side(
          <span class={styles.tagDot} style={{ background: 'var(--pl-tint-indigo)' }} />,
          'Report',
        )}
        {side(<span class={styles.tagDot} style={{ background: 'var(--pl-tint-green)' }} />, 'DSA')}
        {side(
          <span class={styles.tagDot} style={{ background: 'var(--pl-tint-orange)' }} />,
          'Kernel',
        )}
      </nav>
      <div class={styles.listPane}>
        <div class={styles.listHead} aria-hidden="true">
          <span>Name</span>
          <span>Size</span>
          <span>Kind</span>
          <span>Modified</span>
        </div>
        <div class={styles.listBody}>
          <For each={FILE_ROWS}>
            {(row, index) => (
              <div class={styles.listRow} classList={{ [styles.rowSelected ?? '']: index() === 0 }}>
                <span class={styles.fileName}>
                  <FileGlyph kind={row.icon} />
                  <span class={styles.fileLabel}>{row.name}</span>
                </span>
                <span>{row.size}</span>
                <span>{row.kind}</span>
                <span>{row.modified}</span>
              </div>
            )}
          </For>
        </div>
        <div class={styles.statusStrip}>
          <span>11 items</span>·<span>3.1 GB available</span>·
          <span class={styles.ok}>
            <Check size={12} aria-hidden="true" />
            Synced
          </span>
        </div>
      </div>
    </div>
  );
}

function TerminalContent(): JSX.Element {
  const line = (
    mode: string,
    links: string,
    owner: string,
    size: string,
    date: string,
    name: JSX.Element,
  ): JSX.Element => (
    <>
      <span class={styles.dim}>{mode}</span>
      {`  ${links} ${owner}  ${size} ${date} `}
      {name}
      {'\n'}
    </>
  );
  return (
    <>
      <div class={styles.termTabs}>
        <span class={styles.termTab}>zsh — student</span>
      </div>
      <pre class={styles.terminal} aria-label="Terminal output">
        <span class={styles.prompt}>student@plotinium:~$</span> ls -la{'\n'}
        total 48{'\n'}
        {line('drwxr-xr-x', '6', 'student staff', '4096', 'Sep 24 10:31', '.')}
        {line('drwxr-xr-x', '4', 'root    root ', '4096', 'Sep 20 08:00', '..')}
        {line('-rw-r--r--', '1', 'student staff', ' 220', 'Sep 20 08:00', '.profile')}
        {line(
          'drwxr-xr-x',
          '3',
          'student staff',
          '4096',
          'Sep 24 10:31',
          <span class={styles.dir}>notes</span>,
        )}
        {line(
          'drwxr-xr-x',
          '2',
          'student staff',
          '4096',
          'Sep 21 17:02',
          <span class={styles.dir}>dsa</span>,
        )}
        {line('-rw-r--r--', '1', 'student staff', '4011', 'Sep 24 09:58', 'boot-log.txt')}
        <span class={styles.prompt}>student@plotinium:~$</span> <span class={styles.cursor} />
      </pre>
    </>
  );
}

const PROCS: readonly [pid: number, name: string, prio: number, cpu: string][] = [
  [1, 'init', 0, '0.1%'],
  [2, 'sched', 0, '1.8%'],
  [7, 'vfs', 4, '2.4%'],
  [12, 'syncd', 8, '0.9%'],
  [23, 'ai.indexer', 32, '9.6%'],
  [41, 'terminal', 12, '3.1%'],
  [44, 'files', 12, '5.2%'],
];

function TaskManagerContent(): JSX.Element {
  return (
    <div class={styles.tm}>
      <div class={styles.cards}>
        <div class={styles.card}>
          <div class={styles.cardKey}>CPU</div>
          <div class={styles.cardValue}>
            23% <small>4 workers</small>
          </div>
          <svg
            class={styles.spark}
            viewBox="0 0 200 30"
            preserveAspectRatio="none"
            role="img"
            aria-label="CPU 23%, steady"
          >
            <polyline
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              points="0,22 12,20 24,23 36,17 48,19 60,14 72,18 84,12 96,16 108,11 120,15 132,13 144,18 156,12 168,16 180,14 200,17"
            />
          </svg>
        </div>
        <div class={styles.card}>
          <div class={styles.cardKey}>Memory</div>
          <div class={styles.cardValue}>
            142 <small>of 256 MB</small>
          </div>
          <div class={styles.groupLabel}>Swap 12 MB · 3 pages out</div>
        </div>
      </div>
      <div class={styles.procs} role="table" aria-label="Processes">
        <div class={`${styles.proc} ${styles.procHead}`} role="row">
          <span role="columnheader">PID</span>
          <span role="columnheader">Name</span>
          <span role="columnheader" class={styles.num}>
            Prio
          </span>
          <span role="columnheader" class={styles.num}>
            CPU
          </span>
        </div>
        <For each={PROCS}>
          {([pid, name, prio, cpu]) => (
            <div
              class={styles.proc}
              classList={{ [styles.procHot ?? '']: name === 'ai.indexer' }}
              role="row"
            >
              <span role="cell">{pid}</span>
              <b role="cell">{name}</b>
              <span role="cell" class={styles.num}>
                {prio}
              </span>
              <span role="cell" class={styles.num}>
                {cpu}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

function EditorToolbar(): JSX.Element {
  const [mode, setMode] = createSignal<'write' | 'split' | 'preview'>('split');
  return (
    <div class={styles.editorBar}>
      <span class={styles.editorTitle}>
        <b>os-report.md</b>
        <span>~/notes · Edited</span>
      </span>
      <span class={styles.spacer} />
      <SegmentedControl
        size="sm"
        label="Editor mode"
        value={mode()}
        onChange={setMode}
        options={[
          { value: 'write', label: 'Write' },
          { value: 'split', label: 'Split' },
          { value: 'preview', label: 'Preview' },
        ]}
      />
      <Button size="sm" variant="primary" icon={<Sparkles size={13} />}>
        Ask AI
      </Button>
    </div>
  );
}

function EditorContent(): JSX.Element {
  return (
    <div class={styles.editor}>
      <pre class={styles.source}>
        <span class={styles.heading}>## 2 Process Scheduler</span>
        {'\n\n'}Plotinium uses a <span class={styles.dim}>**</span>multilevel feedback queue
        <span class={styles.dim}>**</span> with 32 priority levels. Long jobs sink; interactive ones
        rise.
        {'\n\n'}- `ai.indexer` runs at priority 32 (lowest) so it never blocks the UI.{'\n'}-
        `sched` (pid 2) rebalances every 10 ms.
      </pre>
      <div class={styles.preview}>
        <h3>2 Process Scheduler</h3>
        <p>
          Plotinium uses a <b>multilevel feedback queue</b> with 32 priority levels. Long jobs sink;
          interactive ones rise.
        </p>
        <p>
          <code>ai.indexer</code> runs at priority 32 (lowest) so it never blocks the UI;{' '}
          <code>sched</code> (pid 2) rebalances every 10 ms.
        </p>
      </div>
    </div>
  );
}

function SettingsContent(props: {
  theme: ThemeChoice;
  onTheme: (theme: ThemeChoice) => void;
}): JSX.Element {
  const [reduceTransparency, setReduceTransparency] = createSignal(false);
  return (
    <div class={styles.settings}>
      <h3>Appearance</h3>
      <div class={styles.group}>
        <SegmentedControl
          label="Theme"
          value={props.theme}
          onChange={(theme) => props.onTheme(theme)}
          fullWidth
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </div>
      <div class={styles.group}>
        <span class={styles.groupLabel}>Accent colour</span>
        <div class={styles.swatches} aria-hidden="true">
          <span
            class={`${styles.swatch} ${styles.swatchOn}`}
            style={{ background: 'var(--pl-tint-indigo)' }}
          />
          <span class={styles.swatch} style={{ background: 'var(--pl-tint-blue)' }} />
          <span class={styles.swatch} style={{ background: 'var(--pl-tint-purple)' }} />
          <span class={styles.swatch} style={{ background: 'var(--pl-tint-pink)' }} />
          <span class={styles.swatch} style={{ background: 'var(--pl-tint-orange)' }} />
          <span class={styles.swatch} style={{ background: 'var(--pl-tint-green)' }} />
          <span class={styles.swatch} style={{ background: 'var(--pl-tint-gray)' }} />
        </div>
      </div>
      <div class={styles.group}>
        <Toggle
          label="Reduce transparency"
          description="Glass becomes solid"
          checked={reduceTransparency()}
          onChange={setReduceTransparency}
        />
      </div>
    </div>
  );
}

function AppContent(props: {
  app: AppId;
  theme: ThemeChoice;
  onTheme: (theme: ThemeChoice) => void;
}): JSX.Element {
  return (
    <Switch>
      <Match when={props.app === 'files'}>
        <FilesContent />
      </Match>
      <Match when={props.app === 'terminal'}>
        <TerminalContent />
      </Match>
      <Match when={props.app === 'task-manager'}>
        <TaskManagerContent />
      </Match>
      <Match when={props.app === 'editor'}>
        <EditorContent />
      </Match>
      <Match when={props.app === 'settings'}>
        <SettingsContent theme={props.theme} onTheme={(theme) => props.onTheme(theme)} />
      </Match>
    </Switch>
  );
}

function toolbarFor(app: AppId): JSX.Element | undefined {
  if (app === 'files') return <FilesToolbar />;
  if (app === 'editor') return <EditorToolbar />;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Gallery settings bridge: Control Centre's Reduced motion drives the gallery's own toggle
// ---------------------------------------------------------------------------------------------

function setGalleryParam(key: string, value: string | null): void {
  const raw = location.hash.replace(/^#\/?/u, '');
  const [path = '', query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  if (value === null) params.delete(key);
  else params.set(key, value);
  const next = params.toString();
  location.hash = `#/${path}${next === '' ? '' : `?${next}`}`;
}

function createReducedMotion(): () => boolean {
  const read = (): boolean => document.documentElement.dataset.motion === 'reduce';
  const [reduced, setReduced] = createSignal(read());
  onMount(() => {
    const observer = new MutationObserver(() => setReduced(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-motion'],
    });
    onCleanup(() => observer.disconnect());
  });
  return reduced;
}

function systemReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------------------------------------------------------------------------------------------
// The desktop: a small compositor stand-in so every chrome state can be tried by hand
// ---------------------------------------------------------------------------------------------

function flipBetween(from: Rect, to: Rect): Win['flip'] {
  return {
    x: from.x - to.x,
    y: from.y - to.y,
    sx: to.w === 0 ? 1 : from.w / to.w,
    sy: to.h === 0 ? 1 : from.h / to.h,
  };
}

function Desktop(props: { scene: ThemeChoice }): JSX.Element {
  const scene = untrack(() => props.scene);
  const uid = createUniqueId();
  const ccId = `gallery-cc-${uid}`;
  const [theme, setTheme] = createSignal<ThemeChoice>(scene);
  const [wins, setWins] = createStore<Win[]>(
    (scene === 'dark' ? DARK_SCENE : LIGHT_SCENE).map((w) => ({ ...w })),
  );
  const [focusedId, setFocusedId] = createSignal<string | undefined>(
    scene === 'dark' ? 'w-files' : 'w-editor',
  );
  const [dragging, setDragging] = createSignal<string>();
  const [launching, setLaunching] = createSignal<string>();
  const [ccOpen, setCcOpen] = createSignal(false);
  const [ccAnchor, setCcAnchor] = createSignal<HTMLElement>();
  const [column, setColumn] = createSignal<HTMLElement>();
  const [netIndex, setNetIndex] = createSignal(0);
  const [budget, setBudget] = createSignal(256);
  const [budgetError, setBudgetError] = createSignal<string>();
  const [focusMode, setFocusMode] = createSignal(false);
  const [frameMeter, setFrameMeter] = createSignal(false);
  const [notes, setNotes] = createSignal<readonly ShellNotification[]>(NOTIFICATIONS.slice(0, 5));
  const [log, setLog] = createSignal(
    'Click a window, drag its title bar, try the traffic lights and the dock.',
  );
  const reduced = createReducedMotion();
  const frames = new Map<string, HTMLElement>();
  let stage: HTMLDivElement | undefined;
  let dock: DockApi | undefined;
  let launchTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(launchTimer));

  const net = (): NetView => NET_CYCLE[netIndex() % NET_CYCLE.length] ?? { state: 'LIVE' };
  const byId = (id: string): Win | undefined => wins.find((w) => w.id === id);
  const focused = createMemo(() => {
    const id = focusedId();
    return id === undefined ? undefined : byId(id);
  });
  const topZ = (): number => wins.reduce((z, w) => Math.max(z, w.z), 0);

  const focusWin = (id: string): void => {
    if (focusedId() !== id) setWins((w) => w.id === id, 'z', topZ() + 1);
    setFocusedId(id);
  };
  const focusTopmost = (): void => {
    const next = wins
      .filter((w) => w.open && w.state !== 'minimised' && w.phase === undefined)
      .reduce<Win | undefined>(
        (best, w) => (best === undefined || w.z > best.z ? w : best),
        undefined,
      );
    setFocusedId(next?.id);
  };

  /** Dock icon centre minus the window's bottom centre (the genie keyframes' origin). */
  const genieFor = (win: Win): { x: number; y: number } => {
    const el = frames.get(win.id);
    const icon = dock?.getIconRect(win.app);
    if (el === undefined || icon === undefined) return { x: 0, y: 400 };
    const r = el.getBoundingClientRect();
    return {
      x: icon.x + icon.width / 2 - (r.x + r.width / 2),
      y: icon.y + icon.height / 2 - r.bottom,
    };
  };

  const flashLaunch = (app: string): void => {
    setLaunching(app);
    clearTimeout(launchTimer);
    launchTimer = setTimeout(() => setLaunching(undefined), 700);
  };

  const close = (id: string): void => {
    setWins((w) => w.id === id, 'phase', 'closing');
    setLog(`Close ${byId(id)?.appName ?? id}`);
  };
  const minimise = (id: string): void => {
    const win = byId(id);
    if (win === undefined) return;
    setWins((w) => w.id === id, { phase: 'minimising', genie: genieFor(win) });
    setLog(`Minimise ${win.appName} into the dock`);
  };
  const toggleMaximise = (id: string): void => {
    const win = byId(id);
    if (win === undefined || stage === undefined) return;
    if (win.state === 'maximised') {
      const to = win.restore ?? { x: 80, y: 80, w: 560, h: 380 };
      setWins((w) => w.id === id, {
        ...to,
        state: 'normal',
        phase: 'unmaximising',
        flip: flipBetween(win, to),
        restore: undefined,
      });
    } else {
      const to = {
        x: 0,
        y: MENUBAR_H,
        w: stage.clientWidth,
        h: stage.clientHeight - MENUBAR_H - DOCK_RESERVE,
      };
      setWins((w) => w.id === id, {
        ...to,
        state: 'maximised',
        phase: 'maximising',
        flip: flipBetween(win, to),
        restore: { x: win.x, y: win.y, w: win.w, h: win.h },
      });
    }
    focusWin(id);
  };
  const phaseEnd = (id: string, phase: WindowPhase): void => {
    if (phase === 'minimising') {
      setWins((w) => w.id === id, { state: 'minimised', phase: undefined });
      focusTopmost();
    } else if (phase === 'closing') {
      setWins((w) => w.id === id, { open: false, phase: undefined, state: 'normal' });
      focusTopmost();
    } else {
      setWins((w) => w.id === id, 'phase', undefined);
    }
  };

  const activate = (app: string): void => {
    const win = wins.find((w) => w.app === app);
    if (win === undefined) {
      flashLaunch(app);
      setLog(`Launch ${app} (no window in this scene)`);
      return;
    }
    if (!win.open) {
      setWins((w) => w.id === win.id, { open: true, state: 'normal', phase: 'opening' });
      flashLaunch(app);
      focusWin(win.id);
      setLog(`Open ${win.appName}`);
    } else if (win.state === 'minimised') {
      setWins((w) => w.id === win.id, {
        state: 'normal',
        phase: 'restoring',
        genie: genieFor(win),
      });
      focusWin(win.id);
      setLog(`Restore ${win.appName} from the dock`);
    } else {
      focusWin(win.id);
    }
  };

  /** Drag (4 px threshold, WM §3.5) or resize by one edge, clamped under the menu bar. */
  const startGesture = (id: string, edge: ResizeEdge | 'move', event: PointerEvent): void => {
    const win = byId(id);
    if (win === undefined || win.state !== 'normal') return;
    const start = { px: event.clientX, py: event.clientY, x: win.x, y: win.y, w: win.w, h: win.h };
    let active = false;
    const onMove = (e: PointerEvent): void => {
      const dx = e.clientX - start.px;
      const dy = e.clientY - start.py;
      if (!active && Math.hypot(dx, dy) < 4) return;
      active = true;
      setDragging(id);
      if (edge === 'move') {
        setWins((w) => w.id === id, { x: start.x + dx, y: Math.max(MENUBAR_H, start.y + dy) });
        return;
      }
      const next: Rect = { x: start.x, y: start.y, w: start.w, h: start.h };
      if (edge.includes('e')) next.w = Math.max(320, start.w + dx);
      if (edge.includes('s')) next.h = Math.max(200, start.h + dy);
      if (edge.includes('w')) {
        next.w = Math.max(320, start.w - dx);
        next.x = start.x + start.w - next.w;
      }
      if (edge.includes('n')) {
        next.h = Math.max(200, start.h - dy);
        next.y = Math.max(MENUBAR_H, start.y + start.h - next.h);
      }
      setWins((w) => w.id === id, next);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setDragging(undefined);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onMenuSelect = (menuId: string, itemId: string): void => {
    const id = focusedId();
    if (id !== undefined && menuId === 'window' && itemId === 'minimise') minimise(id);
    else if (id !== undefined && menuId === 'window' && itemId === 'zoom') toggleMaximise(id);
    else if (id !== undefined && itemId === 'close-window') close(id);
    else setLog(`Menu intent: ${menuId} → ${itemId}`);
  };

  const onStatus = (item: StatusItemId, anchor: HTMLElement): void => {
    if (item === 'control-centre' || item === 'clock') {
      setCcAnchor(anchor);
      setCcOpen((open) => !open);
      return;
    }
    setLog(`Status item: ${item}`);
  };

  const dockItems = createMemo((): DockItem[] =>
    DOCK_APPS.map((app) => {
      const open = wins.filter((w) => w.app === app.id && w.open);
      return {
        id: app.id,
        label: app.label,
        icon: app.id,
        running: open.length > 0,
        windows: open.length,
        launching: launching() === app.id,
        badge: app.id === 'settings' ? 1 : undefined,
      };
    }),
  );

  const commitBudget = (mb: number): void => {
    if (mb < 142) {
      setBudgetError("Budget can't be below current use (142 MB)");
      return;
    }
    setBudgetError(undefined);
    setBudget(mb);
    setLog(`Memory budget set to ${mb} MB`);
  };

  return (
    <>
      <div class={styles.desktop} data-theme={theme()} ref={(el) => (stage = el)}>
        <Wallpaper />
        <div class={styles.menubarSlot}>
          <MenuBar
            appName={focused()?.appName ?? 'Plotinium'}
            menus={MENUS[focused()?.app ?? 'desktop']}
            net={net()}
            now={NOW}
            clock={CLOCK}
            ai={{ state: 'idle' }}
            memory={{ usedMb: 142, budgetMb: budget() }}
            services={HEALTHY}
            unreadNotifications={notes().filter((n) => n.unread === true).length}
            openStatus={ccOpen() ? 'control-centre' : undefined}
            controlCentreId={ccId}
            onMenuSelect={onMenuSelect}
            onSystemAction={(action) => setLog(`System action: ${action}`)}
            onStatus={onStatus}
          />
        </div>

        <div
          class={styles.windows}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setFocusedId(undefined);
          }}
        >
          <For each={wins}>
            {(win) => (
              <Show when={win.open}>
                <WindowFrame
                  frameRef={(el) => frames.set(win.id, el)}
                  title={win.title}
                  appName={win.appName}
                  focused={focusedId() === win.id}
                  state={win.state}
                  dragging={dragging() === win.id}
                  phase={win.phase}
                  genie={win.genie}
                  flip={win.flip}
                  hideTitle={win.app === 'files' || win.app === 'editor'}
                  toolbar={toolbarFor(win.app)}
                  style={{
                    left: `${win.x}px`,
                    top: `${win.y}px`,
                    width: `${win.w}px`,
                    height: `${win.h}px`,
                    'z-index': String(win.z),
                  }}
                  onFocusRequest={() => focusWin(win.id)}
                  onClose={() => close(win.id)}
                  onMinimise={() => minimise(win.id)}
                  onMaximize={() => toggleMaximise(win.id)}
                  onTitlePointerDown={(event) => startGesture(win.id, 'move', event)}
                  onResizeStart={(edge, event) => startGesture(win.id, edge, event)}
                  onPhaseEnd={(phase) => phaseEnd(win.id, phase)}
                >
                  <AppContent app={win.app} theme={theme()} onTheme={setTheme} />
                </WindowFrame>
              </Show>
            )}
          </For>
        </div>

        <Show when={frameMeter()}>
          <div class={styles.meter} aria-label="Frame meter">
            <b>p95 16.7 ms</b> · 60 Hz · dropped 0.4% · LoAF&gt;50 ours 0 / other 1
          </div>
        </Show>

        <div class={styles.dockSlot}>
          <Dock
            items={dockItems()}
            trash={{ full: true }}
            onActivate={activate}
            onTrash={() => setLog('Open Trash')}
            onItemMenu={(app) => setLog(`Item menu for ${app}`)}
            apiRef={(api) => (dock = api)}
          />
        </div>

        <Show when={ccOpen()}>
          <div class={styles.rightColumn}>
            <ControlCentre
              open={ccOpen()}
              inline
              id={ccId}
              anchor={ccAnchor()}
              companions={[column()]}
              onClose={() => setCcOpen(false)}
              net={net()}
              now={NOW}
              clock={CLOCK}
              lastSyncAt={NOW - 60_000}
              syncQueue={{ pending: net().state === 'OFFLINE' ? 3 : 0 }}
              onOpenSync={() => setNetIndex((i) => i + 1)}
              services={netIndex() % NET_CYCLE.length === 2 ? DEGRADED : HEALTHY}
              onRetryService={(name) => setLog(`Retry ${name} now`)}
              theme={theme()}
              onThemeChange={setTheme}
              reducedMotion={reduced()}
              systemReducedMotion={systemReducedMotion()}
              onReducedMotionChange={(on) => setGalleryParam('motion', on ? 'reduce' : null)}
              memory={{ budgetMb: budget(), usedMb: 142, error: budgetError() }}
              onMemoryBudgetCommit={commitBudget}
              focusMode={focusMode()}
              onFocusModeChange={setFocusMode}
              frameMeter={frameMeter()}
              frameMeterSummary="p95 16.7 ms · 60 Hz"
              onFrameMeterChange={setFrameMeter}
              version="Plotinium 0.3.0 · build a1f93c2"
              onOpenSettings={() => activate('settings')}
            />
            <div class={styles.column} ref={setColumn}>
              <NotificationCenter
                notifications={notes()}
                now={NOW}
                onDismiss={(id) => setNotes((list) => list.filter((n) => n.id !== id))}
                onClearAll={() => setNotes([])}
                onAction={(id, action) => setLog(`Notification ${id} → ${action}`)}
                onOpen={(id) => setLog(`Open notification ${id}`)}
              />
            </div>
          </div>
        </Show>
      </div>
      <p class={styles.log} aria-live="polite">
        <span>Last intent:</span>
        <code>{log()}</code>
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// State sheets
// ---------------------------------------------------------------------------------------------

function Themed(props: { children: (theme: ThemeChoice) => JSX.Element }): JSX.Element {
  return (
    <For each={THEMES}>
      {(theme) => (
        <div class={styles.themeBlock} data-theme={theme}>
          <span class={styles.themeLabel}>{theme === 'dark' ? 'Dark' : 'Light'}</span>
          {props.children(theme)}
        </div>
      )}
    </For>
  );
}

const noop = (): void => undefined;

function MenuBarStates(): JSX.Element {
  const bar = (p: {
    app: string;
    menus: readonly MenuBarMenu[];
    net: NetView;
    usedMb: number;
    services: readonly SvcView[];
    ai: 'idle' | 'indexing' | 'off' | 'error';
  }): JSX.Element => (
    <div class={styles.barFrame}>
      <MenuBar
        appName={p.app}
        menus={p.menus}
        net={p.net}
        now={NOW}
        clock={CLOCK}
        ai={{ state: p.ai, progress: 0.42, detail: 'quota reached' }}
        memory={{ usedMb: p.usedMb, budgetMb: 256 }}
        services={p.services}
        unreadNotifications={p.app === 'Files' ? 0 : 3}
        onMenuSelect={noop}
        onSystemAction={noop}
        onStatus={noop}
      />
    </div>
  );
  return (
    <Themed>
      {() => (
        <div class={styles.bars}>
          {bar({
            app: 'Files',
            menus: MENUS.files,
            net: { state: 'LIVE' },
            usedMb: 142,
            services: HEALTHY,
            ai: 'idle',
          })}
          {bar({
            app: 'Terminal',
            menus: MENUS.terminal,
            net: { state: 'OFFLINE', queued: 3 },
            usedMb: 222,
            services: DEGRADED,
            ai: 'indexing',
          })}
          {bar({
            app: 'Editor',
            menus: MENUS.editor,
            net: { state: 'SYNCING', ops: 3 },
            usedMb: 246,
            services: HEALTHY,
            ai: 'off',
          })}
          {bar({
            app: 'Settings',
            menus: MENUS.settings,
            net: { state: 'AUTH_REQUIRED', queued: 2 },
            usedMb: 120,
            services: HEALTHY,
            ai: 'error',
          })}
        </div>
      )}
    </Themed>
  );
}

function DockStates(): JSX.Element {
  const [launching, setLaunching] = createSignal(false);
  const [attention, setAttention] = createSignal(false);
  const [full, setFull] = createSignal(false);
  const items = (): DockItem[] =>
    DOCK_APPS.map((app) => ({
      id: app.id,
      label: app.label,
      icon: app.id,
      running: app.id === 'files' || app.id === 'terminal' || app.id === 'editor',
      windows: app.id === 'terminal' ? 2 : app.id === 'files' || app.id === 'editor' ? 1 : 0,
      badge: app.id === 'settings' ? 1 : app.id === 'editor' ? 3 : undefined,
      launching: app.id === 'search' && launching(),
      attention: app.id === 'task-manager' && attention(),
    }));
  const pulse = (set: (v: boolean) => void): void => {
    set(true);
    setTimeout(() => set(false), 900);
  };
  return (
    <>
      <div class={styles.controls}>
        <Button size="sm" onClick={() => pulse(setLaunching)}>
          Launch Search (bounce)
        </Button>
        <Button size="sm" onClick={() => pulse(setAttention)}>
          Task Manager needs attention
        </Button>
        <Button size="sm" onClick={() => setFull((f) => !f)}>
          {full() ? 'Empty Trash' : 'Fill Trash'}
        </Button>
      </div>
      <Themed>
        {() => (
          <div class={styles.dockStage}>
            <Dock items={items()} trash={{ full: full() }} onActivate={noop} onTrash={noop} />
          </div>
        )}
      </Themed>
    </>
  );
}

function WindowStates(): JSX.Element {
  const [replay, setReplay] = createSignal<WindowPhase>();
  const cell = (p: {
    caption: string;
    focused: boolean;
    dragging?: boolean;
    state?: WindowState;
    overlay?: WindowOverlay;
    shimmer?: boolean;
    phase?: WindowPhase;
    canMaximise?: boolean;
  }): JSX.Element => (
    <div>
      <div class={styles.windowCell}>
        <WindowFrame
          title="report.md — Editor"
          appName="Editor"
          focused={p.focused}
          dragging={p.dragging}
          state={p.state}
          overlay={p.overlay}
          shimmer={p.shimmer}
          phase={p.phase}
          genie={{ x: 0, y: 160 }}
          canMaximise={p.canMaximise}
          resizable={false}
          style={{ position: 'relative' }}
          onClose={noop}
          onMinimise={noop}
          onMaximize={noop}
          onPhaseEnd={() => setReplay(undefined)}
        >
          <div class={styles.sample}>
            Plotinium runs every app as a process with its own pid. The scheduler uses a priority
            queue with a 10 ms quantum.
          </div>
        </WindowFrame>
      </div>
      <div class={styles.windowCaption}>{p.caption}</div>
    </div>
  );
  return (
    <>
      <div class={styles.controls}>
        <For each={['opening', 'minimising', 'restoring', 'closing'] as const}>
          {(phase) => (
            <Button size="sm" onClick={() => setReplay(phase)}>
              Play {phase}
            </Button>
          )}
        </For>
      </div>
      <Themed>
        {() => (
          <div class={styles.windowGrid}>
            {cell({
              caption: 'Focused (coloured lights, heavy shadow tier)',
              focused: true,
              phase: replay(),
            })}
            {cell({ caption: 'Unfocused (grey lights, dim layer, idle tint)', focused: false })}
            {cell({
              caption: 'Dragging (drag shadow tier, no crossfade)',
              focused: true,
              dragging: true,
            })}
            {cell({
              caption: 'Restoring… with real byte counts and a sheen',
              focused: true,
              shimmer: true,
              overlay: {
                kind: 'restoring',
                doneBytes: 3.1 * 1024 * 1024,
                totalBytes: 5 * 1024 * 1024,
              },
            })}
            {cell({
              caption: 'Not responding (Wait / Force quit)',
              focused: true,
              overlay: { kind: 'not-responding' },
            })}
            {cell({
              caption: 'Fixed size: zoom disabled (hollow)',
              focused: true,
              canMaximise: false,
            })}
          </div>
        )}
      </Themed>
    </>
  );
}

function ControlCentreStates(): JSX.Element {
  const [theme, setTheme] = createSignal<ThemeChoice>('dark');
  const [focus, setFocus] = createSignal(false);
  const [meter, setMeter] = createSignal(true);
  const [budget, setBudget] = createSignal(256);
  const [retrying, setRetrying] = createSignal<readonly string[]>([]);
  const panel = (p: {
    net: NetView;
    services: readonly SvcView[];
    failed?: number;
  }): JSX.Element => (
    <ControlCentre
      open
      inline
      autoFocus={false}
      onClose={noop}
      net={p.net}
      now={NOW}
      clock={CLOCK}
      lastSyncAt={NOW - 60_000}
      syncQueue={{ pending: p.net.state === 'OFFLINE' ? p.net.queued : 0, failed: p.failed }}
      onRetrySync={noop}
      services={p.services}
      retryingServices={retrying()}
      onRetryService={(name) => setRetrying((list) => [...list, name])}
      theme={theme()}
      onThemeChange={setTheme}
      reducedMotion={false}
      onReducedMotionChange={(on) => setGalleryParam('motion', on ? 'reduce' : null)}
      memory={{ budgetMb: budget(), usedMb: 142 }}
      onMemoryBudgetCommit={setBudget}
      focusMode={focus()}
      onFocusModeChange={setFocus}
      frameMeter={meter()}
      frameMeterSummary="p95 16.7 ms · 60 Hz"
      onFrameMeterChange={setMeter}
      version="Plotinium 0.3.0 · build a1f93c2"
      onOpenSettings={noop}
    />
  );
  return (
    <Themed>
      {() => (
        <div class={styles.ccRow}>
          {panel({ net: { state: 'LIVE' }, services: HEALTHY })}
          {panel({ net: { state: 'OFFLINE', queued: 3 }, services: DEGRADED, failed: 1 })}
        </div>
      )}
    </Themed>
  );
}

function NotificationStates(): JSX.Element {
  const [centre, setCentre] = createSignal<readonly ShellNotification[]>(NOTIFICATIONS);
  const [banners, setBanners] = createSignal<readonly ShellNotification[]>([]);
  const [focusMode, setFocusMode] = createSignal(false);
  let count = 0;
  const post = (level: ShellNotification['level']): void => {
    count += 1;
    const sample: Record<
      ShellNotification['level'],
      Omit<ShellNotification, 'id' | 'at' | 'level'>
    > = {
      info: {
        title: 'Lock granted — report.md',
        body: 'You hold the edit lock now',
        app: 'editor',
        appName: 'Editor',
      },
      success: {
        title: 'Semantic index up to date',
        body: '1,284 files · 0 errors',
        app: 'search',
        appName: 'Search',
      },
      warning: {
        title: 'Conflict saved as copy',
        body: 'Your version was kept as',
        code: 'report (conflict from bob).md',
        app: 'files',
        appName: 'Files',
        actions: [{ id: 'show', label: 'Show in Files', kind: 'link' }],
      },
      error: {
        title: 'Lock lost on report.md',
        body: 'The server revoked your lease. Your edits are kept locally.',
        app: 'editor',
        appName: 'Editor',
        actions: [{ id: 'retry', label: 'Retry', kind: 'primary' }],
      },
    };
    setBanners((list) => [{ id: `toast-${count}`, level, at: NOW, ...sample[level] }, ...list]);
  };
  return (
    <>
      <div class={styles.controls}>
        <Button size="sm" onClick={() => post('info')}>
          Post info
        </Button>
        <Button size="sm" onClick={() => post('success')}>
          Post success
        </Button>
        <Button size="sm" onClick={() => post('warning')}>
          Post warning (10 s)
        </Button>
        <Button size="sm" variant="danger" onClick={() => post('error')}>
          Post error (sticky)
        </Button>
        <Toggle size="sm" label="Focus" checked={focusMode()} onChange={setFocusMode} />
        <Button size="sm" variant="ghost" onClick={() => setCentre(NOTIFICATIONS)}>
          Refill centre
        </Button>
      </div>
      <Themed>
        {() => (
          <div class={styles.notifyRow}>
            <NotificationCenter
              notifications={centre()}
              now={NOW}
              onDismiss={(id) => setCentre((list) => list.filter((n) => n.id !== id))}
              onClearAll={() => setCentre([])}
              onAction={noop}
              onOpen={noop}
            />
            <div class={styles.toastStage}>
              <NotificationToasts
                inline
                notifications={banners()}
                now={NOW}
                focusMode={focusMode()}
                onDismiss={(id) => setBanners((list) => list.filter((n) => n.id !== id))}
                onAction={noop}
              />
            </div>
          </div>
        )}
      </Themed>
    </>
  );
}

export default function ShellPage(): JSX.Element {
  return (
    <Page
      title="Desktop shell"
      lead="The chrome of the macOS-inspired desktop: wallpaper, the glass menu bar with its status area, the floating dock with magnification, window chrome with traffic lights, Control Centre and notifications. Every piece is presentational; this page wires a tiny compositor stand-in so each state can be tried by hand."
    >
      <Section
        title="Desktop"
        lead="A working desktop in each theme. Drag title bars, resize from any edge, double-click a title bar to zoom, minimise into the dock and click the icon to restore, and open Control Centre from the menu bar (the connectivity tile cycles the sync states). Menus and tooltips portal to the page, so they follow the gallery's theme toggle."
      >
        <For each={THEMES}>{(theme) => <Desktop scene={theme} />}</For>
      </Section>
      <Section
        title="Menu bar"
        lead="Status area states: online; offline with the queue and a degraded service, memory above 85% and AI indexing; syncing with memory above 95% and AI off; sign-in needed with an AI error."
      >
        <MenuBarStates />
      </Section>
      <Section
        title="Dock"
        lead="Hover to magnify (transform only). Running dots, badges, the launch bounce and the attention hop; keyboard: Tab into the dock, then the arrow keys."
      >
        <DockStates />
      </Section>
      <Section
        title="Window chrome"
        lead="Focus, drag and process states. Replay the one-shot phases; under Reduce motion they end at once."
      >
        <WindowStates />
      </Section>
      <Section
        title="Control Centre"
        lead="Healthy and online; offline with a failed sync op and degraded services (open the services tile)."
      >
        <ControlCentreStates />
      </Section>
      <Section
        title="Notifications"
        lead="Notification Centre with a stacked group, and banners: info and success leave after 6 s, warnings after 10 s, errors stay; hover or focus pauses the timer; Focus holds back info and success."
      >
        <NotificationStates />
      </Section>
    </Page>
  );
}
