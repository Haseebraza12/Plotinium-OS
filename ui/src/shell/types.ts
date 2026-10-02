/**
 * View shapes for the desktop shell components (menu bar, dock, window chrome, Control Centre,
 * notifications). They mirror the Solid store of specs/05-wm/window-manager.md §4.7, trimmed to
 * what the chrome draws. The host fills them from kernel events; the components never fetch.
 */
import type { IconId } from '../icons/index.tsx';

/**
 * Connectivity as the tray shows it (window-manager.md §3.11, §4.7 `NetView`). `UNAVAILABLE`
 * means the network is up but the sync service itself is degraded or not linked, so nothing
 * reaches the server; the tray must never say "synced" then (UI-025).
 */
export type NetView =
  | { state: 'LIVE' }
  | { state: 'SYNCING'; ops: number }
  | { state: 'RECONNECTING'; retryAt: number }
  | { state: 'OFFLINE'; queued: number }
  | { state: 'AUTH_REQUIRED'; queued: number }
  | { state: 'UNAVAILABLE'; queued: number; reason: string };

export type SvcState = 'starting' | 'running' | 'degraded' | 'failed' | 'blocked';

/** One service row (window-manager.md §4.7 `SvcView`). */
export interface SvcView {
  name: string;
  state: SvcState;
  reason?: string;
  attempts: number;
  /** Epoch ms of the next automatic retry. */
  nextRetryAt?: number;
  blockedBy?: string;
}

/** The menu-bar memory meter (accounted pages against the budget, MEM-01). */
export interface MemoryView {
  usedMb: number;
  budgetMb: number;
}

export type AiState = 'idle' | 'indexing' | 'off' | 'error';

export interface AiView {
  state: AiState;
  /** Indexing progress, 0..1. */
  progress?: number;
  /** Error text for the accessible name ("key rejected", "quota reached"). */
  detail?: string;
}

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface NotificationAction {
  id: string;
  label: string;
  /** primary: accent button; secondary: ghost button; link: inline text action. Default secondary. */
  kind?: 'primary' | 'secondary' | 'link';
}

/** A notification (window-manager.md §3.17, §4.7 `Notification`), as the chrome draws it. */
export interface ShellNotification {
  id: string;
  level: NotificationLevel;
  title: string;
  body?: string;
  /** A monospace fragment shown after the body: a file name or a path. */
  code?: string;
  actions?: readonly NotificationAction[];
  /** Source app, for the icon and the grouping ("+2 from Files"). */
  app?: IconId;
  /** Source app name for the accessible name and the group label. */
  appName?: string;
  /** Epoch ms when it was posted. */
  at: number;
  unread?: boolean;
  /** Identical notifications merged into this one ("×3"); absent or 1 for a single one. */
  count?: number;
}

/** One app in the dock (the dock replaces the spec's taskbar groups, WMD-10). */
export interface DockItem {
  /** The app id (the group key and the getIconRect key). */
  id: string;
  label: string;
  icon: IconId;
  /** At least one window or process: shows the running dot. */
  running?: boolean;
  /** Open windows; spoken, and shown as a count badge when above 1 and no badge is set. */
  windows?: number;
  /** How many of those windows are minimised: the minimised marker and the spoken name. */
  minimised?: number;
  /** An app badge (unread count). 0 hides it. */
  badge?: number;
  /** Rising edge plays one attention hop (WMD-09); the badge carries it under reduced motion. */
  attention?: boolean;
  /** Rising edge plays the launch bounce once. */
  launching?: boolean;
}

/** The atom menu's system commands. */
export type SystemAction = 'about' | 'settings' | 'restart' | 'shutdown' | 'lock' | 'logout';

/** Menu-bar status items, left to right. */
export type StatusItemId =
  'services' | 'connectivity' | 'ai' | 'memory' | 'control-centre' | 'search' | 'clock';

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Window states (architecture §4.3 `WinState`). */
export type WindowState = 'normal' | 'minimised' | 'maximised' | 'fullscreen';

/** One-shot chrome animations the compositor asks for (visual-language-macos.md §3.7.3). */
export type WindowPhase =
  'opening' | 'closing' | 'minimising' | 'restoring' | 'maximising' | 'unmaximising';

/** Content overlays for window–process coupling (window-manager.md §3.12). */
export type WindowOverlay =
  | { kind: 'restoring'; doneBytes: number; totalBytes: number }
  | { kind: 'suspended' }
  | { kind: 'not-responding' }
  | { kind: 'restore-failed' };

export type WindowOverlayAction = 'restore' | 'wait' | 'force-quit' | 'restart' | 'details';

export type ThemeChoice = 'light' | 'dark';
