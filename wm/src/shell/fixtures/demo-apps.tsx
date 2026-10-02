/**
 * Demo apps for the dev harness and the shell tests. The shell may not import apps/ (package
 * boundaries), so these small views stand in for Files, Terminal, Editor, Task Manager, Settings
 * and About: they exercise the same `AppEntry` / `ViewContext` contract the host's real registry
 * uses (unified and titled chrome, fixed-size windows, `setTitle`, menu commands) and are built
 * from @plotinium/ui primitives so screenshots are comparable with the Stitch references.
 */
import ChevronLeft from 'lucide-solid/icons/chevron-left';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import Clock from 'lucide-solid/icons/clock';
import Download from 'lucide-solid/icons/download';
import FileText from 'lucide-solid/icons/file-text';
import Folder from 'lucide-solid/icons/folder';
import HardDrive from 'lucide-solid/icons/hard-drive';
import House from 'lucide-solid/icons/house';
import Users from 'lucide-solid/icons/users';
import { createSignal, For, onMount, untrack, type JSX } from 'solid-js';
import { render } from 'solid-js/web';

import type { AppEntry, AppRegistry, ThemePref, ViewContext } from '../env.ts';
import {
  AtomLogo,
  IconButton,
  SearchField,
  SegmentedControl,
  SidebarList,
  Table,
  type TableColumn,
} from '../ui.ts';
import styles from './demo-apps.module.css';

interface FileRow {
  readonly name: string;
  readonly size: string;
  readonly kind: string;
  readonly modified: string;
  readonly owner: string;
}

const FILES: readonly FileRow[] = [
  {
    name: 'os-report.md',
    size: '18 KB',
    kind: 'Markdown',
    modified: 'Today 10:31',
    owner: 'student',
  },
  {
    name: 'scheduler-notes.md',
    size: '6 KB',
    kind: 'Markdown',
    modified: 'Yesterday 22:14',
    owner: 'student',
  },
  { name: 'vfs-design.pdf', size: '1.2 MB', kind: 'PDF', modified: '22 Sep', owner: 'alice' },
  { name: 'boot-log.txt', size: '4 KB', kind: 'Text', modified: 'Today 09:58', owner: 'student' },
  { name: 'dsa', size: '—', kind: 'Folder', modified: '21 Sep', owner: 'student' },
  { name: 'screenshots', size: '—', kind: 'Folder', modified: '20 Sep', owner: 'bob' },
  { name: 'ai-index.json', size: '88 KB', kind: 'JSON', modified: 'Today 10:40', owner: 'student' },
  { name: 'lab3-paging.md', size: '9 KB', kind: 'Markdown', modified: '19 Sep', owner: 'student' },
  { name: 'sync-protocol.md', size: '12 KB', kind: 'Markdown', modified: '18 Sep', owner: 'alice' },
  { name: 'todo.txt', size: '1 KB', kind: 'Text', modified: '16 Sep', owner: 'student' },
];

const FILE_COLUMNS: readonly TableColumn<FileRow>[] = [
  {
    id: 'name',
    header: 'Name',
    width: 'minmax(150px, 2fr)',
    sortValue: (r) => r.name,
    cell: (r) => (
      <span class={styles.nameCell}>
        {r.kind === 'Folder' ? (
          <Folder size={16} aria-hidden="true" />
        ) : (
          <FileText size={16} aria-hidden="true" />
        )}
        {r.name}
      </span>
    ),
  },
  { id: 'size', header: 'Size', width: '72px', muted: true, cell: (r) => r.size },
  { id: 'kind', header: 'Kind', width: '92px', muted: true, cell: (r) => r.kind },
  { id: 'modified', header: 'Modified', width: '118px', muted: true, cell: (r) => r.modified },
  { id: 'owner', header: 'Owner', width: '72px', muted: true, cell: (r) => r.owner },
];

function FilesDemo(props: { ctx: ViewContext }): JSX.Element {
  const [place, setPlace] = createSignal('home');
  const [query, setQuery] = createSignal('');
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set(['os-report.md']));
  const rows = (): readonly FileRow[] =>
    FILES.filter((f) => f.name.toLowerCase().includes(query().trim().toLowerCase()));
  return (
    <div class={styles.split} data-app-view={props.ctx.app}>
      <div class={styles.sidebar} data-pl-drag-region="">
        <SidebarList
          label="Places"
          selected={place()}
          onSelect={setPlace}
          sections={[
            {
              id: 'fav',
              title: 'Favourites',
              items: [
                { id: 'home', label: 'Home', icon: House },
                { id: 'docs', label: 'Documents', icon: FileText },
                { id: 'downloads', label: 'Downloads', icon: Download },
                { id: 'recent', label: 'Recent', icon: Clock },
              ],
            },
            {
              id: 'loc',
              title: 'Locations',
              items: [
                { id: 'root', label: '/', icon: HardDrive },
                { id: 'tmp', label: '/tmp', icon: Folder },
                { id: 'shared', label: 'Shared', icon: Users },
              ],
            },
          ]}
        />
      </div>
      <div class={styles.main}>
        <div class={styles.toolbar} data-pl-drag-region="">
          <IconButton label="Back" icon={<ChevronLeft size={16} />} size="sm" />
          <IconButton label="Forward" icon={<ChevronRight size={16} />} size="sm" />
          <div class={styles.crumb}>
            <span class={styles.crumbTitle}>notes</span>
            <span class={styles.crumbPath}>/home/{props.ctx.session.user}/notes</span>
          </div>
          <span class={styles.spacer} />
          <SearchField
            label="Search in notes"
            placeholder="Search in notes"
            pill
            value={query()}
            onInput={setQuery}
          />
        </div>
        <div class={styles.scroll}>
          <Table
            label="Files in notes"
            columns={FILE_COLUMNS}
            rows={rows()}
            rowId={(r) => r.name}
            selectionMode="multiple"
            selected={selected()}
            onSelectionChange={setSelected}
          />
        </div>
        <div class={styles.status}>
          <span>{rows().length} items</span>
          <span>·</span>
          <span>3.1 GB available</span>
          <span>·</span>
          <span class={styles.ok}>Synced</span>
        </div>
      </div>
    </div>
  );
}

