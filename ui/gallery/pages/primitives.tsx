import Archive from 'lucide-solid/icons/archive';
import Bell from 'lucide-solid/icons/bell';
import ChevronLeft from 'lucide-solid/icons/chevron-left';
import ChevronRight from 'lucide-solid/icons/chevron-right';
import Clipboard from 'lucide-solid/icons/clipboard';
import Clock from 'lucide-solid/icons/clock';
import Code from 'lucide-solid/icons/code';
import Copy from 'lucide-solid/icons/copy';
import Cpu from 'lucide-solid/icons/cpu';
import Download from 'lucide-solid/icons/download';
import Eye from 'lucide-solid/icons/eye';
import FileCode from 'lucide-solid/icons/file-code';
import FileText from 'lucide-solid/icons/file-text';
import Folder from 'lucide-solid/icons/folder';
import FolderPlus from 'lucide-solid/icons/folder-plus';
import HardDrive from 'lucide-solid/icons/hard-drive';
import House from 'lucide-solid/icons/house';
import Image from 'lucide-solid/icons/image';
import Inbox from 'lucide-solid/icons/inbox';
import Info from 'lucide-solid/icons/info';
import Keyboard from 'lucide-solid/icons/keyboard';
import Lock from 'lucide-solid/icons/lock';
import Palette from 'lucide-solid/icons/palette';
import Pencil from 'lucide-solid/icons/pencil';
import Play from 'lucide-solid/icons/play';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import Scissors from 'lucide-solid/icons/scissors';
import Share2 from 'lucide-solid/icons/share-2';
import Shield from 'lucide-solid/icons/shield';
import Sparkles from 'lucide-solid/icons/sparkles';
import SunDim from 'lucide-solid/icons/sun-dim';
import Timer from 'lucide-solid/icons/timer';
import Trash2 from 'lucide-solid/icons/trash-2';
import TriangleAlert from 'lucide-solid/icons/triangle-alert';
import Users from 'lucide-solid/icons/users';
import Volume2 from 'lucide-solid/icons/volume-2';
import VolumeX from 'lucide-solid/icons/volume-x';
import Wifi from 'lucide-solid/icons/wifi';
import { createSignal, For, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';

import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  ContextMenu,
  Dialog,
  EmptyState,
  IconButton,
  Kbd,
  ListGroup,
  ListRow,
  Menu,
  Pill,
  Popover,
  ProgressBar,
  ProgressRing,
  SearchField,
  SegmentedControl,
  Select,
  Sheet,
  SidebarList,
  Slider,
  Spinner,
  Table,
  Tabs,
  TextField,
  Toggle,
  Tooltip,
  type IconComponent,
  type MenuEntry,
  type SidebarSection,
  type SortState,
  type TableColumn,
} from '../../src/primitives/index.ts';
import { Caption, Demo, Grid, Page, Row, Section, Stack, Stage, ThemeSplit } from '../kit.tsx';
import type { GalleryPageMeta } from '../types.ts';
import styles from './primitives.module.css';

export const meta: GalleryPageMeta = {
  id: 'primitives',
  title: 'Primitives',
  group: 'Primitives',
  order: 0,
  description: 'Every accessible, themed primitive with realistic sample data.',
};

/* ---------------------------------------------------------------- sample data */

interface FileRow {
  name: string;
  size: number;
  kind: string;
  modified: string;
  modifiedSort: number;
  owner: string;
  icon: IconComponent;
}

