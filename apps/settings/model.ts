/**
 * Settings view models and the map from each Settings control to where its value lives
 * (ui-design-system.md §3.8.14; MEM-01, PROC-03, PRE-05, BOOT-06). Pure functions, unit-tested.
 *
 * Three homes for a value:
 * - `sysctl` (kernel parameters, set by the Settings process): the memory budget and soft limit,
 *   the swap tier, the scheduler quanta and T_age, the boot flags. The specs spell some keys two
 *   ways (memory-and-paging.md `mm.budget` in bytes; syscall-abi.md `mm.budgetMB`), so each
 *   setting lists its spellings and the one the kernel reports wins;
 * - the desktop preferences (`AppEnv.prefs`): appearance, Dock, windows, general, sync, updates;
 * - `ai.telemetry.optin` for telemetry sync (PRE-05), confirmed before the preference changes.
 */
import type {
  AuditRecord,
  IndexStatus,
  NetStatus,
  ProcInfo,
  Quota,
  RetOf,
  StatFs,
  TelemetryEvent as KernelTelemetryEvent,
} from '@plotinium/protocol';
import type {
  BoundTerms,
  NetworkModel,
  PrivacyModel,
  SettingKey,
  SettingsSectionId,
  SettingValues,
  StorageModel,
  TelemetryEvent,
  UpdatesModel,
  UsersModel,
} from '@plotinium/ui/apps/settings';

import type { DesktopPrefKey, DesktopPrefs } from '../src/descriptor.ts';
import { SETTINGS_SECTIONS } from './index.ts';

export const MIB = 1024 * 1024;
export const GUEST_UID = 65_534;

/** Sidebar order; the descriptor's View menu sends `go.<id>`. */
export const SECTION_IDS: readonly SettingsSectionId[] = SETTINGS_SECTIONS.map((s) => s.id);

/** The section named by the launch argv (`settings memory`); `privacy-ai` is an alias. */
export function sectionFromArgv(argv: readonly string[]): SettingsSectionId | undefined {
  const want = argv[0] === 'privacy-ai' ? 'privacy' : argv[0];
  return SECTION_IDS.find((s) => s === want);
}

/** The section of a View-menu command id (`go.memory`), if it is one. */
export function sectionOfCommand(id: string): SettingsSectionId | undefined {
  return SECTION_IDS.find((s) => `go.${s}` === id);
}

// ---------------------------------------------------------------------------------------------
// Where each value lives
// ---------------------------------------------------------------------------------------------

type Scalar = string | number | boolean;

export interface SysctlBinding {
  /** Kernel keys in order of preference; the first one `sysctl.get` reports is used. */
  readonly keys: readonly string[];
  readonly toKernel: (value: Scalar, key: string) => Scalar;
  readonly fromKernel: (value: Scalar, key: string) => Scalar | undefined;
}

/**
 * Sizes: `mm.budget` is in bytes (memory-and-paging.md §4.6), `mm.budgetMB` in MB. The kernel
 * reports 0 while the memory manager is not running; that is "unknown", not a 0 MB budget.
 */
const mbOrBytes: Pick<SysctlBinding, 'toKernel' | 'fromKernel'> = {
  toKernel: (v, key) => (key.endsWith('MB') ? Number(v) : Number(v) * MIB),
  fromKernel: (v, key) =>
    typeof v === 'number' && v > 0 ? Math.round(key.endsWith('MB') ? v : v / MIB) : undefined,
};

const ms: Pick<SysctlBinding, 'toKernel' | 'fromKernel'> = {
  toKernel: (v) => Number(v),
  fromKernel: (v) => (typeof v === 'number' ? v : undefined),
};

const flag: Pick<SysctlBinding, 'toKernel' | 'fromKernel'> = {
  toKernel: (v) => Boolean(v),
  fromKernel: (v) => (typeof v === 'boolean' ? v : undefined),
};