const LISTING = [
  'total 48',
  'drwxr-xr-x  6 student staff  4096 Sep 24 10:31 .',
  'drwxr-xr-x  4 root    root   4096 Sep 20 08:00 ..',
  '-rw-r--r--  1 student staff   220 Sep 20 08:00 .profile',
  'drwxr-xr-x  3 student staff  4096 Sep 24 10:31 notes',
  'drwxr-xr-x  2 student staff  4096 Sep 21 17:02 dsa',
  '-rw-r--r--  1 student staff  4011 Sep 24 09:58 boot-log.txt',
];

function TerminalDemo(props: { ctx: ViewContext }): JSX.Element {
  onMount(() => props.ctx.setTitle(`${props.ctx.session.user} — sh — 80×24`));
  const prompt = (): string => `${props.ctx.session.user}@plotinium:~$ `;
  return (
    <pre class={styles.term} data-app-view={props.ctx.app} tabindex="0">
      <span class={styles.prompt}>{prompt()}</span>ls -la{'\n'}
      <For each={LISTING}>{(line) => <span class={styles.muted}>{`${line}\n`}</span>}</For>
      <span class={styles.prompt}>{prompt()}</span>
    </pre>
  );
}

interface ProcRow {
  readonly pid: number;
  readonly name: string;
  readonly prio: number;
  readonly cpu: string;
}

const PROCS: readonly ProcRow[] = [
  { pid: 1, name: 'init', prio: 0, cpu: '0.1%' },
  { pid: 2, name: 'sched', prio: 0, cpu: '1.8%' },
  { pid: 7, name: 'vfs', prio: 4, cpu: '2.4%' },
  { pid: 12, name: 'syncd', prio: 8, cpu: '0.9%' },
  { pid: 23, name: 'ai.indexer', prio: 32, cpu: '9.6%' },
  { pid: 41, name: 'terminal', prio: 12, cpu: '3.1%' },
  { pid: 44, name: 'files', prio: 12, cpu: '5.2%' },
];

const PROC_COLUMNS: readonly TableColumn<ProcRow>[] = [
  { id: 'pid', header: 'PID', width: '56px', muted: true, cell: (r) => String(r.pid) },
  { id: 'name', header: 'Name', mono: true, cell: (r) => r.name },
  { id: 'prio', header: 'Prio', width: '56px', align: 'end', cell: (r) => String(r.prio) },
  { id: 'cpu', header: 'CPU', width: '64px', align: 'end', cell: (r) => r.cpu },
];

type TaskTab = 'processes' | 'memory' | 'predictions';

function TaskManagerDemo(props: { ctx: ViewContext }): JSX.Element {
  const initial = (): TaskTab => {
    const a = props.ctx.argv[0];
    return a === 'memory' || a === 'predictions' ? a : 'processes';
  };
  const [tab, setTab] = createSignal<TaskTab>(initial());
  return (
    <div class={`${styles.main} ${styles.fill}`} data-app-view={props.ctx.app}>
      <div class={`${styles.toolbar} ${styles.toolbarPad}`} data-pl-drag-region="">
        <span class={styles.crumbTitle}>Task Manager</span>
        <span class={styles.spacer} />
        <SegmentedControl
          label="Task Manager sections"
          size="sm"
          value={tab()}
          onChange={setTab}
          options={[
            { value: 'processes', label: 'Processes' },
            { value: 'memory', label: 'Memory' },
            { value: 'predictions', label: 'Predictions' },
          ]}
        />
      </div>
      <div class={styles.cards}>
        <div class={styles.card}>
          <span class={styles.cardLabel}>CPU</span>
          <span class={styles.cardValue}>23% · 4 workers</span>
        </div>
        <div class={styles.card}>
          <span class={styles.cardLabel}>Memory</span>
          <span class={styles.cardValue}>142 of 256 MB</span>
        </div>
      </div>
      <div class={styles.scroll}>
        <Table
          label="Processes"
          columns={PROC_COLUMNS}
          rows={PROCS}
          rowId={(r) => String(r.pid)}
          density="compact"
        />
      </div>
    </div>
  );
}

