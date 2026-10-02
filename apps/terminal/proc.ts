/**
 * The `term` process (shell-and-terminal.md §3.3), the program behind `/bin/terminal.json`:
 *
 * 1. the window: `PLT_WINDOW=<wid>` when the host already created it and bound it to this pid,
 *    otherwise `window.create({title})`;
 * 2. the TTY: `tty.open({wid})`, then `spawn` of `/bin/sh.json` with argv `['-sh']`, descriptors
 *    0, 1 and 2 on the TTY, a new process group and `$HOME` as the directory; it waits for the
 *    shell, and when the shell exits `term` exits and the window closes;
 * 3. closing the window sends SIGTERM to `term`: it hangs up the shell's session (SIGHUP), waits
 *    up to 1 s for it, and exits, which closes the TTY.
 *
 * Kernels without the TTY subsystem answer `tty.open` with an errno (ENOSYS today, TODO(R1):
 * kernel/core/tty). `term` then owns the window (`phase: 'owner'`, the life of `appProcess` in
 * apps/files/lib/relay.ts): the Terminal view runs the shell in its own process host
 * (./host/host.ts, ./session.ts), and `term` is the caller of record for the executor-only calls
 * that host's programs make (`open`, `read`, `mkdir`, `unlink`, `kill`, `ai.agent.*`, …; the
 * allow-list is TERMINAL_RELAY_CALLS in ./manifest.ts), which the view posts on the window's
 * display channel (window-manager.md §3.13). It serves them in order until SIGTERM or SIGHUP.
 *
 * All state is in `st` and every loop yields, so `term` can be paged out and restored (WM §3.12).
 * TODO(R1): `spawn` has no `session: 'new'` / `ctty` options yet (§4.8 requested); the kernel makes
 * the TTY the controlling terminal of the process that opened it and its children.
 */
import type { SignalName } from '@plotinium/protocol';
import type { Program, ProgramContext, SysGen } from '@plotinium/kernel/sys';
import { errnoOf } from '@plotinium/kernel/sys';

import type { PortLike, RelayRequest } from '../files/lib/relay.ts';
import {
  asPort,
  displayOf,
  parseRelayInput,
  serveRelay,
  transferables,
} from '../files/lib/relay.ts';
import { TERMINAL_RELAY_CALLS } from './manifest.ts';

export const SHELL_MANIFEST = '/bin/sh.json';
export const HANGUP_GRACE_MS = 1_000;
/** How long the window owner sleeps between wake-ups when it has no display channel. */
export const OWNER_SLEEP_MS = 60_000;
/**
 * How long `term` sleeps between checks for relayed calls (UI-121). A program cannot block on its
 * display channel yet (the executor has no wake-up for port messages, TODO(R1)), so it polls,
 * but it backs off: right after a call it checks again in RELAY_BUSY_SLEEP_MS (a command reading
 * a file makes several calls in a row, and a terminal is latency-bound), and each check that
 * finds nothing doubles the wait, up to RELAY_QUIET_SLEEP_MS. The old loop kept waking every
 * 4 ms for two seconds after each call (about 500 wake-ups, each a `sleep` trace in the kernel
 * log); this one wakes about seven times to reach the quiet interval, whose latency is unchanged.
 */
export const RELAY_BUSY_SLEEP_MS = 4;
export const RELAY_QUIET_SLEEP_MS = 100;

/** The next wait after a check: back to the busy interval after work, else twice as long. */
export function nextRelaySleep(previousMs: number, served: boolean): number {
  if (served) return RELAY_BUSY_SLEEP_MS;
  return Math.min(RELAY_QUIET_SLEEP_MS, Math.max(RELAY_BUSY_SLEEP_MS, previousMs * 2));
}
/** Environment variable a host sets when it created the window itself (apps/src/descriptor.ts). */
export const WINDOW_ENV = 'PLT_WINDOW';