/** The Settings controls backed by kernel parameters. */
export const SYSCTL_BINDINGS = {
  'mm.budgetMB': { keys: ['mm.budget', 'mm.budgetMB'], ...mbOrBytes },
  'mm.softLimitMB': { keys: ['mm.softLimit', 'mm.softLimitMB'], ...mbOrBytes },
  'mm.remoteOnly': {
    keys: ['mm.swap.tier', 'mm.swapTier'],
    toKernel: (v) => (v === true ? 'remote' : 'auto'),
    fromKernel: (v) => (typeof v === 'string' ? v === 'remote' : undefined),
  },
  'sched.quantumMs.interactive': {
    keys: ['sched.quantum.interactive', 'sched.quantumMs.interactive'],
    ...ms,
  },
  'sched.quantumMs.normal': { keys: ['sched.quantum.normal', 'sched.quantumMs.normal'], ...ms },
  'sched.quantumMs.background': {
    keys: ['sched.quantum.background', 'sched.quantumMs.background'],
    ...ms,
  },
  'sched.tAgeMs': { keys: ['sched.tAge', 'sched.tAgeMs'], ...ms },
  'boot.menuNextBoot': { keys: ['boot.showMenuNextBoot', 'boot.menuNextBoot'], ...flag },
  'boot.verbose': { keys: ['boot.verbose'], ...flag },
} as const satisfies Partial<Record<SettingKey, SysctlBinding>>;

export type SysctlSettingKey = keyof typeof SYSCTL_BINDINGS;

export function isSysctlSetting(key: SettingKey): key is SysctlSettingKey {
  return Object.hasOwn(SYSCTL_BINDINGS, key);
}

/** Defaults of the kernel-backed controls (processes-and-scheduling.md §3.1; MEM-01). */
export const SYSCTL_DEFAULTS: Readonly<Pick<SettingValues, SysctlSettingKey>> = {
  'mm.budgetMB': 256,
  'mm.softLimitMB': 64,
  'mm.remoteOnly': false,
  'sched.quantumMs.interactive': 5,
  'sched.quantumMs.normal': 10,
  'sched.quantumMs.background': 20,
  'sched.tAgeMs': 100,
  'boot.menuNextBoot': false,
  'boot.verbose': false,
};

/** The kernel key to write: the spelling the kernel reported, else the owning spec's. */
export function sysctlKeyFor(
  setting: SysctlSettingKey,
  reported: Readonly<Record<string, Scalar>>,
): string {
  const keys: readonly string[] = SYSCTL_BINDINGS[setting].keys;
  return keys.find((k) => Object.hasOwn(reported, k)) ?? keys[0] ?? setting;
}

/** The controls' values from `sysctl.get`, defaults for keys the kernel does not report. */
export function valuesFromSysctl(
  reported: Readonly<Record<string, Scalar>>,
): Pick<SettingValues, SysctlSettingKey> {
  const out: Record<string, Scalar> = { ...SYSCTL_DEFAULTS };
  for (const [setting, binding] of Object.entries(SYSCTL_BINDINGS) as [
    SysctlSettingKey,
    SysctlBinding,
  ][]) {
    const key = binding.keys.find((k) => Object.hasOwn(reported, k));
    if (key === undefined) continue;
    const raw = reported[key];
    const v = raw === undefined ? undefined : binding.fromKernel(raw, key);
    if (v !== undefined) out[setting] = v;
  }
  return out as Pick<SettingValues, SysctlSettingKey>;
}

/** Settings keys that are desktop preferences (the rest are sysctl-backed). */
export const PREF_SETTING_KEYS = [
  'general.deviceName',
  'general.language',
  'general.clock24h',
  'appearance.theme',
  'appearance.accent',
  'appearance.reduceMotion',
  'appearance.reduceTransparency',
  'dock.size',
  'dock.magnification',
  'dock.magnificationScale',
  'dock.autohide',
  'dock.showIndicators',
  'dock.showSuggestions',
  'dock.minimiseEffect',
  'windows.doubleClickTitle',
  'sync.files',
  'sync.swapWriteBehind',
  'telemetry.sync',
  'agent.requireConfirm',
  'updates.auto',
  'updates.channel',
] as const satisfies readonly (SettingKey & DesktopPrefKey)[];

export type PrefSettingKey = (typeof PREF_SETTING_KEYS)[number];

export function isPrefSetting(key: SettingKey): key is PrefSettingKey {
  return (PREF_SETTING_KEYS as readonly string[]).includes(key);
}

export function valuesFromPrefs(
  prefs: Readonly<DesktopPrefs>,
): Pick<SettingValues, PrefSettingKey> {
  const out: Partial<Record<PrefSettingKey, unknown>> = {};
  for (const key of PREF_SETTING_KEYS) out[key] = prefs[key];
  return out as Pick<SettingValues, PrefSettingKey>;
}

