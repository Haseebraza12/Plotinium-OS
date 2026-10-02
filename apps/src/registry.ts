/**
 * The apps registry: every built-in app's descriptor, the program registry the kernel and the
 * executors are given, and the adapter that turns descriptors into the desktop shell's app
 * entries. web/ is the only consumer; it composes the OS (tools/eslint-rules/boundaries.js):
 *
 *   - main thread: `createShellAppRegistry(APP_DESCRIPTORS, bindings)` → wm `DesktopEnv.apps`;
 *   - kernel worker: `new StaticProgramCatalog(PROGRAM_MANIFESTS)` → `createKernel({ programs })`;
 *   - executor bundle: `startExecutor({ loaders: PROGRAM_MODULES })`.
 *
 * Implements: processes-and-scheduling.md §3.6 and §4.4 (program registry, `/bin/<name>.json`
 * manifests), window-manager.md §3.1 and §3.13 (views, view ports, the display relay),
 * ui-implementation-guide.md §3.6.2 and §4.8 (view modules and their context).
 * Requirement IDs: SYS-01 (apps reach the OS only through system calls).
 *
 * Program modules are imported lazily (one chunk per group), so neither the main thread nor the
 * kernel worker evaluates program code; only an executor does, after its realm is sandboxed.
 */
import type { AppManifestInput, ArgsIn, Cap, CallName, KEvent, RetOf } from '@plotinium/protocol';
import { CALL_NAMES, lookupCall } from '@plotinium/protocol';

import { descriptor as about } from '../about/index.ts';
import type { CommandName } from '../coreutils/lib/command.ts';
import { DEMO_MANIFESTS } from '../demo/index.ts';
import { descriptor as editor } from '../editor/index.ts';
import { descriptor as files } from '../files/index.ts';
import { createRelaySys, type RelaySysClient } from '../files/lib/relay.ts';
import { descriptor as settings } from '../settings/index.ts';
import { descriptor as taskmgr } from '../taskmgr/index.ts';
import { descriptor as terminal } from '../terminal/index.ts';
import type {
  AppDescriptor,
  AppEnv,
  AppHostBindings,
  AppSys,
  AppViewContext,
  AppWindowRef,
  DisplayPortLike,
  ProgramLoader,
  RunnableProgram,
  ShellAppEntry,
  ShellAppRegistry,
  ShellViewContextLike,
} from './descriptor.ts';

// ---------------------------------------------------------------------------------------------
// App descriptors
// ---------------------------------------------------------------------------------------------

/** The built-in GUI apps in Dock order (BUILTIN_APP_IDS). */
export const APP_DESCRIPTORS: readonly AppDescriptor[] = Object.freeze([
  files,
  terminal,
  editor,
  taskmgr,
  settings,
  about,
]);

/** The descriptor of an app id, or undefined. */
export function appDescriptor(id: string): AppDescriptor | undefined {
  return APP_DESCRIPTORS.find((d) => d.id === id);
}

// ---------------------------------------------------------------------------------------------
// Program registry
// ---------------------------------------------------------------------------------------------

/**
 * Capabilities of an ordinary user program (syscall-abi.md §4.5 "Typical manifest caps": `sh`,
 * coreutils, Terminal, Files, Editor, Task Manager, `burn`, `memhog`).
 */
export const USER_CAPS: readonly Cap[] = Object.freeze([
  'fs.read',
  'fs.write',
  'proc',
  'window',
  'tty',
  'lock',
  'mem',
]);

/**
 * Root-only rights a command needs when a root shell runs it (`kill` of another uid, `svcctl
 * restart`, `fsck --repair`, …). Listing them is safe: `caps(child) = manifest.caps ∩
 * bounding(uid, class)` drops them for every other uid (syscall-abi.md §3.5).
 */
const ROOT_CAPS: readonly Cap[] = ['kill.other', 'sys.admin'];

