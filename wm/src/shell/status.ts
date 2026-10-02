/**
 * Kernel events → menu-bar status (window-manager.md §3.11, §4.7; OFF-04, WMD-11). Pure mapping
 * from protocol payloads to the ui view shapes, applied one batch at a time. The shell keeps the
 * result in a Solid store; nothing here reads a clock (event times come from the batch).
 */
import type { EventData, KEvent, NetStatus, Topic } from '@plotinium/protocol';

import type { AiView, MemoryView, NetView, ShellNotification, SvcView } from './ui.ts';

const MB = 1024 * 1024;
/** Without a `retryAt` from the kernel, a reconnect is assumed within this window. */
const DEFAULT_RETRY_MS = 5_000;

export interface LeaseView {
  /** The inode id (a UUIDv7). */
  readonly ino: string;
  readonly holder: string;
  readonly state: 'held' | 'released' | 'expired';
  readonly expiresAt: number | null;
  readonly fence: number | null;
}

export interface StatusState {
  readonly net: NetView;
  readonly lastSyncAt: number | undefined;
  readonly queued: number;
  readonly leaseTtlMs: number;
  readonly services: readonly SvcView[];
  readonly memory: MemoryView | undefined;
  readonly ai: AiView | undefined;
  /** The last `ai.index.progress` with files still pending, or undefined once it finished. */
  readonly aiIndexing: AiView | undefined;
  readonly update: { version: string; build: string } | undefined;
  readonly lease: LeaseView | undefined;
}

export const INITIAL_STATUS: StatusState = Object.freeze<StatusState>({
  net: { state: 'LIVE' },
  lastSyncAt: undefined,
  queued: 0,
  leaseTtlMs: 15_000,
  services: [],
  memory: undefined,
  ai: undefined,
  aiIndexing: undefined,
  update: undefined,
  lease: undefined,
});

/** NetStatus (syscall-abi.md §4.4.8) → the tray's view (the exact strings live in ui format.ts). */
export function netView(s: NetStatus, at: number): NetView {
  const retryAt = (s as NetStatus & { retryAt?: number }).retryAt ?? at + DEFAULT_RETRY_MS;
  switch (s.state) {
    case 'online':
      return s.queuedOps > 0 ? { state: 'SYNCING', ops: s.queuedOps } : { state: 'LIVE' };
    case 'connecting':
    case 'resuming':
      return { state: 'RECONNECTING', retryAt };
    case 'offline':
      return { state: 'OFFLINE', queued: s.queuedOps };
    case 'auth-required':
      return { state: 'AUTH_REQUIRED', queued: s.queuedOps };
  }
}

type SvcTopic = 'svc.started' | 'svc.degraded' | 'svc.failed' | 'svc.stopped';

function applyService(
  list: readonly SvcView[],
  topic: SvcTopic,
  d: EventData[SvcTopic],
  at: number,
): SvcView[] {
  const prev = list.find((s) => s.name === d.name);
  const rest = list.filter((s) => s.name !== d.name);
  switch (topic) {
    case 'svc.stopped':
      return rest;
    case 'svc.started':
      return [...rest, { name: d.name, state: 'running', attempts: 0 }];
    case 'svc.degraded':
    case 'svc.failed': {
      const row: SvcView = {
        name: d.name,
        state: topic === 'svc.failed' ? 'failed' : 'degraded',
        attempts: (prev?.attempts ?? 0) + 1,
        ...(d.error === undefined ? {} : { reason: d.error }),
        ...(d.retryInMs === undefined ? {} : { nextRetryAt: at + d.retryInMs }),
      };
      return [...rest, row];
    }
  }
}

/**
 * The AI item from `ai.model` and `ai.index.progress` (UI-071). A model that finished loading is
 * idle unless the indexer reported files still pending; an index report with nothing pending is
 * idle too, so the chip never stays at "AI 100%, indexing".
 */
