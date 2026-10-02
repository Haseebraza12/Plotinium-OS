/**
 * The app descriptor: the one contract between an app (apps/<app>/index.ts), the desktop shell
 * (wm/src/shell: Dock, menu bar, window chrome, launcher) and the web host (web/src: who spawns
 * the app's process, opens its window and mounts its view).
 *
 * Implements: specs/05-wm/window-manager.md §3.1 (views receive only sys, display, pid, wid and
 * container), §4.2 (manifest fields the window manager reads), specs/05-wm/ui-implementation-guide.md
 * §3.6.2 (a view module exports `mount(ctx) => dispose`) and §4.8 (the view context).
 * Primary owner: R3 WM/UI. Requirement IDs: SYS-01 (apps reach the OS only through system calls).
 *
 * How the pieces fit (the order the host follows when the user opens an app):
 *
 *   0. web/ passes `createShellAppRegistry(APP_DESCRIPTORS, bindings)` (apps/src/registry.ts) as
 *      wm's `DesktopEnv.apps`; the kernel worker gets `PROGRAM_MANIFESTS` (its program catalog)
 *      and every executor gets `PROGRAM_MODULES` (`startExecutor({ loaders })`).
 *   1. wm/src/shell lists the entries in the Dock (`dock`), the launcher and Search (`keywords`),
 *      and draws `title`, `icon` and `menus` in the menu bar while one of the app's windows is
 *      focused.
 *   2. On launch the kernel spawns `/bin/<id>.json`, whose `manifest.entry` is a key of
 *      `PROGRAM_MODULES`; the process creates its window (`windowOwnerProgram`) and the kernel
 *      binds a view port to (pid, wid).
 *   3. The shell calls the entry's `mountView`, which awaits `descriptor.load()` (a lazy chunk)
 *      and calls `mount(ctx)` with the window's content element and a full `AppViewContext`.
 *      `mount` returns the disposer the shell calls when the window closes, the process exits or
 *      the view is dehydrated for page-out.
 *
 * A descriptor module (apps/<app>/index.ts) MUST stay light: it may import types, @plotinium/protocol
 * and small constants only. Views, CodeMirror, xterm and programs are imported lazily from
 * `load()` and from the `PROGRAM_MODULES` loaders, so the Dock and the executor bundles never pull
 * in an app's view code.
 */
import type {
  AppManifestInput,
  ArgsIn,
  CallName,
  KEvent,
  RetOf,
  SignalName,
  UnameInfo,
} from '@plotinium/protocol';
import type { Program, ProgramContext, SysGen } from '@plotinium/kernel/sys';
import type { IconId, MenuEntry } from '@plotinium/ui';

// ---------------------------------------------------------------------------------------------
// Identity of the built-in apps
// ---------------------------------------------------------------------------------------------

/** The built-in GUI apps, in their default Dock order. */
export const BUILTIN_APP_IDS = [
  'files',
  'terminal',
  'editor',
  'taskmgr',
  'settings',
  'about',
] as const;

export type BuiltinAppId = (typeof BUILTIN_APP_IDS)[number];

export function isBuiltinAppId(id: string): id is BuiltinAppId {
  return (BUILTIN_APP_IDS as readonly string[]).includes(id);
}

// ---------------------------------------------------------------------------------------------
// System calls from a view
// ---------------------------------------------------------------------------------------------

/**
 * The promise system-call client a view receives. `createViewSys(port)` from
 * `@plotinium/kernel/sys` satisfies it structurally.
 *
 * Routing is the host's job, not the app's: calls whose registry origin includes V go over the
 * window's view port; calls that only an executor may make (origin E: `kill`, `setpriority`,
 * `sysctl.set`, `open`/`read`/`writeFile`, …) are performed by the app's own process on the
 * view's behalf (the display channel of window-manager.md §3.13), so the kernel still sees the
 * app's pid and credentials. A call the host cannot route rejects with a `SysError`-shaped value
 * (`{errno: 'ENOSYS' | 'EPERM', message}`); apps show that state instead of failing.
 */
export interface AppSys {
  call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>>;
}

/** Kernel events pushed to a view (at most one batch per animation frame, ABI-07). */
export type EventBatchListener = (batch: readonly KEvent[]) => void;

// ---------------------------------------------------------------------------------------------
// Desktop preferences (the "prefs" a view may read and change)
// ---------------------------------------------------------------------------------------------