/** Every coreutils command, with the extra capabilities it needs beyond USER_CAPS. */
const COMMANDS = {
  ai: [],
  bootlog: [],
  cat: [],
  chmod: [],
  chown: ROOT_CAPS,
  cp: [],
  debug: [...ROOT_CAPS, 'debug.fault'],
  df: [],
  du: [],
  echo: [],
  find: [],
  free: [],
  fsck: ROOT_CAPS,
  grep: [],
  help: [],
  id: [],
  kill: ROOT_CAPS,
  ln: [],
  ls: [],
  lsof: [],
  man: [],
  mkdir: [],
  mv: [],
  nice: ROOT_CAPS,
  pmap: [],
  predict: [],
  ps: [],
  pwd: [],
  quota: [],
  reboot: ROOT_CAPS,
  renice: ROOT_CAPS,
  rm: [],
  rmdir: [],
  semsearch: [],
  shutdown: ROOT_CAPS,
  stat: [],
  su: ROOT_CAPS,
  svcctl: ROOT_CAPS,
  swapctl: ROOT_CAPS,
  top: ROOT_CAPS,
  touch: [],
  tree: [],
  uname: [],
  uptime: [],
  vmstat: [],
  whoami: [],
} as const satisfies Record<CommandName, readonly Cap[]>;

/** The coreutils command names, sorted. */
export const COMMAND_NAMES: readonly CommandName[] = Object.freeze(
  (Object.keys(COMMANDS) as CommandName[]).sort(),
);

/** The AI front ends, absent from the AI-off build (SHL-18, C12; coreutils AI_PROGRAMS). */
export const AI_COMMANDS: readonly CommandName[] = ['ai', 'semsearch', 'predict'];

/** Programs the Terminal bundles until coreutils has them (apps/terminal/host/extras.ts). */
export const TERMINAL_EXTRAS = ['sleep', 'head', 'clear'] as const;

/** The shell's manifest (`/bin/sh.json`, found by the Terminal and by `$PATH` lookup). */
export const SHELL_ENTRY = 'apps/shell/sh';

function commandEntry(name: string): string {
  return `apps/coreutils/${name}`;
}

function uniqueCaps(...lists: readonly (readonly Cap[])[]): Cap[] {
  return [...new Set(lists.flat())];
}

function commandManifest(name: string, extra: readonly Cap[]): AppManifestInput {
  return {
    name,
    kind: 'command',
    title: name,
    entry: commandEntry(name),
    requires: [],
    caps: uniqueCaps(USER_CAPS, extra),
  };
}

export interface ProgramRegistryOptions {
  /** false for the AI-off build: `ai`, `semsearch` and `predict` are left out (SHL-18). */
  readonly ai?: boolean;
}

/**
 * The `/bin/<name>.json` manifests of every bundled program: the shell, coreutils, the Terminal's
 * extras, the demo programs and the GUI apps. The kernel's program catalog is built from these
 * (`new StaticProgramCatalog(programManifests())`), and mkfs may seed them into `/bin`.
 */
export function programManifests(opts: ProgramRegistryOptions = {}): AppManifestInput[] {
  const ai = opts.ai !== false;
  const out: AppManifestInput[] = [
    {
      name: 'sh',
      kind: 'command',
      title: 'sh',
      entry: SHELL_ENTRY,
      requires: [],
      checkpointable: true,
      caps: uniqueCaps(USER_CAPS, ['kill.other']),
    },
  ];
  for (const name of COMMAND_NAMES) {
    if (!ai && AI_COMMANDS.includes(name)) continue;
    out.push(commandManifest(name, COMMANDS[name]));
  }
  for (const name of TERMINAL_EXTRAS) out.push(commandManifest(name, []));
  out.push(...DEMO_MANIFESTS);
  for (const d of APP_DESCRIPTORS) out.push(d.manifest);
  return out;
}

/** `programManifests()` of the full build. */
export const PROGRAM_MANIFESTS: readonly AppManifestInput[] = Object.freeze(programManifests());

/** Anything that looks like a program: `init` and `run` (the executor checks again at load). */
function isRunnable(x: unknown): x is RunnableProgram {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { init?: unknown }).init === 'function' &&
    typeof (x as { run?: unknown }).run === 'function'
  );
}

function expectProgram(entry: string, x: unknown): RunnableProgram {
  if (!isRunnable(x)) throw new Error(`${entry} has no program export`);
  return x;
}

/**
 * `manifest.entry` → lazy loader: the executor side of the program registry (kernel/src/runtime
 * `ProgramLoaders`). Each loader resolves to the program itself.
 */
