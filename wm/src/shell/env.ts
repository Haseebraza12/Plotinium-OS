/**
 * `DesktopEnv`: everything the desktop shell needs from its host, injected once by
 * `mountDesktop(root, env)` (window-manager.md §3.1; ui-implementation-guide.md §3.6). The shell
 * never imports the kernel, the apps or storage: the host (web/) fills this object from the
 * kernel link, the apps registry and the auth and session services, and the dev harness fills it
 * with fakes. Every field except `identity`, `apps` and one compositor source is optional; a
 * missing feed simply leaves its status item in the neutral state.
 */
import type { ArgsIn, CallName, KEvent, RetOf } from '@plotinium/protocol';

import type { Compositor, Rect, Snap, WinState } from '../compositor/index.ts';
import type {
  IconId,
  LoginUser,
  MenuBarMenu,
  QueuedOp,
  SearchPreview,
  SearchResult,
  SearchStats,
  SemanticState,
  ShellNotification,
  UpdateNote,
} from './ui.ts';

// ---------------------------------------------------------------------------------------------
// Kernel link
// ---------------------------------------------------------------------------------------------

/**
 * The view-port system-call client (structurally `ViewSys` from @plotinium/kernel/sys): only the
 * allow-list of window-manager.md §4.5 succeeds on it; anything else fails with EPERM.
 */
export interface ViewSysClient {
  call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>>;
  readonly closed: boolean;
}

/** Callbacks the host wires into the view-port client it creates (`createViewSys` options). */
export interface ViewSysHandlers {
  /** Kernel event batches pushed to this view (at most one per animation frame). */
  readonly onEvents: (batch: readonly KEvent[]) => void;
  /** Terminal views: `tty.output` bytes. */
  readonly onTtyOut: (data: ArrayBuffer) => void;
  readonly onClose: (reason: string) => void;
}

