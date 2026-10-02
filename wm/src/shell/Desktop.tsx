/**
 * The desktop (window-manager.md §3; ui-implementation-guide.md §3.6.1 `Desktop.tsx`): wallpaper,
 * menu bar with live status, the window layer bridged to the framework-free compositor, the dock,
 * and the system overlays (Control Centre, Notification Centre and banners, Search, Overview, the
 * window switcher, the frame meter, the lease banner, the connectivity popover, Restart to
 * update). Kernel events and compositor coarse events land in Solid state here; the compositor
 * stays the sole writer of window geometry and z-index (R-GEO).
 */
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  getOwner,
  onMount,
  Show,
  untrack,
  type JSX,
} from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import type { KEvent } from '@plotinium/protocol';

import type { CoarseEvent, Compositor, KeyboardGesture, LayoutRow } from '../compositor/index.ts';
import { createCompositor, flipFrom } from '../compositor/index.ts';
import { dockDecision, dockItems, type DockWindow } from './dock-logic.ts';
import {
  contentBox,
  focusIntoWhenReady,
  isChromeTarget,
  minimiseEffect,
  snapPreviewWriter,
  tokenPx,
} from './dom.ts';
import type {
  DesktopEnv,
  LayoutWindow,
  Prefs,
  PowerAction,
  Session,
  WindowBinding,
} from './env.ts';
import { frameSummary, FrameSampler } from './frame-sampler.ts';
import {
  isNavigationKey,
  isSwitcherRelease,
  matchKey,
  shortcutSections,
  type ShellAction,
} from './keys.ts';
import { createKernelLink, type KernelLink, type WindowSignal } from './kernel-link.ts';
import {
  Debounce,
  focusTarget,
  PERSIST_DEBOUNCE_MS,
  restorePlan,
  snapshotLayout,
} from './layout.ts';
import { isEditableTarget, menuShortcut } from './menu-keys.ts';
import { menusFor, windowActions } from './menus.ts';
import { createWindowAnimator, readMotionTokens } from './motion.ts';
import {
  applyEvents,
  degradedServiceOf,
  degradedServices,
  INITIAL_STATUS,
  mergeNotifications,
  notificationKey,
  notificationSource,
  notificationsFrom,
  trayNet,
  type StatusState,
} from './status.ts';
import styles from './Shell.module.css';
import {
  highlightSwitcher,
  openSwitcher,
  selectedWid,
  stepSwitcher,
  SWITCHER_HOLD_MS,
  type SwitcherState,
} from './switcher.ts';
import { retag, tagDock, tagHandles, tagWindow } from './testids.ts';
import type {
  AiView,
  DegradedService,
  DockApi,
  IconId,
  FrameMeterStats,
  MenuBarApi,
  MenuBarMenu,
  MenuEntry,
  OverviewSlot,
  OverviewWindow,
  RetryState,
  SearchPreview,
  SearchResult,
  SearchStats,
  SemanticState,
  ShellNotification,
  ShortcutGroup,
  StatusItemId,
  SwitcherItem,
  ThemeChoice,
} from './ui.ts';
import {
  AboutAppDialog,
  appMenuItems,
  AppSwitcher,
  Button,
  Checkbox,
  ControlCentre,
  Dialog,
  Dock,
  focusableIn,
  FrameMeterHUD,
  HelpSheet,
  LockBanner,
  Menu,
  MenuBar,
  NotificationCenter,
  NotificationToasts,
  OfflinePopover,
  Overview,
  RestartToUpdateDialog,
  SearchPalette,
  Wallpaper,
} from './ui.ts';
import { createViewHost } from './views.ts';
import { WindowLayer, type WindowParts, type WinView } from './WindowLayer.tsx';

/** What the desktop exposes to `mountDesktop`'s handle (test hooks, WM-06). */
export interface DesktopApi {
  layout(): LayoutRow[];
  sessionId(): string;
  compositor(): Compositor;
  /** Open an app as the Dock would (singletons focus their window). */
  launch(app: string, argv?: readonly string[]): void;
  /** Post a notification (banner plus Notification Centre). */
  notify(n: ShellNotification): void;
  /** Feed kernel event batches when the host has no `kernel.subscribe`. */
  events(batch: readonly KEvent[]): void;
}

export interface DesktopProps {
  env: DesktopEnv;
  session: Session;
  prefs: Prefs;
  setPrefs: (patch: Partial<Prefs>) => void;
  theme: ThemeChoice;
  systemReducedMotion: boolean;
  /** The lock screen is up: global keys are off. */
  locked: boolean;
  onLock: () => void;
  onApi: (api: DesktopApi | null) => void;
}

type SearchState = {
  open: boolean;
  query: string;
  results: readonly SearchResult[];
  preview: SearchPreview | undefined;
  aiMode: boolean;
  loading: boolean;
  progress: number | undefined;
  stats: SearchStats | undefined;
  semantic: SemanticState | undefined;
  notice: string | undefined;
  error: string | undefined;
};

const EMPTY_SEARCH: SearchState = {
  open: false,
  query: '',
  results: [],
  preview: undefined,
  aiMode: false,
  loading: false,
  progress: undefined,
  stats: undefined,
  semantic: undefined,
  notice: undefined,
  error: undefined,
};

const OVERVIEW_EXIT_MS = 340;

/** A preview from the result itself when the host has no preview source (never a stuck skeleton). */
export function basicPreview(r: SearchResult): SearchPreview {
  const lines =
    r.snippet === undefined
      ? []
      : [
          {
            text: r.snippet,
            style: 'body' as const,
            highlight: true,
            ...(r.line === undefined ? {} : { n: r.line }),
          },
        ];
  return lines.length > 0
    ? {
        resultId: r.id,
        state: 'ready',
        title: r.title,
        lines,
        ...(r.citation === undefined ? {} : { meta: r.citation }),
      }
    : {
        resultId: r.id,
        state: 'unavailable',
        title: r.title,
        message: 'No preview for this result',
      };
}

/** The icons of the system apps the shell opens itself (menu bar, status items, Trash). */
const SYSTEM_APP_ICON = {
  files: 'files',
  terminal: 'terminal',
  taskmgr: 'task-manager',
  settings: 'settings',
} as const satisfies Record<string, IconId>;
const LAUNCH_BOUNCE_MS = 1_500;
const RESTORE_TIMEOUT_MS = 10_000;
/** A service retry with no answer and no service event gives up after this (UI-074). */
const RETRY_TIMEOUT_MS = 10_000;
/** At most one banner per source in this window; repeats go to the centre (UI-080). */
const BANNER_GAP_MS = 2_000;
/** A menu command for a window whose view is still loading is retried for this long. */
const COMMAND_RETRY_MS = 100;
const COMMAND_RETRY_LIMIT = 80;
const AI_IDLE: AiView = Object.freeze({ state: 'idle' });
const CLOCK_24H = Object.freeze({});
const CLOCK_12H = Object.freeze({ hour12: true });
/** The desktop's own bold menu while no window has focus (UI-085, UI-086: no dead Quit). */
const DESKTOP_APP_MENU: readonly MenuEntry[] = Object.freeze([
  { id: 'about', label: 'About Plotinium' },
  { kind: 'separator', id: 'desktop-sep-1' },
  { id: 'settings', label: 'Settings…' },
]);

type HelpView = { readonly kind: 'shortcuts' } | { readonly kind: 'app'; readonly app: string };