export interface TermState {
  phase: 'start' | 'running' | 'owner' | 'closing' | 'done';
  wid: number | null;
  /** The window was created by the host (`PLT_WINDOW`): the host closes it. */
  hostWindow: boolean;
  fd: number | null;
  tty: number | null;
  shPid: number | null;
  title: string;
  hangup: boolean;
  code: number;
  waitedMs: number;
  /** Why the kernel TTY path is not used (`tty.open` failed), for `proc.info` readers. */
  ttyError: string | null;
  /** Relayed calls performed for the view's process host. */
  served: number;
}

function* quiet<T>(call: SysGen<T>): SysGen<T | null> {
  try {
    return yield* call;
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
    return null;
  }
}

function hostWid(ctx: ProgramContext): number | null {
  const given = Number.parseInt(ctx.env.get(WINDOW_ENV) ?? '', 10);
  return Number.isInteger(given) && given > 0 ? given : null;
}

/** The folder a Terminal was opened on: an absolute path in `argv[1]`, else null. */
export function startDirectoryOf(argv: readonly string[]): string | null {
  const dir = argv[1];
  return dir !== undefined && dir.startsWith('/') ? dir : null;
}

/** Starts the session; returns the display channel when `window.create` gave one. */
function* start(ctx: ProgramContext, st: TermState): SysGen<PortLike | undefined> {
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
    yield* quiet(ctx.sys.call('sig.action', { sig, action: 'catch' }));
  }
  const cred = yield* quiet(ctx.sys.call('proc.cred', {}));
  const home = cred?.home ?? '/';
  st.title = cred === null ? 'Terminal' : `${cred.user}@plotinium: ~`;
  let display: PortLike | undefined;
  if (st.wid === null) {
    const given = hostWid(ctx);
    if (given !== null) {
      st.wid = given;
      st.hostWindow = true;
    } else {
      const win = yield* quiet(
        ctx.sys.call('window.create', {
          title: st.title,
          icon: 'terminal',
          minSize: { w: 420, h: 240 },
          restoreKey: 'terminal',
        }),
      );
      st.wid = win?.wid ?? null;
      display = win === null ? undefined : asPort(win.display);
    }
  }
  if (st.wid === null) {
    st.ttyError = 'no window';
    st.phase = 'owner';
    return display;
  }
  let tty: { fd: number; n: number };
  try {
    tty = yield* ctx.sys.call('tty.open', { wid: st.wid });
  } catch (e) {
    const errno = errnoOf(e);
    if (errno === undefined) throw e;
    // No kernel TTY: the view's process host runs the shell; this process owns the window.
    st.ttyError = errno;
    st.phase = 'owner';
    return display;
  }
  st.fd = tty.fd;
  st.tty = tty.n;
  const fds = { 0: tty.fd, 1: tty.fd, 2: tty.fd };
  // Opened on a folder (Files' Open in Terminal, UI-129): a shell started there, since a login
  // shell changes to $HOME. The kernel checks the directory; if it refuses, a login shell.
  const dir = startDirectoryOf(ctx.argv);
  let sh: { pid: number } | null = null;
  if (dir !== null) {
    sh = yield* quiet(
      ctx.sys.call('spawn', { path: SHELL_MANIFEST, argv: ['sh'], fds, pgid: 0, cwd: dir }),
    );
  }
  sh ??= yield* ctx.sys.call('spawn', {
    path: SHELL_MANIFEST,
    argv: ['-sh'],
    fds,
    pgid: 0,
    cwd: home,
  });
  st.shPid = sh.pid;
  st.phase = 'running';
  return display;
}

/** Waits for the shell; returns when it ended or a hang-up was asked for. */
function* waitShell(ctx: ProgramContext, st: TermState): SysGen<void> {
  while (st.phase === 'running' && !st.hangup && st.shPid !== null) {
    try {
      const r = yield* ctx.sys.call('wait', { pid: st.shPid });
      if ('status' in r && (r.status.kind === 'exited' || r.status.kind === 'signaled')) {
        st.code = r.status.code;
        st.phase = 'done';
      }
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === 'ESRCH') st.phase = 'done';
      else if (errno !== 'ECANCELED') throw e;
    }
  }
  if (st.phase === 'running') st.phase = 'closing';
}

