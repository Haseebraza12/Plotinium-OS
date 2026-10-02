/**
 * A complete fake `DesktopEnv` for the dev harness (wm/src/shell/dev-harness.tsx) and the shell
 * tests: demo apps, a fake kernel on the real compositor-port protocol, a login with several
 * users plus Guest, a saved layout that reopens three windows (WM-06), Search over a small
 * corpus, and a live status feed (sync, memory, AI, a degraded service). Nothing here is used by
 * the product build; web/ fills the same interface from the kernel and the apps registry.
 */
import type {
  BuildIdentity,
  DesktopEnv,
  LoginResult,
  Prefs,
  SearchResponse,
  Session,
  SessionLayout,
  ThemePref,
  ViewSysClient,
} from '../env.ts';
import type { LoginUser, QueuedOp, SearchResult, ShellNotification } from '../ui.ts';
import { createDemoApps } from './demo-apps.tsx';
import { createFakeKernel, type FakeKernel } from './fake-kernel.ts';

export const DEV_IDENTITY: BuildIdentity = Object.freeze({
  name: 'Plotinium',
  version: '0.3.0',
  build: 'a1f93c2',
  buildDate: '2026-09-26',
  codename: null,
});

export const DEV_PASSWORD = 'plotinium';

export const DEV_USERS: readonly LoginUser[] = [
  { id: 'student', name: 'student', kind: 'user' },
  { id: 'alice', name: 'alice', kind: 'user' },
  { id: 'guest', name: 'Guest', kind: 'guest' },
];

const MB = 1024 * 1024;

export interface DevEnvOptions {
  /** Show the login screen (default true); false signs `student` in at once. */
  readonly login?: boolean;
  /** Reopen the saved three-window layout (default true). */
  readonly restore?: boolean;
  readonly theme?: ThemePref;
  readonly reducedMotion?: boolean;
  /** Pretend the server is unreachable (the login offline badge, OFFLINE tray state). */
  readonly offline?: boolean;
  /** Delay of the fake process start (ms). */
  readonly launchDelayMs?: number;
  /** Delay of a password check (ms), so the stage text is visible. */
  readonly verifyDelayMs?: number;
  readonly viewport?: { w: number; h: number };
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => void;
  /** The handle's `setPrefs`, bound once the desktop is mounted (Settings' theme control). */
  readonly setPrefs?: (patch: Partial<Prefs>) => void;
}

export interface DevEnv {
  readonly env: DesktopEnv;
  readonly kernel: FakeKernel;
  /** Power and notification-action calls the shell made. */
  readonly calls: string[];
  /** Layouts the shell saved. */
  readonly saved: { layout: SessionLayout; durability: 'relaxed' | 'strict' }[];
  /** Push the demo status feed (sync, memory, AI, a degraded service). */
  seedStatus(): void;
  /** Bind the handle's `setPrefs` after mounting. */
  bindPrefs(fn: (patch: Partial<Prefs>) => void): void;
}

/** The layout of the Stitch `desktop-dark` reference: Files, Terminal and Task Manager. */
export function referenceLayout(uid: number, viewport: { w: number; h: number }): SessionLayout {
  const win = (
    app: string,
    title: string,
    rect: { x: number; y: number; w: number; h: number },
    z: number,
    focused: boolean,
  ): SessionLayout['windows'][number] => ({
    app,
    argv: [],
    title,
    rect,
    restoreRect: null,
    state: 'normal',
    prevState: 'normal',
    snap: null,
    z,
    focused,
    proc: null,
  });
  return {
    v: 1,
    osSessionId: 'dev-session',
    uid,
    savedAt: 0,
    viewport: { w: viewport.w, h: viewport.h, dpr: 1 },
    windows: [
      win('terminal', 'student — sh — 80×24', { x: 856, y: 60, w: 556, h: 336 }, 1, false),
      win('taskmgr', 'Task Manager', { x: 858, y: 412, w: 448, h: 316 }, 2, false),
      win('files', 'notes', { x: 72, y: 132, w: 800, h: 548 }, 3, true),
    ],
  };
}

const CORPUS: readonly SearchResult[] = [
  {
    id: 'file:/home/student/notes/os-report.md',
    group: 'top',
    kind: 'file',
    title: 'os-report.md',
    citation: '~/notes/os-report.md:14',
    line: 14,
    snippet: 'Plotinium uses a multilevel feedback queue with 32 priority levels.',
    meta: 'Edited today',
    fileKind: 'document',
  },
  {
    id: 'file:/home/student/notes/scheduler-notes.md',
    group: 'semantic',
    kind: 'file',
    title: 'scheduler-notes.md',
    citation: '~/notes/scheduler-notes.md:3',
    line: 3,
    snippet: 'Round-robin inside each level; aging lifts starved jobs.',
    relevance: 0.82,
    meta: 'Edited yesterday',
    fileKind: 'document',
  },
  {
    id: 'file:/home/student/notes/vfs-design.pdf',
    group: 'semantic',
    kind: 'file',
    title: 'vfs-design.pdf',
    citation: '~/notes/vfs-design.pdf',
    relevance: 0.61,
    owner: 'alice',
    meta: '22 Sep',
    fileKind: 'document',
  },
];

function deniedSys(): ViewSysClient {
  return {
    closed: false,
    call: () => Promise.reject(new Error('ENOSYS: the dev harness has no kernel')),
  };
}