/** A MessagePort, or anything with the same two members (tests, the dev harness). */
export interface PortLike {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** One kernel window as the shell learns it from the compositor port `create` message. */
export interface WindowBinding {
  readonly wid: number;
  readonly pid: number;
  readonly app: string;
  /** The view port the kernel bound to (pid, wid) and transferred with `create`, if any. */
  readonly viewPort: MessagePort | null;
  /** The display channel to the app's process, if any. */
  readonly display: MessagePort | null;
  readonly argv: readonly string[];
}

export interface KernelEnv {
  /**
   * The shell's end of the kernel compositor channel (R-PORT, WMD-02). The shell creates the
   * compositor and binds it here once; lifecycle commands (`create`, `close`, `focus`, …) are
   * accepted only on this port. Shell intents (`launch`, `power`, `layout`, `viewCrashed`, `pref`,
   * `svc.retry`, `net.retry`, `notify.action`) are posted on it too unless a callback below
   * handles them. Give either this or `compositor`.
   */
  readonly compositorPort?: PortLike;
  /** A compositor the host already created (then the host owns its animation hooks). */
  readonly compositor?: Compositor;
  /** Builds the view-port client for a window (web passes `createViewSys` from kernel/sys). */
  readonly viewSys?: (win: WindowBinding, handlers: ViewSysHandlers) => ViewSysClient;
  /** The shell's own system-call client (status snapshots such as `svc.status`), optional. */
  readonly sys?: ViewSysClient;
  /** Kernel event batches for the menu bar, Control Centre and notifications. */
  readonly subscribe?: (fn: (batch: readonly KEvent[]) => void) => () => void;
  /** Launch an app: the kernel spawns its process, which opens its window over the port. */
  readonly launch?: (app: string, opts: LaunchOptions) => void | Promise<void>;
  /** The router's `interactive` hint during gestures (WMD-05). */
  readonly interactive?: (active: boolean) => void;
}

export interface LaunchOptions {
  readonly argv: readonly string[];
  /** Session restore (WM-06): the saved window, already scaled to the current work area. */
  readonly restore?: LayoutWindow;
}

// ---------------------------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------------------------

/** Topics a view can listen to through its context. */
export interface ViewEventData {
  'tty.output': ArrayBuffer;
  'kernel.events': readonly KEvent[];
  'view.close': string;
  'window.resize': { cw: number; ch: number };
}

/** What `mountView` receives (ui-implementation-guide.md §4.8; window-manager.md §3.1). */
export interface ViewContext {
  readonly pid: number;
  readonly wid: number;
  readonly app: string;
  readonly argv: readonly string[];
  /** The window's content element; the view renders into it and nowhere else. */
  readonly container: HTMLElement;
  /** View-port client bound to (pid, wid); allow-list only. */
  readonly sys: ViewSysClient;
  /** Display channel to the app's process, or null when the host runs the app in the view. */
  readonly display: MessagePort | null;
  onViewEvent<T extends keyof ViewEventData>(
    topic: T,
    cb: (data: ViewEventData[T]) => void,
  ): () => void;
  /** An app-menu command for this window (menu id, item id). */
  onMenuCommand(cb: (menuId: string, itemId: string) => void): () => void;
  /** The view's error boundary caught `err`: the window shows "<App> stopped" (WMD-23). */
  reportCrash(err: unknown): void;
  /** The applied theme, so JS-themed views (xterm, CodeMirror) can follow it. */
  theme(): 'light' | 'dark';
  /** Ask the shell to close this window (the same path as the close button). */
  requestClose(): void;
  /** The signed-in session (user name, uid, guest or demo). */
  readonly session: Session;
  /** The desktop preferences as currently applied. */
  prefs(): Prefs;
  /**
   * Set this window's title (menu bar, switcher, Overview, session layout). The shell updates
   * the compositor; a view that also wants the kernel to know calls `window.setTitle` on `sys`.
   */
  setTitle(title: string): void;
  /** Open (or, for a singleton app, focus) another app, exactly like the Dock does. */
  launch(app: string, argv?: readonly string[]): void;
  /**
   * Kernel event batches filtered by topic (`'proc.*'` matches every `proc.` topic, `'*'` all).
   * The shell owns the subscription: it uses the host's `kernel.subscribe` feed, else the
   * batches the kernel pushes on this window's view port.
   */
  subscribe(topics: readonly string[], fn: (batch: readonly KEvent[]) => void): () => void;
}

/** A disposer, or a promise of one (a lazily loaded view chunk). */
export type ViewMount = (() => void) | Promise<() => void>;

/** How the window of an app is drawn (from the app's descriptor, `AppWindowSpec`). */
export interface AppWindowHints {
  /**
   * `titlebar` (default): the frame draws the centred title. `unified`: the app draws its own
   * toolbar and sidebar under floating traffic lights and marks `data-pl-drag-region` areas.
   */
  readonly chrome?: 'titlebar' | 'unified';
  /** false: no resize handles (Settings, About). Default true. */
  readonly resizable?: boolean;
  /** false: the zoom button is disabled. Default true. */
  readonly maximizable?: boolean;
  /** The size a new window opens at (the manifest's `width` × `height`); default 720 × 480. */
  readonly width?: number;
  readonly height?: number;
}

export interface AppEntry {
  /** The app id (manifest name, dock and switcher group key): `files`, `terminal`, … */
  readonly id: string;
  /** `Files`, `Terminal`, … (menu bar, dock label, switcher). */
  readonly title: string;
  readonly icon: IconId;
  /** In the dock even when not running. Default true. */
  readonly pinned?: boolean;
  /** Listed in Search's Apps group and launchable by id. Default true. */
  readonly launchable?: boolean;
  /** A second launch focuses the existing window instead of opening another. */
  readonly singleton?: boolean;
  /** The app's menus (File, Edit, View, …); the Window and Help menus are added by the shell. */
  readonly menus?: readonly MenuBarMenu[];
  /** Window chrome hints (unified toolbar, fixed size). */
  readonly window?: AppWindowHints;
  mountView(container: HTMLElement, ctx: ViewContext): ViewMount;
}

export interface AppRegistry {
  /** Apps in dock order. */
  list(): readonly AppEntry[];
  get(id: string): AppEntry | undefined;
}

// ---------------------------------------------------------------------------------------------
// Auth, session, preferences
// ---------------------------------------------------------------------------------------------

export interface Session {
  readonly uid: number;
  readonly user: string;
  readonly kind: 'user' | 'guest' | 'demo';
}

export type LoginResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly error?: string; readonly retryAt?: number };

export interface AuthEnv {
  /** Users to show; `kind: 'guest' | 'demo'` tiles sign in without a password. */
  users(): readonly LoginUser[] | Promise<readonly LoginUser[]>;
  /** Password sign-in; the password is passed straight through and never stored. */
  login(userId: string, password: string, report: (stage: string) => void): Promise<LoginResult>;
  /** Guest or demo tile. */
  guest(userId: string, report: (stage: string) => void): Promise<LoginResult>;
  /** Server unreachable: the badge says the saved offline verifier is used (OFF-03). */
  offline?(): boolean;
  /** A session that is already signed in: the login screen is skipped. */
  current?(): Session | null;
  /** The login screen is input-ready (the boot record's user-wait clock starts). */
  shown?(): void;
  /** Lock screen: verify the signed-in user's password again. */
  unlock?(userId: string, password: string): Promise<LoginResult>;
}

export interface LayoutWindow {
  readonly app: string;
  readonly argv: readonly string[];
  readonly title: string;
  readonly rect: Rect;
  readonly restoreRect: Rect | null;
  readonly state: WinState;
  readonly prevState: 'normal' | 'maximised' | 'fullscreen';
  readonly snap: Snap;
  readonly z: number;
  readonly focused: boolean;
  readonly proc: { osSessionId: string; pid: number; pageIds: number[] } | null;
}

/** window-manager.md §4.6. */
export interface SessionLayout {
  readonly v: 1;
  readonly osSessionId: string;
  readonly uid: number;
  readonly savedAt: number;
  readonly viewport: { w: number; h: number; dpr: number };
  readonly windows: readonly LayoutWindow[];
}