export type ThemePref = 'system' | 'light' | 'dark';
/** `system` follows the OS media query; `always` forces the reduced variant on. */
export type FollowPref = 'system' | 'always';
export type AccentPref =
  'violet' | 'blue' | 'purple' | 'pink' | 'red' | 'orange' | 'yellow' | 'green' | 'graphite';

/**
 * User preferences that live on the desktop side (wm/src/shell `prefs.ts`): it applies them at
 * once (`data-theme`, `data-motion`, `data-transparency`, the accent, the Dock) and persists them
 * in the user's settings file. Kernel parameters are NOT here: they are `sysctl` keys.
 */
export interface DesktopPrefs {
  'general.deviceName': string;
  'general.language': 'en-GB' | 'en-US' | 'ur-PK';
  'general.clock24h': boolean;
  'appearance.theme': ThemePref;
  'appearance.accent': AccentPref;
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
  'sync.files': boolean;
  'sync.swapWriteBehind': boolean;
  'agent.requireConfirm': boolean;
  /**
   * The user's telemetry-sync consent as last confirmed by `ai.telemetry.optin` (PRE-05: off by
   * default; Settings changes it only after the kernel accepted the new value).
   */
  'telemetry.sync': boolean;
  'updates.auto': boolean;
  'updates.channel': 'stable' | 'beta';
}

export type DesktopPrefKey = keyof DesktopPrefs;

/** Defaults for a fresh profile (ui-design-system.md §3.8.14). Hosts start from these. */
export const DEFAULT_PREFS: Readonly<DesktopPrefs> = Object.freeze({
  'general.deviceName': 'Plotinium',
  'general.language': 'en-GB',
  'general.clock24h': true,
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
  'sync.files': true,
  'sync.swapWriteBehind': true,
  'agent.requireConfirm': true,
  'telemetry.sync': false,
  'updates.auto': true,
  'updates.channel': 'stable',
});

export function isDesktopPrefKey(key: string): key is DesktopPrefKey {
  return Object.hasOwn(DEFAULT_PREFS, key);
}

/** The element whose dataset carries the appearance switches (`document.documentElement`). */
export interface AppearanceRoot {
  readonly dataset: Record<string, string | undefined>;
}

/**
 * Applies the appearance preferences the way ui/src/tokens reads them (visual-language-macos.md
 * §3.7.2; DSN-05): `data-theme` (absent = follow the OS), `data-motion="reduce"` and
 * `data-transparency="reduce"` for the "always" overrides (the OS media queries apply either way),
 * and `data-accent` for the accent. A host passes this as the `apply` of `createMemoryPrefs`, so
 * Settings changes the theme and reduced motion through the prefs callbacks.
 */
export function applyAppearance(root: AppearanceRoot, prefs: Readonly<DesktopPrefs>): void {
  const ds = root.dataset;
  const theme = prefs['appearance.theme'];
  if (theme === 'system') delete ds['theme'];
  else ds['theme'] = theme;
  if (prefs['appearance.reduceMotion'] === 'always') ds['motion'] = 'reduce';
  else delete ds['motion'];
  if (prefs['appearance.reduceTransparency'] === 'always') ds['transparency'] = 'reduce';
  else delete ds['transparency'];
  ds['accent'] = prefs['appearance.accent'];
}

/**
 * The subset of the desktop shell's own preferences (wm/src/shell `Prefs`) that Settings also
 * edits. wm and apps may not import each other, so the host bridges the two stores with these.
 * The optional fields are the Settings keys the shell applies itself (UI-040): the menu-bar
 * clock, the Dock and the window preferences of contract C3.
 */
export interface ShellPrefsLike {
  readonly theme: ThemePref;
  readonly reducedMotion: boolean;
  readonly dockMagnification: boolean;
  readonly clock24h?: boolean;
  readonly dockSize?: number;
  readonly dockMagnifiedScale?: number;
  readonly dockAutoHide?: boolean;
  readonly dockIndicators?: boolean;
  readonly titleDoubleClick?: 'zoom' | 'minimise';
  readonly minimiseEffect?: 'genie' | 'scale';
}

export function toShellPrefs(p: Readonly<DesktopPrefs>): ShellPrefsLike {
  return {
    theme: p['appearance.theme'],
    reducedMotion: p['appearance.reduceMotion'] === 'always',
    dockMagnification: p['dock.magnification'],
    clock24h: p['general.clock24h'],
    dockSize: p['dock.size'],
    dockMagnifiedScale: p['dock.magnificationScale'],
    dockAutoHide: p['dock.autohide'],
    dockIndicators: p['dock.showIndicators'],
    titleDoubleClick: p['windows.doubleClickTitle'],
    minimiseEffect: p['dock.minimiseEffect'],
  };
}