/** Human labels for error messages ("Could not change Global budget: …"). */
export const SETTING_LABEL: Readonly<Partial<Record<SettingKey, string>>> = {
  'mm.budgetMB': 'the memory budget',
  'mm.softLimitMB': 'the per-process soft limit',
  'mm.remoteOnly': 'the swap tier',
  'sched.quantumMs.interactive': 'the interactive quantum',
  'sched.quantumMs.normal': 'the normal quantum',
  'sched.quantumMs.background': 'the background quantum',
  'sched.tAgeMs': 'the aging interval',
  'boot.menuNextBoot': 'the boot menu flag',
  'boot.verbose': 'verbose boot',
  'telemetry.sync': 'telemetry sync',
};

// ---------------------------------------------------------------------------------------------
// Telemetry (PRE-05)
// ---------------------------------------------------------------------------------------------

function isKernelEvent(x: unknown): x is KernelTelemetryEvent {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r['seq'] === 'number' &&
    typeof r['ts'] === 'number' &&
    typeof r['app'] === 'string' &&
    (r['kind'] === 'launch' || r['kind'] === 'focus' || r['kind'] === 'close')
  );
}

/** `ai.telemetry.export` output (JSON Lines) → events, oldest first; bad lines are skipped. */
export function parseTelemetry(jsonl: string): KernelTelemetryEvent[] {
  const out: KernelTelemetryEvent[] = [];
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const v: unknown = JSON.parse(t);
      if (isKernelEvent(v)) out.push(v);
    } catch {
      // A torn last line (export while recording) is not an event.
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** The 4-hour bucket of predictive-prefetch.md §3.2: "08:00–12:00 weekday". */
export function bucketText(e: Pick<KernelTelemetryEvent, 'hourBucket' | 'weekend'>): string {
  const from = e.hourBucket * 4;
  return `${pad2(from)}:00–${pad2(from + 4)}:00 ${e.weekend ? 'weekend' : 'weekday'}`;
}

/** Newest first, at most `limit` rows. App ids and times only (no names or paths). */
export function telemetryRows(
  events: readonly KernelTelemetryEvent[],
  limit: number,
): TelemetryEvent[] {
  return [...events]
    .reverse()
    .slice(0, limit)
    .map((e) => {
      const row: TelemetryEvent = {
        id: `${e.osSessionId}:${String(e.seq)}`,
        at: e.ts,
        event: e.kind,
        app: e.app,
        bucket: bucketText(e),
      };
      if (e.prev !== null) row.previousApp = e.prev;
      return row;
    });
}

/** "24 Sep 2026, 10:41" (en-GB), or "—" for no events. */
export function formatWhen(t: number | null, locale = 'en-GB'): string {
  if (t === null) return '—';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(t);
}

/** `telemetry-YYYYMMDD-HHmm.jsonl` (predictive-prefetch.md §3.3, Export). */
export function exportFileName(t: number): string {
  const d = new Date(t);
  return `telemetry-${String(d.getFullYear())}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.jsonl`;
}

/** The predictor line of the Privacy summary: "cold start 12/50 launches" or "Markov-2". */
export function predictorText(
  p: { model: string; launches: number } | null,
  aiAvailable: boolean,
): string {
  if (!aiAvailable) return 'off';
  if (p === null) return 'not running';
  if (p.launches < 50) return `cold start ${String(p.launches)}/50 launches`;
  return p.model === 'markov2' ? 'Markov-2' : p.model === 'markov1' ? 'Markov-1' : 'MFU';
}

export interface PrivacyFacts {
  readonly aiAvailable: boolean;
  readonly events: readonly KernelTelemetryEvent[];
  readonly exportBytes: number;
  readonly rowLimit: number;
  readonly predictor: { model: string; launches: number } | null;
  readonly exporting: boolean;
  readonly optinPending: boolean;
  readonly telemetryError?: string;
  readonly index: IndexStatus | null;
  readonly indexError?: string;
  readonly indexer: ProcInfo | undefined;
  readonly rebuilding: boolean;
  readonly net: NetStatus | null;
  readonly audit: readonly AuditRecord[];
  readonly budget: {
    usedCents: number;
    capCents: number;
    resetsOn: string;
    provider?: string;
  } | null;
  readonly locale?: string;
}

function modelState(f: PrivacyFacts): PrivacyModel['model'] {
  if (!f.aiAvailable) return { name: '—', detail: 'AI is off in this build', state: 'off' };
  const idx = f.index;
  if (idx === null)
    return {
      name: '—',
      detail: f.indexError ?? 'the AI runtime has not answered',
      state: 'unavailable',
    };
  const size =
    idx.totalBytes === undefined ? '' : ` · ${String(Math.round(idx.totalBytes / MIB))} MB`;
  switch (idx.modelState) {
    case 'ready':
      return { name: idx.modelKey, detail: `ready${size}`, state: 'ready' };
    case 'loading': {
      const pct =
        idx.loadedBytes !== undefined && idx.totalBytes !== undefined && idx.totalBytes > 0
          ? Math.round((idx.loadedBytes / idx.totalBytes) * 100)
          : null;
      // Every byte is in but the runtime has not reported ready: it is starting the model, not
      // loading it ("loading 100%" read as a contradiction, UI-141).
      const detail = pct === null ? 'loading' : pct >= 100 ? 'starting' : `loading ${String(pct)}%`;
      return { name: idx.modelKey, detail, state: 'loading' };
    }
    case 'absent':
      return { name: idx.modelKey, detail: 'not downloaded yet', state: 'unavailable' };
    case 'evicted':
      return { name: idx.modelKey, detail: 'evicted to free memory', state: 'unavailable' };
    case 'failed':
      return {
        name: idx.modelKey,
        detail: idx.lastError ?? 'failed to load',
        state: 'unavailable',
      };
  }
}

function indexState(s: IndexStatus['state']): PrivacyModel['index']['state'] {
  switch (s) {
    case 'idle':
      return 'idle';
    case 'indexing':
      return 'indexing';
    case 'paused':
    case 'throttled':
      return 'paused';
    case 'degraded':
      return 'error';
  }
}

export function agentStatus(net: NetStatus | null): PrivacyModel['agent']['status'] {
  if (net === null) return 'offline';
  if (net.degraded.some((d) => d.startsWith('ai'))) return 'degraded';
  switch (net.state) {
    case 'online':
      return 'connected';
    case 'auth-required':
      return 'signed-out';
    case 'connecting':
    case 'resuming':
      return 'degraded';
    case 'offline':
      return 'offline';
  }
}

/**
 * Two Privacy controls have no system call behind them yet (UI-146), so the pane disables them
 * with these notes instead of confirming and then reporting "not available".
 */
export const REBUILD_NOTE = 'Rebuilding the index from Settings is not available in this build.';
export const SERVER_DELETE_NOTE =
  'The copy on the server is kept: deleting it from here is not available in this build.';

export function toPrivacyModel(f: PrivacyFacts): PrivacyModel {
  const oldest = f.events[0]?.ts ?? null;
  const telemetry: PrivacyModel['telemetry'] = {
    rows: telemetryRows(f.events, f.rowLimit),
    count: f.events.length,
    bytes: f.exportBytes,
    oldest: formatWhen(oldest, f.locale),
    predictor: predictorText(f.predictor, f.aiAvailable),
  };
  if (f.exporting) telemetry.exporting = true;
  if (f.optinPending) telemetry.pending = true;
  if (f.telemetryError !== undefined) telemetry.error = f.telemetryError;
  telemetry.serverDeleteUnavailable = SERVER_DELETE_NOTE;
  const idx = f.index;
  const index: PrivacyModel['index'] = {
    state: idx === null ? (f.indexError === undefined ? 'paused' : 'error') : indexState(idx.state),
    indexed: idx?.indexedFiles ?? 0,
    total: idx === null ? 0 : idx.indexedFiles + idx.pending,
    pid: f.indexer?.pid ?? 0,
    priority:
      f.indexer === undefined ? 32 : Math.min(39, Math.max(0, f.indexer.priority + f.indexer.nice)),
  };
  if (f.rebuilding) index.rebuilding = true;
  index.rebuildUnavailable = REBUILD_NOTE;
  const err = idx?.lastError ?? f.indexError;
  if (err !== undefined && index.state === 'error') index.error = err;
  const last = [...f.audit].sort((a, b) => b.t - a.t)[0];
  const agent: PrivacyModel['agent'] = {
    provider: f.budget?.provider ?? 'Plotinium server (LLM proxy)',
    status: agentStatus(f.net),
    usedCents: f.budget?.usedCents ?? 0,
    capCents: f.budget?.capCents ?? 0,
    resetsOn: f.budget?.resetsOn ?? '—',
  };
  if (last !== undefined)
    agent.lastAction = {
      time: formatWhen(last.t, f.locale),
      summary: last.argsSummary,
      outcome: last.outcome,
    };
  return { telemetry, model: modelState(f), index, agent };
}

// ---------------------------------------------------------------------------------------------
// Network, users, storage, updates, scheduler bound
// ---------------------------------------------------------------------------------------------

export function toNetworkModel(
  net: NetStatus | null,
  server: string,
  locale = 'en-GB',
): NetworkModel {
  if (net === null) return { status: 'offline', queued: 0, server, lastSync: 'never' };
  // Online with the sync service degraded is not "Online": nothing reaches the server (UI-141).
  const status: NetworkModel['status'] =
    net.state === 'online'
      ? net.degraded.includes('sync')
        ? 'degraded'
        : net.queuedOps > 0
          ? 'syncing'
          : 'online'
      : net.state === 'auth-required'
        ? 'auth'
        : net.state === 'offline'
          ? 'offline'
          : 'syncing';
  return {
    status,
    queued: net.queuedOps,
    server,
    lastSync: net.lastAckAt === null ? 'never' : formatWhen(net.lastAckAt, locale),
  };
}

export function toUsersModel(
  list: RetOf<'users.list'> | null,
  currentUid: number | null,
): UsersModel {
  if (list === null) return { users: [], groups: [], canAdmin: currentUid === 0 };
  const groupName = new Map(list.groups.map((g) => [g.gid, g.name]));
  const admins = new Set(
    list.groups
      .filter((g) => g.name === 'wheel' || g.name === 'admin' || g.name === 'sudo')
      .map((g) => g.gid),
  );
  const users = list.users.map((u) => {
    const role: UsersModel['users'][number]['role'] =
      u.uid === 0 || u.groups.some((g) => admins.has(g))
        ? 'admin'
        : u.uid === GUEST_UID
          ? 'guest'
          : 'standard';
    const account = {
      name: u.name,
      uid: u.uid,
      role,
      groups: u.groups.map((g) => groupName.get(g) ?? String(g)),
    };
    return u.uid === currentUid ? { ...account, current: true } : account;
  });
  const groups = list.groups.map((g) => ({
    name: g.name,
    gid: g.gid,
    members: list.users
      .filter((u) => u.gid === g.gid || u.groups.includes(g.gid))
      .map((u) => u.name),
  }));
  return { users, groups, canAdmin: currentUid === 0 };
}

export function toStorageModel(statfs: StatFs | null, quota: Quota | null): StorageModel {
  const used = statfs?.usageBytes ?? 0;
  const files = quota?.usedBytes ?? 0;
  const swap = statfs?.swapBytes.local ?? 0;
  const system = Math.max(0, used - files - swap);
  const categories: StorageModel['categories'] = [
    { id: 'files', label: 'Files', bytes: Math.min(files, Math.max(used, files)), tint: 'indigo' },
    { id: 'swap', label: 'Swap', bytes: swap, tint: 'orange' },
    { id: 'system', label: 'System & caches', bytes: system, tint: 'gray' },
  ];
  return {
    usedBytes: used,
    quotaBytes: statfs?.quotaBytes ?? Math.max(used, 1),
    categories: categories.filter((c) => c.bytes > 0),
    cloudBytes: quota?.source === 'server' ? quota.usedBytes : 0,
    cloudQuotaBytes: quota?.quotaBytes ?? 0,
    trashBytes: 0,
  };
}

export function toUpdatesModel(
  current: string,
  available: { version: string; build: string } | null,
  lastChecked: string,
  state: UpdatesModel['state'] = 'idle',
  error?: string,
): UpdatesModel {
  const model: UpdatesModel = { current, lastChecked, state };
  if (available !== null)
    model.available = {
      version: available.version,
      sizeBytes: 0,
      releasedOn: `build ${available.build}`,
      notes: ['Restart to update. Your windows and files are restored after the restart.'],
    };
  if (error !== undefined) model.error = error;
  return model;
}

/**
 * The fixed terms of the declared PROC-04 bound that Settings > Scheduler recomputes as the
 * sliders move (processes-and-scheduling.md §3.12.5: p = 39, N = 51, E = 1, δ = 1 ms,
 * H_kill = 400 ms; 5,450 ms with the default quanta and T_age). N grows with the live load.
 */
export function boundTerms(procs: readonly ProcInfo[]): BoundTerms {
  const runnable = procs.filter((p) => p.state === 'READY' || p.state === 'RUNNING').length;
  return { p: 39, n: Math.max(51, runnable), e: 1, deltaMs: 1, hKillMs: 400 };
}