export function createDevEnv(o: DevEnvOptions = {}): DevEnv {
  const now = o.now ?? (() => Date.now());
  const schedule =
    o.schedule ??
    ((fn: () => void, ms: number) => {
      if (ms <= 0) fn();
      else setTimeout(fn, ms);
    });
  const later = <T>(value: T, ms: number): Promise<T> =>
    new Promise((resolve) => schedule(() => resolve(value), ms));
  const calls: string[] = [];
  const saved: DevEnv['saved'] = [];
  let setPrefs = o.setPrefs;
  const apps = createDemoApps({
    version: DEV_IDENTITY.version,
    build: DEV_IDENTITY.build,
    setTheme: (theme) => setPrefs?.({ theme }),
  });
  const kernel = createFakeKernel({
    apps,
    titles: { files: 'notes', taskmgr: 'Task Manager' },
    launchDelayMs: o.launchDelayMs ?? 0,
    now,
    schedule,
  });
  const verifyMs = o.verifyDelayMs ?? 0;
  const sessionOf = (id: string): Session =>
    id === 'guest'
      ? { uid: 2000, user: 'guest', kind: 'guest' }
      : { uid: id === 'alice' ? 1002 : 1001, user: id, kind: 'user' };
  const viewport = o.viewport ?? { w: 1440, h: 900 };
  const outbox: QueuedOp[] = [
    { id: 'op1', verb: 'write', path: '~/notes/os-report.md', time: '10:41' },
    { id: 'op2', verb: 'mkdir', path: '~/notes/figures', time: '10:42' },
  ];
  const notifications: ShellNotification[] = [
    {
      id: 'welcome',
      level: 'info',
      title: 'Welcome to Plotinium',
      body: 'Press Ctrl+Space to search, Alt+` to switch windows.',
      app: 'atom',
      appName: 'Plotinium',
      at: now() - 60_000,
      unread: false,
    },
  ];

  const env: DesktopEnv = {
    identity: DEV_IDENTITY,
    apps,
    kernel: {
      compositorPort: kernel.port,
      viewSys: () => deniedSys(),
      subscribe: (fn) => kernel.subscribe(fn),
    },
    auth: {
      users: () => DEV_USERS,
      login: async (userId, password, report): Promise<LoginResult> => {
        report('Checking password');
        await later(undefined, verifyMs);
        if (password !== DEV_PASSWORD) return { ok: false };
        report('Loading your desktop');
        return { ok: true, session: sessionOf(userId) };
      },
      guest: async (userId, report): Promise<LoginResult> => {
        report('Starting session');
        await later(undefined, verifyMs);
        return { ok: true, session: sessionOf(userId) };
      },
      offline: () => o.offline === true,
      current: () => (o.login === false ? sessionOf('student') : null),
      unlock: (userId, password) =>
        later<LoginResult>(
          password === DEV_PASSWORD ? { ok: true, session: sessionOf(userId) } : { ok: false },
          verifyMs,
        ),
    },
    session: {
      osSessionId: 'dev-session',
      loadLayout: (s) => (o.restore === false ? null : referenceLayout(s.uid, viewport)),
      saveLayout: (layout, durability) => {
        saved.push({ layout, durability });
      },
    },
    prefs: {
      initial: {
        ...(o.theme === undefined ? {} : { theme: o.theme }),
        ...(o.reducedMotion === undefined ? {} : { reducedMotion: o.reducedMotion }),
      },
      save: (p) => calls.push(`prefs:${p.theme}`),
    },
    search: {
      query: (q, signal): Promise<SearchResponse> => {
        const needle = q.trim().toLowerCase();
        const results = CORPUS.filter(
          (r) =>
            r.title.toLowerCase().includes(needle) ||
            (r.snippet ?? '').toLowerCase().includes(needle),
        ).map((r) => ({ ...r, terms: [needle] }));
        return later(
          signal.aborted
            ? { results: [] }
            : { results, stats: { count: results.length, ms: 12, source: 'local index' } },
          40,
        );
      },
      open: (r, how) => calls.push(`open:${how}:${r.id}`),
      askAgent: (prompt) => calls.push(`agent:${prompt}`),
    },
    power: (action) => calls.push(`power:${action}`),
    setMemoryBudget: (mb) => {
      calls.push(`budget:${String(mb)}`);
      return Promise.resolve(undefined);
    },
    retryService: (name) => {
      calls.push(`retry:${name}`);
    },
    retryNetwork: () => calls.push('retry-network'),
    outbox: () => outbox,
    notificationAction: (id, action) => calls.push(`notify:${id}:${action}`),
    ai: true,
    now,
    notifications,
  };

  const seedStatus = (): void => {
    kernel.publish('net.state', {
      state: o.offline === true ? 'offline' : 'online',
      queuedOps: o.offline === true ? 2 : 0,
      lastAckAt: now() - 90_000,
      degraded: [],
      leaseTtlMs: 15_000,
      serverBuild: DEV_IDENTITY.build,
    });
    kernel.publish('mem.pressure', { accounted: 142 * MB, budget: 256 * MB, level: 'ok' });
    kernel.publish('ai.model', { state: 'ready' });
    kernel.publish('svc.started', { name: 'syncd', critical: true });
  };

  return {
    env,
    kernel,
    calls,
    saved,
    seedStatus,
    bindPrefs: (fn) => {
      setPrefs = fn;
    },
  };
}
