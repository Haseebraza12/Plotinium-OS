/**
 * Sample Settings models from the design references (settings-about, settings-privacy-ai).
 * Team names stay placeholders until TEAM_CONTRACT.md §1 is filled (the reference's names were
 * invented). Used by the gallery and the tests; the real models come from apps/settings.
 */
import type {
  AboutModel,
  BoundTerms,
  MemoryStatus,
  NetworkModel,
  PrivacyModel,
  SettingsUser,
  SettingValues,
  StorageModel,
  UpdatesModel,
  UsersModel,
} from './models.ts';

const MB = 1048576;
const GB = MB * 1024;

export const SAMPLE_USER: SettingsUser = { name: 'student', uid: 1001 };

export const DEFAULT_VALUES: SettingValues = {
  'general.deviceName': 'Lab PC 14',
  'general.language': 'en-GB',
  'general.clock24h': true,
  'boot.menuNextBoot': false,
  'boot.verbose': false,
  'appearance.theme': 'system',
  'appearance.accent': 'violet',
  'appearance.reduceMotion': 'system',
  'appearance.reduceTransparency': 'system',
  'dock.size': 52,
  'dock.magnification': true,
  'dock.magnificationScale': 1.45,
  'dock.autohide': false,
  'dock.showIndicators': true,
  'dock.showSuggestions': true,
  'dock.minimiseEffect': 'genie',
  'windows.doubleClickTitle': 'zoom',
  'mm.budgetMB': 256,
  'mm.softLimitMB': 64,
  'mm.remoteOnly': false,
  'sched.quantumMs.interactive': 5,
  'sched.quantumMs.normal': 10,
  'sched.quantumMs.background': 20,
  'sched.tAgeMs': 100,
  'sync.files': true,
  'sync.swapWriteBehind': true,
  'telemetry.sync': false,
  'agent.requireConfirm': true,
  'updates.auto': true,
  'updates.channel': 'stable',
};

export const SAMPLE_ABOUT: AboutModel = {
  name: 'Plotinium',
  version: '0.3.0',
  build: 'a1f93c2',
  builtAt: '2026-09-24',
  tagline: 'An AI-native operating system for the web',
  kernel: 'plotinium 0.3.0-a1f93c2',
  host: { browser: 'Chrome 154', cores: 8 },
  memoryBudget: '256 MB',
  storage: 'OPFS 1.2 GB · Cloud 340 MB',
  signedIn: 'student · uid 1001',
  updateStatus: 'up to date on this channel',
  team: [
    { role: 'R1', title: 'Systems Architect', area: 'Kernel' },
    { role: 'R2', title: 'Database Engineer', area: 'VFS / Database' },
    { role: 'R3', title: 'UI Subsystem Lead', area: 'WM / UI' },
    { role: 'R4', title: 'Pipeline Specialist', area: 'AI Pipeline' },
    { role: 'R5', title: 'Integration Engineer', area: 'QA / DevOps' },
  ],
  footer: ['Lahore Garrison University · Capstone, Fall 2026', '© 2026 Plotinium Team'],
};

const T0 = Date.UTC(2026, 8, 24, 10, 41, 7);

export const SAMPLE_PRIVACY: PrivacyModel = {
  telemetry: {
    rows: [
      {
        id: 't4',
        at: T0,
        event: 'focus',
        app: 'Editor',
        previousApp: 'Files',
        bucket: 'Thu · 10–11',
      },
      {
        id: 't3',
        at: T0 - 15_000,
        event: 'launch',
        app: 'Editor',
        previousApp: 'Files',
        bucket: 'Thu · 10–11',
      },
      {
        id: 't2',
        at: T0 - 109_000,
        event: 'focus',
        app: 'Terminal',
        previousApp: 'Files',
        bucket: 'Thu · 10–11',
      },
      {
        id: 't1',
        at: T0 - 185_000,
        event: 'close',
        app: 'Task Manager',
        previousApp: 'Terminal',
        bucket: 'Thu · 10–11',
      },
    ],
    count: 1284,
    bytes: 94 * 1024,
    oldest: '3 Sep',
    predictor: 'Markov-2',
  },
  model: { name: 'mdbr-leaf-ir', detail: 'local, 23 MB', state: 'ready' },
  index: { state: 'indexing', indexed: 3118, total: 3530, pid: 23, priority: 32 },
  agent: {
    provider: 'Claude via Plotinium gateway',
    status: 'connected',
    usedCents: 320,
    capCents: 5000,
    resetsOn: '1 Oct',
    lastAction: { time: '10:40', summary: 'summarise os-report.md', outcome: 'confirmed' },
  },
};

export const SAMPLE_NETWORK: NetworkModel = {
  status: 'syncing',
  queued: 3,
  server: 'https://os.plotinium.dev',
  lastSync: '14:31',
  latencyMs: 38,
};

export const SAMPLE_USERS: UsersModel = {
  users: [
    { name: 'student', uid: 1001, role: 'admin', groups: ['student', 'wheel'], current: true },
    { name: 'alice', uid: 1002, role: 'standard', groups: ['alice', 'lab'] },
    { name: 'bob', uid: 1003, role: 'standard', groups: ['bob', 'lab'] },
    { name: 'guest', uid: 65534, role: 'guest', groups: ['nogroup'] },
  ],
  groups: [
    { name: 'wheel', gid: 10, members: ['root', 'student'] },
    { name: 'lab', gid: 200, members: ['alice', 'bob'] },
  ],
  canAdmin: true,
};

export const SAMPLE_STORAGE: StorageModel = {
  usedBytes: 1.2 * GB,
  quotaBytes: 6 * GB,
  categories: [
    { id: 'files', label: 'Files', bytes: 540 * MB, tint: 'blue' },
    { id: 'swap', label: 'Local swap', bytes: 380 * MB, tint: 'indigo' },
    { id: 'ai', label: 'AI model and index', bytes: 176 * MB, tint: 'purple' },
    { id: 'system', label: 'System', bytes: 120 * MB, tint: 'gray' },
    { id: 'telemetry', label: 'Telemetry', bytes: 12 * MB, tint: 'teal' },
  ],
  cloudBytes: 340 * MB,
  cloudQuotaBytes: 2 * GB,
  trashBytes: 18 * MB,
};

export const SAMPLE_UPDATES: UpdatesModel = {
  current: '0.3.0',
  lastChecked: 'today at 09:12',
  state: 'ready',
  available: {
    version: '0.3.1',
    sizeBytes: 4.2 * MB,
    releasedOn: '24 Sep',
    notes: [
      'Faster page-in from local swap (p95 142 → 96 ms).',
      'Task Manager: the Scheduler tab shows the aging bound live.',
      'Fixes a focus ring clipped by the Dock.',
    ],
  },
};

export const SAMPLE_MEMORY_STATUS: MemoryStatus = {
  usedBytes: 231 * MB,
  lowWatermark: 0.75,
  highWatermark: 0.85,
};

export const SAMPLE_BOUND: BoundTerms = { p: 39, n: 51, e: 1, deltaMs: 1, hKillMs: 400 };