/** The desktop preferences that differ from `current` after the shell changed its own. */
export function fromShellPrefs(
  shell: ShellPrefsLike,
  current: Readonly<DesktopPrefs>,
): Partial<DesktopPrefs> {
  const out: Partial<DesktopPrefs> = {};
  if (shell.theme !== current['appearance.theme']) out['appearance.theme'] = shell.theme;
  const motion: FollowPref = shell.reducedMotion ? 'always' : 'system';
  if (motion !== current['appearance.reduceMotion']) out['appearance.reduceMotion'] = motion;
  if (shell.dockMagnification !== current['dock.magnification'])
    out['dock.magnification'] = shell.dockMagnification;
  if (shell.clock24h !== undefined && shell.clock24h !== current['general.clock24h'])
    out['general.clock24h'] = shell.clock24h;
  if (shell.dockSize !== undefined && shell.dockSize !== current['dock.size'])
    out['dock.size'] = shell.dockSize;
  if (
    shell.dockMagnifiedScale !== undefined &&
    shell.dockMagnifiedScale !== current['dock.magnificationScale']
  )
    out['dock.magnificationScale'] = shell.dockMagnifiedScale;
  if (shell.dockAutoHide !== undefined && shell.dockAutoHide !== current['dock.autohide'])
    out['dock.autohide'] = shell.dockAutoHide;
  if (shell.dockIndicators !== undefined && shell.dockIndicators !== current['dock.showIndicators'])
    out['dock.showIndicators'] = shell.dockIndicators;
  if (
    shell.titleDoubleClick !== undefined &&
    shell.titleDoubleClick !== current['windows.doubleClickTitle']
  )
    out['windows.doubleClickTitle'] = shell.titleDoubleClick;
  if (shell.minimiseEffect !== undefined && shell.minimiseEffect !== current['dock.minimiseEffect'])
    out['dock.minimiseEffect'] = shell.minimiseEffect;
  return out;
}

/** The desktop's preference store as a view sees it. */
export interface AppPrefs {
  get(): Readonly<DesktopPrefs>;
  /** Applies at once and persists; rejects (for example EACCES for a guest) without applying. */
  set<K extends DesktopPrefKey>(key: K, value: DesktopPrefs[K]): Promise<void>;
  /** Called after every change, whoever made it (Settings, Control Centre). */
  subscribe(fn: (prefs: Readonly<DesktopPrefs>) => void): () => void;
}

/**
 * A small in-memory `AppPrefs` for hosts, tests and the gallery. `apply` runs after each change
 * (the host sets `data-theme` and friends there and persists the values).
 */
