/**
 * Terminal sessions: one shell on one TTY per tab (shell-and-terminal.md §3.2–§3.3).
 *
 * Two backends carry the byte stream between xterm and the TTY:
 *
 * - `kernelBackend`, the normative path: the window belongs to a `term` process (./proc.ts), the
 *   kernel owns the TTY, keystrokes go out with `tty.input` on the view port, output batches come
 *   back as `tty.output` view events, and a new grid size goes out with `tty.resize` (WM §4.5).
 *   One TTY per window, so a new tab is a new Terminal window.
 * - `localBackend`: the Terminal's own process host (./host/host.ts) runs the shell and its
 *   commands with a local TTY and delegates every other call to the kernel through the view's
 *   system-call client. It supports tabs. It is the path used until the kernel TTY and process
 *   syscalls are wired (TODO(R1)).
 */
import type { ArgsIn, CallName, WaitStatus } from '@plotinium/protocol';

import type { ConfirmRenderer, ConfirmRequester, Delegate, HostIdentity } from './host/host.ts';
import { ProcessHost } from './host/host.ts';
import { bundledManPages } from './host/manpages.ts';
import type { HostProgram } from './host/programs.ts';
import { bundledPrograms } from './host/programs.ts';

export interface GridSize {
  cols: number;
  rows: number;
}

export type OutputBatch = (data: Uint8Array, ack: () => void) => void;

/** One open session (a tab). */
export interface SessionPort {
  /** Keyboard input; 'again' when the TTY's input queue is full (retry next frame). */
  send(data: string): Promise<'ok' | 'again'>;
  resize(size: GridSize): void;
  /** Output batches; `ack` after xterm parsed one (SHL-03). Batches before this are kept. */
  onOutput(listener: OutputBatch): void;
  /** The shell ended; the tab closes. */
  onExit(listener: (code: number) => void): void;
  /** The shell's directory changed: `display` is `~/notes` style. */
  onCwd(listener: (cwd: string, display: string) => void): void;
  /** Hang up (SIGHUP to the session). */
  close(): void;
}

/** How a session starts. */
export interface OpenOptions {
  /**
   * Start the shell in this directory (Files' "Open in Terminal", UI-129) instead of a login
   * shell in the home directory. Ignored when it is not a directory the user may enter.
   */
  readonly cwd?: string;
}

export interface SessionBackend {
  readonly kind: 'kernel' | 'local';
  /** Several sessions in one window. */
  readonly tabs: boolean;
  /** The user the prompt and title show. */
  user(): string;
  open(size: GridSize, opts?: OpenOptions): Promise<SessionPort>;
  dispose(): void;
}

/** The view's system-call client (a view port, `createViewSys`), as the backends use it. */
export interface CallPort {
  call(name: string, args: unknown): Promise<unknown>;
}

/** The typed client a view receives (`AppSys`, `ViewSysClient`), structurally. */
export interface TypedSys {
  call<C extends CallName>(name: C, args: ArgsIn<C>): Promise<unknown>;
}

/**
 * The typed view client as the untyped port the process host delegates through. Names are passed
 * as they are: the kernel is the authority on which calls exist for a view (ENOSYS otherwise),
 * and the host caches that answer for calls outside the registry (host.ts `delegate`).
 */
export function callPortOf(sys: TypedSys): CallPort {
  return {
    call: (name, args) => sys.call(name as CallName, args as ArgsIn<CallName>),
  };
}

function statusCode(s: WaitStatus): number {
  return s.kind === 'exited' || s.kind === 'signaled' ? s.code : 0;
}

// ---------------------------------------------------------------------------------------------
// Local backend
// ---------------------------------------------------------------------------------------------

export interface LocalBackendOptions {
  /** The kernel: every call the host does not run itself goes here. */
  readonly sys?: CallPort;
  readonly identity?: HostIdentity;
  readonly programs?: Readonly<Record<string, HostProgram>>;
  readonly ai?: boolean;
  readonly confirm?: ConfirmRenderer;
  readonly onConfirmStrip?: (tty: number, active: boolean, requester: ConfirmRequester) => void;
  /** Injected for tests; the default is the browser clock. */
  readonly host?: ProcessHost;
}