const FILES: readonly FileRow[] = [
  {
    name: 'os-report.md',
    size: 18_000,
    kind: 'Markdown',
    modified: 'Today 10:31',
    modifiedSort: 9,
    owner: 'student',
    icon: FileText,
  },
  {
    name: 'scheduler-notes.md',
    size: 6_000,
    kind: 'Markdown',
    modified: 'Yesterday 22:14',
    modifiedSort: 8,
    owner: 'student',
    icon: FileText,
  },
  {
    name: 'vfs-design.pdf',
    size: 1_200_000,
    kind: 'PDF',
    modified: '22 Sep',
    modifiedSort: 6,
    owner: 'alice',
    icon: FileText,
  },
  {
    name: 'boot-log.txt',
    size: 4_000,
    kind: 'Text',
    modified: 'Today 09:58',
    modifiedSort: 7,
    owner: 'student',
    icon: FileText,
  },
  {
    name: 'dsa',
    size: 0,
    kind: 'Folder',
    modified: '21 Sep',
    modifiedSort: 5,
    owner: 'student',
    icon: Folder,
  },
  {
    name: 'screenshots',
    size: 0,
    kind: 'Folder',
    modified: '20 Sep',
    modifiedSort: 4,
    owner: 'bob',
    icon: Folder,
  },
  {
    name: 'ai-index.json',
    size: 88_000,
    kind: 'JSON',
    modified: 'Today 10:40',
    modifiedSort: 10,
    owner: 'student',
    icon: FileCode,
  },
  {
    name: 'lab3-paging.md',
    size: 9_000,
    kind: 'Markdown',
    modified: '19 Sep',
    modifiedSort: 3,
    owner: 'student',
    icon: FileText,
  },
  {
    name: 'kernel-panic.png',
    size: 240_000,
    kind: 'PNG image',
    modified: '17 Sep',
    modifiedSort: 1,
    owner: 'bob',
    icon: Image,
  },
  {
    name: 'todo.txt',
    size: 1_000,
    kind: 'Text',
    modified: '16 Sep',
    modifiedSort: 0,
    owner: 'student',
    icon: FileText,
  },
];

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1000)} KB`;
}

const FILE_COLUMNS: readonly TableColumn<FileRow>[] = [
  {
    id: 'name',
    header: 'Name',
    width: 'minmax(0, 2.4fr)',
    sortValue: (r) => r.name,
    cell: (r) => (
      <span class={styles.fileName}>
        <span class={styles.fileIcon}>
          <Dynamic component={r.icon} size={15} />
        </span>
        {r.name}
      </span>
    ),
  },
  {
    id: 'size',
    header: 'Size',
    width: 'minmax(0, 0.9fr)',
    sortValue: (r) => r.size,
    cell: (r) => formatSize(r.size),
    muted: true,
  },
  {
    id: 'kind',
    header: 'Kind',
    width: 'minmax(0, 1fr)',
    sortValue: (r) => r.kind,
    cell: (r) => r.kind,
    muted: true,
  },
  {
    id: 'modified',
    header: 'Modified',
    width: 'minmax(0, 1.3fr)',
    sortValue: (r) => r.modifiedSort,
    cell: (r) => r.modified,
    muted: true,
  },
  {
    id: 'owner',
    header: 'Owner',
    width: 'minmax(0, 0.8fr)',
    sortValue: (r) => r.owner,
    cell: (r) => r.owner,
    muted: true,
  },
];

interface ProcRow {
  pid: number;
  name: string;
  state: 'running' | 'sleeping' | 'blocked';
  prio: number;
  cpu: number;
  mem: number;
}

const PROCS: readonly ProcRow[] = [
  { pid: 1, name: 'init', state: 'sleeping', prio: 0, cpu: 0.1, mem: 2.1 },
  { pid: 2, name: 'sched', state: 'running', prio: 0, cpu: 1.8, mem: 1.2 },
  { pid: 7, name: 'vfs', state: 'running', prio: 4, cpu: 2.4, mem: 12.6 },
  { pid: 12, name: 'synced', state: 'sleeping', prio: 8, cpu: 0.9, mem: 6.3 },
  { pid: 23, name: 'ai.indexer', state: 'running', prio: 32, cpu: 9.6, mem: 41.0 },
  { pid: 41, name: 'terminal', state: 'running', prio: 12, cpu: 3.1, mem: 18.4 },
  { pid: 44, name: 'files', state: 'sleeping', prio: 12, cpu: 5.2, mem: 22.7 },
  { pid: 212, name: 'ai.agent', state: 'blocked', prio: 16, cpu: 0.0, mem: 9.8 },
];

const STATE_TONE = { running: 'success', sleeping: 'neutral', blocked: 'warning' } as const;

const PROC_COLUMNS: readonly TableColumn<ProcRow>[] = [
  {
    id: 'pid',
    header: 'PID',
    width: '56px',
    sortValue: (r) => r.pid,
    cell: (r) => r.pid,
    muted: true,
  },
  {
    id: 'name',
    header: 'Name',
    width: 'minmax(0, 2fr)',
    sortValue: (r) => r.name,
    cell: (r) => r.name,
    mono: true,
  },
  {
    id: 'state',
    header: 'State',
    width: 'minmax(0, 1.2fr)',
    sortValue: (r) => r.state,
    cell: (r) => (
      <Pill tone={STATE_TONE[r.state]} dot>
        {r.state}
      </Pill>
    ),
  },
  {
    id: 'prio',
    header: 'Prio',
    width: '56px',
    align: 'end',
    sortValue: (r) => r.prio,
    cell: (r) => r.prio,
  },
  {
    id: 'cpu',
    header: 'CPU',
    width: '64px',
    align: 'end',
    sortValue: (r) => r.cpu,
    cell: (r) => `${r.cpu.toFixed(1)}%`,
  },
  {
    id: 'mem',
    header: 'Memory',
    width: '80px',
    align: 'end',
    sortValue: (r) => r.mem,
    cell: (r) => `${r.mem.toFixed(1)} MB`,
  },
];

const FINDER_SECTIONS: readonly SidebarSection[] = [
  {
    id: 'favourites',
    title: 'Favourites',
    items: [
      { id: 'home', label: 'Home', icon: House },
      { id: 'documents', label: 'Documents', icon: FileText },
      { id: 'downloads', label: 'Downloads', icon: Download },
      { id: 'recent', label: 'Recent', icon: Clock },
    ],
  },
  {
    id: 'locations',
    title: 'Locations',
    items: [
      { id: 'root', label: '/', icon: HardDrive },
      { id: 'tmp', label: '/tmp', icon: Folder },
      { id: 'shared', label: 'Shared', icon: Users, badge: 3 },
    ],
  },
  {
    id: 'tags',
    title: 'Tags',
    items: [
      { id: 'tag-report', label: 'Report', dot: true, tint: 'indigo' },
      { id: 'tag-dsa', label: 'DSA', dot: true, tint: 'green' },
      { id: 'tag-kernel', label: 'Kernel', dot: true, tint: 'orange' },
    ],
  },
];

const SETTINGS_SECTIONS: readonly SidebarSection[] = [
  {
    id: 'net',
    items: [
      { id: 'network', label: 'Wi-Fi & Network', icon: Wifi, tint: 'blue' },
      { id: 'appearance', label: 'Appearance', icon: Palette, tint: 'indigo' },
      { id: 'notifications', label: 'Notifications', icon: Bell, tint: 'red' },
      { id: 'sound', label: 'Sound', icon: Volume2, tint: 'pink' },
    ],
  },
  {
    id: 'system',
    items: [
      { id: 'memory', label: 'Memory', icon: Cpu, tint: 'teal' },
      { id: 'scheduler', label: 'Scheduler', icon: Timer, tint: 'orange' },
      { id: 'privacy', label: 'Privacy & AI', icon: Shield, tint: 'indigo' },
      { id: 'keyboard', label: 'Keyboard', icon: Keyboard, tint: 'gray' },
      { id: 'developer', label: 'Developer', icon: Code, tint: 'gray', disabled: true },
      { id: 'about', label: 'About Plotinium', icon: Info, tint: 'gray' },
    ],
  },
];

const FILE_MENU: readonly MenuEntry[] = [
  { id: 'new-folder', label: 'New Folder', icon: FolderPlus, shortcut: ['Ctrl', '⇧', 'N'] },
  { id: 'open', label: 'Open', shortcut: ['Ctrl', 'O'] },
  { id: 'quick-look', label: 'Quick Look', icon: Eye, shortcut: ['Space'] },
  { kind: 'separator' },
  { id: 'rename', label: 'Rename…', icon: Pencil },
  { id: 'compress', label: 'Compress “os-report.md”', icon: Archive },
  { id: 'share', label: 'Share…', icon: Share2, disabled: true },
  { kind: 'separator' },
  { kind: 'header', label: 'Sort by' },
  { id: 'sort-name', label: 'Name', checked: true },
  { id: 'sort-date', label: 'Date Modified', checked: false },
  { kind: 'separator' },
  { id: 'trash', label: 'Move to Trash', icon: Trash2, shortcut: ['Ctrl', '⌫'], danger: true },
];

const CONTEXT_MENU: readonly MenuEntry[] = [
  { id: 'open', label: 'Open' },
  {
    id: 'ask-ai',
    label: 'Summarise with AI',
    icon: Sparkles,
    description: 'Runs on ai.agent after confirmation',
  },
  { kind: 'separator' },
  { id: 'cut', label: 'Cut', icon: Scissors, shortcut: ['Ctrl', 'X'] },
  { id: 'copy', label: 'Copy', icon: Copy, shortcut: ['Ctrl', 'C'] },
  { id: 'paste', label: 'Paste', icon: Clipboard, shortcut: ['Ctrl', 'V'], disabled: true },
  { kind: 'separator' },
  { id: 'trash', label: 'Move to Trash', icon: Trash2, danger: true },
];

/* ---------------------------------------------------------------- page */

function WindowFrame(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <div class={styles.window}>
      <div class={styles.titlebar}>
        <span class={styles.lights} aria-hidden="true">
          <span class={styles.light} />
          <span class={styles.light} />
          <span class={styles.light} />
        </span>
        {props.title}
      </div>
      {props.children}
    </div>
  );
}

function ButtonsShowcase(): JSX.Element {
  return (
    <Stack>
      <Row>
        <Button variant="primary">Run plan</Button>
        <Button>Export…</Button>
        <Button variant="tinted" icon={<Sparkles size={14} />}>
          Ask AI
        </Button>
        <Button variant="ghost">Cancel</Button>
      </Row>
      <Row>
        <Button variant="danger" icon={<Trash2 size={14} />}>
          Clear telemetry
        </Button>
        <Button variant="destructive">Empty Trash</Button>
        <Button disabled>Rebuild index</Button>
      </Row>
      <Row>
        <Toggle label="Sync telemetry" checked={false} onChange={() => undefined} />
        <Toggle label="Require confirmation" checked onChange={() => undefined} />
      </Row>
    </Stack>
  );
}

export default function PrimitivesPage(): JSX.Element {
  // Form state
  const [telemetry, setTelemetry] = createSignal(true);
  const [syncTelemetry, setSyncTelemetry] = createSignal(false);
  const [confirmAll, setConfirmAll] = createSignal(true);
  const [hidden, setHidden] = createSignal(false);
  const [trashToo, setTrashToo] = createSignal(true);
  const [mode, setMode] = createSignal<'write' | 'split' | 'preview'>('split');
  const [view, setView] = createSignal<'list' | 'icons' | 'columns'>('list');
  const [query, setQuery] = createSignal('paging');
  const [palette, setPalette] = createSignal('');
  const [user, setUser] = createSignal('student');
  const [password, setPassword] = createSignal('hunter2');
  const [iconSize, setIconSize] = createSignal<'small' | 'medium' | 'large'>('medium');
  const [shell, setShell] = createSignal<'zsh' | 'bash' | 'sh' | undefined>(undefined);
  const [budget, setBudget] = createSignal(256);
  const [volume, setVolume] = createSignal(62);
  const [brightness, setBrightness] = createSignal(80);
  const [indexed, setIndexed] = createSignal(3118);
  // Overlays
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuAnchor, setMenuAnchor] = createSignal<HTMLButtonElement>();
  const [popoverOpen, setPopoverOpen] = createSignal(false);
  const [popoverAnchor, setPopoverAnchor] = createSignal<HTMLButtonElement>();
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [sheetOpen, setSheetOpen] = createSignal(false);
  const [lastAction, setLastAction] = createSignal('None yet');
  // Collections
  const [place, setPlace] = createSignal('documents');
  const [pane, setPane] = createSignal('privacy');
  const [fileSort, setFileSort] = createSignal<SortState>({
    column: 'name',
    direction: 'ascending',
  });
  const [fileSelection, setFileSelection] = createSignal<ReadonlySet<string>>(
    new Set(['os-report.md']),
  );
  const [procSort, setProcSort] = createSignal<SortState>({
    column: 'cpu',
    direction: 'descending',
  });
  const [procSelection, setProcSelection] = createSignal<ReadonlySet<string>>(new Set(['23']));
  const [tmTab, setTmTab] = createSignal<'processes' | 'memory' | 'predictions'>('processes');

  return (
    <Page
      title="Primitives"
      lead="Accessible building blocks for every Plotinium screen. They take data through props and report intents through callbacks; none touches storage, workers or the network (SYS-01)."
    >
      <Section
        title="Both themes"
        lead="The same controls in light and dark, side by side on the wallpaper."
      >
        <ThemeSplit wallpaper>{() => <ButtonsShowcase />}</ThemeSplit>
      </Section>

      <Section title="Buttons">
        <Grid min={320}>
          <Demo title="Push buttons" note="sm · md · lg" column>
            <Row>
              <Button variant="primary" size="sm">
                Save
              </Button>
              <Button variant="primary">Save</Button>
              <Button variant="primary" size="lg">
                Save
              </Button>
            </Row>
            <Row>
              <Button icon={<RefreshCw size={14} />}>Rebuild index</Button>
              <Button icon={<Download size={14} />}>Export…</Button>
              <Button variant="ghost" trailingIcon={<ChevronRight size={14} />}>
                View all
              </Button>
            </Row>
          </Demo>
          <Demo title="Icon buttons" note="labelled, toggleable">
            <IconButton label="Back" icon={<ChevronLeft size={16} />} />
            <IconButton label="Forward" icon={<ChevronRight size={16} />} disabled />
            <IconButton label="Ask AI" icon={<Sparkles size={16} />} variant="glass" pressed />
            <IconButton label="New Folder" icon={<FolderPlus size={16} />} variant="bordered" />
            <IconButton label="Play" icon={<Play size={16} />} variant="glass" round size="lg" />
          </Demo>
        </Grid>
      </Section>

      <Section title="Selection controls">
        <Grid min={300}>
          <Demo title="Toggle" note="spring knob" column>
            <Toggle
              label="Keep telemetry on this device"
              description="Always on. Telemetry never leaves the device unless you opt in."
              checked={telemetry()}
              onChange={setTelemetry}
            />
            <Toggle
              label="Sync telemetry to server"
              description="Sends launch, focus and close events to your account."
              checked={syncTelemetry()}
              onChange={setSyncTelemetry}
            />
            <Toggle
              label="Require confirmation for all changes"
              checked={confirmAll()}
              onChange={setConfirmAll}
            />
            <Toggle label="Developer mode" checked={false} onChange={() => undefined} disabled />
          </Demo>
          <Demo title="Checkbox" column>
            <Checkbox label="Show hidden files" checked={hidden()} onChange={setHidden} />
            <Checkbox
              label="Include .trash in search"
              description="Deleted items stay searchable for 30 days."
              checked={trashToo()}
              onChange={setTrashToo}
            />
            <Checkbox
              label="Select all (3 of 10)"
              checked={false}
              indeterminate
              onChange={() => undefined}
            />
            <Checkbox label="Encrypt swap" checked disabled onChange={() => undefined} />
          </Demo>
          <Demo title="Segmented control" note="sliding highlight" column>
            <SegmentedControl
              label="Editor mode"
              options={[
                { value: 'write', label: 'Write' },
                { value: 'split', label: 'Split' },
                { value: 'preview', label: 'Preview' },
              ]}
              value={mode()}
              onChange={setMode}
            />
            <SegmentedControl
              label="View as"
              size="sm"
              tone="accent"
              options={[
                { value: 'list', label: 'List' },
                { value: 'icons', label: 'Icons' },
                { value: 'columns', label: 'Columns' },
              ]}
              value={view()}
              onChange={setView}
            />
            <Caption>
              Editor: {mode()} · Files: {view()}
            </Caption>
          </Demo>
        </Grid>
      </Section>

      <Section title="Text entry">
        <Grid min={300}>
          <Demo title="Search field" column>
            <SearchField
              label="Search in notes"
              placeholder="Search in notes"
              value={query()}
              onInput={setQuery}
            />
            <SearchField
              label="Search Plotinium"
              placeholder="Search apps, files and commands"
              pill
              size="lg"
              value={palette()}
              onInput={setPalette}
              trailing={<Kbd keys={['Ctrl', 'Space']} />}
            />
          </Demo>
          <Demo title="Text field" column>
            <TextField
              label="User name"
              value={user()}
              onInput={setUser}
              hint="Lower case, 3 to 32 characters."
              autocomplete="username"
            />
            <TextField
              label="Password"
              type="password"
              value={password()}
              onInput={setPassword}
              error="Incorrect password. 2 attempts left before a 30 s wait."
              leading={<Lock size={14} />}
            />
            <TextField
              label="Mount point"
              value="/home/student/notes"
              onInput={() => undefined}
              mono
              readOnly
            />
          </Demo>
          <Demo title="Pop-up button" column>
            <Select
              label="Sidebar icon size"
              value={iconSize()}
              onChange={setIconSize}
              options={[
                { value: 'small', label: 'Small' },
                { value: 'medium', label: 'Medium' },
                { value: 'large', label: 'Large' },
              ]}
            />
            <Select
              label="Login shell"
              placeholder="Choose a shell…"
              value={shell()}
              onChange={setShell}
              options={[
                { value: 'zsh', label: 'zsh-like (default)' },
                { value: 'bash', label: 'bash-compatible' },
                { value: 'sh', label: 'POSIX sh', disabled: true },
              ]}
            />
          </Demo>
        </Grid>
      </Section>

      <Section title="Values and progress">
        <Grid min={300}>
          <Demo title="Slider" column>
            <Slider
              label="Memory budget"
              min={64}
              max={512}
              step={32}
              value={budget()}
              onInput={setBudget}
              format={(v) => `${v} MB`}
              showValue
            />
            <Slider
              label="Volume"
              variant="large"
              value={volume()}
              onInput={setVolume}
              startIcon={<VolumeX size={14} />}
              endIcon={<Volume2 size={14} />}
            />
            <Slider
              label="Brightness"
              variant="large"
              value={brightness()}
              onInput={setBrightness}
              startIcon={<SunDim size={14} />}
            />
          </Demo>
          <Demo title="Progress bar" note="determinate only" column>
            <ProgressBar
              label="Index status"
              value={indexed()}
              max={3530}
              valueText={`${indexed().toLocaleString('en-GB')} of 3,530 chunks`}
              showValue
              tone="warning"
            />
            <ProgressBar label="Monthly AI budget" value={6.4} valueText="$3.20 of $50" showValue />
            <ProgressBar label="Restoring session" value={72} showValue sweep size="sm" />
            <Button
              size="sm"
              onClick={() => setIndexed((n) => (n >= 3530 ? 2900 : Math.min(3530, n + 137)))}
            >
              Index more
            </Button>
          </Demo>
          <Demo title="Rings, badges, keys">
            <ProgressRing
              label="Memory"
              value={142}
              max={256}
              valueText="142 of 256 MB"
              centerLabel="142"
              showValue
              size={48}
            />
            <ProgressRing label="Quota" value={88} tone="danger" size={36} />
            <Stack>
              <Row>
                <Pill caps tone="danger" variant="outline">
                  Delete
                </Pill>
                <Pill caps tone="accent" variant="outline">
                  Move
                </Pill>
                <Pill caps tone="warning" variant="outline">
                  Chmod
                </Pill>
              </Row>
              <Row>
                <Pill tone="accent" icon={<Cpu size={11} />}>
                  On-device
                </Pill>
                <Pill tone="success" dot>
                  Connected
                </Pill>
                <Pill tone="warning" dot>
                  412 pending
                </Pill>
                <Badge count={3} label="3 unread notifications" />
                <Badge count={128} label="128 updates" tone="accent" />
              </Row>
              <Row>
                <Kbd keys={['Ctrl', '↵']} />
                <Kbd keys={['Esc']} />
                <Kbd keys={['Ctrl', '⇧', 'P']} />
              </Row>
            </Stack>
          </Demo>
        </Grid>
      </Section>

      <Section title="People and states">
        <Grid min={280}>
          <Demo title="Avatar">
            <Avatar name="student" size="xl" />
            <Avatar name="alice" size="lg" status="online" />
            <Avatar name="bob" status="away" />
            <Avatar name="Guest User" size="sm" status="offline" />
          </Demo>
          <Demo title="Spinner" note="in-app waits only (DSN-07)" column>
            <Spinner label="Asking the agent…" showLabel />
            <Spinner label="Listing /home/student" size="md" />
          </Demo>
          <Demo title="Empty state">
            <EmptyState
              compact
              icon={<Inbox size={36} stroke-width={1.5} />}
              title="No results for “paging”"
              description="Semantic search is offline. Keyword results would appear here."
              actions={<Button size="sm">Clear search</Button>}
            />
          </Demo>
        </Grid>
      </Section>

      <Section
        title="Overlays"
        lead="Menus, pop-ups and popovers are portalled glass surfaces; Escape closes only the topmost one."
      >
        <Grid min={300}>
          <Demo title="Menu" note="arrows, Home/End, type-ahead">
            <Button
              ref={setMenuAnchor}
              aria-haspopup="menu"
              aria-expanded={menuOpen()}
              onClick={() => setMenuOpen((o) => !o)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMenuOpen(true);
                }
              }}
            >
              File
            </Button>
            <Menu
              open={menuOpen()}
              anchor={menuAnchor()}
              label="File"
              items={FILE_MENU}
              onSelect={(id) => setLastAction(`File → ${id}`)}
              onClose={() => setMenuOpen(false)}
            />
            <Caption>Last action: {lastAction()}</Caption>
          </Demo>
          <Demo title="Context menu" note="right-click or Shift+F10" column>
            <ContextMenu
              label="Actions for os-report.md"
              items={CONTEXT_MENU}
              onSelect={(id) => setLastAction(`Context → ${id}`)}
            >
              <button type="button" class={styles.contextTarget}>
                os-report.md
              </button>
            </ContextMenu>
          </Demo>
          <Demo title="Tooltip and popover">
            <Tooltip content="Search in notes (Ctrl F)">
              <IconButton label="Search" icon={<Info size={16} />} variant="bordered" />
            </Tooltip>
            <Button
              ref={setPopoverAnchor}
              variant="tinted"
              icon={<Sparkles size={14} />}
              aria-expanded={popoverOpen()}
              onClick={() => setPopoverOpen((o) => !o)}
            >
              AI
            </Button>
            <Popover
              open={popoverOpen()}
              anchor={popoverAnchor()}
              label="AI status"
              onClose={() => setPopoverOpen(false)}
            >
              <div class={styles.popoverBody}>
                <div class={styles.popoverRow}>
                  <strong>Provider</strong>
                  <Pill tone="success" dot>
                    Connected
                  </Pill>
                </div>
                <span class={styles.muted}>Claude via Plotinium gateway</span>
                <ProgressBar
                  label="Monthly budget"
                  value={6.4}
                  valueText="$3.20 of $50"
                  showValue
                  size="sm"
                />
                <Toggle
                  label="Require confirmation"
                  checked={confirmAll()}
                  onChange={setConfirmAll}
                />
                <Button size="sm" data-autofocus onClick={() => setPopoverOpen(false)}>
                  Open ai log…
                </Button>
              </div>
            </Popover>
          </Demo>
          <Demo title="Dialog" note="focus trap, safe default">
            <Button
              variant="danger"
              icon={<Trash2 size={14} />}
              onClick={() => setDialogOpen(true)}
            >
              Empty Trash…
            </Button>
            <Dialog
              open={dialogOpen()}
              role="alertdialog"
              centered
              size="sm"
              icon={<Trash2 size={36} />}
              title="Empty the Trash?"
              description="12 items (48 MB) will be deleted permanently. You can’t undo this action."
              onClose={() => setDialogOpen(false)}
              actions={
                <>
                  <Button data-autofocus onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      setLastAction('Trash emptied');
                      setDialogOpen(false);
                    }}
                  >
                    Empty Trash
                  </Button>
                </>
              }
            />
          </Demo>
        </Grid>
        <Demo title="Sheet" note="drops from its window's title bar">
          <WindowFrame title="student@plotinium: ~ — 120×36">
            <div class={styles.windowBody}>
              <Button variant="primary" onClick={() => setSheetOpen(true)}>
                Show confirmation sheet
              </Button>
            </div>
            <Sheet
              open={sheetOpen()}
              role="alertdialog"
              floating
              icon={<TriangleAlert size={28} color="var(--pl-warning)" />}
              title="Confirm destructive plan"
              description={
                <>
                  ai.agent wants to run 5 steps in one transaction for{' '}
                  <span class={styles.mono}>"clean up my old build folders"</span>.
                </>
              }
              onClose={() => setSheetOpen(false)}
              actions={
                <>
                  <Button icon={<Pencil size={14} />}>Edit plan</Button>
                  <Button variant="primary" data-autofocus onClick={() => setSheetOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    icon={<Play size={14} />}
                    onClick={() => setSheetOpen(false)}
                  >
                    Run plan
                  </Button>
                </>
              }
            >
              <Row>
                <Pill caps tone="danger" variant="outline">
                  Delete
                </Pill>
                <span class={styles.mono}>~/projects/lab2/build/</span>
                <Caption>remove 1 dir, 9 files · to trash</Caption>
              </Row>
            </Sheet>
          </WindowFrame>
        </Demo>
      </Section>

      <Section title="Lists and navigation">
        <Grid min={340}>
          <Demo title="Sidebar · Files" note="glyph icons, tags">
            <SidebarList
              label="Places"
              sections={FINDER_SECTIONS}
              selected={place()}
              onSelect={setPlace}
            />
          </Demo>
          <Demo title="Sidebar · Settings" note="colour tiles">
            <SidebarList
              label="Settings"
              iconStyle="tile"
              accentSelection
              sections={SETTINGS_SECTIONS}
              selected={pane()}
              onSelect={setPane}
            />
          </Demo>
        </Grid>
        <Demo title="Grouped list · Privacy & AI" column>
          <Stage>
            <Stack style={{ 'max-width': '680px' }}>
              <ListGroup
                title="Usage telemetry"
                footer="App ids and times only. No file names, paths or content."
              >
                <ListRow
                  title="Keep telemetry on this device"
                  subtitle="Always on. Telemetry never leaves the device unless you opt in."
                  trailing={
                    <Toggle
                      label="Keep telemetry on this device"
                      hideLabel
                      checked={telemetry()}
                      onChange={setTelemetry}
                    />
                  }
                />
                <ListRow
                  title="Sync telemetry to server"
                  subtitle="Off. Sends launch, focus and close events to your account."
                  trailing={
                    <Toggle
                      label="Sync telemetry to server"
                      hideLabel
                      checked={syncTelemetry()}
                      onChange={setSyncTelemetry}
                    />
                  }
                />
                <ListRow
                  title="Recent events"
                  value="1,284 events · 94 KB"
                  chevron
                  onClick={() => setLastAction('Open recent events')}
                />
              </ListGroup>
              <ListGroup title="Semantic search">
                <ListRow
                  title="Embedding model"
                  value={
                    <Row gap="var(--pl-space-2)">
                      <span class={styles.mono}>mdbr-leaf-ir</span>
                      <Pill tone="accent">On-device</Pill>
                    </Row>
                  }
                />
                <ListRow
                  title="Index status"
                  subtitle="3,118 of 3,530 chunks indexed · ai.indexer pid 23 · priority 32"
                  trailing={
                    <Button size="sm" icon={<RefreshCw size={12} />}>
                      Rebuild index
                    </Button>
                  }
                />
              </ListGroup>
            </Stack>
          </Stage>
        </Demo>
        <Demo title="Tabs · Task Manager" column>
          <Tabs
            label="Task Manager views"
            selected={tmTab()}
            onChange={setTmTab}
            tabs={[
              { id: 'processes', label: 'Processes' },
              { id: 'memory', label: 'Memory' },
              { id: 'predictions', label: 'Predictions' },
            ]}
          >
            {(id) => (
              <div class={styles.tmHeader}>
                <div class={styles.stat}>
                  <span class={styles.statLabel}>{id === 'memory' ? 'Resident' : 'CPU'}</span>
                  <span class={styles.statValue}>
                    {id === 'memory' ? '142' : '23%'}{' '}
                    <span class={styles.statUnit}>
                      {id === 'memory' ? 'of 256 MB' : '4 workers'}
                    </span>
                  </span>
                </div>
                <div class={styles.stat}>
                  <span class={styles.statLabel}>{id === 'predictions' ? 'Next app' : 'Swap'}</span>
                  <span class={styles.statValue}>
                    {id === 'predictions' ? 'Editor' : '12 MB'}{' '}
                    <span class={styles.statUnit}>
                      {id === 'predictions' ? '0.71 confidence' : '3 pages out'}
                    </span>
                  </span>
                </div>
              </div>
            )}
          </Tabs>
          <Tabs
            label="Terminal sessions"
            variant="underline"
            selected="shell"
            onChange={() => undefined}
            tabs={[
              { id: 'shell', label: 'zsh — student' },
              { id: 'log', label: 'ai log', count: 4 },
              { id: 'top', label: 'top', disabled: true },
            ]}
          >
            {() => (
              <Caption>Underline variant: each tab owns its indicator, which scales in.</Caption>
            )}
          </Tabs>
        </Demo>
      </Section>

      <Section
        title="Tables"
        lead="Sortable headers (aria-sort), click / Ctrl-click / Shift-click selection, arrows, Ctrl+A, Enter to open."
      >
        <Demo title="Files · list view" column>
          <WindowFrame title="notes">
            <div class={styles.split}>
              <SidebarList
                label="Places"
                sections={FINDER_SECTIONS}
                selected={place()}
                onSelect={setPlace}
              />
              <div class={styles.filesPane}>
                <Table
                  label="Files in notes"
                  columns={FILE_COLUMNS}
                  rows={FILES}
                  rowId={(r) => r.name}
                  sort={fileSort()}
                  onSortChange={setFileSort}
                  selectionMode="multiple"
                  selected={fileSelection()}
                  onSelectionChange={setFileSelection}
                  onActivate={(r) => setLastAction(`Open ${r.name}`)}
                />
                <div class={styles.status}>
                  <span>
                    {fileSelection().size} of {FILES.length} selected
                  </span>
                  <span>·</span>
                  <span>3.1 GB available</span>
                  <span>·</span>
                  <span class={styles.statusOk}>✓ Synced</span>
                </div>
              </div>
            </div>
          </WindowFrame>
        </Demo>
        <Demo title="Task Manager · processes" column>
          <Table
            label="Processes"
            density="compact"
            columns={PROC_COLUMNS}
            rows={PROCS}
            rowId={(r) => String(r.pid)}
            sort={procSort()}
            onSortChange={setProcSort}
            selected={procSelection()}
            onSelectionChange={setProcSelection}
          />
          <Caption>
            Selected pid: {[...procSelection()].join(', ') || 'none'} · Last action: {lastAction()}
          </Caption>
        </Demo>
      </Section>

      <Section
        title="Tiles"
        lead="Settings icon tiles reuse the tint tokens; the label always names the item."
      >
        <Row>
          <For
            each={
              [
                'blue',
                'indigo',
                'teal',
                'green',
                'yellow',
                'orange',
                'red',
                'pink',
                'purple',
                'gray',
              ] as const
            }
          >
            {(tint) => (
              <span
                class={styles.tile}
                style={{ background: `var(--pl-tint-${tint})` }}
                title={tint}
              >
                <Wifi size={14} aria-hidden="true" />
              </span>
            )}
          </For>
        </Row>
      </Section>
    </Page>
  );
}
