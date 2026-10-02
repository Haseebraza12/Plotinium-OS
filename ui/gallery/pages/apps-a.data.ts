/**
 * Sample data for the apps-a gallery page, taken from the files-light, files-semantic-search,
 * editor-conflict and terminal-ai designs. Not a page (the registry only loads *.tsx).
 */
import type { EditorDocument } from '../../src/apps/editor/EditorApp.tsx';
import type { SidebarFile } from '../../src/apps/editor/EditorSidebar.tsx';
import type { FileEntry, FileTag, Place, Quota, SemanticHit } from '../../src/apps/files/types.ts';
import type { ConfirmationBlock } from '../../src/apps/terminal/ansi.ts';

/** Thu 24 Sep 2026, 10:42 (local time), the clock in every design. */
export const NOW = new Date(2026, 8, 24, 10, 42).getTime();
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 8, day, hour, minute).getTime();
const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

export const QUOTA: Quota = { used: 1.2 * GB, total: 2 * GB };
export const QUOTA_NEARLY_FULL: Quota = { used: 1.93 * GB, total: 2 * GB };

export const FAVOURITES: Place[] = [
  { id: 'home', label: 'Home', icon: 'home', path: '/home/student' },
  { id: 'documents', label: 'Documents', icon: 'documents', path: '/home/student/Documents' },
  { id: 'downloads', label: 'Downloads', icon: 'downloads', path: '/home/student/Downloads' },
  { id: 'recent', label: 'Recent', icon: 'recent', path: '/home/student' },
];
export const LOCATIONS: Place[] = [
  { id: 'root', label: '/', icon: 'root', path: '/' },
  { id: 'tmp', label: '/tmp', icon: 'tmp', path: '/tmp' },
  { id: 'mnt', label: '/mnt', icon: 'mnt', path: '/mnt', unmounted: true },
];
export const TAGS: FileTag[] = [
  { id: 'urgent', label: 'urgent', tint: 'red' },
  { id: 'review', label: 'review', tint: 'orange' },
  { id: 'capstone', label: 'capstone', tint: 'indigo' },
  { id: 'notes', label: 'notes', tint: 'blue' },
  { id: 'done', label: 'done', tint: 'green' },
];

const doc = (
  id: string,
  name: string,
  extra: Partial<FileEntry> & Pick<FileEntry, 'mtime'>,
): FileEntry => ({
  id,
  name,
  path: `/home/student/Documents/${name}`,
  type: 'file',
  mode: 0o644,
  size: KB,
  owner: 'student',
  uid: 1001,
  group: 'capstone',
  version: 1,
  ctime: at(1, 9),
  writable: true,
  ...extra,
});

/** The Documents folder of files-light (42 items in the design; the first ten are shown). */
export const DOCUMENTS: FileEntry[] = [
  doc('os-report', 'os-report.md', { size: 24 * KB, mtime: at(24, 9, 18), version: 8 }),
  doc('proposal', 'capstone-proposal.pdf', {
    size: 1.8 * MB,
    mtime: at(23, 17, 40),
    version: 3,
    tags: ['capstone'],
  }),
  doc('design', 'design', { type: 'dir', mode: 0o755, size: 0, mtime: at(22, 11) }),
  doc('kernel-notes', 'kernel-notes.txt', {
    mode: 0o600,
    size: 8 * KB,
    mtime: at(21, 16, 5),
    version: 12,
    lock: { holder: 'alice', since: NOW - 2 * 60_000 },
  }),
  doc('scheduler', 'scheduler.ts', { size: 12 * KB, mtime: at(20, 14, 30), version: 5 }),
  doc('boot-log', 'boot-log.txt', { mode: 0o444, size: 3 * KB, mtime: at(19, 8), writable: false }),
  doc('team-contract', 'team-contract.md', {
    mode: 0o664,
    size: 6 * KB,
    mtime: at(15, 10),
    sync: 'pending',
  }),
  doc('screenshot', 'screenshot-wm.png', { size: 640 * KB, mtime: at(14, 13) }),
  doc('vfs-diagram', 'vfs-diagram.svg', { size: 48 * KB, mtime: at(12, 12), sync: 'conflict' }),
  doc('run', 'run.sh', { mode: 0o755, size: KB, mtime: at(10, 18) }),
];

/** The notes folder searched in files-semantic-search. */
export const HITS: SemanticHit[] = [
  {
    id: 'week6',
    path: 'notes/week6-standup.md',
    name: 'week6-standup.md',
    lineStart: 42,
    lineEnd: 51,
    score: 0.94,
    snippet:
      '…Bob found a memory leak in the WindowFrame UI component; listeners were never removed on close…',
    highlights: [[13, 56]],
    owner: 'student',
    verified: 'own',
  },
  {
    id: 'os-report',
    path: 'notes/os-report.md',
    name: 'os-report.md',
    lineStart: 118,
    lineEnd: 126,
    score: 0.88,
    snippet: '…the leak in the dock component grew heap by 3 MB per window open…',
    highlights: [[5, 31]],
    owner: 'student',
    verified: 'own',
  },
  {
    id: 'bugs',
    path: 'notes/bugs.log',
    name: 'bugs.log',
    lineStart: 7,
    lineEnd: 9,
    score: 0.76,
    snippet: '…fixed: UI component leak, detached ResizeObserver in taskbar…',
    highlights: [[8, 25]],
    owner: 'alice',
    verified: 'server',
  },
  {
    id: 'meeting',
    path: 'notes/meeting-2026-09-17.md',
    name: 'meeting-2026-09-17.md',
    lineStart: 23,
    lineEnd: 30,
    score: 0.61,
    snippet: '…discussed memory profiling of the Terminal renderer…',
    highlights: [[11, 27]],
    owner: 'bob',
    verified: 'server',
    stale: true,
  },
];

