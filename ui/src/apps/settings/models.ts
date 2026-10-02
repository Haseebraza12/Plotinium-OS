/**
 * Settings view models (ui-design-system.md §3.8.14; ui-implementation-guide.md §3.4.5). The
 * Settings process reads device settings through the kernel (`config.get`) and user settings
 * from ~/.config/plotinium/settings.json, and sends these models. The view emits one typed
 * intent per control (`SettingChange`) plus a few actions; it stores nothing itself (SYS-01).
 */
import type { AuditOutcome } from '@plotinium/protocol';

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'desktop'
  | 'memory'
  | 'scheduler'
  | 'network'
  | 'privacy'
  | 'users'
  | 'storage'
  | 'updates'
  | 'about';

/** Why a section may be limited: guests cannot change device settings; AI-off builds hide AI. */
export type SectionAvailability = 'ok' | 'guest' | 'ai-off' | 'safe';

export type ThemePref = 'system' | 'light' | 'dark';
export type FollowPref = 'system' | 'always';
export type AccentId =
  'violet' | 'blue' | 'purple' | 'pink' | 'red' | 'orange' | 'yellow' | 'green' | 'graphite';

/** Every control's value, keyed by its settings key. */
export interface SettingValues {
  'general.deviceName': string;
  'general.language': 'en-GB' | 'en-US' | 'ur-PK';
  'general.clock24h': boolean;
  'boot.menuNextBoot': boolean;
  'boot.verbose': boolean;
  'appearance.theme': ThemePref;
  'appearance.accent': AccentId;
  'appearance.reduceMotion': FollowPref;
  'appearance.reduceTransparency': FollowPref;
  'dock.size': number;
  'dock.magnification': boolean;
  'dock.magnificationScale': number;
  'dock.autohide': boolean;
  'dock.showIndicators': boolean;
  'dock.showSuggestions': boolean;
  'dock.minimiseEffect': 'genie' | 'scale';
  'windows.doubleClickTitle': 'zoom' | 'minimise';
  'mm.budgetMB': number;
  'mm.softLimitMB': number;
  'mm.remoteOnly': boolean;
  'sched.quantumMs.interactive': number;
  'sched.quantumMs.normal': number;
  'sched.quantumMs.background': number;
  'sched.tAgeMs': number;
  'sync.files': boolean;
  'sync.swapWriteBehind': boolean;
  'telemetry.sync': boolean;
  'agent.requireConfirm': boolean;
  'updates.auto': boolean;
  'updates.channel': 'stable' | 'beta';
}

export type SettingKey = keyof SettingValues;

/** One intent per control: `{ key: 'mm.budgetMB', value: 384 }`. */
export type SettingChange = {
  [K in SettingKey]: { key: K; value: SettingValues[K] };
}[SettingKey];

export type SettingsAction =
  | 'telemetry.viewAll'
  | 'telemetry.export'
  | 'telemetry.clear'
  | 'telemetry.clearServerToo'
  | 'index.rebuild'
  | 'ai.openLog'
  | 'about.systemReport'
  | 'about.licences'
  | 'about.copyUname'
  | 'updates.check'
  | 'updates.install'
  | 'sync.now'
  | 'storage.emptyTrash'
  | 'users.add'
  | 'users.changePassword'
  | 'users.forgetDevice'
  | 'memory.restoreDefaults'
  | 'scheduler.restoreDefaults';

export interface SettingsUser {
  name: string;
  uid: number;
  guest?: boolean;
  /** Account changes will sync later. */
  offline?: boolean;
}

export interface TeamMember {
  role: 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  title: string;
  area: string;
  /** From TEAM_CONTRACT.md; undefined shows "Member to be announced". */
  name?: string;
}

/** One third-party component that ships in the browser build (THIRD_PARTY.md §2.1–§2.2). */
export interface LicenceNotice {
  /** Package or font name ("solid-js", "Inter"). */
  name: string;
  /** SPDX id ("MIT", "OFL-1.1"). */
  licence: string;
  /** What it does in Plotinium ("UI framework"). */
  use: string;
}

export interface AboutModel {
  name: string;
  version: string;
  codename?: string;
  build: string;
  builtAt: string;
  tagline: string;
  kernel: string;
  host: { browser: string; cores: number };
  memoryBudget: string;
  /** undefined: "Storage estimate unavailable". */
  storage?: string;
  signedIn: string;
  updateStatus: string;
  team: readonly TeamMember[];
  footer: readonly string[];
  /** Shown by the Licences button (UI-146); without it the button raises `about.licences`. */
  licences?: readonly LicenceNotice[];
}

export interface TelemetryEvent {
  id: string;
  /** Epoch ms. */
  at: number;
  event: 'launch' | 'focus' | 'close';
  app: string;
  previousApp?: string;
  bucket: string;
}

export interface PrivacyModel {
  telemetry: {
    rows: readonly TelemetryEvent[];
    count: number;
    bytes: number;
    oldest: string;
    predictor: string;
    exporting?: boolean;
    /** A sync opt-in request is in flight. */
    pending?: boolean;
    error?: string;
    /** Why the server copy cannot be deleted from here (the Clear dialog says so, UI-146). */
    serverDeleteUnavailable?: string;
  };
  model: {
    name: string;
    detail: string;
    state: 'ready' | 'loading' | 'unavailable' | 'off';
  };
  index: {
    state: 'indexing' | 'idle' | 'paused' | 'error';
    indexed: number;
    total: number;
    pid: number;
    priority: number;
    rebuilding?: boolean;
    error?: string;
    /** Why Rebuild index cannot run in this build; the button is disabled with it (UI-146). */
    rebuildUnavailable?: string;
  };
  agent: {
    provider: string;
    status: 'connected' | 'degraded' | 'offline' | 'signed-out';
    usedCents: number;
    capCents: number;
    resetsOn: string;
    lastAction?: { time: string; summary: string; outcome: AuditOutcome };
  };
}

export interface NetworkModel {
  /** `degraded`: online, but the kernel lists the sync service as degraded (nothing syncs). */
  status: 'online' | 'syncing' | 'offline' | 'auth' | 'degraded';
  queued: number;
  server: string;
  lastSync: string;
  latencyMs?: number;
}

export interface UserAccount {
  name: string;
  uid: number;
  role: 'admin' | 'standard' | 'guest';
  groups: readonly string[];
  current?: boolean;
}

export interface UsersModel {
  users: readonly UserAccount[];
  groups: readonly { name: string; gid: number; members: readonly string[] }[];
  /** The current user may add users (root or admin). */
  canAdmin: boolean;
}

export interface StorageCategory {
  id: string;
  label: string;
  bytes: number;
  tint: 'indigo' | 'blue' | 'teal' | 'green' | 'yellow' | 'orange' | 'purple' | 'gray';
}

export interface StorageModel {
  usedBytes: number;
  quotaBytes: number;
  categories: readonly StorageCategory[];
  cloudBytes: number;
  cloudQuotaBytes: number;
  trashBytes: number;
}

export interface UpdatesModel {
  current: string;
  lastChecked: string;
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  progress?: number;
  error?: string;
  available?: { version: string; sizeBytes: number; releasedOn: string; notes: readonly string[] };
}

export interface MemoryStatus {
  usedBytes: number;
  lowWatermark: number;
  highWatermark: number;
}

/** The fixed terms of the PROC-04 bound the Scheduler pane recomputes. */
export interface BoundTerms {
  p: number;
  n: number;
  e: number;
  deltaMs: number;
  hKillMs: number;
}