function aiFrom(
  s: StatusState,
  e: KEvent<'ai.index.progress' | 'ai.model'>,
): { ai: AiView; aiIndexing: AiView | undefined } {
  if (e.topic === 'ai.model') {
    if (e.data.state === 'failed')
      return { ai: { state: 'error', detail: 'model failed to load' }, aiIndexing: s.aiIndexing };
    if (e.data.state === 'loading') {
      const total = e.data.totalBytes ?? 0;
      const done = e.data.loadedBytes ?? 0;
      return {
        ai: { state: 'indexing', progress: total > 0 ? Math.min(1, done / total) : 0 },
        aiIndexing: s.aiIndexing,
      };
    }
    return { ai: s.aiIndexing ?? { state: 'idle' }, aiIndexing: s.aiIndexing };
  }
  const d = e.data;
  if ((d.state === 'indexing' || d.state === 'throttled') && d.pending > 0) {
    const all = d.indexedFiles + d.pending;
    const view: AiView = { state: 'indexing', progress: d.indexedFiles / all };
    return { ai: view, aiIndexing: view };
  }
  if (d.state === 'degraded')
    return { ai: { state: 'error', detail: 'index degraded' }, aiIndexing: undefined };
  return { ai: { state: 'idle' }, aiIndexing: undefined };
}

/** Topics that change the menu-bar status. */
const STATUS_TOPICS = [
  'net.state',
  'svc.started',
  'svc.degraded',
  'svc.failed',
  'svc.stopped',
  'mem.pressure',
  'ai.index.progress',
  'ai.model',
  'update.available',
  'lock.queued',
  'lock.granted',
  'lock.lost',
] as const satisfies readonly Topic[];
type StatusTopic = (typeof STATUS_TOPICS)[number];

/** Topics that post a notification. */
const NOTIFY_TOPICS = [
  'notify',
  'vfs.conflict',
  'lock.lost',
  'update.available',
  'svc.degraded',
] as const satisfies readonly Topic[];
type NotifyTopic = (typeof NOTIFY_TOPICS)[number];

/** Narrow an event to the topics a switch below handles (every other topic is ignored). */
function isStatusEvent(e: KEvent): e is KEvent<StatusTopic> {
  return (STATUS_TOPICS as readonly Topic[]).includes(e.topic);
}
function isNotifyEvent(e: KEvent): e is KEvent<NotifyTopic> {
  return (NOTIFY_TOPICS as readonly Topic[]).includes(e.topic);
}

/** Apply one kernel batch. Returns the same object when nothing the shell draws changed. */
export function applyEvents(state: StatusState, batch: readonly KEvent[]): StatusState {
  let s = state;
  for (const e of batch) {
    if (!isStatusEvent(e)) continue;
    switch (e.topic) {
      case 'net.state':
        s = {
          ...s,
          net: netView(e.data, e.t),
          queued: e.data.queuedOps,
          leaseTtlMs: e.data.leaseTtlMs > 0 ? e.data.leaseTtlMs : s.leaseTtlMs,
          lastSyncAt: e.data.lastAckAt ?? s.lastSyncAt,
        };
        break;
      case 'svc.started':
      case 'svc.degraded':
      case 'svc.failed':
      case 'svc.stopped':
        s = { ...s, services: applyService(s.services, e.topic, e.data, e.t) };
        break;
      case 'mem.pressure':
        s = {
          ...s,
          memory: { usedMb: e.data.accounted / MB, budgetMb: e.data.budget / MB },
        };
        break;
      case 'ai.index.progress':
      case 'ai.model':
        s = { ...s, ...aiFrom(s, e) };
        break;
      case 'update.available':
        s = { ...s, update: { version: e.data.version, build: e.data.build } };
        break;
      case 'lock.queued':
        s = {
          ...s,
          lease: {
            ino: e.data.ino,
            holder: e.data.holder ?? 'another user',
            state: 'held',
            expiresAt: e.data.expiresAt ?? null,
            fence: e.data.fence ?? null,
          },
        };
        break;
      case 'lock.granted':
        if (s.lease?.ino === e.data.ino) s = { ...s, lease: { ...s.lease, state: 'released' } };
        break;
      case 'lock.lost':
        s = {
          ...s,
          lease: {
            ino: e.data.ino,
            holder: e.data.holder ?? 'you',
            state: 'expired',
            expiresAt: e.data.expiresAt ?? null,
            fence: e.data.fence ?? null,
          },
        };
        break;
    }
  }
  return s;
}