export function Desktop(props: DesktopProps): JSX.Element {
  // Everything below is created once per signed-in session; the props that never change for a
  // session are read untracked.
  const env = untrack(() => props.env);
  const session = untrack(() => props.session);
  const clock = env.now ?? (() => Date.now());
  const uid = createUniqueId();
  const ccId = `pl-cc-${uid}`;
  let dockRootEl: HTMLDivElement | undefined;
  let menubarRootEl: HTMLDivElement | undefined;
  let dockApi: DockApi | undefined;
  let menubarApi: MenuBarApi | undefined;
  const doc = document;
  const view = window;
  const rootStyle = doc.documentElement;

  // ------------------------------------------------------------------ state
  const [wins, setWins] = createStore<WinView[]>([]);
  const [status, setStatus] = createSignal<StatusState>(INITIAL_STATUS);
  const [notes, setNotes] = createSignal<readonly ShellNotification[]>(env.notifications ?? []);
  const [toasts, setToasts] = createSignal<readonly ShellNotification[]>([]);
  const [launching, setLaunching] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [firstLaunch, setFirstLaunch] = createSignal<readonly string[]>([]);
  const [ccOpen, setCcOpen] = createSignal(false);
  const [column, setColumn] = createSignal<HTMLElement>();
  const [netOpen, setNetOpen] = createSignal(false);
  const [netAnchor, setNetAnchor] = createSignal<HTMLElement>();
  const [retry, setRetry] = createSignal<RetryState>('idle');
  const [retrying, setRetrying] = createSignal<readonly string[]>([]);
  const [search, setSearch] = createStore<SearchState>({ ...EMPTY_SEARCH });
  const [overviewOpen, setOverviewOpen] = createSignal(false);
  const [overviewHidden, setOverviewHidden] = createSignal(false);
  const [overviewList, setOverviewList] = createSignal<readonly OverviewWindow[]>([]);
  const [overviewSel, setOverviewSel] = createSignal<string>();
  const [slots, setSlots] = createSignal<ReadonlyMap<string, OverviewSlot['rect']>>(new Map());
  const [switcher, setSwitcher] = createSignal<SwitcherState | null>(null);
  const [switcherShown, setSwitcherShown] = createSignal(false);
  const [updateOpen, setUpdateOpen] = createSignal(false);
  const [autoInstall, setAutoInstall] = createSignal(true);
  const [restarting, setRestarting] = createSignal(false);
  const [powerAsk, setPowerAsk] = createSignal<'restart' | 'shutdown' | 'logout' | null>(null);
  const [bootMenu, setBootMenu] = createSignal(false);
  const [winMenu, setWinMenu] = createSignal<{ wid: number; at: { x: number; y: number } } | null>(
    null,
  );
  const [dockMenu, setDockMenu] = createSignal<{
    app: string;
    at: { x: number; y: number };
    anchor: HTMLElement | undefined;
  } | null>(null);
  const [memError, setMemError] = createSignal<string>();
  const [memApplying, setMemApplying] = createSignal(false);
  const [frame, setFrame] = createSignal<{
    stats: FrameMeterStats | undefined;
    samples: number[];
  }>();
  const [hudExpanded, setHudExpanded] = createSignal(false);
  const [leaseNotify, setLeaseNotify] = createSignal(false);
  const [guardAsk, setGuardAsk] = createSignal<{ wid: number; reason: string } | null>(null);
  const [now, setNow] = createSignal(clock());
  const [netFocus, setNetFocus] = createSignal<'connectivity' | 'services'>('connectivity');
  const [retryErrors, setRetryErrors] = createSignal<Readonly<Record<string, string>>>({});
  const [help, setHelp] = createSignal<HelpView | null>(null);
  const [aboutApp, setAboutApp] = createSignal<string | null>(null);
  const [ccAutoFocus, setCcAutoFocus] = createSignal(false);
  const [ccReturn, setCcReturn] = createSignal<HTMLElement>();
  let rootEl: HTMLDivElement | undefined;
  /**
   * The bare desktop was clicked and the compositor cannot unfocus windows itself: every window
   * is shown inactive and window keys do nothing until focus goes back into a window (UI-083).
   */
  let desktopActive = false;

  const bindings = new Map<number, WindowBinding>();
  const parts = new Map<number, WindowParts>();
  const lastFocus = new Map<number, Element>();
  const closeGuards = new Map<number, string>();
  const pendingArgv = new Map<string, (readonly string[])[]>();
  const pendingRestore = new Map<string, LayoutWindow[]>();
  const restoreByWid = new Map<number, LayoutWindow>();
  const degradedSince = new Map<string, number>();
  /** Service retries in flight: their give-up timers (UI-074). */
  const retryTimers = new Map<string, number>();
  /** Menu commands waiting for a newly launched window's view (Dock Trash → Files' Go › Trash). */
  const pendingCommands = new Map<string, { menuId: string; itemId: string }[]>();
  const commandTimers = new Set<number>();
  const cleanups: (() => void)[] = [];
  const osSessionId =
    env.session?.osSessionId ??
    (typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `session-${String(session.uid)}`);
  let restoreLeft = 0;
  let restoreFocus: number | null = null;
  let restoring = false;
  let overviewTimer: ReturnType<typeof setTimeout> | undefined;
  let switcherTimer: ReturnType<typeof setTimeout> | undefined;

  const reducedMotion = (): boolean =>
    props.prefs.reducedMotion ||
    props.systemReducedMotion ||
    rootStyle.dataset['motion'] === 'reduce';
  const motionScale = (): number => (reducedMotion() ? 0 : 1);

  // ------------------------------------------------------------------ compositor
  const menubarH = tokenPx(rootStyle, '--pl-menubar-h', 28);
  const dockReserve = tokenPx(rootStyle, '--pl-dock-reserve', 84);
  /**
   * The Dock's reserve as it is now: the Dock preferences rewrite `--pl-dock-reserve` when its
   * size or auto-hide changes, then call `viewportChanged`, and the work area follows (UI-040).
   */
  const dockReserveNow = (): number => tokenPx(rootStyle, '--pl-dock-reserve', dockReserve);
  const titlebarH = tokenPx(rootStyle, '--pl-titlebar-h', 38);

  /** The snap preview element of the window layer, written by the compositor (UI-038). */
  let previewEl: HTMLDivElement | undefined;
  /**
   * When the Dock last activated each app: a window of that app opening within DOCK_LAUNCH_MS
   * grows out of its dock icon (UI-156; ui-implementation-guide.md §3.5.3). Read from the press
   * itself, so the Dock needs no change.
   */
  const dockPresses = new Map<string, number>();
  const DOCK_LAUNCH_MS = 10_000;
  const onDockPress = (ev: Event): void => {
    if (ev instanceof KeyboardEvent && ev.key !== 'Enter' && ev.key !== ' ') return;
    const target = ev.target;
    if (!(target instanceof Element) || dockRootEl?.contains(target) !== true) return;
    const app = target.closest('[data-dock-id]')?.getAttribute('data-dock-id');
    if (app !== null && app !== undefined && app !== 'trash')
      dockPresses.set(app, performance.now());
  };
  doc.addEventListener('pointerdown', onDockPress, true);
  doc.addEventListener('keydown', onDockPress, true);
  onCleanup(() => {
    doc.removeEventListener('pointerdown', onDockPress, true);
    doc.removeEventListener('keydown', onDockPress, true);
  });
  const dockCentre = (app: string): { x: number; y: number } | null => {
    const r = dockApi?.getIconRect(app);
    return r === undefined ? null : { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };

  const animator = createWindowAnimator({
    element: (wid) => parts.get(wid)?.section,
    window: (wid) => {
      const w = cmp.model.get(wid);
      return w === undefined ? undefined : { rect: { x: w.x, y: w.y, w: w.w, h: w.h }, app: w.app };
    },
    dockIcon: (app) => dockApi?.getIconRect(app),
    flush: () => cmp.flusher.flush(),
    viewportH: () => view.innerHeight,
    tokens: () => readMotionTokens(rootStyle, reducedMotion()),
    // Settings → Desktop & Dock → Minimise effect, read at the moment of the minimise (C3, UI-041).
    effect: () => minimiseEffect(rootStyle),
  });

  const cmp: Compositor =
    env.kernel.compositor ??
    createCompositor({
      viewport: () => ({
        w: view.innerWidth,
        h: view.innerHeight,
        dpr: view.devicePixelRatio || 1,
      }),
      insets: () => ({ top: menubarH, bottom: dockReserveNow() }),
      raf: (cb) => view.requestAnimationFrame(() => cb()),
      interactive: (active) => env.kernel.interactive?.(active),
      anim: animator,
      dockIcon: dockCentre,
      openOrigin: (app) => {
        const at = dockPresses.get(app);
        dockPresses.delete(app);
        return at !== undefined && performance.now() - at <= DOCK_LAUNCH_MS
          ? dockCentre(app)
          : null;
      },
      // A new window opens at its app's manifest size (UI-011).
      defaultSize: (app) => {
        const hints = env.apps.get(app)?.window;
        return hints?.width === undefined || hints.height === undefined
          ? undefined
          : { w: hints.width, h: hints.height };
      },
      snapPreview: snapPreviewWriter(() => previewEl),
      titlebarH,
      now: () => performance.now(),
    });

  const viewHost = createViewHost({
    apps: env.apps,
    kernel: env.kernel,
    theme: () => props.theme,
    requestClose: (wid) => closeWindow(wid),
    crashed: (wid, message) => link?.post({ t: 'viewCrashed', wid, message }),
    document: doc,
    session,
    prefs: () => props.prefs,
    setTitle: (wid, title) => cmp.model.setTitle(wid, title),
    launch: (app, argv) => launch(app, argv),
  });

  const overlayFor = (wid: number, sig: WindowSignal): void => {
    switch (sig.kind) {
      case 'close-guard':
        if (sig.reason === null) closeGuards.delete(wid);
        else closeGuards.set(wid, sig.reason);
        return;
      case 'restoring':
        setWins(
          (w) => w.wid === wid,
          'overlay',
          sig.doneBytes >= sig.totalBytes && sig.totalBytes > 0
            ? undefined
            : { kind: 'restoring', doneBytes: sig.doneBytes, totalBytes: sig.totalBytes },
        );
        return;
      case 'suspended':
        setWins((w) => w.wid === wid, 'overlay', { kind: 'suspended' });
        return;
      case 'not-responding':
        setWins((w) => w.wid === wid, 'overlay', sig.on ? { kind: 'not-responding' } : undefined);
        return;
      case 'restore-failed':
        setWins((w) => w.wid === wid, 'overlay', { kind: 'restore-failed' });
        return;
    }
  };

  const link: KernelLink | null =
    env.kernel.compositor === undefined && env.kernel.compositorPort !== undefined
      ? createKernelLink(env.kernel.compositorPort, {
          onCreate: (m) => {
            const app = m.app ?? '';
            // The kernel's `create` carries no argv; the shell remembers what it launched with.
            const queued = pendingArgv.get(app)?.shift();
            bindings.set(m.wid, {
              wid: m.wid,
              pid: m.pid,
              app,
              viewPort: m.viewPort,
              display: m.display,
              argv: m.argv.length > 0 ? m.argv : (queued ?? []),
            });
            if (m.restore !== null) restoreByWid.set(m.wid, m.restore);
          },
          onEvents: (batch) => handleEvents(batch),
          onNotify: (n) => handleKernelNotify(n),
          onOverlay: overlayFor,
          onAttach: (wid, display) => {
            viewHost.attach(wid, display);
            setWins((w) => w.wid === wid, 'overlay', undefined);
          },
        })
      : null;
  if (link !== null) cmp.bindKernelPort(link.compositorPort);

  // ------------------------------------------------------------------ status and notifications
  /** When each source last showed a banner (UI-080: at most one per source per 2 s). */
  const lastBanner = new Map<string, number>();
  /**
   * Notifications go to the centre, merging repeats ("×3"). Banners follow three rules: none
   * while Control Centre is open (the centre shows them, UI-024); a repeat of a visible banner
   * merges into it; otherwise at most one banner per source per 2 s (errors always show).
   */
  const addNotifications = (list: readonly ShellNotification[]): void => {
    if (list.length === 0) return;
    setNotes((prev) => mergeNotifications(prev, list));
    if (untrack(ccOpen)) return;
    const at = clock();
    const shown = untrack(toasts).map(notificationKey);
    const banners: ShellNotification[] = [];
    for (const n of list) {
      const key = notificationKey(n);
      if (shown.includes(key)) {
        banners.push(n);
        continue;
      }
      const source = notificationSource(n);
      const last = lastBanner.get(source);
      if (n.level !== 'error' && last !== undefined && at - last < BANNER_GAP_MS) continue;
      lastBanner.set(source, at);
      shown.push(key);
      banners.push(n);
    }
    if (banners.length > 0) setToasts((prev) => mergeNotifications(prev, banners, 12));
  };

  /** A service that started again takes its "is degraded" banners and cards with it. */
  const dropDegradedNotes = (name: string): void => {
    const stale = (n: ShellNotification): boolean => degradedServiceOf(n.id) === name;
    if (untrack(notes).some(stale)) setNotes((l) => l.filter((n) => !stale(n)));
    if (untrack(toasts).some(stale)) setToasts((l) => l.filter((n) => !stale(n)));
  };

  function handleEvents(batch: readonly KEvent[]): void {
    const at = clock();
    // "Since" times first: the degraded rows read this (plain) map when the status changes.
    for (const e of batch)
      if (
        (e.topic === 'svc.degraded' || e.topic === 'svc.failed') &&
        !degradedSince.has(e.data.name)
      )
        degradedSince.set(e.data.name, e.t || at);
    setStatus((s) => applyEvents(s, batch));
    for (const e of batch) {
      if (e.topic === 'svc.degraded' || e.topic === 'svc.failed') {
        endRetry(e.data.name);
      } else if (e.topic === 'svc.started' || e.topic === 'svc.stopped') {
        degradedSince.delete(e.data.name);
        endRetry(e.data.name);
        if (e.topic === 'svc.started') dropDegradedNotes(e.data.name);
      } else if (e.topic === 'net.state' && retry() === 'checking') {
        setRetry(e.data.state === 'online' ? 'idle' : 'failed');
      }
    }
    addNotifications(notificationsFrom(batch));
  }

  function handleKernelNotify(n: unknown): void {
    if (n === null || typeof n !== 'object') return;
    const r = n as Record<string, unknown>;
    const title = typeof r['title'] === 'string' ? r['title'] : undefined;
    if (title === undefined) return;
    const level = r['level'];
    const source =
      r['source'] !== null && typeof r['source'] === 'object'
        ? (r['source'] as Record<string, unknown>)
        : {};
    const from = typeof source['app'] === 'string' ? appEntry(source['app']) : undefined;
    const actions = Array.isArray(r['actions'])
      ? r['actions'].flatMap((a: unknown) => {
          if (a === null || typeof a !== 'object') return [];
          const x = a as Record<string, unknown>;
          return typeof x['id'] === 'string' && typeof x['label'] === 'string'
            ? [{ id: x['id'], label: x['label'] }]
            : [];
        })
      : [];
    addNotifications([
      {
        id: typeof r['id'] === 'string' ? r['id'] : `k${String(clock())}`,
        level:
          level === 'success' || level === 'warning' || level === 'error'
            ? level
            : level === 'warn'
              ? 'warning'
              : 'info',
        title,
        ...(typeof r['body'] === 'string' ? { body: r['body'] } : {}),
        ...(actions.length > 0 ? { actions } : {}),
        ...(from === undefined ? {} : { app: from.icon, appName: from.title }),
        at: typeof r['at'] === 'number' ? r['at'] : clock(),
        unread: true,
      },
    ]);
  }

  // ------------------------------------------------------------------ layout persistence (WM-06)
  const snapshot = (): ReturnType<typeof snapshotLayout> =>
    snapshotLayout({
      windows: cmp.model.windows(),
      argv: (wid) => bindings.get(wid)?.argv ?? [],
      osSessionId,
      uid: session.uid,
      now: clock(),
      viewport: { w: view.innerWidth, h: view.innerHeight, dpr: view.devicePixelRatio || 1 },
      persisted: (w) => cmp.model.persisted(w),
    });
  const saveLayout = (durability: 'relaxed' | 'strict'): Promise<void> => {
    if (restoring) return Promise.resolve();
    const layout = snapshot();
    if (env.session?.saveLayout !== undefined)
      return Promise.resolve(env.session.saveLayout(layout, durability)).catch(() => undefined);
    link?.post({ t: 'layout', layout });
    return Promise.resolve();
  };
  const persist = new Debounce(() => void saveLayout('relaxed'), PERSIST_DEBOUNCE_MS, {
    set: (fn, ms) => view.setTimeout(fn, ms),
    clear: (h) => view.clearTimeout(h as number),
  });

  const applyRestore = (wid: number, app: string): void => {
    let lw = restoreByWid.get(wid);
    restoreByWid.delete(wid);
    if (lw === undefined) {
      const queue = pendingRestore.get(app);
      lw = queue?.shift();
    }
    if (lw === undefined) return;
    const m = cmp.model;
    // Compact mode maximised the new window; apply the saved state to the normal window first.
    if (m.compact && m.stateOf(wid) === 'maximised') m.restore(wid);
    const base = lw.state === 'normal' && lw.snap === null ? lw.rect : (lw.restoreRect ?? lw.rect);
    m.setRect(wid, base);
    if (lw.snap !== null) m.snap(wid, lw.snap);
    if (lw.state === 'maximised' || (lw.state === 'minimised' && lw.prevState === 'maximised'))
      m.maximise(wid);
    if (lw.state === 'fullscreen') m.fullscreen(wid);
    if (lw.state === 'minimised') m.minimise(wid);
    if (lw.focused && lw.state !== 'minimised') restoreFocus = wid;
    m.compactFit(wid);
    m.reportGeometry(wid);
    restoreLeft--;
    if (restoreLeft <= 0) finishRestore();
  };
  const finishRestore = (): void => {
    if (!restoring) return;
    restoring = false;
    restoreLeft = 0;
    pendingRestore.clear();
    if (restoreFocus !== null) cmp.focus(restoreFocus);
    persist.schedule();
  };

  // ------------------------------------------------------------------ compositor coarse events
  const appEntry = (app: string): ReturnType<DesktopEnv['apps']['get']> => env.apps.get(app);
  /** The registered id of a system app (the registry may use another id with the same icon). */
  const sysApp = (id: keyof typeof SYSTEM_APP_ICON): string => {
    if (env.apps.get(id) !== undefined) return id;
    const icon = SYSTEM_APP_ICON[id];
    return env.apps.list().find((a) => a.icon === icon)?.id ?? id;
  };

  const onCoarse = (e: CoarseEvent): void => {
    switch (e.type) {
      case 'opened': {
        const m = cmp.model.get(e.wid);
        const entry = appEntry(e.app);
        if (!bindings.has(e.wid)) {
          const queue = pendingArgv.get(e.app);
          bindings.set(e.wid, {
            wid: e.wid,
            pid: m?.pid ?? 0,
            app: e.app,
            viewPort: null,
            display: null,
            argv: queue?.shift() ?? [],
          });
        }
        setWins(
          produce((list) => {
            list.push({
              wid: e.wid,
              pid: m?.pid ?? 0,
              app: e.app,
              appName: entry?.title ?? e.app,
              icon: entry?.icon ?? 'atom',
              chrome: entry?.window?.chrome ?? 'titlebar',
              resizable: entry?.window?.resizable !== false,
              maximizable: entry?.window?.maximizable !== false,
              title: e.title,
              state: 'normal',
              snap: null,
              focused: e.focused,
              dragging: false,
              attention: false,
              overlay: undefined,
              status: '',
            });
          }),
        );
        setLaunching((s) => {
          const next = new Set(s);
          next.delete(e.app);
          return next;
        });
        if (!firstLaunch().includes(e.app)) setFirstLaunch((l) => [...l, e.app]);
        applyRestore(e.wid, e.app);
        persist.schedule();
        return;
      }
      case 'closed':
        if (kbMode?.wid === e.wid) kbMode.finish(false);
        animator.release(e.wid);
        viewHost.unmount(e.wid);
        bindings.delete(e.wid);
        closeGuards.delete(e.wid);
        lastFocus.delete(e.wid);
        setWins((list) => list.filter((w) => w.wid !== e.wid));
        persist.schedule();
        return;
      case 'focused': {
        setWins(
          produce((list) => {
            for (const w of list) {
              w.focused = w.wid === e.wid;
              if (w.focused) w.attention = false;
            }
          }),
        );
        persist.schedule();
        // Keyboard focus follows (§3.4 rule 3): a launch, a switch, a minimise or close hand-off
        // (UI-018). A pointer press sets DOM focus itself (the browser, or the chrome handler).
        const wid = e.wid;
        if (wid !== null && !pressing) queueMicrotask(() => focusDom(wid, false));
        return;
      }
      case 'state':
        if (e.state === 'minimised') animator.release(e.wid);
        setWins((w) => w.wid === e.wid, 'state', e.state);
        persist.schedule();
        return;
      case 'title':
        setWins((w) => w.wid === e.wid, 'title', e.title);
        return;
      case 'attention':
        setWins((w) => w.wid === e.wid, 'attention', e.on);
        return;
      case 'dragging':
        setWins((w) => w.wid === e.wid, 'dragging', e.on);
        return;
      case 'restoring':
        overlayFor(e.wid, { kind: 'restoring', doneBytes: e.doneBytes, totalBytes: e.totalBytes });
        return;
      case 'snap':
        setWins((w) => w.wid === e.wid, 'snap', e.snap);
        persist.schedule();
        return;
      case 'geometry':
        persist.schedule();
        return;
      case 'phase':
        return;
    }
  };

  const onParts = (wid: number, p: WindowParts): void => {
    parts.set(wid, p);
    const w = cmp.model.get(wid);
    const unified = appEntry(w?.app ?? '')?.window?.chrome === 'unified';
    cmp.attach(wid, p.slot, contentBox(p.view, unified ? 0 : titlebarH));
    tagWindow(p.section, w?.app ?? '', wid);
    const obs = retag(p.section, () => tagHandles(p.section), false);
    const onFocusIn = (ev: FocusEvent): void => {
      // Only app content is remembered: a restore never lands on a traffic light (UI-017).
      if (ev.target instanceof Element && p.view.contains(ev.target)) lastFocus.set(wid, ev.target);
    };
    let lastEscape = Number.NEGATIVE_INFINITY;
    // Listened to in the capture phase: an app that handles its own keys (xterm stops the
    // propagation of every key it takes) must not swallow the full-screen exit (UI-094).
    const onKey = (ev: KeyboardEvent): void => {
      cmp.input(wid);
      // Escape twice within 500 ms leaves full screen (window-manager.md §3.7).
      if (ev.key !== 'Escape' || cmp.model.stateOf(wid) !== 'fullscreen') return;
      const t = performance.now();
      if (t - lastEscape > 500) {
        lastEscape = t;
        return;
      }
      lastEscape = Number.NEGATIVE_INFINITY;
      void cmp.toggleFullscreen(wid);
    };
    // A press on the chrome (title bar, frame edge, an empty spot of a drag region) focuses the
    // window without the chrome taking DOM focus: the window's content gets it (UI-018).
    let chromePress = false;
    const onPress = (ev: PointerEvent): void => {
      if (ev.button !== 0) return;
      pressing = true;
      view.setTimeout(() => {
        pressing = false;
      }, 0);
      chromePress = isChromeTarget(ev.target, p.section);
    };
    const onMouseDown = (ev: MouseEvent): void => {
      if (!chromePress || ev.button !== 0) return;
      chromePress = false;
      ev.preventDefault();
      focusDom(wid, true);
    };
    p.section.addEventListener('focusin', onFocusIn);
    p.section.addEventListener('keydown', onKey, true);
    p.section.addEventListener('pointerdown', onPress, true);
    p.section.addEventListener('mousedown', onMouseDown);
    cleanups.push(() => {
      obs();
      p.section.removeEventListener('focusin', onFocusIn);
      p.section.removeEventListener('keydown', onKey, true);
      p.section.removeEventListener('pointerdown', onPress, true);
      p.section.removeEventListener('mousedown', onMouseDown);
    });
    const binding = bindings.get(wid);
    if (binding !== undefined) viewHost.mount(binding, p.view);
    // A window that opens focused takes keyboard focus once its view is mounted (UI-018).
    if (cmp.model.focused === wid) queueMicrotask(() => focusDom(wid, false));
  };
  const onGone = (wid: number): void => {
    parts.delete(wid);
  };

  // ------------------------------------------------------------------ window commands
  const focusedWid = (): number | null => cmp.model.focused;
  const focusedWin = createMemo(() => wins.find((w) => w.focused));

  /** A pointer press on a window is being handled: the browser or the chrome sets DOM focus. */
  let pressing = false;
  let stopFocusWait: (() => void) | undefined;
  /** Focus may be taken from nowhere, the Dock, the menu bar or a window, never from an overlay. */
  const stealable = (active: Element | null, section: HTMLElement): boolean => {
    if (active === null || active === doc.body || active === doc.documentElement) return true;
    if (active === section) return true;
    if (dockRootEl?.contains(active) === true || menubarRootEl?.contains(active) === true)
      return true;
    for (const p of parts.values()) if (p.section.contains(active)) return true;
    return false;
  };
  /**
   * Move DOM focus into window `wid` (window-manager.md §3.4 rule 3; UI-017, UI-018): its last
   * focused content element, else its first control, else the window itself (and its first
   * control once its view has loaded). Never away from the window's own content, and unless
   * `force` (an explicit request: Dock, switcher, menu) never away from an open overlay.
   */
  const focusDom = (wid: number, force: boolean): void => {
    const p = parts.get(wid);
    if (p === undefined || !p.section.isConnected || cmp.model.focused !== wid) return;
    const section = p.section;
    const active = doc.activeElement;
    // Focus already in the app content stays; on the chrome (a traffic light) it moves in.
    if (active !== null && p.view.contains(active)) return;
    if (!force && !stealable(active, section)) return;
    stopFocusWait?.();
    stopFocusWait = focusIntoWhenReady(section, lastFocus.get(wid) ?? null);
  };

  const focusWindow = (wid: number, moveDom: boolean): void => {
    const w = cmp.model.get(wid);
    if (w === undefined) return;
    if (w.state === 'minimised') void cmp.restore(wid);
    else cmp.focus(wid);
    if (moveDom) queueMicrotask(() => focusDom(wid, true));
  };

  function closeWindow(wid: number | null): void {
    if (wid === null) return;
    const reason = closeGuards.get(wid);
    if (reason !== undefined) {
      setGuardAsk({ wid, reason });
      return;
    }
    cmp.requestClose(wid);
  }

  const animatedSnap = (wid: number, zone: 'left' | 'right'): void => {
    const w = cmp.model.get(wid);
    if (w === undefined) return;
    const from = cmp.model.rectOf(w);
    if (!cmp.model.snap(wid, zone)) return;
    void animator
      .play(wid, 'maximising', { flip: flipFrom(from, cmp.model.rectOf(w)) })
      .then(() => cmp.model.reportGeometry(wid));
  };

  const viewOf = (wid: number): WinView | undefined => wins.find((w) => w.wid === wid);

  /** The running keyboard move or size mode (window menu → Move / Size; UI-094, WCAG 2.5.7). */
  let kbMode: { wid: number; finish: (revert: boolean) => void } | null = null;
  const announce = (wid: number, text: string): void => {
    setWins((w) => w.wid === wid, 'status', text);
  };
  const startKeyboardMode = (wid: number, mode: 'move' | 'size'): void => {
    kbMode?.finish(false);
    const w = cmp.model.get(wid);
    const v = viewOf(wid);
    if (w === undefined || v === undefined) return;
    if (mode === 'size' && !v.resizable) return;
    // Move and Size act on the normal window: leave a maximised or full-screen state first.
    if (w.state === 'maximised' || w.state === 'fullscreen') void cmp.restore(wid);
    const g: KeyboardGesture | null = cmp.keyboard(wid, mode);
    if (g === null) return;
    const describe = (): string => {
      const work = cmp.model.work;
      return mode === 'move'
        ? `Moved to ${String(Math.round(w.x - work.x))}, ${String(Math.round(w.y - work.y))}`
        : `Resized to ${String(Math.round(w.w))} × ${String(Math.round(w.h))}`;
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const step = ev.shiftKey ? 1 : 16;
      let dx = 0;
      let dy = 0;
      switch (ev.key) {
        case 'ArrowLeft':
          dx = -step;
          break;
        case 'ArrowRight':
          dx = step;
          break;
        case 'ArrowUp':
          dy = -step;
          break;
        case 'ArrowDown':
          dy = step;
          break;
        case 'Enter':
          finish(false);
          break;
        case 'Escape':
          finish(true);
          break;
        default:
          return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      if (dx !== 0 || dy !== 0) {
        g.step(dx, dy);
        announce(wid, describe());
      }
    };
    const onPointer = (): void => finish(false);
    function finish(revert: boolean): void {
      if (g === null || g.done) return;
      view.removeEventListener('keydown', onKey, true);
      view.removeEventListener('pointerdown', onPointer, true);
      view.removeEventListener('blur', onPointer);
      if (kbMode?.wid === wid) kbMode = null;
      if (revert) g.cancel();
      else g.commit();
      announce(wid, revert ? `${mode === 'move' ? 'Move' : 'Size'} cancelled` : describe());
    }
    view.addEventListener('keydown', onKey, true);
    view.addEventListener('pointerdown', onPointer, true);
    view.addEventListener('blur', onPointer);
    kbMode = { wid, finish };
    announce(
      wid,
      mode === 'move'
        ? 'Move: arrow keys move the window, Shift for 1 pixel, Enter to finish, Escape to cancel'
        : 'Size: arrow keys resize the window, Shift for 1 pixel, Enter to finish, Escape to cancel',
    );
  };

  /** Where focus goes back when the window menu closes (UI-094). */
  let winMenuReturn: HTMLElement | null = null;
  const openWindowMenu = (
    wid: number,
    anchor: HTMLElement,
    at?: { x: number; y: number },
  ): void => {
    const active = doc.activeElement;
    winMenuReturn = active instanceof HTMLElement && active !== doc.body ? active : null;
    const r = anchor.getBoundingClientRect();
    setWinMenu({ wid, at: at ?? { x: r.left + 16, y: r.bottom } });
  };
  type WindowMenuClose = Parameters<Parameters<typeof Menu>[0]['onClose']>[0];
  const closeWindowMenu = (reason: WindowMenuClose): void => {
    const m = winMenu();
    setWinMenu(null);
    const back = winMenuReturn;
    winMenuReturn = null;
    if (m === null || reason === 'outside') return;
    // The menu had focus; it goes back to the window, not to <body> (UI-094). After a command
    // only when nothing else (a hand-off, a close guard) took it. A right-click on the title bar
    // leaves focus on the window section itself: that goes on into the content, as on a restore.
    queueMicrotask(() => {
      const section = parts.get(m.wid)?.section;
      if (
        reason !== 'select' &&
        back !== null &&
        back !== section &&
        back.isConnected &&
        section?.contains(back) === true &&
        cmp.model.focused === m.wid
      ) {
        back.focus({ preventScroll: true });
        return;
      }
      focusDom(m.wid, reason !== 'select');
    });
  };

  const windowCommand = (wid: number | null, id: string): boolean => {
    if (wid === null) return false;
    switch (id) {
      case 'minimise':
        void cmp.minimise(wid);
        return true;
      case 'zoom':
        if (viewOf(wid)?.maximizable !== false) void cmp.toggleMaximise(wid);
        return true;
      case 'fullscreen':
        if (viewOf(wid)?.maximizable !== false) void cmp.toggleFullscreen(wid);
        return true;
      case 'move':
      case 'size':
        startKeyboardMode(wid, id);
        return true;
      case 'snap-left':
        animatedSnap(wid, 'left');
        return true;
      case 'snap-right':
        animatedSnap(wid, 'right');
        return true;
      case 'close-window':
        closeWindow(wid);
        return true;
      case 'bring-all-to-front': {
        const app = cmp.model.get(wid)?.app;
        for (const w of cmp.model.windows())
          if (w.app === app && w.state !== 'minimised' && w.wid !== wid) cmp.focus(w.wid);
        cmp.focus(wid);
        return true;
      }
      default:
        return false;
    }
  };

  // ------------------------------------------------------------------ launching
  /**
   * Run a menu command on a window as soon as its view listens (a new window's view loads
   * lazily, so the first tries may find no listener yet).
   */
  const commandWhenReady = (wid: number, menuId: string, itemId: string, tries = 0): void => {
    if (cmp.model.get(wid) === undefined) return;
    if (viewHost.menuCommand(wid, menuId, itemId) || tries >= COMMAND_RETRY_LIMIT) return;
    const t = view.setTimeout(() => {
      commandTimers.delete(t);
      commandWhenReady(wid, menuId, itemId, tries + 1);
    }, COMMAND_RETRY_MS);
    commandTimers.add(t);
  };

  /**
   * The View-menu item that opens `argv[0]` in an app (`settings privacy` → `go.privacy`,
   * `taskmgr memory` → `view.memory`), so a running singleton can be sent where a new launch
   * would have opened (UI-077).
   */
  const argvCommand = (
    app: string,
    argv: readonly string[],
  ): { menuId: string; itemId: string } | undefined => {
    const want = argv[0];
    if (want === undefined || want === '') return undefined;
    const target = want === 'privacy-ai' ? 'privacy' : want;
    for (const menu of appEntry(app)?.menus ?? [])
      for (const item of menu.items)
        if (
          (item.kind === undefined || item.kind === 'item') &&
          (item.id === `go.${target}` || item.id === `view.${target}`)
        )
          return { menuId: menu.id, itemId: item.id };
    return undefined;
  };

  const launch = (app: string, argv: readonly string[] = [], restore?: LayoutWindow): void => {
    const entry = appEntry(app);
    if (entry?.singleton === true && restore === undefined) {
      const existing = wins.find((w) => w.app === app);
      if (existing !== undefined) {
        focusWindow(existing.wid, true);
        const cmd = argvCommand(app, argv);
        if (cmd !== undefined) commandWhenReady(existing.wid, cmd.menuId, cmd.itemId);
        return;
      }
    }
    setLaunching((s) => new Set(s).add(app));
    view.setTimeout(() => {
      setLaunching((s) => {
        if (!s.has(app)) return s;
        const next = new Set(s);
        next.delete(app);
        return next;
      });
    }, LAUNCH_BOUNCE_MS);
    const queue = pendingArgv.get(app) ?? [];
    queue.push(argv);
    pendingArgv.set(app, queue);
    const fail = (err: unknown): void =>
      addNotifications([
        {
          id: `launch-${app}-${String(clock())}`,
          level: 'error',
          title: `Could not open ${entry?.title ?? app}`,
          body: err instanceof Error ? err.message : String(err),
          at: clock(),
          unread: true,
        },
      ]);
    if (env.kernel.launch !== undefined) {
      try {
        void Promise.resolve(
          env.kernel.launch(app, { argv, ...(restore === undefined ? {} : { restore }) }),
        ).catch(fail);
      } catch (err) {
        fail(err);
      }
    } else if (link !== null) {
      link.post({ t: 'launch', app, argv, ...(restore === undefined ? {} : { restore }) });
    } else fail(new Error('No kernel link'));
  };

  const dockWindows = (): DockWindow[] =>
    wins.map((w) => ({
      wid: w.wid,
      app: w.app,
      state: w.state,
      focused: w.focused,
      attention: w.attention,
      z: cmp.model.get(w.wid)?.z ?? 0,
    }));

  const iconAt = (app: string): { x: number; y: number } => {
    const r = dockApi?.getIconRect(app);
    return r === undefined
      ? { x: view.innerWidth / 2, y: view.innerHeight - dockReserveNow() }
      : { x: r.x + r.width / 2, y: r.y - 6 };
  };

  /**
   * The Dock's Trash opens Files at the Trash, the way Files' own Go › Trash does (UI-084): a
   * running Files window is brought forward and sent there, otherwise a new one opens there.
   */
  const openTrash = (): void => {
    const files = sysApp('files');
    const cmd = { menuId: 'go', itemId: 'go.trash' };
    const open = wins
      .filter((w) => w.app === files)
      .sort((a, b) => (cmp.model.get(b.wid)?.z ?? 0) - (cmp.model.get(a.wid)?.z ?? 0))[0];
    if (open !== undefined) {
      focusWindow(open.wid, true);
      commandWhenReady(open.wid, cmd.menuId, cmd.itemId);
      return;
    }
    pendingCommands.set(files, [...(pendingCommands.get(files) ?? []), cmd]);
    launch(files);
  };

  /** Escape in the Dock or the menu bar: back to the focused window (§3.9), else nowhere. */
  const returnToWindow = (): void => {
    const wid = focusedWid();
    if (wid !== null) focusWindow(wid, true);
    else if (doc.activeElement instanceof HTMLElement) doc.activeElement.blur();
  };

  const dockButton = (app: string): HTMLElement | undefined =>
    /^[\w.-]+$/u.test(app)
      ? (dockRootEl?.querySelector<HTMLElement>(`[data-dock-id="${app}"]`) ?? undefined)
      : undefined;

  const activateApp = (app: string): void => {
    const d = dockDecision(app, dockWindows());
    switch (d.kind) {
      case 'launch':
        launch(app);
        return;
      case 'focus':
        focusWindow(d.wid, true);
        return;
      case 'minimise':
        void cmp.minimise(d.wid);
        return;
      case 'restore':
        focusWindow(d.wid, true);
        return;
      case 'choose':
        setDockMenu({ app, at: iconAt(app), anchor: dockButton(app) });
        return;
    }
  };

  const dockMenuItems = createMemo((): MenuEntry[] => {
    const m = dockMenu();
    if (m === null) return [];
    const own = wins.filter((w) => w.app === m.app);
    const items: MenuEntry[] = own.map((w) => ({
      id: `w:${String(w.wid)}`,
      label: w.state === 'minimised' ? `${w.title} (minimised)` : w.title,
      checked: w.focused,
    }));
    if (items.length > 0) items.push({ kind: 'separator', id: 'dock-sep' });
    items.push({ id: 'new', label: 'New Window' });
    if (own.length > 0) items.push({ id: 'close-all', label: 'Close All', danger: true });
    return items;
  });

  const onDockMenu = (id: string): void => {
    const m = dockMenu();
    setDockMenu(null);
    if (m === null) return;
    if (id === 'new') launch(m.app);
    else if (id === 'close-all')
      for (const w of wins.filter((x) => x.app === m.app)) closeWindow(w.wid);
    else if (id.startsWith('w:')) focusWindow(Number(id.slice(2)), true);
  };

  // ------------------------------------------------------------------ system actions
  const power = (action: PowerAction): void => {
    persist.cancel();
    void saveLayout('strict').then(() => {
      if (env.power !== undefined) env.power(action);
      else if (action !== 'reboot-menu') link?.post({ t: 'power', action });
      else link?.post({ t: 'power', action: 'reboot' });
    });
  };

  const onSystemAction = (
    action: 'about' | 'settings' | 'restart' | 'shutdown' | 'lock' | 'logout',
  ): void => {
    switch (action) {
      case 'about':
        if (appEntry('about') !== undefined) launch('about');
        else launch(sysApp('settings'), ['about']);
        return;
      case 'settings':
        launch(sysApp('settings'));
        return;
      case 'restart':
        setBootMenu(false);
        setPowerAsk('restart');
        return;
      case 'shutdown':
        setPowerAsk('shutdown');
        return;
      case 'logout':
        setBootMenu(false);
        setPowerAsk('logout');
        return;
      case 'lock':
        env.power?.('lock');
        props.onLock();
        return;
    }
  };

  const onMenuSelect = (menuId: string, itemId: string): void => {
    const wid = desktopActive ? null : focusedWid();
    const app = wid === null ? undefined : cmp.model.get(wid)?.app;
    if (menuId === 'app') {
      if (itemId === 'quit' && app !== undefined)
        for (const w of wins.filter((x) => x.app === app)) closeWindow(w.wid);
      else if (itemId === 'about') {
        // "About <App>" describes that app; the desktop's own item is About Plotinium (UI-076).
        if (app !== undefined && appEntry(app) !== undefined && app !== 'about') setAboutApp(app);
        else onSystemAction('about');
      } else if (itemId === 'settings') onSystemAction('settings');
      return;
    }
    if (itemId === 'app-help') {
      setHelp(
        app === undefined || appEntry(app) === undefined
          ? { kind: 'shortcuts' }
          : { kind: 'app', app },
      );
      return;
    }
    if (itemId.startsWith('app:')) {
      launch(itemId.slice(4));
      return;
    }
    if (itemId === 'new-terminal') {
      launch(sysApp('terminal'));
      return;
    }
    if (itemId === 'search') {
      openSearch(false);
      return;
    }
    if (itemId === 'overview') {
      toggleOverview();
      return;
    }
    if (itemId === 'new-window' && app !== undefined) {
      launch(app);
      return;
    }
    if (itemId === 'keyboard-shortcuts') {
      // Settings has no keyboard section: the shell lists its own keys (UI-077).
      setHelp({ kind: 'shortcuts' });
      return;
    }
    if (menuId === 'window' && windowCommand(wid, itemId)) return;
    if (itemId === 'close-window') {
      closeWindow(wid);
      return;
    }
    if (wid !== null) viewHost.menuCommand(wid, menuId, itemId);
  };

  // ------------------------------------------------------------------ Search
  let searchAbort: AbortController | null = null;
  const appResults = (q: string): SearchResult[] => {
    const needle = q.trim().toLowerCase();
    return env.apps
      .list()
      .filter((a) => a.launchable !== false)
      .filter(
        (a) => needle === '' || a.title.toLowerCase().includes(needle) || a.id.includes(needle),
      )
      .map((a): SearchResult => ({
        id: `app:${a.id}`,
        group: 'apps',
        kind: 'app',
        title: a.title,
        meta: 'Application',
        app: a.icon,
        running: wins.some((w) => w.app === a.id),
      }));
  };
  const runSearch = (q: string): void => {
    setSearch('query', q);
    searchAbort?.abort();
    const apps = appResults(q);
    const provider = env.search;
    if (provider === undefined || q.trim() === '') {
      setSearch({
        results: apps,
        loading: false,
        progress: undefined,
        error: undefined,
        stats: q.trim() === '' ? undefined : { count: apps.length, ms: 0, source: 'apps' },
      });
      return;
    }
    const ac = new AbortController();
    searchAbort = ac;
    const t0 = performance.now();
    setSearch({ loading: true, progress: 0.5, results: apps });
    provider.query(q, ac.signal).then(
      (r) => {
        if (ac.signal.aborted) return;
        const merged = [...r.results, ...apps.filter((a) => !r.results.some((x) => x.id === a.id))];
        setSearch({
          results: merged,
          loading: false,
          progress: undefined,
          stats: r.stats ?? {
            count: merged.length,
            ms: Math.round(performance.now() - t0),
            source: 'local index',
          },
          semantic: r.semantic,
          notice: r.notice,
          error: r.error,
        });
      },
      (err: unknown) => {
        if (ac.signal.aborted) return;
        setSearch({
          loading: false,
          progress: undefined,
          error: `Search failed — ${err instanceof Error ? err.message : String(err)}. Showing apps.`,
        });
      },
    );
  };
  const openSearch = (ai: boolean): void => {
    setCcOpen(false);
    setNetOpen(false);
    setSearch({ ...EMPTY_SEARCH, open: true, aiMode: ai && env.search?.askAgent !== undefined });
    runSearch('');
  };
  /** Nothing to show yet while the provider answers (apps are listed at once). */
  const searchBusy = (): boolean => search.loading && search.results.length === 0;
  const closeSearch = (): void => {
    searchAbort?.abort();
    setSearch('open', false);
  };
  const openResult = (r: SearchResult, how: 'open' | 'reveal'): void => {
    closeSearch();
    if (r.id.startsWith('app:')) launch(r.id.slice(4));
    else env.search?.open?.(r, how);
  };

  // ------------------------------------------------------------------ Overview
  const owner = getOwner();
  /** The thumbnails of one Overview opening live in their own root, disposed after it closes. */
  let thumbs: (() => void) | undefined;
  const disposeThumbs = (): void => {
    thumbs?.();
    thumbs = undefined;
  };
  const toggleOverview = (): void => {
    if (overviewOpen()) {
      closeOverview(undefined);
      return;
    }
    disposeThumbs();
    const list = createRoot((dispose) => {
      thumbs = dispose;
      return overviewWindows();
    }, owner);
    clearTimeout(overviewTimer);
    setSlots(new Map());
    setOverviewList(list);
    const f = focusedWid();
    setOverviewSel(f === null ? list[0]?.id : String(f));
    setCcOpen(false);
    setNetOpen(false);
    setOverviewHidden(true);
    setOverviewOpen(true);
  };
  const overviewWindows = (): OverviewWindow[] =>
    cmp.model
      .windows()
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt || a.wid - b.wid)
      .map((w): OverviewWindow => {
        const v = wins.find((x) => x.wid === w.wid);
        return {
          id: String(w.wid),
          title: w.title,
          app: v?.icon ?? 'atom',
          appName: v?.appName ?? w.app,
          state:
            w.state === 'minimised'
              ? 'minimised'
              : v?.overlay?.kind === 'restoring'
                ? 'restoring'
                : 'normal',
          aspect: w.h > 0 ? w.w / w.h : 1.5,
          ...(w.state === 'minimised' ? {} : { rect: { x: w.x, y: w.y, width: w.w, height: w.h } }),
          thumbnail: <OverviewThumb wid={w.wid} width={w.w} height={w.h} />,
        };
      });
  const closeOverview = (pick: number | undefined): void => {
    setOverviewOpen(false);
    if (pick !== undefined) focusWindow(pick, true);
    clearTimeout(overviewTimer);
    overviewTimer = setTimeout(() => {
      setOverviewHidden(false);
      disposeThumbs();
    }, OVERVIEW_EXIT_MS * motionScale());
  };

  function OverviewThumb(p: { wid: number; width: number; height: number }): JSX.Element {
    let host: HTMLDivElement | undefined;
    onMount(() => {
      const section = parts.get(p.wid)?.section;
      if (host === undefined || section === undefined) return;
      const clone = section.cloneNode(true) as HTMLElement;
      for (const el of [clone, ...Array.from(clone.querySelectorAll('[id]'))])
        el.removeAttribute('id');
      clone.removeAttribute('data-testid');
      for (const el of Array.from(clone.querySelectorAll('[data-testid]')))
        el.removeAttribute('data-testid');
      clone.setAttribute('aria-hidden', 'true');
      clone.inert = true;
      // The clone keeps the window's own size; the host scales it into the tile (origin 0 0).
      clone.style.width = `${String(p.width)}px`;
      clone.style.height = `${String(p.height)}px`;
      clone.style.transform = 'none';
      clone.style.opacity = '1';
      clone.style.visibility = 'visible';
      host.replaceChildren(clone);
    });
    const scale = (): number => {
      const r = slots().get(String(p.wid));
      return r === undefined || p.width <= 0 ? 0 : r.width / p.width;
    };
    // Static placement lives in the stylesheet (the CSP drops static style attributes, UI-091);
    // only the measured scale is written, through the CSSOM.
    return (
      <div
        ref={(el) => (host = el)}
        aria-hidden="true"
        class={styles.thumb}
        style={{
          transform: `scale(${String(scale())})`,
          opacity: scale() > 0 ? '1' : '0',
        }}
      />
    );
  }

  // ------------------------------------------------------------------ window switcher
  const topToBottom = (): number[] =>
    cmp.model
      .windows()
      .map((w) => w.wid)
      .reverse();
  const switchStep = (dir: 1 | -1): void => {
    const s = switcher();
    if (s === null) {
      const opened = openSwitcher(topToBottom(), dir, performance.now());
      if (opened === null) return;
      setSwitcher(opened);
      clearTimeout(switcherTimer);
      switcherTimer = setTimeout(() => {
        if (switcher() !== null) setSwitcherShown(true);
      }, SWITCHER_HOLD_MS);
      return;
    }
    setSwitcher(stepSwitcher(s, dir));
  };
  const commitSwitcher = (wid?: number): void => {
    const s = switcher();
    clearTimeout(switcherTimer);
    setSwitcher(null);
    setSwitcherShown(false);
    const target = wid ?? (s === null ? undefined : selectedWid(s));
    if (target !== undefined) focusWindow(target, true);
  };
  const cancelSwitcher = (): void => {
    clearTimeout(switcherTimer);
    setSwitcher(null);
    setSwitcherShown(false);
  };
  const switcherItems = createMemo((): SwitcherItem[] => {
    const s = switcher();
    if (s === null) return [];
    const counts = new Map<string, number>();
    for (const w of wins) counts.set(w.app, (counts.get(w.app) ?? 0) + 1);
    return s.order.flatMap((wid) => {
      const w = wins.find((x) => x.wid === wid);
      if (w === undefined) return [];
      const n = counts.get(w.app) ?? 1;
      return [
        {
          id: String(wid),
          title: w.title,
          app: w.icon,
          appName: w.appName,
          ...(w.state === 'minimised' ? { state: 'minimised' as const } : {}),
          ...(n > 1 ? { count: n } : {}),
        },
      ];
    });
  });

  // ------------------------------------------------------------------ keyboard (WM-07)
  const runAction = (action: ShellAction): void => {
    // After a click on the bare desktop no window is the target of window keys (UI-083).
    const wid = desktopActive ? null : focusedWid();
    switch (action) {
      case 'switch-next':
        switchStep(1);
        return;
      case 'switch-prev':
        switchStep(-1);
        return;
      case 'window-menu': {
        const w = wid === null ? undefined : cmp.model.get(wid);
        if (w !== undefined && wid !== null)
          setWinMenu({ wid, at: { x: w.x + 16, y: w.y + titlebarH } });
        return;
      }
      case 'snap-left':
        if (wid !== null) animatedSnap(wid, 'left');
        return;
      case 'snap-right':
        if (wid !== null) animatedSnap(wid, 'right');
        return;
      case 'maximise-toggle':
        if (wid !== null) void cmp.toggleMaximise(wid);
        return;
      case 'restore-or-minimise': {
        if (wid === null) return;
        const w = cmp.model.get(wid);
        if (w !== undefined && (w.state === 'maximised' || w.snap !== null)) void cmp.restore(wid);
        else void cmp.minimise(wid);
        return;
      }
      case 'minimise':
        if (wid !== null) void cmp.minimise(wid);
        return;
      case 'close':
        closeWindow(wid);
        return;
      case 'open-terminal':
        launch(sysApp('terminal'));
        return;
      case 'launcher':
      case 'search':
        if (search.open) closeSearch();
        else openSearch(false);
        return;
      case 'focus-dock':
        dockApi?.focus();
        return;
      case 'focus-menubar':
        menubarApi?.focus();
        return;
      case 'overview':
        toggleOverview();
        return;
      case 'control-centre':
        if (ccOpen()) closeCc(true);
        else {
          const active = doc.activeElement;
          openCc(active instanceof HTMLElement && active !== doc.body ? active : undefined, true);
        }
        return;
    }
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (props.locked) return;
    if (switcher() !== null && ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      cancelSwitcher();
      return;
    }
    const action = matchKey(ev);
    if (action === null) {
      if (isNavigationKey(ev)) ev.preventDefault();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    runAction(action);
  };
  const onKeyUp = (ev: KeyboardEvent): void => {
    if (switcher() !== null && isSwitcherRelease(ev)) commitSwitcher();
  };

  /**
   * Tab past the last stop of the desktop wraps to the menu bar, and Shift+Tab before the first
   * wraps to the last, so focus never lands on the page body between them (UI-088).
   */
  const wrapTab = (ev: KeyboardEvent): void => {
    const root = rootEl;
    const active = doc.activeElement;
    if (root === undefined || !(active instanceof HTMLElement) || !root.contains(active)) return;
    // Tab stops only: roving items that are not the current stop (tabindex -1) are skipped.
    const stops = focusableIn(root).filter((el) => el.getAttribute('tabindex') !== '-1');
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (first === undefined || last === undefined) return;
    if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      if (menubarApi !== undefined) menubarApi.focus();
      else first.focus();
    } else if (ev.shiftKey && active === first) {
      ev.preventDefault();
      last.focus();
    }
  };

  /**
   * Bubble phase, after the app had its turn: Tab wrapping, and the focused app's menu key
   * equivalents (UI-087) for keys the app did not handle itself (`defaultPrevented`). Never in
   * a text field, never with an overlay (a portal outside the desktop) holding focus.
   */
  const onKeyDownAfterApps = (ev: KeyboardEvent): void => {
    if (props.locked || ev.defaultPrevented) return;
    if (ev.key === 'Tab') {
      if (!ev.altKey && !ev.ctrlKey && !ev.metaKey) wrapTab(ev);
      return;
    }
    if (ev.repeat || isEditableTarget(ev.target)) return;
    const target = ev.target;
    if (!(target instanceof Node) || rootEl === undefined) return;
    if (target !== doc.body && !rootEl.contains(target)) return;
    if (focusedWid() === null || desktopActive) return;
    const hit = menuShortcut(untrack(menus), ev);
    if (hit === null) return;
    ev.preventDefault();
    onMenuSelect(hit.menuId, hit.itemId);
  };
  const onBlur = (): void => {
    if (switcher() !== null) commitSwitcher();
  };

  // ------------------------------------------------------------------ clock
  const needSeconds = createMemo((): boolean => {
    const s = status();
    const t = untrack(now);
    return (
      s.net.state === 'RECONNECTING' ||
      s.lease !== undefined ||
      retry() === 'checking' ||
      s.services.some((x) => x.nextRetryAt !== undefined && x.nextRetryAt > t)
    );
  });
  let tick: ReturnType<typeof setTimeout> | undefined;
  const scheduleTick = (): void => {
    clearTimeout(tick);
    const t = clock();
    const period = needSeconds() ? 1_000 : 60_000;
    tick = setTimeout(
      () => {
        setNow(clock());
        scheduleTick();
      },
      period - (t % period) + 5,
    );
  };
  createEffect(
    on(needSeconds, () => {
      setNow(clock());
      scheduleTick();
    }),
  );

  // ------------------------------------------------------------------ frame meter (WMD-19)
  createEffect(() => {
    if (!props.prefs.frameMeter) return;
    const sampler = new FrameSampler();
    let last = performance.now();
    let raf = 0;
    let alive = true;
    const loop = (t: number): void => {
      sampler.sample(t - last);
      last = t;
      if (alive) raf = view.requestAnimationFrame(loop);
    };
    raf = view.requestAnimationFrame(loop);
    const iv = setInterval(
      () => setFrame({ stats: sampler.stats(), samples: sampler.samples(120) }),
      1_000,
    );
    let po: PerformanceObserver | undefined;
    // Only frames since the meter was switched on count: boot and earlier frames are not
    // buffered in (UI-072).
    const since = performance.now();
    try {
      if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
        po = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration <= 50 || entry.startTime < since) continue;
            const scripts =
              (entry as PerformanceEntry & { scripts?: { sourceURL?: string }[] }).scripts ?? [];
            sampler.longFrame(scripts.some((s) => (s.sourceURL ?? '').startsWith(location.origin)));
          }
        });
        po.observe({ type: 'long-animation-frame' });
      }
    } catch {
      po = undefined;
    }
    onCleanup(() => {
      alive = false;
      view.cancelAnimationFrame(raf);
      clearInterval(iv);
      po?.disconnect();
      setFrame(undefined);
    });
  });

  // Reduced motion switched on mid-flight: finish every running window animation.
  createEffect(
    on(reducedMotion, (on) => {
      if (on) animator.finishAll();
    }),
  );

  // ------------------------------------------------------------------ status views
  const unread = (): number => notes().filter((n) => n.unread === true).length;
  createEffect(
    on(ccOpen, (open) => {
      if (open)
        setNotes((list) => list.map((n) => (n.unread === true ? { ...n, unread: false } : n)));
    }),
  );
  const degradedRows = createMemo((): DegradedService[] =>
    degradedServices(status().services).map((s) => {
      const since = degradedSince.get(s.name);
      return {
        id: s.name,
        name: s.name,
        detail:
          s.reason ??
          (s.state === 'blocked' ? `blocked by ${s.blockedBy ?? 'a dependency'}` : s.state),
        since:
          since === undefined
            ? '—'
            : // Same 12- or 24-hour form as the menu-bar clock (Settings › 24-hour time, UI-040).
              new Date(since).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: !props.prefs.clock24h,
              }),
        state: s.state === 'failed' ? 'failed' : 'degraded',
      };
    }),
  );
  const nextCheckS = (): number | undefined => {
    const n = status().net;
    return n.state === 'RECONNECTING'
      ? Math.max(0, Math.ceil((n.retryAt - now()) / 1000))
      : undefined;
  };
  const memoryView = (): {
    budgetMb: number;
    usedMb: number;
    error?: string;
    applying?: boolean;
    disabledReason?: string;
  } => {
    const m = status().memory;
    const err = memError();
    const disabled =
      session.kind === 'guest'
        ? 'Managed by the administrator'
        : env.setMemoryBudget === undefined
          ? 'Not available in this session'
          : m === undefined
            ? 'Waiting for the memory manager'
            : undefined;
    return {
      budgetMb: Math.round(m?.budgetMb ?? 256),
      // Unrounded: the same value as the menu bar, formatted the same way (KB below 1 MB, UI-090).
      usedMb: m?.usedMb ?? 0,
      ...(err === undefined ? {} : { error: err }),
      applying: memApplying(),
      ...(disabled === undefined ? {} : { disabledReason: disabled }),
    };
  };
  const commitBudget = (mb: number): void => {
    const set = env.setMemoryBudget;
    if (set === undefined) return;
    setMemApplying(true);
    set(mb).then(
      (err) => {
        setMemApplying(false);
        setMemError(err);
        if (err === undefined)
          setStatus((s) => ({ ...s, memory: { usedMb: s.memory?.usedMb ?? 0, budgetMb: mb } }));
      },
      (e: unknown) => {
        setMemApplying(false);
        setMemError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  function settleRetry(): void {
    if (untrack(retry) === 'checking')
      setRetry(untrack(status).net.state === 'LIVE' ? 'idle' : 'failed');
  }
  const retryNetwork = (): void => {
    setRetry('checking');
    if (env.retryNetwork !== undefined) env.retryNetwork();
    else link?.post({ t: 'net.retry' });
    view.setTimeout(settleRetry, 4_000);
  };
  /**
   * A service retry ends on its answer, on the service's next event, or after a timeout; a
   * failure is shown on the row ("Could not retry …") instead of "Retrying…" forever (UI-074).
   */
  function endRetry(name: string, error?: string): void {
    const timer = retryTimers.get(name);
    if (timer !== undefined) view.clearTimeout(timer);
    retryTimers.delete(name);
    if (untrack(retrying).includes(name)) setRetrying((r) => r.filter((n) => n !== name));
    if (error !== undefined) setRetryErrors((m) => ({ ...m, [name]: error }));
    else if (untrack(retryErrors)[name] !== undefined)
      setRetryErrors((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== name)));
  }
  const retryService = (name: string): void => {
    if (untrack(retrying).includes(name)) return;
    endRetry(name);
    setRetrying((r) => [...r, name]);
    retryTimers.set(
      name,
      view.setTimeout(() => endRetry(name, 'Could not retry: no answer'), RETRY_TIMEOUT_MS),
    );
    const failed = (reason: unknown): void =>
      endRetry(
        name,
        `Could not retry: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    try {
      if (env.retryService !== undefined) {
        const answer = env.retryService(name);
        if (answer instanceof Promise)
          answer.then((refusal) => {
            if (refusal === undefined) endRetry(name);
            else failed(refusal);
          }, failed);
      } else if (link !== null) link.post({ t: 'svc.retry', name });
      else failed('not available in this session');
    } catch (err) {
      failed(err);
    }
  };

  /** The element keyboard focus returns to when Control Centre closes with Escape or Alt+C. */
  const openCc = (returnTo: HTMLElement | undefined, keyboard: boolean): void => {
    setNetOpen(false);
    if (search.open) closeSearch();
    // Banners hand off to the centre, which lists them (UI-024).
    setToasts([]);
    setCcReturn(returnTo);
    setCcAutoFocus(keyboard);
    setCcOpen(true);
  };
  const closeCc = (restoreFocus: boolean): void => {
    const back = ccReturn();
    const inside = column()?.parentElement?.contains(doc.activeElement) === true;
    setCcOpen(false);
    if (restoreFocus && inside && back?.isConnected === true) back.focus();
  };
  /** The status-bar buttons that open Control Centre: clicks on them never count as outside. */
  const ccTriggers = (): HTMLElement[] =>
    Array.from(
      menubarRootEl?.querySelectorAll<HTMLElement>(
        '[data-status-item="control-centre"], [data-status-item="clock"]',
      ) ?? [],
    );
  /** Keyboard activation (Enter or Space) leaves the trigger focus-visible; a click does not. */
  const byKeyboard = (el: HTMLElement): boolean => {
    try {
      return el.matches(':focus-visible');
    } catch {
      return false;
    }
  };

  const onStatus = (item: StatusItemId, anchor: HTMLElement): void => {
    switch (item) {
      case 'control-centre':
      case 'clock':
        if (ccOpen()) closeCc(false);
        else openCc(anchor, byKeyboard(anchor));
        return;
      case 'connectivity':
      case 'services': {
        const focus = item === 'services' ? 'services' : 'connectivity';
        setCcOpen(false);
        if (netOpen() && netFocus() === focus) {
          setNetOpen(false);
          return;
        }
        setNetFocus(focus);
        setNetAnchor(anchor);
        setNetOpen(true);
        return;
      }
      case 'search':
        openSearch(false);
        return;
      case 'memory':
        launch(sysApp('taskmgr'), ['memory']);
        return;
      case 'ai':
        if (env.search?.askAgent !== undefined) openSearch(true);
        // Settings' section for the model, the index and the agent is Privacy & AI (UI-077).
        else launch(sysApp('settings'), ['privacy']);
        return;
    }
  };
  const openStatus = (): StatusItemId | undefined =>
    ccOpen() ? 'control-centre' : netOpen() ? 'connectivity' : search.open ? 'search' : undefined;

  const onNotificationAction = (id: string, actionId: string): void => {
    setToasts((l) => l.filter((n) => n.id !== id));
    if (actionId === 'restart-update') {
      setUpdateOpen(true);
      return;
    }
    if (actionId === 'later') return;
    if (env.notificationAction !== undefined) env.notificationAction(id, actionId);
    else link?.post({ t: 'notify.action', id, actionId });
  };

  const updateOffer = createMemo(() => {
    const o = env.update?.offer() ?? null;
    const u = status().update;
    return {
      version: o?.version ?? u?.version ?? env.identity.version,
      build: o?.build ?? u?.build ?? env.identity.build,
      size: o?.size ?? '—',
      notes: o?.notes ?? [],
    };
  });
  const restartForUpdate = (): void => {
    setRestarting(true);
    persist.cancel();
    void saveLayout('strict').then(() => {
      if (env.update !== undefined) env.update.restart();
      else power('reboot');
    });
  };

  const lease = (): StatusState['lease'] => status().lease;
  const dismissLease = (): void => {
    setStatus((s) => ({ ...s, lease: undefined }));
  };

  const dock = createMemo(() =>
    dockItems(env.apps.list(), dockWindows(), launching(), firstLaunch()),
  );
  const focusedEntry = createMemo(() => {
    const w = focusedWin();
    return w === undefined ? undefined : appEntry(w.app);
  });
  const menus = createMemo(() => menusFor(focusedEntry(), env.apps.list()));
  // Stable values for the menu bar, so status events never hand it new objects (UI-023).
  const appName = createMemo(() => focusedEntry()?.title ?? 'Plotinium');
  const appMenu = createMemo((): readonly MenuEntry[] =>
    focusedEntry() === undefined ? DESKTOP_APP_MENU : appMenuItems(appName()),
  );
  const clockOptions = createMemo(() => (props.prefs.clock24h ? CLOCK_24H : CLOCK_12H));
  const tray = createMemo(() => trayNet(status()));
  /** Banners are on screen (not handed to Control Centre, not hidden by Search or Overview). */
  const bannersShown = (): boolean =>
    !ccOpen() &&
    !search.open &&
    !overviewOpen() &&
    toasts().some((n) => !props.prefs.focusMode || n.level === 'warning' || n.level === 'error');

  /** The help sheet's content: the desktop's keys, or what an app's menus do from the keyboard. */
  const helpView = createMemo(() => {
    const h = help();
    if (h === null) return undefined;
    if (h.kind === 'shortcuts')
      return {
        title: 'Keyboard Shortcuts',
        intro: 'These keys work everywhere on the desktop.',
        app: undefined,
        groups: shortcutSections().map((sec): ShortcutGroup => ({
          id: sec.id,
          title: sec.title,
          rows: sec.rows,
        })),
        empty: undefined,
        more: false,
      };
    const entry = appEntry(h.app);
    const title = entry?.title ?? h.app;
    const own = (entry?.menus ?? []).filter(
      (m: MenuBarMenu) => m.id !== 'window' && m.id !== 'help',
    );
    const groups = own
      .map((m): ShortcutGroup => ({
        id: m.id,
        title: m.label,
        rows: m.items.flatMap((i) =>
          (i.kind === undefined || i.kind === 'item') &&
          i.shortcut !== undefined &&
          i.disabled !== true
            ? [{ id: i.id, label: i.label, keys: i.shortcut }]
            : [],
        ),
      }))
      .filter((g) => g.rows.length > 0);
    return {
      title: `${title} Help`,
      intro: `${title}'s commands are in its menus in the menu bar; these are their keyboard shortcuts.`,
      app: entry?.icon,
      groups,
      empty: `${title} has no keyboard shortcuts of its own. Its commands are in its menus.`,
      more: true,
    };
  });

  // ------------------------------------------------------------------ Dock preferences (UI-040)
  // The space kept free for the Dock follows its size (icon + padding + margins, 84 px at the
  // default 52 px) and shrinks to the edge margin while it hides itself. Control Centre's column
  // reads the token; the compositor re-reads its work area on `viewportChanged`.
  createEffect(() => {
    const reserve = props.prefs.dockAutoHide ? 8 : props.prefs.dockSize + 32;
    rootStyle.style.setProperty('--pl-dock-reserve', `${String(reserve)}px`);
    cmp.viewportChanged();
  });
  onCleanup(() => rootStyle.style.removeProperty('--pl-dock-reserve'));

  // ------------------------------------------------------------------ lock (UI-027)
  /** Elements this shell made inert for the lock screen, with their previous aria-hidden. */
  const lockMarks: { el: HTMLElement; ariaHidden: string | null }[] = [];
  let lockReturn: HTMLElement | null = null;
  let lockedFromDesktop = false;
  /** Everything of the session that is open in a layer closes when the screen locks. */
  const closeTransientLayers = (): void => {
    menubarApi?.close();
    setCcOpen(false);
    setNetOpen(false);
    if (search.open) closeSearch();
    if (overviewOpen()) closeOverview(undefined);
    if (switcher() !== null) cancelSwitcher();
    setDockMenu(null);
    setWinMenu(null);
    setHelp(null);
    setAboutApp(null);
    setPowerAsk(null);
    setGuardAsk(null);
    setUpdateOpen(false);
  };
  /**
   * While locked, the desktop and every layer it portalled to <body> are inert and hidden from
   * assistive technology; the page's own roots (`#plt-…`, which hold the boot, panic and login
   * screens) and scripts are left alone.
   */
  const markInert = (): void => {
    const targets: HTMLElement[] = rootEl === undefined ? [] : [rootEl];
    for (const child of Array.from(doc.body.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (rootEl !== undefined && child.contains(rootEl)) continue;
      if (child.id.startsWith('plt-')) continue;
      if (/^(SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT)$/u.test(child.tagName)) continue;
      if (child.querySelector('[data-testid="login-screen"]') !== null) continue;
      targets.push(child);
    }
    for (const el of targets) {
      if (el.hasAttribute('inert')) continue;
      lockMarks.push({ el, ariaHidden: el.getAttribute('aria-hidden') });
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    }
  };
  const unmarkInert = (): void => {
    for (const { el, ariaHidden } of lockMarks.splice(0)) {
      el.removeAttribute('inert');
      if (ariaHidden === null) el.removeAttribute('aria-hidden');
      else el.setAttribute('aria-hidden', ariaHidden);
    }
  };
  createEffect(
    on(
      () => props.locked,
      (locked, was) => {
        if (locked) {
          if (was === false) {
            lockedFromDesktop = true;
            const active = doc.activeElement;
            lockReturn =
              active instanceof HTMLElement && rootEl?.contains(active) === true ? active : null;
          }
          closeTransientLayers();
          markInert();
          return;
        }
        unmarkInert();
        if (!lockedFromDesktop) return;
        lockedFromDesktop = false;
        const back = lockReturn;
        lockReturn = null;
        // After unlock, focus goes back where it was, else into the focused window.
        queueMicrotask(() => {
          if (back?.isConnected === true && !back.closest('[inert]')) back.focus();
          else {
            const wid = focusedWid();
            if (wid !== null) focusWindow(wid, true);
          }
        });
      },
    ),
  );

  // ------------------------------------------------------------------ desktop clicks (UI-083)
  /** A compositor that can take focus away from every window (fix-windows' API, when present). */
  type DesktopFocusing = Compositor & { focusDesktop?: () => void };
  /** Back from the bare desktop: the windows show the compositor's real focus again. */
  const leaveDesktop = (): void => {
    if (!desktopActive) return;
    desktopActive = false;
    const f = cmp.model.focused;
    setWins(
      produce((list) => {
        for (const w of list) w.focused = w.wid === f;
      }),
    );
  };
  /**
   * A press on the bare desktop takes focus away from the windows, as on macOS: the menu bar
   * shows the desktop's menus and keys no longer reach the app. The wallpaper and the window
   * layer are click-through, so such a press targets the shell root itself.
   */
  const onDesktopPress = (ev: PointerEvent): void => {
    if (ev.button !== 0 || props.locked || rootEl === undefined || ev.target !== rootEl) return;
    const active = doc.activeElement;
    if (active instanceof HTMLElement && rootEl.contains(active)) active.blur();
    const c: DesktopFocusing = cmp;
    if (c.focusDesktop !== undefined) {
      c.focusDesktop();
      return;
    }
    if (cmp.model.focused === null) return;
    desktopActive = true;
    setWins(
      produce((list) => {
        for (const w of list) w.focused = false;
      }),
    );
  };
  /** Focus or a press inside a window (a click, the Dock, the switcher) ends the desktop state. */
  const onWindowEntry = (ev: Event): void => {
    const t = ev.target;
    if (!desktopActive || !(t instanceof Node)) return;
    for (const p of parts.values())
      if (p.section.contains(t)) {
        leaveDesktop();
        return;
      }
  };
  const onFocusChange = (e: CoarseEvent): void => {
    if (e.type === 'focused') desktopActive = false;
  };

  // ------------------------------------------------------------------ lifecycle
  /** Deliver a queued menu command to the next window of its app (see `openTrash`). */
  const onWindowOpened = (e: CoarseEvent): void => {
    if (e.type !== 'opened') return;
    const queue = pendingCommands.get(e.app);
    const cmd = queue?.shift();
    if (queue !== undefined && queue.length === 0) pendingCommands.delete(e.app);
    if (cmd !== undefined) commandWhenReady(e.wid, cmd.menuId, cmd.itemId);
  };

  onMount(() => {
    view.addEventListener('keydown', onKeyDown, true);
    view.addEventListener('keydown', onKeyDownAfterApps);
    view.addEventListener('keyup', onKeyUp, true);
    view.addEventListener('blur', onBlur);
    const onResize = (): void => cmp.viewportChanged();
    const onPageHide = (): void => {
      persist.cancel();
      void saveLayout('relaxed');
    };
    view.addEventListener('resize', onResize);
    view.addEventListener('pagehide', onPageHide);
    onCleanup(() => {
      view.removeEventListener('keydown', onKeyDown, true);
      view.removeEventListener('keydown', onKeyDownAfterApps);
      view.removeEventListener('keyup', onKeyUp, true);
      view.removeEventListener('blur', onBlur);
      view.removeEventListener('resize', onResize);
      view.removeEventListener('pagehide', onPageHide);
    });
    onCleanup(cmp.subscribe(onCoarse));
    onCleanup(cmp.subscribe(onWindowOpened));
    onCleanup(cmp.subscribe(onFocusChange));
    const desktopRoot = rootEl;
    if (desktopRoot !== undefined) {
      desktopRoot.addEventListener('pointerdown', onDesktopPress);
      desktopRoot.addEventListener('pointerdown', onWindowEntry, true);
      desktopRoot.addEventListener('focusin', onWindowEntry);
      onCleanup(() => {
        desktopRoot.removeEventListener('pointerdown', onDesktopPress);
        desktopRoot.removeEventListener('pointerdown', onWindowEntry, true);
        desktopRoot.removeEventListener('focusin', onWindowEntry);
      });
    }
    if (env.kernel.subscribe !== undefined) onCleanup(env.kernel.subscribe(handleEvents));
    if (dockRootEl !== undefined) {
      const el = dockRootEl;
      cleanups.push(retag(el, () => tagDock(el)));
    }
    if (menubarRootEl !== undefined) {
      const el = menubarRootEl;
      cleanups.push(
        retag(el, () => {
          const chip = el.querySelector('button[aria-label^="Sync:"]');
          if (chip !== null && chip.getAttribute('data-testid') !== 'net-status')
            chip.setAttribute('data-testid', 'net-status');
        }),
      );
    }
    props.onApi({
      layout: () => cmp.layout(),
      sessionId: () => osSessionId,
      compositor: () => cmp,
      launch: (app, argv = []) => launch(app, argv),
      notify: (n) => addNotifications([n]),
      events: (batch) => handleEvents(batch),
    });
    env.onPhase?.('desktop');
    void restoreSession();
  });

  const restoreSession = async (): Promise<void> => {
    const sess = env.session;
    if (sess?.loadLayout === undefined) return;
    let layout;
    try {
      layout = await sess.loadLayout(session);
    } catch {
      layout = null;
    }
    if (layout === null || layout.windows.length === 0) return;
    const plan = restorePlan(layout, { w: view.innerWidth, h: view.innerHeight }, cmp.model.work);
    restoring = true;
    restoreLeft = plan.length;
    const target = focusTarget(plan);
    restoreFocus = null;
    for (const w of plan) {
      const q = pendingRestore.get(w.app) ?? [];
      q.push(
        target >= 0 && plan[target] === w ? { ...w, focused: true } : { ...w, focused: false },
      );
      pendingRestore.set(w.app, q);
    }
    for (const w of plan) launch(w.app, w.argv, w);
    view.setTimeout(finishRestore, RESTORE_TIMEOUT_MS);
  };

  onCleanup(() => {
    props.onApi(null);
    persist.flush();
    unmarkInert();
    for (const t of retryTimers.values()) view.clearTimeout(t);
    retryTimers.clear();
    for (const t of commandTimers) view.clearTimeout(t);
    commandTimers.clear();
    clearTimeout(tick);
    clearTimeout(overviewTimer);
    clearTimeout(switcherTimer);
    disposeThumbs();
    searchAbort?.abort();
    for (const c of cleanups.splice(0)) c();
    viewHost.dispose();
    link?.dispose();
  });

  // ------------------------------------------------------------------ view
  const winMenuItems = (): MenuEntry[] => {
    const m = winMenu();
    const w = m === null ? undefined : viewOf(m.wid);
    return windowActions(
      w?.state === 'maximised',
      w === undefined ? {} : { resizable: w.resizable, maximizable: w.maximizable, state: w.state },
    );
  };

  return (
    <div
      ref={(el) => (rootEl = el)}
      class={styles.root}
      data-testid="desktop"
      data-theme-applied={props.theme}
      data-overview={overviewOpen() ? 'true' : undefined}
    >
      <Wallpaper />
      <div ref={(el) => (menubarRootEl = el)} class={styles.menubar} data-testid="menubar">
        {/* Plain props (no conditional spreads): a spread makes every prop read track the
            status signal, which re-created the titles on each event (UI-023). */}
        <MenuBar
          appName={appName()}
          appLabel={focusedEntry() === undefined ? 'Plotinium desktop' : undefined}
          appMenu={appMenu()}
          userName={session.user}
          menus={menus()}
          onMenuSelect={onMenuSelect}
          onSystemAction={onSystemAction}
          net={tray()}
          now={now()}
          clock={clockOptions()}
          ai={env.ai === false ? undefined : (status().ai ?? AI_IDLE)}
          memory={status().memory}
          services={status().services}
          unreadNotifications={unread()}
          openStatus={openStatus()}
          onStatus={onStatus}
          controlCentreId={ccId}
          animateIn
          apiRef={(api) => (menubarApi = api)}
        />
      </div>

      <WindowLayer
        windows={wins}
        compositor={cmp}
        overview={overviewHidden()}
        onParts={onParts}
        onGone={onGone}
        onClose={(wid) => closeWindow(wid)}
        onWindowMenu={openWindowMenu}
        previewRef={(el) => (previewEl = el)}
        onOverlayAction={(wid, action) => {
          if (action === 'restore' || action === 'wait')
            setWins((w) => w.wid === wid, 'overlay', undefined);
          if (action === 'restore') focusWindow(wid, true);
          else if (action === 'force-quit') link?.post({ t: 'kill', wid, signal: 'SIGKILL' });
          else if (action === 'restart') {
            const app = cmp.model.get(wid)?.app;
            closeWindow(wid);
            if (app !== undefined) launch(app);
          }
        }}
      />

      <div ref={(el) => (dockRootEl = el)} class={styles.dock} data-testid="dock">
        <Dock
          items={dock()}
          trash={{ full: false }}
          onActivate={activateApp}
          onTrash={openTrash}
          onItemMenu={(app, anchor) => setDockMenu({ app, at: iconAt(app), anchor })}
          magnification={props.prefs.dockMagnification}
          magnifiedScale={props.prefs.dockMagnifiedScale}
          iconSize={props.prefs.dockSize}
          autoHide={props.prefs.dockAutoHide}
          holdOpen={dockMenu() !== null}
          indicators={props.prefs.dockIndicators}
          onEscape={returnToWindow}
          animateIn
          label="Dock"
          apiRef={(api) => (dockApi = api)}
        />
      </div>

      <Menu
        open={dockMenu() !== null}
        onClose={(reason) => {
          // The anchor prop is gone once the menu state clears, so the icon is focused here:
          // Escape hands focus back to the Dock icon the menu came from (UI-078).
          const anchor = dockMenu()?.anchor;
          setDockMenu(null);
          if (reason === 'escape' && anchor?.isConnected === true) anchor.focus();
        }}
        onSelect={onDockMenu}
        items={dockMenuItems()}
        label={`${appEntry(dockMenu()?.app ?? '')?.title ?? 'App'} windows`}
        at={dockMenu()?.at}
        anchor={dockMenu()?.anchor}
        placement="top"
      />
      <Menu
        open={winMenu() !== null}
        onClose={closeWindowMenu}
        onSelect={(id) => {
          const m = winMenu();
          if (m !== null) windowCommand(m.wid, id);
        }}
        items={winMenuItems()}
        label="Window"
        {...(winMenu() === null ? {} : { at: winMenu()?.at ?? { x: 0, y: 0 } })}
      />

      <Show when={ccOpen()}>
        <div class={styles.rightColumn}>
          <ControlCentre
            open={ccOpen()}
            inline
            id={ccId}
            anchor={ccReturn()}
            autoFocus={ccAutoFocus()}
            companions={[column(), ...ccTriggers()]}
            onClose={() => setCcOpen(false)}
            net={tray()}
            now={now()}
            clock={clockOptions()}
            lastSyncAt={status().lastSyncAt}
            syncQueue={{ pending: status().queued }}
            onOpenSync={() => {
              setCcOpen(false);
              const chip = menubarRootEl?.querySelector<HTMLElement>('[data-testid="net-status"]');
              if (chip !== null && chip !== undefined) setNetAnchor(chip);
              setNetFocus('connectivity');
              setNetOpen(true);
            }}
            onRetrySync={retryNetwork}
            services={status().services}
            onRetryService={retryService}
            retryingServices={retrying()}
            retryErrors={retryErrors()}
            theme={props.theme}
            onThemeChange={(theme) => props.setPrefs({ theme })}
            reducedMotion={props.prefs.reducedMotion}
            systemReducedMotion={props.systemReducedMotion}
            onReducedMotionChange={(on) => props.setPrefs({ reducedMotion: on })}
            memory={memoryView()}
            onMemoryBudgetCommit={commitBudget}
            focusMode={props.prefs.focusMode}
            onFocusModeChange={(on) => props.setPrefs({ focusMode: on })}
            frameMeter={props.prefs.frameMeter}
            frameMeterSummary={frameSummary(frame()?.stats)}
            onFrameMeterChange={(on) => props.setPrefs({ frameMeter: on })}
            version={`Plotinium ${env.identity.version} · build ${env.identity.build}`}
            onOpenSettings={() => {
              setCcOpen(false);
              launch(sysApp('settings'));
            }}
          />
          <div class={styles.column} ref={setColumn}>
            <NotificationCenter
              notifications={notes()}
              now={now()}
              onDismiss={(id) => setNotes((l) => l.filter((n) => n.id !== id))}
              onClearAll={() => setNotes([])}
              onAction={onNotificationAction}
            />
          </div>
        </div>
      </Show>

      {/* Banners never cover Control Centre, Search or Overview (UI-024): Control Centre takes
          them over, Search and Overview hide them until they close. */}
      <Show when={!ccOpen() && !search.open && !overviewOpen()}>
        <NotificationToasts
          notifications={toasts()}
          now={now()}
          focusMode={props.prefs.focusMode}
          onDismiss={(id) => setToasts((l) => l.filter((n) => n.id !== id))}
          onAction={onNotificationAction}
          onOpen={() => openCc(undefined, false)}
        />
      </Show>

      <OfflinePopover
        open={netOpen()}
        onClose={() => setNetOpen(false)}
        anchor={netAnchor()}
        net={tray()}
        focus={netFocus()}
        queued={env.outbox?.() ?? []}
        degraded={degradedRows()}
        retry={retry()}
        nextCheckS={nextCheckS()}
        onRetry={retryNetwork}
        onOpenTaskManager={() => {
          setNetOpen(false);
          launch(sysApp('taskmgr'));
        }}
        onRetryService={retryService}
        retryingServices={retrying()}
        retryErrors={retryErrors()}
      />

      <SearchPalette
        open={search.open}
        onClose={closeSearch}
        query={search.query}
        onQueryChange={runSearch}
        results={search.results}
        scope={env.search === undefined ? 'apps' : 'all'}
        preview={search.preview}
        onActiveChange={(r) => {
          const provider = env.search;
          if (r === undefined || r.kind === 'app') {
            setSearch('preview', undefined);
            return;
          }
          if (provider?.preview === undefined) {
            setSearch('preview', basicPreview(r));
            return;
          }
          void provider.preview(r).then(
            (p) => setSearch('preview', p ?? basicPreview(r)),
            () => setSearch('preview', basicPreview(r)),
          );
        }}
        onOpen={(r) => openResult(r, 'open')}
        onReveal={env.search?.open === undefined ? undefined : (r) => openResult(r, 'reveal')}
        {...(env.search?.askAgent === undefined
          ? {}
          : {
              onAskAgent: (prompt: string, about?: SearchResult) => {
                closeSearch();
                env.search?.askAgent?.(prompt, about);
              },
            })}
        aiMode={search.aiMode}
        onAiModeChange={(on) => setSearch('aiMode', on)}
        {...(search.semantic === undefined ? {} : { semantic: search.semantic })}
        {...(search.progress === undefined ? {} : { progress: search.progress })}
        loading={searchBusy()}
        {...(search.error === undefined ? {} : { error: search.error })}
        {...(search.notice === undefined ? {} : { notice: search.notice })}
        {...(search.stats === undefined ? {} : { stats: search.stats })}
      />

      <Overview
        open={overviewOpen()}
        windows={overviewList()}
        selectedId={overviewSel()}
        onSelect={setOverviewSel}
        onPick={(id) => closeOverview(Number(id))}
        onCancel={() => closeOverview(undefined)}
        onCloseWindow={(id) => {
          closeWindow(Number(id));
          setOverviewList((l) => l.filter((w) => w.id !== id));
        }}
        onLayout={(list) => setSlots(new Map(list.map((s) => [s.id, s.rect])))}
        onLaunch={(app) => {
          closeOverview(undefined);
          launch(app);
        }}
      />

      <AppSwitcher
        open={switcherShown()}
        items={switcherItems()}
        selectedId={(() => {
          const s = switcher();
          const w = s === null ? undefined : selectedWid(s);
          return w === undefined ? undefined : String(w);
        })()}
        onHighlight={(id) => {
          const s = switcher();
          if (s !== null) setSwitcher(highlightSwitcher(s, Number(id)));
        }}
        onCommit={(id) => commitSwitcher(Number(id))}
        onCancel={cancelSwitcher}
      />

      <Show when={props.prefs.frameMeter}>
        <FrameMeterHUD
          stats={frame()?.stats}
          samples={frame()?.samples ?? []}
          expanded={hudExpanded()}
          onToggleExpanded={() => setHudExpanded((x) => !x)}
          corner="top-right"
          shifted={ccOpen() || bannersShown()}
        />
      </Show>

      <Show when={lease()}>
        {(l) => (
          <div class={styles.banner}>
            <LockBanner
              holder={{ name: l().holder, uid: 0 }}
              file={`inode ${l().ino.slice(0, 8)}`}
              remainingS={
                l().expiresAt === null
                  ? 0
                  : Math.max(0, Math.ceil(((l().expiresAt ?? 0) - now()) / 1000))
              }
              ttlS={Math.round(status().leaseTtlMs / 1000)}
              lease={{ mode: 'X', fence: l().fence ?? 0 }}
              state={l().state}
              notifying={leaseNotify()}
              onNotify={() => setLeaseNotify((x) => !x)}
              onOpenForWriting={dismissLease}
            />
          </div>
        )}
      </Show>

      <RestartToUpdateDialog
        open={updateOpen()}
        current={{ version: env.identity.version, build: env.identity.build }}
        next={updateOffer()}
        notes={updateOffer().notes}
        {...(updateOffer().notes.length === 0
          ? { notesMessage: 'Release notes are available when online' }
          : {})}
        autoInstall={autoInstall()}
        onAutoInstallChange={setAutoInstall}
        autoInstallDisabled={session.kind === 'guest'}
        onLater={() => setUpdateOpen(false)}
        onRestart={restartForUpdate}
        restarting={restarting()}
      />

      <Dialog
        open={powerAsk() !== null}
        onClose={() => setPowerAsk(null)}
        role="alertdialog"
        size="sm"
        centered
        title={
          powerAsk() === 'shutdown'
            ? 'Shut down Plotinium?'
            : powerAsk() === 'logout'
              ? `Log out ${session.user}?`
              : 'Restart Plotinium?'
        }
        description={
          powerAsk() === 'restart'
            ? 'Your windows are saved and restored after the restart.'
            : 'Your windows are saved and restored at the next sign-in.'
        }
        actions={
          <>
            <Button data-autofocus onClick={() => setPowerAsk(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const ask = powerAsk();
                setPowerAsk(null);
                if (ask === 'shutdown') power('shutdown');
                else if (ask === 'logout') power('logout');
                else power(bootMenu() ? 'reboot-menu' : 'reboot');
              }}
            >
              {powerAsk() === 'shutdown'
                ? 'Shut Down'
                : powerAsk() === 'logout'
                  ? 'Log Out'
                  : 'Restart'}
            </Button>
          </>
        }
      >
        <Show when={powerAsk() === 'restart'}>
          <Checkbox
            checked={bootMenu()}
            onChange={setBootMenu}
            label="Show the boot menu"
            description="Choose Safe mode, Recovery or Verbose boot."
          />
        </Show>
      </Dialog>

      <Dialog
        open={guardAsk() !== null}
        onClose={() => setGuardAsk(null)}
        role="alertdialog"
        size="sm"
        title="Discard unsaved changes?"
        description={guardAsk()?.reason ?? ''}
        actions={
          <>
            <Button data-autofocus onClick={() => setGuardAsk(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const g = guardAsk();
                setGuardAsk(null);
                if (g !== null) {
                  closeGuards.delete(g.wid);
                  cmp.requestClose(g.wid);
                }
              }}
            >
              Discard and Close
            </Button>
          </>
        }
      />

      <HelpSheet
        open={helpView() !== undefined}
        onClose={() => setHelp(null)}
        title={helpView()?.title ?? ''}
        intro={helpView()?.intro}
        app={helpView()?.app}
        groups={helpView()?.groups ?? []}
        empty={helpView()?.empty}
        secondary={
          helpView()?.more === true
            ? { label: 'All Keyboard Shortcuts', onSelect: () => setHelp({ kind: 'shortcuts' }) }
            : undefined
        }
      />

      <AboutAppDialog
        open={aboutApp() !== null}
        onClose={() => setAboutApp(null)}
        app={appEntry(aboutApp() ?? '')?.icon ?? 'atom'}
        name={appEntry(aboutApp() ?? '')?.title ?? ''}
        version={env.identity.version}
        build={env.identity.build}
        detail="A system app of Plotinium, built with it."
      />
    </div>
  );
}