export function programModules(opts: ProgramRegistryOptions = {}): Record<string, ProgramLoader> {
  const ai = opts.ai !== false;
  const out: Record<string, ProgramLoader> = {
    [SHELL_ENTRY]: () =>
      import('../shell/proc.ts').then((m) => expectProgram(SHELL_ENTRY, m.default)),
  };
  for (const name of COMMAND_NAMES) {
    if (!ai && AI_COMMANDS.includes(name)) continue;
    const entry = commandEntry(name);
    out[entry] = () =>
      import('../coreutils/index.ts').then((m) => expectProgram(entry, m.PROGRAMS[name]));
  }
  for (const name of TERMINAL_EXTRAS) {
    const entry = commandEntry(name);
    out[entry] = () =>
      import('../terminal/host/extras.ts').then((m) => expectProgram(entry, m[name]));
  }
  for (const m of DEMO_MANIFESTS) {
    const entry = m.entry;
    if (entry === undefined) continue;
    const name = m.name;
    out[entry] = () =>
      import('../demo/index.ts').then((d) => expectProgram(entry, d.demoProgram(name)));
  }
  for (const d of APP_DESCRIPTORS) {
    const entry = d.manifest.entry;
    const load = d.program;
    if (entry === undefined || load === undefined) continue;
    out[entry] = () => load().then((p) => expectProgram(entry, p));
  }
  return out;
}

/** `programModules()` of the full build. */
export const PROGRAM_MODULES: Readonly<Record<string, ProgramLoader>> =
  Object.freeze(programModules());

// ---------------------------------------------------------------------------------------------
// The desktop shell's app entries
// ---------------------------------------------------------------------------------------------

/** A failed call as the apps read it (`SysError`-shaped: `errno` and a message). */
export class AppCallError extends Error {
  readonly errno: string;

  constructor(errno: string, message: string) {
    super(message);
    this.name = 'SysError';
    this.errno = errno;
  }
}

/** Topic patterns as `sys.subscribe` takes them: `proc.*`, `mem.fault`, `*`. */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === '*' || pattern === topic) return true;
  if (pattern.endsWith('.*')) return topic.startsWith(pattern.slice(0, -1));
  return false;
}

/** Every executor-only call (registry origin `E`): what a view port refuses. */
export const EXECUTOR_CALLS: readonly CallName[] = Object.freeze(
  CALL_NAMES.filter((name) => lookupCall(name)?.origin === 'E'),
);

/** A view's routed client; `dispose` rejects relayed calls still in flight. */
export interface RoutedSys extends AppSys {
  dispose(reason?: string): void;
}

/**
 * The system-call client a view gets (window-manager.md §3.13–§3.14). Calls a view port may make
 * go to the port. Executor-only calls (registry origin `E`) are made by the window's process:
 * through `bindings.execCall` when the host has one, else as a relay request on the window's
 * display channel (apps/files/lib/relay.ts, served by the process's `appProcess`), else they fail
 * with ENOSYS. The display port is read at each call, since the kernel replaces it after a
 * page-in.
 */
export function routedSys(
  shell: Pick<ShellViewContextLike, 'sys' | 'display'>,
  win: AppWindowRef,
  bindings: Pick<AppHostBindings, 'execCall'>,
  allow: readonly string[] = EXECUTOR_CALLS,
): RoutedSys {
  let bound: { readonly port: DisplayPortLike; readonly client: RelaySysClient } | null = null;
  const relay = (): RelaySysClient | null => {
    const port = shell.display;
    if (bound !== null && bound.port === port) return bound.client;
    bound?.client.dispose(port === null ? 'display channel closed' : 'display channel replaced');
    bound = port === null ? null : { port, client: createRelaySys(shell.sys, port, { allow }) };
    return bound?.client ?? null;
  };
  const call = <C extends CallName>(name: C, args: ArgsIn<C>): Promise<RetOf<C>> => {
    if (lookupCall(name)?.origin !== 'E') return shell.sys.call(name, args);
    const exec = bindings.execCall;
    if (exec !== undefined) return exec(win, name, args);
    const client = allow.includes(name) ? relay() : null;
    if (client !== null) return client.call(name, args);
    return Promise.reject(
      new AppCallError(
        'ENOSYS',
        `${name} is made by the app's own process, and this window has no channel to it yet`,
      ),
    );
  };
  return {
    call,
    dispose(reason = 'view closed') {
      bound?.client.dispose(reason);
      bound = null;
    },
  };
}