const DOC = `## 2 Process Scheduler

Plotinium uses a multilevel feedback queue
with 32 priority levels. Long jobs sink;
interactive ones rise.

- \`ai.indexer\` runs at priority 32 (lowest)
- \`sched\` (pid 2) rebalances every 10 ms.`;

function EditorDemo(props: { ctx: ViewContext }): JSX.Element {
  onMount(() => props.ctx.setTitle('os-report.md — ~/notes'));
  return (
    <div class={styles.editor} data-app-view={props.ctx.app}>
      <pre class={styles.code} tabindex="0">
        {DOC}
      </pre>
      <div class={styles.preview}>
        <h2>2 Process Scheduler</h2>
        <p>
          Plotinium uses a <strong>multilevel feedback queue</strong> with 32 priority levels. Long
          jobs sink; interactive ones rise.
        </p>
      </div>
    </div>
  );
}

function SettingsDemo(props: { ctx: ViewContext; setTheme: (t: ThemePref) => void }): JSX.Element {
  const [section, setSection] = createSignal(untrack(() => props.ctx.argv[0]) ?? 'appearance');
  return (
    <div class={styles.split} data-app-view={props.ctx.app}>
      <div class={styles.sidebar} data-pl-drag-region="">
        <SidebarList
          label="Settings"
          selected={section()}
          onSelect={setSection}
          sections={[
            {
              id: 'main',
              items: [
                { id: 'about', label: 'About' },
                { id: 'appearance', label: 'Appearance' },
                { id: 'memory', label: 'Memory' },
                { id: 'keyboard', label: 'Keyboard' },
                { id: 'ai', label: 'Privacy & AI' },
              ],
            },
          ]}
        />
      </div>
      <div class={styles.pane} data-pl-drag-region="">
        <span class={styles.crumbTitle}>Appearance</span>
        <SegmentedControl
          label="Theme"
          value={props.ctx.prefs().theme}
          onChange={(t) => props.setTheme(t)}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'system', label: 'Follow system' },
          ]}
        />
      </div>
    </div>
  );
}

function AboutDemo(props: { ctx: ViewContext; version: string; build: string }): JSX.Element {
  return (
    <div class={styles.about} data-app-view={props.ctx.app}>
      <AtomLogo size={72} />
      <h1 class={styles.aboutTitle}>Plotinium</h1>
      <span class={styles.muted}>
        Version {props.version} · build {props.build}
      </span>
    </div>
  );
}

const mount =
  (View: (p: { ctx: ViewContext }) => JSX.Element) =>
  (container: HTMLElement, ctx: ViewContext): (() => void) =>
    render(() => <View ctx={ctx} />, container);

export interface DemoAppsOptions {
  readonly version: string;
  readonly build: string;
  /** Settings' theme control (the harness forwards it to the desktop handle). */
  readonly setTheme: (t: ThemePref) => void;
}

/** The demo registry: the six built-in apps in their Dock order. */
export function createDemoApps(o: DemoAppsOptions): AppRegistry {
  const list: AppEntry[] = [
    {
      id: 'files',
      title: 'Files',
      icon: 'files',
      window: { chrome: 'unified' },
      menus: [
        {
          id: 'file',
          label: 'File',
          items: [
            { id: 'new-window', label: 'New Window' },
            { id: 'new-folder', label: 'New Folder' },
          ],
        },
        {
          id: 'edit',
          label: 'Edit',
          items: [
            { id: 'copy', label: 'Copy' },
            { id: 'paste', label: 'Paste' },
          ],
        },
        {
          id: 'view',
          label: 'View',
          items: [
            { id: 'as-list', label: 'as List' },
            { id: 'as-icons', label: 'as Icons' },
          ],
        },
        { id: 'go', label: 'Go', items: [{ id: 'home', label: 'Home' }] },
      ],
      mountView: mount(FilesDemo),
    },
    { id: 'terminal', title: 'Terminal', icon: 'terminal', mountView: mount(TerminalDemo) },
    { id: 'editor', title: 'Editor', icon: 'editor', mountView: mount(EditorDemo) },
    {
      id: 'taskmgr',
      title: 'Task Manager',
      icon: 'task-manager',
      window: { chrome: 'unified' },
      singleton: true,
      mountView: mount(TaskManagerDemo),
    },
    {
      id: 'settings',
      title: 'Settings',
      icon: 'settings',
      window: { chrome: 'unified', resizable: false, maximizable: false },
      singleton: true,
      mountView: (container, ctx) =>
        render(() => <SettingsDemo ctx={ctx} setTheme={o.setTheme} />, container),
    },
    {
      id: 'about',
      title: 'About Plotinium',
      icon: 'atom',
      pinned: false,
      singleton: true,
      window: { resizable: false, maximizable: false },
      mountView: (container, ctx) =>
        render(() => <AboutDemo ctx={ctx} version={o.version} build={o.build} />, container),
    },
  ];
  return {
    list: () => list,
    get: (id) => list.find((a) => a.id === id),
  };
}
