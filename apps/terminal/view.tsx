/**
 * The Terminal view (shell-and-terminal.md §3.1 "Terminal view"; UI guide §3.6.2–§3.6.3): mounts
 * ui's TerminalApp (tabs, one xterm per session, status strip) into the window's content element
 * and wires it to the sessions through TerminalController. xterm is the TTY device only: keys become
 * bytes for the TTY (Ctrl-C and Ctrl-Z included; the line discipline turns them into SIGINT and
 * SIGTSTP for the foreground process group), and TTY output is written back one acknowledged batch
 * at a time (SHL-03). A new grid size goes to the TTY winsize (SIGWINCH).
 *
 * Which TTY carries the byte stream (./session.ts):
 * - the kernel's, when the kernel serves this window's TTY (`tty.resize` succeeds on the view port
 *   and the host passes the view port's `tty.output` pushes as `onViewEvent`);
 * - otherwise the Terminal's own process host (./host/host.ts): a pseudo-terminal pair with the
 *   line discipline of ./ldisc.ts, the login shell of apps/shell and the coreutils as processes,
 *   pipes and job control, delegating every other call to the kernel through `ctx.sys`.
 *
 * Exports `mount` (AppMount, apps/src/descriptor.ts) and, as the default, the same function.
 */
import { EmptyState } from '@plotinium/ui';
import { TERMINAL_TAB_LIMIT, TerminalApp, type AgentStatus } from '@plotinium/ui/apps/terminal';
import { createSignal, ErrorBoundary, Show, type Accessor, type JSX } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';

import type { AppViewContext } from '../src/descriptor.ts';
import { ANSI_CONFIRM } from './confirm.ts';
import type { TerminalSnapshot, TerminalViewState } from './controller.ts';
import {
  parseSnapshot,
  SNAPSHOT_MAX_LINES,
  snapshotText,
  TerminalController,
} from './controller.ts';
import type { ConfirmRequester, HostIdentity } from './host/host.ts';
import type { HostProgram } from './host/programs.ts';
import { TERMINAL_MENU } from './manifest.ts';
import type { CallPort, GridSize, SessionBackend } from './session.ts';
import { autoBackend, callPortOf, kernelBackend, localBackend, probeKernelTty } from './session.ts';

/**
 * Optional extras a host may add to the view context. The desktop shell's `ViewContext`
 * (wm/src/shell/env.ts) has `onViewEvent`; passing it through lets the kernel TTY path work.
 */
export interface TerminalExtras {
  /** The view port's pushes: `tty.output` batches and `view.close`. */
  readonly onViewEvent?: {
    (topic: 'tty.output', cb: (data: ArrayBuffer) => void): () => void;
    (topic: 'view.close', cb: (reason: string) => void): () => void;
  };
  /**
   * 'auto' (default): the kernel TTY when it serves this window, else the process host.
   * 'local': always the process host (tests, the gallery). 'kernel': always the kernel TTY.
   */
  readonly tty?: 'auto' | 'kernel' | 'local';
  /** More programs for the process host, by name (for example `ai.agent` from ai/). */
  readonly programs?: Readonly<Record<string, HostProgram>>;
  /** The kernel-confirmation strip over the title bar (DSN-16), drawn by the compositor. */
  readonly onConfirmStrip?: (active: boolean) => void;
  readonly fontSize?: number;
  readonly screenReaderMode?: boolean;
  /**
   * The snapshot the host saved for this window (UI-127; shell-and-terminal.md §3.3): a restored
   * window reopens its tabs in their directories and shows their previous text before the new
   * shells' output. Checked with `parseSnapshot`; anything else is ignored.
   */
  readonly restore?: unknown;
  /**
   * Lets the host read this window's snapshot when it saves the session (layout persistence,
   * dehydrate). The view registers its reader on mount and unregisters it on dispose.
   */
  readonly onSnapshot?: (read: () => TerminalSnapshot) => () => void;
}

export type TerminalMountContext = AppViewContext & TerminalExtras;

const INITIAL_SIZE: GridSize = { cols: 80, rows: 24 };

/** The part of ui's `TerminalHandle` (one mounted xterm) the controller drives. */
interface XtermHandle {
  write(data: Uint8Array, callback?: () => void): void;
  size(): GridSize;
  clear(): void;
  focus(): void;
  selection(): string;
  paste(text: string): void;
  selectAll(): void;
  lines(maxLines: number): string[];
}

/** The system clipboard, absent outside secure contexts. */
function clipboardOf(): Clipboard | undefined {
  return (globalThis.navigator as { clipboard?: Clipboard } | undefined)?.clipboard;
}