export function localBackend(opts: LocalBackendOptions = {}): SessionBackend {
  const sys = opts.sys;
  const delegate: Delegate | undefined =
    sys === undefined ? undefined : (call, args) => sys.call(call, args);
  const host =
    opts.host ??
    new ProcessHost({
      programs: bundledPrograms({
        ...(opts.ai === undefined ? {} : { ai: opts.ai }),
        ...(opts.programs === undefined ? {} : { extra: opts.programs }),
      }),
      ...(delegate === undefined ? {} : { delegate }),
      ...(opts.identity === undefined ? {} : { identity: opts.identity }),
      ...(opts.confirm === undefined ? {} : { confirm: opts.confirm }),
      ...(opts.onConfirmStrip === undefined ? {} : { onConfirmStrip: opts.onConfirmStrip }),
      manPages: bundledManPages(),
      log: (m) => console.warn(`terminal: ${m}`),
    });
  const links = new Set<{ hangup(graceMs?: number): void }>();
  let userName = opts.identity?.user ?? 'user';
  return {
    kind: 'local',
    tabs: true,
    user: () => userName,
    async open(size, opts = {}) {
      userName = (await host.whoami()).user;
      // A given directory gets a shell started there; a login shell would change to $HOME.
      const dir = opts.cwd === undefined ? null : await host.enterableDirectory(opts.cwd);
      const link = await host.openTerminal(
        dir === null ? size : { ...size, cwd: dir, argv: ['sh'] },
      );
      links.add(link);
      const exits: ((code: number) => void)[] = [];
      let exited: number | null = null;
      link.onExit((s) => {
        links.delete(link);
        exited = statusCode(s);
        for (const l of exits) l(exited);
      });
      return {
        send: (data) => Promise.resolve(link.input(data)),
        resize: (s) => link.resize(s.cols, s.rows),
        onOutput: (listener) => link.attach(listener),
        onExit: (listener) => {
          if (exited !== null) listener(exited);
          else exits.push(listener);
        },
        onCwd: (listener) => {
          const now = link.cwd();
          listener(now.path, now.display);
          link.onCwd(listener);
        },
        close: () => link.hangup(),
      };
    },
    dispose() {
      for (const link of links) link.hangup(0);
      links.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Kernel backend (tty.input / tty.resize / tty.output on the view port)
// ---------------------------------------------------------------------------------------------

export interface KernelBackendOptions {
  readonly sys: CallPort;
  /** Subscribes to the view port's `tty.output` pushes; returns an unsubscribe. */
  readonly onTtyOutput: (listener: (data: ArrayBuffer) => void) => () => void;
  /** The view port closed (the `term` process exited); returns an unsubscribe. */
  readonly onClosed?: (listener: () => void) => (() => void) | void;
  readonly user?: string;
}

function isErrnoError(e: unknown, errno: string): boolean {
  return typeof e === 'object' && e !== null && 'errno' in e && e.errno === errno;
}

export function kernelBackend(opts: KernelBackendOptions): SessionBackend {
  let opened = false;
  const unsubscribers: (() => void)[] = [];
  return {
    kind: 'kernel',
    tabs: false,
    user: () => opts.user ?? 'user',
    open(size) {
      if (opened) return Promise.reject(new Error('the kernel TTY serves one session per window'));
      opened = true;
      const early: Uint8Array[] = [];
      let listener: OutputBatch | null = null;
      unsubscribers.push(
        opts.onTtyOutput((data) => {
          const bytes = new Uint8Array(data);
          // TODO(R1): acknowledge with tty.ack({seq}) once the protocol has it (§4.1).
          if (listener === null) early.push(bytes);
          else listener(bytes, () => undefined);
        }),
      );
      const exits: ((code: number) => void)[] = [];
      const stop = opts.onClosed?.(() => {
        for (const l of exits) l(0);
      });
      if (typeof stop === 'function') unsubscribers.push(stop);
      const resize = (s: GridSize): void => {
        void opts.sys.call('tty.resize', { cols: s.cols, rows: s.rows }).catch(() => undefined);
      };
      resize(size);
      return Promise.resolve({
        send: (data) =>
          opts.sys.call('tty.input', { data }).then(
            () => 'ok' as const,
            (e: unknown) => {
              if (isErrnoError(e, 'EAGAIN')) return 'again' as const;
              throw e instanceof Error ? e : new Error(String(e));
            },
          ),
        resize,
        onOutput: (l) => {
          listener = l;
          for (const bytes of early.splice(0)) l(bytes, () => undefined);
        },
        onExit: (l) => exits.push(l),
        onCwd: () => undefined,
        close: () => undefined,
      });
    },
    dispose() {
      for (const u of unsubscribers.splice(0)) u();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Choosing a backend
// ---------------------------------------------------------------------------------------------

/**
 * Whether the kernel serves this window's TTY: `tty.resize` is a view-origin call, so the view
 * can ask without side effects beyond setting the size it is about to set anyway. A kernel
 * without the TTY subsystem answers ENOSYS; a window without a TTY answers another errno.
 */
export async function probeKernelTty(sys: CallPort, size: GridSize): Promise<boolean> {
  try {
    await sys.call('tty.resize', { cols: size.cols, rows: size.rows });
    return true;
  } catch {
    return false;
  }
}

/**
 * A backend that decides on first use: the kernel TTY when `probe` says the kernel serves it,
 * otherwise the Terminal's own process host. Until the decision it reports the local backend's
 * capabilities (tabs on), which is also what it falls back to.
 */
export function autoBackend(
  probe: () => Promise<boolean>,
  kernel: () => SessionBackend,
  local: () => SessionBackend,
): SessionBackend {
  let chosen: SessionBackend | null = null;
  let deciding: Promise<SessionBackend> | null = null;
  let disposed = false;
  const decide = (): Promise<SessionBackend> => {
    deciding ??= probe()
      .catch(() => false)
      .then((useKernel) => {
        chosen = useKernel ? kernel() : local();
        if (disposed) chosen.dispose();
        return chosen;
      });
    return deciding;
  };
  return {
    get kind() {
      return chosen?.kind ?? 'local';
    },
    get tabs() {
      return chosen?.tabs ?? true;
    },
    user: () => chosen?.user() ?? 'user',
    async open(size, opts) {
      const backend = await decide();
      if (disposed) throw new Error('the Terminal was closed');
      return backend.open(size, opts);
    },
    dispose() {
      disposed = true;
      chosen?.dispose();
    },
  };
}