/** The names the sync service runs under (svcmgr `sync`; the dev harness `syncd`). */
const SYNC_SERVICES: ReadonlySet<string> = new Set(['sync', 'syncd']);

/** Why the sync service is not working (its reason), or undefined while it is healthy or unknown. */
export function syncIssue(services: readonly SvcView[]): string | undefined {
  const svc = services.find(
    (x) =>
      SYNC_SERVICES.has(x.name) &&
      (x.state === 'degraded' || x.state === 'failed' || x.state === 'blocked'),
  );
  if (svc === undefined) return undefined;
  if (svc.reason !== undefined && svc.reason !== '') return svc.reason;
  return svc.state === 'blocked'
    ? `blocked by ${svc.blockedBy ?? 'a dependency'}`
    : `sync service ${svc.state}`;
}

/**
 * Connectivity as the tray shows it (UI-025): a reachable server with a degraded or unlinked sync
 * service is "Sync unavailable", never "all changes synced". Offline, reconnecting and sign-in
 * states stay as they are (they already say changes are not reaching the server).
 */
export function trayNet(s: Pick<StatusState, 'net' | 'services' | 'queued'>): NetView {
  const issue = syncIssue(s.services);
  if (issue === undefined) return s.net;
  if (s.net.state === 'LIVE') return { state: 'UNAVAILABLE', queued: s.queued, reason: issue };
  if (s.net.state === 'SYNCING') return { state: 'UNAVAILABLE', queued: s.net.ops, reason: issue };
  return s.net;
}

/** Degraded, failed or blocked services (the menu-bar item hides at 0). */
export function degradedServices(services: readonly SvcView[]): SvcView[] {
  return services.filter(
    (s) => s.state === 'degraded' || s.state === 'failed' || s.state === 'blocked',
  );
}

/** `notify`, `vfs.conflict`, `lock.lost` and `update.available` become notifications. */
export function notificationsFrom(batch: readonly KEvent[]): ShellNotification[] {
  const out: ShellNotification[] = [];
  for (const e of batch) {
    if (!isNotifyEvent(e)) continue;
    switch (e.topic) {
      case 'notify':
        out.push({
          id: `n${String(e.data.nid)}`,
          level: e.data.level === 'warn' ? 'warning' : e.data.level,
          title: e.data.title,
          ...(e.data.body === '' ? {} : { body: e.data.body }),
          at: e.t,
          unread: true,
        });
        break;
      case 'vfs.conflict':
        out.push({
          id: `conflict-${e.data.ino}-${String(e.seq)}`,
          level: 'warning',
          title: `Changed on the server by ${e.data.by}`,
          body: 'Your version was kept as',
          code: e.data.keptAs.path,
          app: 'files',
          appName: 'Files',
          actions: [{ id: 'open', label: 'Open', kind: 'primary' }],
          at: e.t,
          unread: true,
        });
        break;
      case 'lock.lost':
        out.push({
          id: `lock-lost-${e.data.ino}-${String(e.seq)}`,
          level: 'warning',
          title: 'Lock lost',
          body: 'Another device took the file over; your copy is read-only until you reopen it.',
          at: e.t,
          unread: true,
        });
        break;
      case 'update.available':
        out.push({
          id: `update-${e.data.build}`,
          level: 'info',
          title: `Plotinium ${e.data.version} is ready`,
          body: 'Restart to update. Your windows will be restored.',
          actions: [
            { id: 'restart-update', label: 'Restart to update', kind: 'primary' },
            { id: 'later', label: 'Later' },
          ],
          app: 'atom',
          appName: 'Plotinium',
          at: e.t,
          unread: true,
        });
        break;
      case 'svc.degraded':
        if (e.data.critical) break;
        out.push({
          id: `svc-${e.data.name}-${String(e.seq)}`,
          level: 'warning',
          title: `${serviceTitle(e.data.name)} is degraded`,
          body:
            e.data.error === undefined || e.data.error === ''
              ? `Service ${e.data.name}`
              : `${e.data.error} (${e.data.name})`,
          appName: SYSTEM_SOURCE,
          at: e.t,
          unread: true,
        });
        break;
    }
  }
  return out;
}