/**
 * The window's owner while the view runs the shell: serves the view's relayed calls, in order,
 * as this process (so the kernel sees term's pid and the user's credentials), until SIGTERM or
 * SIGHUP. Without a display channel there is nothing to serve and it only sleeps.
 */
function* own(ctx: ProgramContext, st: TermState, port: PortLike | undefined): SysGen<void> {
  const queue: RelayRequest[] = [];
  if (port !== undefined) {
    port.onmessage = (ev: MessageEvent) => {
      const req = parseRelayInput(ev.data);
      if (req !== undefined) queue.push(req);
    };
  }
  let wait = RELAY_QUIET_SLEEP_MS;
  while (!st.hangup) {
    let served = false;
    for (let req = queue.shift(); req !== undefined && port !== undefined; req = queue.shift()) {
      const reply = yield* serveRelay(ctx.sys, req, TERMINAL_RELAY_CALLS);
      st.served += 1;
      served = true;
      try {
        port.postMessage(reply, reply.ok ? transferables(reply.value) : []);
      } catch {
        // The view went away (closed or dehydrated): the reply has no reader.
      }
      if (st.hangup) break;
    }
    if (st.hangup) break;
    wait = nextRelaySleep(wait, served);
    const ms = port === undefined ? OWNER_SLEEP_MS : wait;
    try {
      yield* ctx.sys.call('sleep', { ms });
    } catch (e) {
      // A caught signal interrupts the sleep (ECANCELED); the loop re-checks `hangup`.
      if (errnoOf(e) !== 'ECANCELED') throw e;
    }
  }
  if (port !== undefined) port.onmessage = null;
  st.phase = 'done';
}

/** §3.3 step 3: SIGHUP to the session's foreground group, then up to 1 s for the shell. */
function* close(ctx: ProgramContext, st: TermState): SysGen<void> {
  const pid = st.shPid;
  if (pid !== null && st.waitedMs === 0) {
    yield* quiet(ctx.sys.call('kill', { pid: -pid, sig: 'SIGHUP' }));
    yield* quiet(ctx.sys.call('kill', { pid: -pid, sig: 'SIGCONT' }));
  }
  while (pid !== null && st.waitedMs < HANGUP_GRACE_MS) {
    const r = yield* quiet(ctx.sys.call('wait', { pid, nohang: true }));
    if (r === null || ('status' in r && r.status.kind !== 'stopped')) break;
    yield* quiet(ctx.sys.call('sleep', { ms: 100 }));
    st.waitedMs += 100;
  }
  st.code = 129;
  st.phase = 'done';
}

export const term: Program<TermState> = {
  checkpointable: true,
  init: () => ({
    phase: 'start',
    wid: null,
    hostWindow: false,
    fd: null,
    tty: null,
    shPid: null,
    title: 'Terminal',
    hangup: false,
    code: 0,
    waitedMs: 0,
    ttyError: null,
    served: 0,
  }),
  *run(ctx, st): SysGen<number> {
    // After a page-in or migration the runtime hands over the new display channel (WM §3.12);
    // the one from `window.create` is only there on the first run.
    let display: PortLike | undefined;
    if (st.phase === 'start') display = yield* start(ctx, st);
    display ??= displayOf(ctx);
    if (st.phase === 'owner') yield* own(ctx, st, display);
    if (st.phase === 'running') yield* waitShell(ctx, st);
    if (st.phase === 'closing') yield* close(ctx, st);
    if (st.wid !== null && !st.hostWindow) {
      yield* quiet(ctx.sys.call('window.close', { wid: st.wid }));
    }
    return st.code;
  },
  signal(_ctx: ProgramContext, st: TermState, sig: SignalName): void {
    if (sig === 'SIGTERM' || sig === 'SIGHUP') st.hangup = true;
  },
};

export default term;