/**
 * The directory a Terminal opened from Files starts in: `argv[0]` when it is an absolute path
 * (Open With > Terminal, "Open in Terminal"), else none (a login shell in the home directory).
 */
export function startDirectory(argv: readonly string[]): string | undefined {
  const dir = argv[0];
  return dir !== undefined && dir.startsWith('/') ? dir : undefined;
}

/** The user the prompt shows before `proc.cred` answers (the host asks the kernel first). */
export function identityOf(ctx: AppViewContext): HostIdentity | undefined {
  const u = ctx.env.user;
  if (u === undefined) return undefined;
  const home = u.uid === 0 ? '/root' : `/home/${u.name}`;
  return { uid: u.uid, gid: u.uid, user: u.name, home };
}

/**
 * The agent item of the status strip: AI off, or no agent program this terminal can run (the
 * `ai` command then says why, UI-055), or a plan waiting for the user's answer.
 */
export function agentStatusOf(
  aiAvailable: boolean,
  waiting: ConfirmRequester | null,
  agentInstalled = true,
): AgentStatus | undefined {
  if (!aiAvailable || !agentInstalled) return { state: 'unavailable' };
  if (waiting !== null) return { state: 'waiting', pid: waiting.pid, on: 'your confirmation' };
  return undefined;
}

/**
 * The backend for this window (see the header). `onConfirm` hears the process host's
 * confirmation takeovers (the status strip shows the waiting agent).
 */
export function chooseBackend(
  ctx: TerminalMountContext,
  sys: CallPort,
  onConfirm?: (active: boolean, requester: ConfirmRequester) => void,
): SessionBackend {
  const identity = identityOf(ctx);
  const strip = ctx.onConfirmStrip;
  const local = (): SessionBackend =>
    localBackend({
      sys,
      ai: ctx.env.aiAvailable,
      confirm: ANSI_CONFIRM,
      ...(identity === undefined ? {} : { identity }),
      ...(ctx.programs === undefined ? {} : { programs: ctx.programs }),
      onConfirmStrip: (_tty, active, requester) => {
        strip?.(active);
        onConfirm?.(active, requester);
      },
    });
  const on = ctx.onViewEvent;
  // The view port's `tty.output` pushes: the shell's `onViewEvent`, or the host's `onTtyOutput`.
  const onTtyOutput: ((listener: (data: ArrayBuffer) => void) => () => void) | undefined =
    on !== undefined ? (listener) => on('tty.output', listener) : ctx.onTtyOutput;
  if (ctx.tty === 'local' || onTtyOutput === undefined) return local();
  const kernel = (): SessionBackend =>
    kernelBackend({
      sys,
      onTtyOutput,
      ...(on === undefined
        ? {}
        : { onClosed: (listener: () => void) => on('view.close', () => listener()) }),
      ...(identity === undefined ? {} : { user: identity.user }),
    });
  if (ctx.tty === 'kernel') return kernel();
  return autoBackend(() => probeKernelTty(sys, INITIAL_SIZE), kernel, local);
}

function TerminalView(props: {
  state: TerminalViewState;
  controller: TerminalController;
  agent: Accessor<AgentStatus | undefined>;
  fontSize: number | undefined;
  screenReaderMode: boolean | undefined;
}): JSX.Element {
  return (
    <Show
      when={props.state.tabs.length > 0 || props.state.error === null}
      fallback={
        <EmptyState title="The shell could not start" description={props.state.error ?? ''} live />
      }
    >
      <TerminalApp
        sessions={props.state.tabs}
        selected={props.state.selected}
        onSelect={(id: string) => props.controller.select(id)}
        onClose={(id: string) => props.controller.closeTab(id)}
        onNew={props.state.canAddTab ? () => void props.controller.newTab() : undefined}
        title={props.state.title}
        cwd={props.state.cwd}
        agent={props.agent()}
        shell="sh"
        onData={(id: string, data: string) => props.controller.data(id, data)}
        onResize={(id: string, size: GridSize) => props.controller.resize(id, size)}
        onReady={(id: string, handle: XtermHandle) =>
          props.controller.ready(id, {
            write: (data, parsed) => handle.write(data, parsed),
            size: () => handle.size(),
            clear: () => handle.clear(),
            focus: () => handle.focus(),
            selection: () => handle.selection(),
            paste: (text) => handle.paste(text),
            selectAll: () => handle.selectAll(),
            snapshot: () => snapshotText(handle.lines(SNAPSHOT_MAX_LINES)),
          })
        }
        fontSize={props.fontSize}
        screenReaderMode={props.screenReaderMode}
      />
    </Show>
  );
}