/**
 * The service whose "is degraded" notification has this id (`svc-<name>-<seq>`), else undefined.
 * When the service starts again the shell drops those notifications: a self-healing degradation
 * such as sync's "connecting" during boot must not leave a stale banner beside "Online, all changes
 * synced".
 */
export function degradedServiceOf(id: string): string | undefined {
  return /^svc-(.+)-\d+$/u.exec(id)?.[1];
}

/** Where system notifications (services, the kernel) come from: one group, one banner source. */
export const SYSTEM_SOURCE = 'System';

/** Readable names of the system services, for notification titles (UI-151). */
const SERVICE_TITLES: Readonly<Record<string, string>> = {
  sync: 'Sync',
  syncd: 'Sync',
  lockd: 'File locking',
  update: 'Software update',
  'ai.agent': 'The AI agent',
  'ai.predictor': 'App predictions',
  'ai.runtime': 'The AI runtime',
  'ai.indexer': 'File indexing',
  vfs: 'The file system',
  netd: 'Networking',
  login: 'Sign-in',
  wm: 'The window manager',
};

/** "File locking" for `lockd`; an unknown service keeps its own name. */
export function serviceTitle(name: string): string {
  return SERVICE_TITLES[name] ?? name;
}

/** Identical notifications share this key: level, source, title, body and code. */
export function notificationKey(n: ShellNotification): string {
  return [n.level, n.app ?? '', n.appName ?? '', n.title, n.body ?? '', n.code ?? ''].join(
    '\u0000',
  );
}

/** The banner rate limit's source: the app, else the system. */
export function notificationSource(n: ShellNotification): string {
  return n.app ?? n.appName ?? SYSTEM_SOURCE;
}

/**
 * Add notifications newest first, merging repeats (UI-080): an identical notification already in
 * the list is replaced by the new one, which keeps the old id (its card stays mounted), moves to
 * the front and counts the repeat ("×3"). Keeps at most `max`.
 */
export function mergeNotifications(
  list: readonly ShellNotification[],
  add: readonly ShellNotification[],
  max = 50,
): ShellNotification[] {
  let out = [...list];
  for (const n of add) {
    const key = notificationKey(n);
    const at = out.findIndex((x) => notificationKey(x) === key);
    const prev = at < 0 ? undefined : out[at];
    if (prev === undefined) {
      out = [n, ...out.filter((x) => x.id !== n.id)];
      continue;
    }
    out.splice(at, 1);
    out.unshift({ ...n, id: prev.id, count: (prev.count ?? 1) + (n.count ?? 1) });
  }
  return out.slice(0, max);
}

/** Keep the centre at the last `max` notifications, newest first, without duplicate ids. */
export function pushNotifications(
  list: readonly ShellNotification[],
  add: readonly ShellNotification[],
  max = 50,
): ShellNotification[] {
  if (add.length === 0) return [...list];
  const ids = new Set(add.map((n) => n.id));
  return [...[...add].reverse(), ...list.filter((n) => !ids.has(n.id))].slice(0, max);
}