/** Inspector entries for the hits. */
export const HIT_ENTRIES: Record<string, FileEntry> = {
  week6: {
    id: 'week6',
    name: 'week6-standup.md',
    path: '/home/student/notes/week6-standup.md',
    type: 'file',
    mode: 0o750,
    size: 4.2 * KB,
    mtime: at(24, 9, 18),
    ctime: at(17, 11),
    owner: 'student',
    uid: 1001,
    group: 'capstone',
    kind: 'Markdown document',
    version: 7,
  },
  'os-report': {
    ...doc('os-report', 'os-report.md', { size: 24 * KB, mtime: at(24, 9, 18), version: 8 }),
    kind: 'Markdown document',
  },
  bugs: {
    ...doc('bugs', 'bugs.log', { size: 2 * KB, mtime: at(18, 15) }),
    owner: 'alice',
    uid: 1002,
    lock: { holder: 'alice', since: NOW - 2 * 60_000 },
  },
  meeting: {
    ...doc('meeting', 'meeting-2026-09-17.md', { size: 5 * KB, mtime: at(17, 16) }),
    owner: 'bob',
    uid: 1003,
    kind: 'Markdown document',
  },
};

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

export const REPORT = `# OS Report

Plotinium is a web operating system with a real kernel, a virtual file system and an agentic
shell. This report covers the parts we built this term.

## 1. Boot sequence

The service DAG starts eighteen services in dependency order. Each one reports progress to
the splash, so the bar shows real work instead of a spinner.

## 2. Scheduler (MLFQ)

Three queues, a 20 ms quantum at the top, and priority boosts every second.

## 3. Virtual memory

Pages are 64 KiB. The clock algorithm picks victims; faults are counted per process.

## 4. Sync and conflicts

Plotinium syncs every file with a **version vector**. When the
client reconnects, \`syncd\` compares the local version (v7) with
the server version (v8).

- If only one side changed, it fast-forwards.
- If both changed, the server keeps v8 and the client copy is
  saved as a *conflicted copy* next to the original.

### 4.1 File locks

A lock is a **lease**: \`alice\` holds it for 30 s and must renew.
While locked, other users open the file read-only.

\`\`\`ts
const lease = await locks.acquire("/home/student/notes/os-report.md", { ttl: 30_000 });
\`\`\`

See [scheduler notes](./lab-4.md) and the boot log below:

> [    0.000] firmware: Plotinium 0.3.0 · POST ok
> [    0.212] vfs: mounted / · 12,408 inodes · 3 users · quotas enforced
> [    0.402] sync: WARN backend unreachable · offline mode · outbox holds 3 ops
> [    0.405] lockd: DEGRADED (requires sync) · local advisory locks only

## 5. AI indexer

The indexer runs at PRI 32 and yields while you type in Search.
`;

export const SCHEDULER = `// MLFQ scheduler: three queues, boost every second.
export interface Proc {
  pid: number;
  queue: 0 | 1 | 2;
  ticks: number;
}

const QUANTUM_MS = [20, 40, 80] as const;

export function pick(queues: Proc[][]): Proc | undefined {
  for (const queue of queues) {
    const next = queue.shift();
    if (next !== undefined) return next;
  }
  return undefined;
}

export function demote(proc: Proc): Proc {
  return { ...proc, queue: Math.min(2, proc.queue + 1) as Proc['queue'], ticks: 0 };
}
`;

export const EDITOR_DOCS: EditorDocument[] = [
  {
    id: 'os-report',
    name: 'os-report.md',
    path: '/home/student/notes/os-report.md',
    state: 'conflict',
  },
  { id: 'scheduler', name: 'scheduler.ts', path: '/home/student/notes/scheduler.ts' },
  { id: 'readme', name: 'README.md', path: '/home/student/notes/README.md', state: 'dirty' },
];

export const EDITOR_FILES: SidebarFile[] = [
  { id: 'os-report', name: 'os-report.md' },
  { id: 'conflict', name: 'os-report (conflict from student, 2026-09-24).md', conflict: true },
  { id: 'lab-4', name: 'lab-4.md' },
];

export const README = `# notes

Working notes for the Plotinium capstone. Start with os-report.md.
`;

// ---------------------------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------------------------

export const PLAN: ConfirmationBlock = {
  header: { agent: 'ai.agent', pid: 212 },
  steps: [
    { command: 'mkdir', args: '~/reports', effect: 'create 1 dir' },
    { command: 'find', args: '~ -type f -name "*.pdf" -mtime -7', effect: '→ 12 files' },
    {
      command: 'mv',
      args: '<12 files> ~/reports/',
      effect: 'modify 12 entries',
      files: ['lab3-vfs.pdf', 'sched-paper.pdf', 'os-report-draft.pdf'],
      fileCount: 12,
    },
    {
      command: 'chmod',
      args: '-R o-w ~/reports',
      effect: 'modify 13 inodes',
      destructive: 'chmod',
    },
  ],
  blast: { inodes: 13, deletions: 0, overwrites: 0, quotaOk: true },
  reasons: ['chmod'],
};

export const AI_REQUEST =
  'ai "move every PDF I changed last week into a new folder called reports, and make it read-only for others"';
