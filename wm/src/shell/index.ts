/**
 * @plotinium/wm/shell: the Solid desktop shell (window-manager.md §3.1; README.md in this
 * folder). The host calls `mountDesktop(root, env)` with a `DesktopEnv`; everything else here is
 * exported for the host's wiring and for tests.
 */
export { LOCAL_SESSION, mountDesktop, type DesktopHandle } from './mount.tsx';
export type {
  AppEntry,
  AppRegistry,
  AppWindowHints,
  AuthEnv,
  BuildIdentity,
  DesktopEnv,
  KernelEnv,
  LaunchOptions,
  LayoutWindow,
  LoginResult,
  PortLike,
  PowerAction,
  Prefs,
  PrefsEnv,
  SearchEnv,
  SearchResponse,
  Session,
  SessionEnv,
  SessionLayout,
  ThemePref,
  UpdateOffer,
  ViewContext,
  ViewEventData,
  ViewMount,
  ViewSysClient,
  ViewSysHandlers,
  WindowBinding,
} from './env.ts';
export type { ShellToKernel } from './kernel-link.ts';
export { createWindowAnimator, readMotionTokens, type WindowAnimator } from './motion.ts';
export { DEFAULT_BINDINGS, matchKey, shortcutOf, type ShellAction } from './keys.ts';
export { DEFAULT_PREFS } from './prefs.ts';
export { filterBatch, topicMatches } from './views.ts';
export type { DesktopApi } from './Desktop.tsx';