/**
 * The host's `AppEnv`, with the user taken from the shell's session when the host did not know it
 * (a guest session makes Settings read-only for device settings before the first `proc.cred`).
 */
export function envFor(env: AppEnv, shell: Pick<ShellViewContextLike, 'session'>): AppEnv {
  const s = shell.session;
  if (env.user !== undefined || s === undefined) return env;
  return { ...env, user: { name: s.user, uid: s.uid, guest: s.kind === 'guest' } };
}

/** The full `AppViewContext` for one window, from the shell's context and the host bindings. */
export function toAppViewContext(
  d: AppDescriptor,
  shell: ShellViewContextLike,
  bindings: AppHostBindings,
  sys: AppSys = routedSys(shell, { pid: shell.pid, wid: shell.wid, app: d.id }, bindings, d.relay),
): AppViewContext {
  return {
    app: d.id,
    wid: shell.wid,
    pid: shell.pid,
    argv: shell.argv,
    container: shell.container,
    sys,
    env: envFor(bindings.env(), shell),
    window: {
      setTitle: (title) => {
        if (shell.setTitle !== undefined) shell.setTitle(title);
        else bindings.setTitle?.(shell.wid, title);
      },
      close: () => {
        shell.requestClose();
      },
    },
    launch: (app, opts) => {
      const argv = opts?.argv ?? [];
      if (shell.launch !== undefined) shell.launch(app, argv);
      else bindings.launch?.(app, argv);
    },
    subscribe: (topics, fn) => {
      const deliver = (batch: readonly KEvent[]): void => {
        const hits = batch.filter((ev) => topics.some((p) => topicMatches(p, ev.topic)));
        if (hits.length > 0) fn(hits);
      };
      // The shell's own feed when it has one (the host's kernel subscription), else the batches
      // the kernel pushes on this window's view port.
      const off =
        shell.subscribe !== undefined
          ? shell.subscribe(topics, deliver)
          : shell.onViewEvent('kernel.events', deliver);
      // Ask the kernel to push these topics on the view port; a kernel without event delivery
      // answers ENOSYS and the apps keep polling.
      if (topics.length > 0)
        shell.sys.call('sys.subscribe', { topics: [...topics] }).catch(() => undefined);
      return off;
    },
    onMenuCommand: (fn) =>
      shell.onMenuCommand((_menuId, itemId) => {
        fn(itemId);
      }),
    reportCrash: (err) => {
      shell.reportCrash(err);
    },
    theme: () => shell.theme(),
    onTtyOutput: (fn) => shell.onViewEvent('tty.output', fn),
  };
}

/** Mounts one descriptor's view; the disposer also ends its relay client. */
export async function mountDescriptor(
  d: AppDescriptor,
  shell: ShellViewContextLike,
  bindings: AppHostBindings,
): Promise<() => void> {
  const mount = await d.load();
  const sys = routedSys(shell, { pid: shell.pid, wid: shell.wid, app: d.id }, bindings, d.relay);
  let dispose: () => void;
  try {
    dispose = mount(toAppViewContext(d, shell, bindings, sys));
  } catch (e) {
    sys.dispose('view crashed');
    throw e;
  }
  return () => {
    try {
      dispose();
    } finally {
      sys.dispose('view closed');
    }
  };
}

/** One descriptor as a shell app entry. */
export function toShellAppEntry(d: AppDescriptor, bindings: AppHostBindings): ShellAppEntry {
  const entry: ShellAppEntry = {
    id: d.id,
    title: d.title,
    icon: d.icon,
    pinned: d.dock !== false,
    launchable: true,
    singleton: d.window.singleInstance,
    window: d.window,
    mountView: (_container, shell) => mountDescriptor(d, shell, bindings),
  };
  return d.menus === undefined ? entry : { ...entry, menus: d.menus };
}

/**
 * wm's `AppRegistry` over the given descriptors, in their order (the Dock order). Pass it as
 * `DesktopEnv.apps`.
 */
export function createShellAppRegistry(
  descriptors: readonly AppDescriptor[],
  bindings: AppHostBindings,
): ShellAppRegistry {
  const entries = descriptors.map((d) => toShellAppEntry(d, bindings));
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    list: () => entries,
    get: (id) => byId.get(id),
  };
}