export function createMemoryPrefs(
  initial: Partial<DesktopPrefs> = {},
  apply?: (prefs: Readonly<DesktopPrefs>, key: DesktopPrefKey) => void | Promise<void>,
): AppPrefs {
  let current: Readonly<DesktopPrefs> = Object.freeze({ ...DEFAULT_PREFS, ...initial });
  const listeners = new Set<(prefs: Readonly<DesktopPrefs>) => void>();
  return {
    get: () => current,
    async set<K extends DesktopPrefKey>(key: K, value: DesktopPrefs[K]): Promise<void> {
      const draft: DesktopPrefs = { ...current };
      draft[key] = value;
      const next = Object.freeze(draft);
      // A refused change (apply rejects) is not kept: the store still holds the old value.
      await apply?.(next, key);
      current = next;
      for (const fn of listeners) fn(current);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Build and team identity
// ---------------------------------------------------------------------------------------------

/** identity-and-branding.md §4.1 `BuildIdentity` (the web build injects it as __PLT_IDENTITY__). */
export interface AppBuildIdentity {
  readonly name: 'Plotinium';
  readonly version: string;
  readonly build: string;
  readonly buildDate: string;
  readonly codename: string | null;
  readonly abi: number;
}

export type RoleCode = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

/** identity-and-branding.md §4.1 `TeamIdentity` (docs/identity/identity.json). */
export interface TeamIdentity {
  readonly name?: string;
  readonly tagline: string;
  readonly section: string;
  readonly teamCode: string;
  readonly members: readonly { readonly name: string; readonly role: RoleCode }[];
}

const ROLE_CODES: readonly string[] = ['R1', 'R2', 'R3', 'R4', 'R5'];

function isRoleCode(x: unknown): x is RoleCode {
  return typeof x === 'string' && ROLE_CODES.includes(x);
}

/**
 * docs/identity/identity.json as a `TeamIdentity`, or undefined when it does not have that shape.
 * The host imports the JSON and passes the result as `AppEnv.team`; members with an unknown role
 * are dropped, and placeholder names (`<R1 name>`) are kept for About to show as "to be announced".
 */
export function parseTeamIdentity(json: unknown): TeamIdentity | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const r = json as Record<string, unknown>;
  const { tagline, section, teamCode, members, name } = r;
  if (typeof tagline !== 'string' || typeof section !== 'string' || typeof teamCode !== 'string')
    return undefined;
  if (!Array.isArray(members)) return undefined;
  const list: { name: string; role: RoleCode }[] = [];
  for (const m of members as unknown[]) {
    if (typeof m !== 'object' || m === null) continue;
    const { name: memberName, role } = m as Record<string, unknown>;
    if (typeof memberName === 'string' && isRoleCode(role)) list.push({ name: memberName, role });
  }
  const team: TeamIdentity = { tagline, section, teamCode, members: list };
  return typeof name === 'string' ? { ...team, name } : team;
}

// ---------------------------------------------------------------------------------------------
// What the host gives a view
// ---------------------------------------------------------------------------------------------

/** Desktop-side facts and services a view may use. Everything is optional-safe for tests. */
export interface AppEnv {
  /** The build identity (one source for every surface, identity-and-branding.md I-1). */
  readonly identity: AppBuildIdentity;
  /** docs/identity/identity.json, when the host bundles it; About falls back to placeholders. */
  readonly team?: TeamIdentity;
  /** Desktop preferences: theme, reduced motion, transparency, accent, Dock, … */
  readonly prefs: AppPrefs;
  /** Whether this build has the AI subsystems (C12: the AI-off build hides AI surfaces). */
  readonly aiAvailable: boolean;
  /** The logged-in user, when the host knows it before the first `proc.cred`. */
  readonly user?: { readonly name: string; readonly uid: number; readonly guest: boolean };
  /** Main-thread frame statistics from wm/src/frame-meter, when it runs. */
  readonly frames?: () => AppFrameStats | null;
  /**
   * The AI agent's spending for this user (agentic-shell.md §3.8: the gateway's budget), when the
   * host can read it (for example from `GET /api/llm/health`). There is no system call for it.
   */
  readonly agentBudget?: () => Promise<AppAgentBudget | null>;
  /**
   * One-shot next-boot requests the boot router reads before any kernel runs
   * (web/src/boot/next-boot.ts `writeNextBoot`; BOOT-06). Settings calls it after the kernel
   * accepted `boot.showMenuNextBoot`, because the router cannot ask the kernel at that point and
   * apps have no storage of their own (SYS-01).
   */
  readonly nextBoot?: (flags: { readonly menuNextBoot: boolean }) => void;
}

export interface AppAgentBudget {
  readonly usedCents: number;
  readonly capCents: number;
  /** "1 Oct", when the cap resets. */
  readonly resetsOn: string;
  readonly provider?: string;
}

export interface AppFrameStats {
  readonly p95Ms: number;
  /** Frame-time histogram bucket counts (0–4 ms, 4–8 ms, …). */
  readonly histogram: readonly number[];
  readonly longFrames: number;
}

/**
 * Launch arguments. `argv` is app-defined: Files and Editor take a path, Settings a section id
 * (`['memory']`), Task Manager a tab id (`['memory']`).
 */
export interface AppLaunch {
  readonly argv?: readonly string[];
}

/** Window chrome actions a view may ask for; the compositor stays the only writer of geometry. */
export interface AppWindowControl {
  setTitle(title: string): void;
  /** The view's own close action: the same path as the close button (SIGTERM to the process). */
  close(): void;
}

/** The context `mount` receives. */
export interface AppViewContext {
  readonly app: string;
  readonly wid: number;
  /** The app's process, or null when the host mounted the view without one (gallery, tests). */
  readonly pid: number | null;
  readonly argv: readonly string[];
  /** The window's content element (WindowFrame's content slot). */
  readonly container: HTMLElement;
  readonly sys: AppSys;
  readonly env: AppEnv;
  readonly window: AppWindowControl;
  /** Open (or focus) another app. */
  launch(app: string, opts?: AppLaunch): void;
  /**
   * Subscribe to kernel events (`sys.subscribe` topics such as `proc.*`, `mem.pressure`). The
   * host owns the subscription and delivers batches; the returned function unsubscribes.
   */
  subscribe(topics: readonly string[], fn: EventBatchListener): () => void;
  /** Menu-bar commands of this app (`AppMenu` item ids) while this window is focused. */
  onMenuCommand(fn: (itemId: string) => void): () => void;
  /** An uncaught error in the view: the window shows "<App> stopped" (WMD-23). */
  reportCrash(err: unknown): void;
  /** The applied theme, for views that theme themselves in JS (xterm, CodeMirror). */
  readonly theme?: () => 'light' | 'dark';
  /**
   * Terminal views on the kernel TTY path: `tty.output` batches for this window (shell-and-
   * terminal.md §3.2). Absent when the host delivers none.
   */
  readonly onTtyOutput?: (fn: (data: ArrayBuffer) => void) => () => void;
}

/** A view module's `mount`: renders into `ctx.container` and returns the disposer. */
export type AppMount = (ctx: AppViewContext) => () => void;

// ---------------------------------------------------------------------------------------------
// Programs (executor side)
// ---------------------------------------------------------------------------------------------

/**
 * A program module as the executor sees it (processes-and-scheduling.md §3.5.1). Structural and
 * deliberately loose: `@plotinium/kernel/sys` `Program<St>` and the shell's stand-in in
 * apps/src/_sys.ts both fit; the executor checks `init` and `run` at load time.
 */
export interface RunnableProgram {
  readonly checkpointable?: boolean;
  init(argv: readonly string[]): unknown;
  run(ctx: never, st: never): Iterator<unknown, unknown, unknown>;
  signal?(ctx: never, st: never, sig: SignalName): void;
}

/** Lazy loader of one program (its own chunk where the bundler can split it). */
export type ProgramLoader = () => Promise<RunnableProgram>;

/** State of a window-owning app process (serialisable: it is checkpointed and paged). */
export interface WindowOwnerState {
  readonly app: string;
  /** The window this process owns, once known. */
  wid: number | null;
  /** Why no window could be created, when the kernel refused (`ENOSYS` before WM wiring). */
  windowError: string | null;
  wakes: number;
}

/** Environment variable a host sets when it created the window itself and bound it to the pid. */
export const WINDOW_ENV = 'PLT_WINDOW';

/** How long a window owner sleeps between wake-ups; it holds no timers of its own. */
export const WINDOW_OWNER_SLEEP_MS = 60_000;

/**
 * The process of an app whose logic lives in its view (Task Manager, Settings, About): it owns
 * the window and its lifetime (window-manager.md §3.12: closing the window sends SIGTERM, whose
 * default action ends this process; killing the process closes the window) and makes the
 * executor-only calls the host relays for the view.
 *
 * It creates its window with `window.create` unless the host already did (`PLT_WINDOW=<wid>` in
 * the environment). A kernel without window syscalls answers ENOSYS; the process then stays alive
 * without a window so the host can still bind the view to its pid.
 */
export function windowOwnerProgram(spec: {
  readonly app: string;
  readonly title: string;
  readonly icon: string;
  readonly width: number;
  readonly height: number;
}): Program<WindowOwnerState> {
  return {
    checkpointable: true,
    init: () => ({ app: spec.app, wid: null, windowError: null, wakes: 0 }),
    *run(ctx: ProgramContext, st: WindowOwnerState): SysGen<number> {
      if (st.wid === null && st.windowError === null) {
        const given = Number.parseInt(ctx.env.get(WINDOW_ENV) ?? '', 10);
        if (Number.isInteger(given) && given > 0) {
          st.wid = given;
        } else {
          try {
            const win = yield* ctx.sys['window.create']({
              title: spec.title,
              icon: spec.icon,
              minSize: { w: Math.min(spec.width, 320), h: Math.min(spec.height, 240) },
              restoreKey: spec.app,
            });
            st.wid = win.wid;
          } catch (e) {
            st.windowError = describeFailure(e);
          }
        }
      }
      for (;;) {
        try {
          yield* ctx.sys.sleep({ ms: WINDOW_OWNER_SLEEP_MS });
        } catch (e) {
          // A caught signal cancels the blocking sleep with ECANCELED (processes-and-scheduling.md
          // §3.5.1 rule 6); anything else ends the process.
          if (errnoOfReason(e) !== 'ECANCELED') throw e;
        }
        st.wakes++;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The descriptor
// ---------------------------------------------------------------------------------------------

export interface AppWindowSpec {
  /** Initial content size in CSS pixels; the compositor centres and cascades. */
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  /** false: fixed size (Settings, About); the resize handles are not drawn. */
  readonly resizable: boolean;
  /** false: the green button is disabled (Settings, About). */
  readonly maximizable: boolean;
  /**
   * `titlebar`: WindowFrame draws the centred title. `unified`: the app draws its own toolbar
   * under the traffic lights (Task Manager, Settings) and marks it `data-pl-drag-region`.
   */
  readonly chrome: 'titlebar' | 'unified';
  /** A second launch focuses the existing window instead of opening another. */
  readonly singleInstance: boolean;
}

/** One menu-bar menu of the app (the ids 'system' and 'app' are reserved by the shell). */
export interface AppMenu {
  readonly id: string;
  readonly label: string;
  readonly items: readonly MenuEntry[];
}

export interface AppDescriptor {
  /** Equals `manifest.name` and the `/bin/<id>.json` file name. */
  readonly id: string;
  /** Display name: menu bar, Dock tooltip, default window title ("Task Manager"). */
  readonly title: string;
  /** Design-system app icon (`@plotinium/ui` ICON_DEFS). */
  readonly icon: IconId;
  /** Kept in the Dock when not running (default true); the order follows BUILTIN_APP_IDS. */
  readonly dock?: boolean;
  /** Extra words for Search and the launcher ("processes", "kill", "memory"). */
  readonly keywords?: readonly string[];
  readonly window: AppWindowSpec;
  /** App menus shown after the bold app-name menu while the app is focused. */
  readonly menus?: readonly AppMenu[];
  /** `/bin/<id>.json`: `entry` names the process module in PROGRAM_MODULES. */
  readonly manifest: AppManifestInput;
  /**
   * The executor-only calls this app's view has its process make, over the display channel.
   * Default: every origin-`E` call is sent; the process's own allow-list (`appProcess({relay})`)
   * is the security boundary and refuses the rest with EPERM.
   */
  readonly relay?: readonly CallName[];
  /** Loads the view chunk. */
  load(): Promise<AppMount>;
  /**
   * Loads the app's process (apps/<app>/proc.ts), registered in PROGRAM_MODULES under
   * `manifest.entry`. Absent for an app whose window is owned by another program.
   */
  readonly program?: ProgramLoader;
}

// ---------------------------------------------------------------------------------------------
// The desktop shell's side (wm/src/shell), mirrored structurally
// ---------------------------------------------------------------------------------------------

/** A MessagePort, or anything with the same two members (tests, a host adapter). */
export interface DisplayPortLike {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/**
 * What wm/src/shell `views.ts` hands a view (`ViewContext`), as far as apps use it. apps may not
 * import wm (tools/eslint-rules/boundaries.js), so this is a structural mirror: wm's
 * `ViewContext` is assignable to it, which web's composition checks at compile time.
 */
export interface ShellViewContextLike {
  readonly pid: number;
  readonly wid: number;
  readonly app: string;
  readonly argv: readonly string[];
  readonly container: HTMLElement;
  /** The view port bound to (pid, wid): only view-origin calls succeed on it. */
  readonly sys: {
    call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>>;
    readonly closed: boolean;
  };
  /**
   * The display channel to the app's process (window-manager.md §3.13), or null. Read at each
   * use: the kernel replaces it after a page-in (`attach`).
   */
  readonly display: DisplayPortLike | null;
  onViewEvent(topic: 'kernel.events', cb: (batch: readonly KEvent[]) => void): () => void;
  onViewEvent(topic: 'tty.output', cb: (data: ArrayBuffer) => void): () => void;
  onMenuCommand(cb: (menuId: string, itemId: string) => void): () => void;
  reportCrash(err: unknown): void;
  theme(): 'light' | 'dark';
  requestClose(): void;
  /**
   * The shell's own title, launch and event paths (wm `ViewContext`). Optional in the mirror so
   * tests and older shells still fit; when present the adapter uses them before the host
   * bindings, so a title reaches the menu bar, the switcher and the saved layout.
   */
  setTitle?(title: string): void;
  launch?(app: string, argv?: readonly string[]): void;
  subscribe?(topics: readonly string[], fn: (batch: readonly KEvent[]) => void): () => void;
  /** The signed-in session as the shell knows it (wm `Session`). */
  readonly session?: {
    readonly uid: number;
    readonly user: string;
    readonly kind: 'user' | 'guest' | 'demo';
  };
}

/** wm/src/shell `AppEntry`, mirrored structurally (see `ShellViewContextLike`). */
export interface ShellAppEntry {
  readonly id: string;
  readonly title: string;
  readonly icon: IconId;
  readonly pinned?: boolean;
  readonly launchable?: boolean;
  readonly singleton?: boolean;
  readonly menus?: readonly AppMenu[];
  /** Not read by the shell today; kept for hosts that size new windows from it. */
  readonly window: AppWindowSpec;
  mountView(container: HTMLElement, ctx: ShellViewContextLike): (() => void) | Promise<() => void>;
}

/** wm/src/shell `AppRegistry`, mirrored structurally. */
export interface ShellAppRegistry {
  list(): readonly ShellAppEntry[];
  get(id: string): ShellAppEntry | undefined;
}

/** The window a relayed call is made for. */
export interface AppWindowRef {
  readonly pid: number;
  readonly wid: number;
  readonly app: string;
}

/**
 * What the host (web/) gives `createShellAppRegistry` so every app view gets a full
 * `AppViewContext`.
 */
export interface AppHostBindings {
  /** Desktop facts and services, read at each mount (so a new session's user is seen). */
  env(): AppEnv;
  /**
   * Open or focus an app: the shell's launch path (wm `KernelEnv.launch`). Used only when the
   * shell's context has no `launch` of its own.
   */
  launch?(app: string, argv: readonly string[]): void;
  /**
   * Performs an executor-only call (registry origin `E`: `kill`, `setpriority`, `sysctl.set`,
   * `writeFile`, `svc.restart`, `reboot`, `sync.flush`, …) as the window's own process. Optional:
   * without it such calls go to the process over the window's display channel
   * (window-manager.md §3.13; the wire format of apps/files/lib/relay.ts, served by the app's
   * `appProcess`), and with neither they reject with ENOSYS, which the apps show.
   */
  execCall?<C extends CallName>(win: AppWindowRef, name: C, args: ArgsIn<C>): Promise<RetOf<C>>;
  /**
   * Changes a window title (`window.setTitle` is not a view-port call). Used only when the
   * shell's context has no `setTitle` of its own.
   */
  setTitle?(wid: number, title: string): void;
}

/** A fixed-size utility window (About, small dialogs). */
export const FIXED_WINDOW: AppWindowSpec = Object.freeze({
  width: 520,
  height: 400,
  minWidth: 520,
  minHeight: 400,
  resizable: false,
  maximizable: false,
  chrome: 'titlebar',
  singleInstance: true,
});

// ---------------------------------------------------------------------------------------------
// Helpers shared by views
// ---------------------------------------------------------------------------------------------

/** The errno of a rejected call (`SysError` or any `{errno}` value), else undefined. */
export function errnoOfReason(reason: unknown): string | undefined {
  if (typeof reason !== 'object' || reason === null || !('errno' in reason)) return undefined;
  const errno: unknown = reason.errno;
  return typeof errno === 'string' ? errno : undefined;
}

/** "Function not implemented (ENOSYS)" for a rejected call; the message for anything else. */
export function describeFailure(reason: unknown): string {
  const errno = errnoOfReason(reason);
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'object' &&
          reason !== null &&
          'message' in reason &&
          typeof reason.message === 'string'
        ? reason.message
        : String(reason);
  if (errno === undefined) return message;
  return message === '' || message === errno ? errno : `${message} (${errno})`;
}

/** The `uname` facts a view formats (identity-and-branding.md §4.3). */
export type AppUname = UnameInfo;

/** A settled system call: the value, or the errno and text of the failure. */
export type SysResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errno: string | undefined; readonly message: string };

/** Makes one call and never rejects: views render the failure instead of crashing. */
export async function trySys<C extends CallName>(
  sys: AppSys,
  name: C,
  args: ArgsIn<C>,
): Promise<SysResult<RetOf<C>>> {
  try {
    return { ok: true, value: await sys.call(name, args) };
  } catch (e) {
    return { ok: false, errno: errnoOfReason(e), message: describeFailure(e) };
  }
}