export interface SessionEnv {
  readonly osSessionId?: string;
  /** The last saved layout for this user, or null (WM-06). */
  loadLayout?(session: Session): Promise<SessionLayout | null> | SessionLayout | null;
  /** Persist: relaxed after coarse events (debounced), strict before shutdown or reboot. */
  saveLayout?(layout: SessionLayout, durability: 'relaxed' | 'strict'): Promise<void> | void;
}

export type ThemePref = 'light' | 'dark' | 'system';

export interface Prefs {
  readonly theme: ThemePref;
  /** Settings override: always reduce motion (otherwise the OS setting applies). */
  readonly reducedMotion: boolean;
  readonly frameMeter: boolean;
  readonly focusMode: boolean;
  readonly dockMagnification: boolean;
  /** Settings › General › 24-hour time (the menu-bar clock). */
  readonly clock24h: boolean;
  /** Settings › Desktop & Dock › Size: the Dock icon size in px (40–80). */
  readonly dockSize: number;
  /** Settings › Magnified size: the largest scale under the pointer (1.1–1.8). */
  readonly dockMagnifiedScale: number;
  /** Settings › Automatically hide and show the Dock. */
  readonly dockAutoHide: boolean;
  /** Settings › Show indicators for open apps (running dots, minimised markers). */
  readonly dockIndicators: boolean;
  /** Settings › Double-click a window's title bar to (written as `data-title-dblclick`, C3). */
  readonly titleDoubleClick: 'zoom' | 'minimise';
  /** Settings › Minimise windows using (written as `data-minimise-effect`, C3). */
  readonly minimiseEffect: 'genie' | 'scale';
}

export interface PrefsEnv {
  readonly initial?: Partial<Prefs>;
  save?(prefs: Prefs): void;
}

// ---------------------------------------------------------------------------------------------
// Optional system surfaces
// ---------------------------------------------------------------------------------------------

export interface SearchResponse {
  readonly results: readonly SearchResult[];
  readonly stats?: SearchStats;
  readonly semantic?: SemanticState;
  readonly notice?: string;
  readonly error?: string;
}

export interface SearchEnv {
  query(q: string, signal: AbortSignal): Promise<SearchResponse>;
  preview?(result: SearchResult): Promise<SearchPreview | undefined>;
  /** Open a file or command result (app results are launched by the shell). */
  open?(result: SearchResult, how: 'open' | 'reveal'): void;
  askAgent?(prompt: string, about?: SearchResult): void;
}

export interface UpdateOffer {
  readonly version: string;
  readonly build: string;
  readonly size: string;
  readonly notes: readonly UpdateNote[];
}

export interface BuildIdentity {
  readonly name?: string;
  readonly version: string;
  readonly build: string;
  readonly buildDate?: string;
  readonly codename?: string | null;
}

export type PowerAction = 'lock' | 'logout' | 'reboot' | 'reboot-menu' | 'shutdown';

export interface DesktopEnv {
  readonly identity: BuildIdentity;
  readonly kernel: KernelEnv;
  readonly apps: AppRegistry;
  readonly auth?: AuthEnv;
  readonly session?: SessionEnv;
  readonly prefs?: PrefsEnv;
  readonly search?: SearchEnv;
  /** Restart, shut down or log out (after the shell persisted the layout with strict durability). */
  readonly power?: (action: PowerAction) => void;
  /** Control Centre memory budget (MEM-01); resolve with an error text when the kernel refuses. */
  readonly setMemoryBudget?: (mb: number) => Promise<string | undefined>;
  /**
   * Retry a degraded service (`svc.control retry`). A promise answers the retry: `undefined`
   * when the kernel accepted it, or the refusal text ("not self-healing"). Without an answer the
   * shell waits for the service's next event and gives up after a timeout ("Could not retry").
   */
  readonly retryService?: (name: string) => void | Promise<string | undefined>;
  readonly retryNetwork?: () => void;
  /** The outbox, for the connectivity popover. */
  readonly outbox?: () => readonly QueuedOp[];
  /** A notification action button. */
  readonly notificationAction?: (id: string, actionId: string) => void;
  /** Accept the waiting update (hand-off to the BOOT-12 shutdown). */
  readonly update?: { offer(): UpdateOffer | null; restart(): void };
  /** The AI features exist in this build (the menu-bar AI item and Search's agent mode). */
  readonly ai?: boolean;
  /** `Date.now` and timers, injectable for tests and the harness. */
  readonly now?: () => number;
  /** Seed notifications (the harness; the kernel's `notify` messages add the rest). */
  readonly notifications?: readonly ShellNotification[];
  /**
   * The shell reached a phase: `login` (the login screen is input-ready) or `desktop` (the desktop
   * has mounted after sign-in). The host marks `desktop-interactive` on the one its boot record
   * uses and starts the user-wait clock on `login`.
   */
  readonly onPhase?: (phase: 'login' | 'desktop') => void;
}
