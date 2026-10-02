/**
 * @plotinium/apps: the built-in applications and programs (terminal, shell, coreutils, files,
 * editor, task manager, settings, about, demo programs).
 *
 * Implements: specs/07-shell/shell-and-terminal.md, specs/05-wm/window-manager.md §3.1 and §3.13,
 * specs/03-kernel/processes-and-scheduling.md §3.6 (program registry).
 * Primary owner: R3 WM/UI (views, shell); R2 and R1 (coreutils, demo programs).
 *
 * The public surface is the app contract (./descriptor.ts) and the registry (./registry.ts):
 *
 *   import { APP_DESCRIPTORS, createShellAppRegistry, PROGRAM_MANIFESTS, PROGRAM_MODULES }
 *     from '@plotinium/apps';
 *
 *   main thread    env.apps = createShellAppRegistry(APP_DESCRIPTORS, { env, launch?, execCall? })
 *   kernel worker  startKernelWorker({ programs: PROGRAM_MANIFESTS, … })
 *   executor       startExecutor({ loaders: PROGRAM_MODULES })
 *
 * The host's `env()` (read at each mount) is an `AppEnv`:
 *
 *   const prefs = createMemoryPrefs(saved, (p) => { applyAppearance(document.documentElement, p);
 *                                                   persist(p); });
 *   env: () => ({ identity, team: parseTeamIdentity(identityJson), prefs, aiAvailable,
 *                 user?, frames?, agentBudget?, nextBoot: (f) => writeNextBoot(localStore(window), f) })
 *
 * `toShellPrefs` / `fromShellPrefs` keep wm's own `Prefs` (theme, reduced motion, magnification)
 * and these desktop preferences in step, since apps and wm may not import each other. Without
 * `execCall`, executor-only calls (`kill`, `setpriority`, `sysctl.set`, …) go to the app's own
 * process over the window's display channel; the shell context's `setTitle`, `launch` and
 * `subscribe` are used before the host bindings of the same name.
 *
 * Apps import only @plotinium/protocol, @plotinium/kernel/sys and @plotinium/ui (SYS-01,
 * ESLint-enforced); views and programs load lazily, so this entry stays light.
 */
export const PACKAGE_NAME = '@plotinium/apps';

export {
  applyAppearance,
  BUILTIN_APP_IDS,
  createMemoryPrefs,
  DEFAULT_PREFS,
  describeFailure,
  errnoOfReason,
  FIXED_WINDOW,
  fromShellPrefs,
  isBuiltinAppId,
  isDesktopPrefKey,
  parseTeamIdentity,
  toShellPrefs,
  trySys,
  WINDOW_ENV,
  WINDOW_OWNER_SLEEP_MS,
  windowOwnerProgram,
} from './descriptor.ts';
export type {
  AccentPref,
  AppAgentBudget,
  AppBuildIdentity,
  AppDescriptor,
  AppearanceRoot,
  AppEnv,
  AppFrameStats,
  AppHostBindings,
  AppLaunch,
  AppMenu,
  AppMount,
  AppPrefs,
  AppSys,
  AppUname,
  AppViewContext,
  AppWindowControl,
  AppWindowRef,
  AppWindowSpec,
  BuiltinAppId,
  DisplayPortLike,
  DesktopPrefKey,
  DesktopPrefs,
  EventBatchListener,
  FollowPref,
  ProgramLoader,
  RoleCode,
  RunnableProgram,
  ShellAppEntry,
  ShellAppRegistry,
  ShellPrefsLike,
  ShellViewContextLike,
  SysResult,
  TeamIdentity,
  ThemePref,
  WindowOwnerState,
} from './descriptor.ts';
export {
  AI_COMMANDS,
  APP_DESCRIPTORS,
  AppCallError,
  appDescriptor,
  COMMAND_NAMES,
  createShellAppRegistry,
  envFor,
  EXECUTOR_CALLS,
  mountDescriptor,
  PROGRAM_MANIFESTS,
  PROGRAM_MODULES,
  programManifests,
  programModules,
  routedSys,
  SHELL_ENTRY,
  TERMINAL_EXTRAS,
  toAppViewContext,
  topicMatches,
  toShellAppEntry,
  USER_CAPS,
  type ProgramRegistryOptions,
  type RoutedSys,
} from './registry.ts';