const EMPTY: TerminalViewState = {
  tabs: [],
  selected: '',
  title: 'Terminal',
  cwd: '',
  canAddTab: false,
  error: null,
};

/** Mounts the Terminal into `ctx.container`; returns the disposer (AppMount). */
export function mount(ctx: TerminalMountContext): () => void {
  const sys = callPortOf(ctx.sys);
  const [waiting, setWaiting] = createSignal<ConfirmRequester | null>(null);
  // Whether an `ai` in this window can start the agent: the kernel runs its own; the process host
  // only the one a host passes in `programs`. Unknown until the backend is chosen.
  const [agentInstalled, setAgentInstalled] = createSignal<boolean | null>(null);
  const agent = (): AgentStatus | undefined => {
    const installed = agentInstalled();
    if (installed === null && ctx.env.aiAvailable) return undefined;
    return agentStatusOf(ctx.env.aiAvailable, waiting(), installed ?? false);
  };
  const backend = chooseBackend(ctx, sys, (active, requester) =>
    setWaiting(active ? requester : null),
  );
  const [state, setState] = createStore<TerminalViewState>({ ...EMPTY, tabs: [] });
  const controller = new TerminalController({
    backend,
    onChange: (next) => setState(reconcile(next, { key: 'id' })),
    onEmpty: () => ctx.window.close(),
    setTitle: (title) => ctx.window.setTitle(title),
    maxTabs: TERMINAL_TAB_LIMIT,
    initialSize: INITIAL_SIZE,
  });
  // After a menu command the keyboard belongs to the terminal again, not to the menu bar
  // (WCAG 2.4.3). The menu restores its own focus as it closes, so this runs a frame later.
  const refocus = (): void => {
    const again = (): void => {
      const sel = controller.selected;
      if (sel !== '') controller.focus(sel);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(again);
    else setTimeout(again, 0);
  };
  const stopMenu = ctx.onMenuCommand((item) => {
    const sel = controller.selected;
    switch (item) {
      case TERMINAL_MENU.newTab:
        void controller.newTab().then(refocus);
        return;
      case TERMINAL_MENU.closeTab:
        if (sel !== '') controller.closeTab(sel);
        break;
      case TERMINAL_MENU.interrupt:
        if (sel !== '') controller.data(sel, '\x03');
        break;
      case TERMINAL_MENU.clear:
        if (sel !== '') controller.clear(sel);
        break;
      case TERMINAL_MENU.copy: {
        const text = sel === '' ? '' : controller.selection(sel);
        const clipboard = clipboardOf();
        if (text !== '' && clipboard !== undefined) {
          clipboard.writeText(text).catch(() => undefined);
        }
        break;
      }
      case TERMINAL_MENU.paste: {
        // Reading the clipboard may ask the user first; a refusal leaves the line as it was.
        const clipboard = clipboardOf();
        if (clipboard === undefined) break;
        clipboard
          .readText()
          .then((text) => controller.paste(controller.selected, text))
          .catch(() => undefined)
          .finally(refocus);
        return;
      }
      case TERMINAL_MENU.selectAll:
        if (sel !== '') controller.selectAll(sel);
        break;
      case TERMINAL_MENU.nextTab:
        controller.step(1);
        break;
      case TERMINAL_MENU.prevTab:
        controller.step(-1);
        break;
      default:
        return;
    }
    refocus();
  });
  const start = startDirectory(ctx.argv);
  // A restored window reopens its saved tabs (UI-127); a new one starts one shell.
  const saved = parseSnapshot(ctx.restore, TERMINAL_TAB_LIMIT);
  const opened =
    saved === null
      ? controller.newTab(start === undefined ? {} : { cwd: start })
      : controller.restore(saved);
  void opened.then(() => {
    setAgentInstalled(backend.kind === 'kernel' || ctx.programs?.['ai.agent'] !== undefined);
  });
  const stopSnapshot = ctx.onSnapshot?.(() => controller.snapshot());
  const disposeRoot = render(
    () => (
      <ErrorBoundary
        fallback={(e: unknown) => {
          ctx.reportCrash(e);
          return <EmptyState title="Terminal stopped" description={String(e)} live />;
        }}
      >
        <TerminalView
          state={state}
          controller={controller}
          agent={agent}
          fontSize={ctx.fontSize}
          screenReaderMode={ctx.screenReaderMode}
        />
      </ErrorBoundary>
    ),
    ctx.container,
  );
  return () => {
    stopMenu();
    stopSnapshot?.();
    controller.dispose();
    disposeRoot();
  };
}

export default mount;
