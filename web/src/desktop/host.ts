/**
 * The desktop host: composes the graphical shell (@plotinium/wm/shell) with the kernel link and
 * the apps registry (window-manager.md §3.1; boot-and-services.md §3.2 stages 5–6). Loaded lazily
 * by main.ts, so none of it is in the boot-critical chunk (BOOT-10).
 *
 * - LOGIN channel: the kernel's `login` service speaks `login.*` on the router port
 *   (kernel/src/host/router-protocol.ts); `AuthEnv` maps onto it. The login screen is the shell's
 *   own (`LoginGate`), mounted when `login` starts, so the desktop mounts under the unlock
 *   transition without a second render.
 * - Compositor port: the shell's end of the wm channel (attached at stage 2); the shell creates
 *   the compositor and binds it. Window views get view-port clients from `createViewSys`.
 * - Apps: `createShellAppRegistry(APP_DESCRIPTORS, …)`, whose views reach their processes over
 *   the window's display channel for executor-only calls.
 * - Preferences: the shell's own `Prefs` and the apps' `DesktopPrefs` are kept in step
 *   (toShellPrefs / fromShellPrefs) and remembered per browser.
 */
import '@plotinium/ui/fonts.css';

import type { AppEnv, AppPrefs, DesktopPrefs, TeamIdentity } from '@plotinium/apps';
import {
  APP_DESCRIPTORS,
  applyAppearance,
  createMemoryPrefs,
  createShellAppRegistry,
  DEFAULT_PREFS as DEFAULT_DESKTOP_PREFS,
  fromShellPrefs,
  parseTeamIdentity,
  toShellPrefs,
} from '@plotinium/apps';
import type { KernelToRouter, RouterToKernel } from '@plotinium/kernel/host/main';
import { createViewSys, SysError } from '@plotinium/kernel/sys';
import type { LoginUser } from '@plotinium/ui';
import type {
  AuthEnv,
  DesktopEnv,
  DesktopHandle,
  LoginResult,
  PowerAction,
  Prefs,
  Session,
  ViewSysClient,
  WindowBinding,
} from '@plotinium/wm/shell';
import { mountDesktop as mountShell } from '@plotinium/wm/shell';

import type { BootContext } from '../boot/driver.ts';
import { IDENTITY } from '../identity.ts';
import { fileSearch, HostChannel, queuedOps, violationMessage } from './host-channel.ts';

declare const __AI__: boolean;

// ---------------------------------------------------------------------------------------------
// The LOGIN channel
// ---------------------------------------------------------------------------------------------

type LoginToRouter = Extract<KernelToRouter, { readonly t: `login.${string}` }>;
type LoginStateMsg = Extract<LoginToRouter, { readonly t: 'login.state' }>;
type LoginViewState = LoginStateMsg['state'];
type SessionInfo = NonNullable<LoginViewState['session']>;
type LoginReplyMsg = Extract<LoginToRouter, { readonly t: 'login.result' }>;
type LoginRequest =
  | { readonly t: 'login.submit'; readonly user: string; readonly secret: string }
  | { readonly t: 'login.guest' }
  | { readonly t: 'login.unlock'; readonly user: string; readonly secret: string };

const LOGIN_TYPES: ReadonlySet<string> = new Set([
  'login.state',
  'login.result',
  'login.session',
  'login.loggedOut',
  'login.lock',
]);

function isLoginMessage(m: unknown): m is LoginToRouter {
  if (typeof m !== 'object' || m === null) return false;
  const t = (m as { t?: unknown }).t;
  return typeof t === 'string' && LOGIN_TYPES.has(t);
}

/** How long a login waits for the kernel's first `login.state` before showing what it has. */
const LOGIN_STATE_WAIT_MS = 4_000;
/** A sign-in request the kernel never answered (it answers every one; this is a backstop). */
const LOGIN_REPLY_TIMEOUT_MS = 60_000;

export interface LoginEvents {
  lock(): void;
  loggedOut(): void;
}

/** The router side of the kernel's `login` service (kernel/src/core/io/login.ts). */
export class LoginChannel {
  state: LoginViewState | null = null;
  session: SessionInfo | null = null;
  osSessionId = '';
  private nextRid = 1;
  private readonly pending = new Map<number, (r: LoginReplyMsg) => void>();
  private readonly changed = new Set<() => void>();
  private readonly post: (m: RouterToKernel) => void;
  private readonly events: LoginEvents;

  constructor(kernel: BootContext['kernel'], events: LoginEvents) {
    this.post = (m) => {
      kernel.post(m);
    };
    this.events = events;
    kernel.onMessage((m) => {
      if (isLoginMessage(m)) this.receive(m);
    });
  }

  private receive(m: LoginToRouter): void {
    switch (m.t) {
      case 'login.state':
        this.state = m.state;
        if (m.state.session !== null) this.session = m.state.session;
        break;
      case 'login.result': {
        const done = this.pending.get(m.rid);
        this.pending.delete(m.rid);
        done?.(m);
        break;
      }
      case 'login.session':
        this.session = m.session;
        this.osSessionId = m.osSessionId;
        break;
      case 'login.loggedOut':
        this.events.loggedOut();
        break;
      case 'login.lock':
        this.events.lock();
        break;
    }
    for (const fn of [...this.changed]) fn();
  }

  /** Ask for the current state (the kernel also posts it when it starts waiting). */
  hello(): void {
    this.post({ t: 'login.hello' });
  }

  /** Resolves once the kernel waits for a user or a session exists (or after a short wait). */
  ready(): Promise<void> {
    const done = (): boolean => this.session !== null || this.state?.waiting === true;
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = (): void => {
        this.changed.delete(check);
        clearTimeout(timer);
        resolve();
      };
      const check = (): void => {
        if (done()) finish();
      };
      const timer = setTimeout(finish, LOGIN_STATE_WAIT_MS);
      this.changed.add(check);
      this.hello();
    });
  }

  request(req: LoginRequest): Promise<LoginReplyMsg> {
    const rid = this.nextRid++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        resolve({ t: 'login.result', rid, ok: false, error: 'The system did not answer' });
      }, LOGIN_REPLY_TIMEOUT_MS);
      this.pending.set(rid, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.post({ ...req, rid });
    });
  }
}

function toSession(s: SessionInfo): Session {
  return { uid: s.uid, user: s.user, kind: s.kind };
}

function toResult(r: LoginReplyMsg): LoginResult {
  if (r.ok) return { ok: true, session: toSession(r.session) };
  return r.retryAt === undefined
    ? { ok: false, error: r.error }
    : { ok: false, error: r.error, retryAt: r.retryAt };
}

const GUEST_TILE: LoginUser = { id: 'guest', name: 'Guest', kind: 'guest' };

function loginUsers(state: LoginViewState | null): LoginUser[] {
  if (state === null) return [GUEST_TILE];
  return state.users.map((u) => {
    const tile: LoginUser = { id: u.id, name: u.name, kind: u.kind };
    if (u.disabled === true) tile.disabled = true;
    if (u.disabledReason !== undefined) tile.disabledReason = u.disabledReason;
    return tile;
  });
}

/** `AuthEnv` over the LOGIN channel; the user-wait clock follows the screen (§3.2 stage 5). */
export function loginAuth(chan: LoginChannel, ctx: Pick<BootContext, 'userWait'>): AuthEnv {
  const attempt = async (req: LoginRequest, report: (stage: string) => void, stage: string) => {
    report(stage);
    ctx.userWait('end');
    const r = await chan.request(req);
    if (r.ok) report('Loading your desktop');
    else ctx.userWait('begin');
    return toResult(r);
  };
  return {
    users: () => loginUsers(chan.state),
    login: (user, password, report) =>
      attempt({ t: 'login.submit', user, secret: password }, report, 'Checking password'),
    guest: (user, report) =>
      attempt(
        user === GUEST_TILE.id ? { t: 'login.guest' } : { t: 'login.submit', user, secret: '' },
        report,
        'Starting a guest session',
      ),
    offline: () => chan.state?.offline ?? false,
    current: () => (chan.session === null ? null : toSession(chan.session)),
    shown: () => {
      ctx.userWait('begin');
    },
    unlock: async (user, password) =>
      toResult(await chan.request({ t: 'login.unlock', user, secret: password })),
  };
}

// ---------------------------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------------------------

const DESKTOP_PREFS_KEY = 'plotinium.prefs.desktop';
const SHELL_PREFS_KEY = 'plotinium.prefs.shell';

function readJson(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or storage off: the preferences last for this session only.
  }
}

/** The saved desktop preferences, keeping only known keys whose type matches the default. */
function savedDesktopPrefs(): Partial<DesktopPrefs> {
  const raw = readJson(DESKTOP_PREFS_KEY);
  const out: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(DEFAULT_DESKTOP_PREFS)) {
    const v = raw[k];
    if (v !== undefined && typeof v === typeof def) out[k] = v;
  }
  return out;
}

function savedShellPrefs(): Partial<Prefs> {
  const raw = readJson(SHELL_PREFS_KEY);
  const out: { -readonly [K in keyof Prefs]?: Prefs[K] } = {};
  if (raw['frameMeter'] === true || raw['frameMeter'] === false) out.frameMeter = raw['frameMeter'];
  if (raw['focusMode'] === true || raw['focusMode'] === false) out.focusMode = raw['focusMode'];
  return out;
}

/**
 * True when every preference the host derives from Settings already matches the shell's current
 * prefs. Compares EVERY key of `toShellPrefs(...)` (theme, reduced motion, dock size and
 * magnification, clock, title double-click, minimise effect, …) so that a change to any one of
 * them is applied live without a reload (UI-040).
 */
function sameShellPrefs(a: ReturnType<typeof toShellPrefs>, b: Prefs): boolean {
  const current = b as unknown as Readonly<Record<string, unknown>>;
  return Object.entries(a).every(([key, value]) => Object.is(value, current[key]));
}

// ---------------------------------------------------------------------------------------------
// The desktop
// ---------------------------------------------------------------------------------------------

function deniedSys(reason: string): ViewSysClient {
  return {
    call: () => Promise.reject(new SysError('EPERM', reason)),
    closed: true,
  };
}

async function loadTeam(): Promise<TeamIdentity | undefined> {
  try {
    const r = await fetch('/branding/identity.json', { credentials: 'same-origin' });
    return r.ok ? parseTeamIdentity(await r.json()) : undefined;
  } catch {
    return undefined;
  }
}

class DesktopHost {
  private readonly ctx: BootContext;
  private readonly port: MessagePort;
  readonly chan: LoginChannel;
  private handle: DesktopHandle | null = null;
  private desktopUp = false;
  private readonly upWaiters: (() => void)[] = [];
  private team: TeamIdentity | undefined;
  private readonly prefs: AppPrefs;
  /** Kernel requests the shell needs and no app can make (./host-channel.ts). */
  private readonly host: HostChannel;

  constructor(ctx: BootContext, port: MessagePort) {
    this.ctx = ctx;
    this.port = port;
    this.host = new HostChannel(ctx.kernel);
    // CSP and Trusted Types violations go to the kernel log (security-model.md §3.9, UI-137).
    document.addEventListener('securitypolicyviolation', (e) => {
      ctx.kernel.post(violationMessage(e));
    });
    this.chan = new LoginChannel(ctx.kernel, {
      lock: () => this.handle?.lock(),
      loggedOut: () => {
        window.location.replace('/');
      },
    });
    const root = document.documentElement;
    this.prefs = createMemoryPrefs(savedDesktopPrefs(), (p) => {
      applyAppearance(root, p);
      writeJson(DESKTOP_PREFS_KEY, p);
      const h = this.handle;
      const shell = toShellPrefs(p);
      if (h !== null && !sameShellPrefs(shell, h.prefs())) h.setPrefs(shell);
    });
    applyAppearance(root, this.prefs.get());
    void loadTeam().then((t) => {
      this.team = t;
    });
  }

  get mounted(): boolean {
    return this.handle !== null;
  }

  private appEnv(): AppEnv {
    const env: AppEnv = {
      identity: IDENTITY,
      prefs: this.prefs,
      aiAvailable: __AI__,
      nextBoot: (f) => {
        this.ctx.setMenuNextBoot(f.menuNextBoot);
      },
    };
    return this.team === undefined ? env : { ...env, team: this.team };
  }

  private post(msg: unknown): void {
    this.port.postMessage(msg);
  }

  private power(action: PowerAction): void {
    // The kernel runs the BOOT-12 steps and ends with `kernel.halted {restart}`; the boot menu
    // on the next boot is the router's one-shot flag.
    if (action === 'reboot-menu') {
      this.ctx.setMenuNextBoot(true);
      this.post({ t: 'power', action: 'reboot' });
      return;
    }
    this.post({ t: 'power', action });
  }

  private env(): DesktopEnv {
    const apps = createShellAppRegistry(APP_DESCRIPTORS, { env: () => this.appEnv() });
    const initial: Partial<Prefs> = { ...savedShellPrefs(), ...toShellPrefs(this.prefs.get()) };
    return {
      identity: IDENTITY,
      kernel: {
        compositorPort: this.port,
        viewSys: (win: WindowBinding, h) =>
          win.viewPort === null
            ? deniedSys('this window has no view port')
            : createViewSys(win.viewPort, {
                onEvents: (batch) => {
                  h.onEvents(batch);
                },
                onTtyOut: (data) => {
                  h.onTtyOut(data);
                },
                onClose: (reason) => {
                  h.onClose(reason);
                },
              }),
      },
      apps,
      auth: loginAuth(this.chan, this.ctx),
      prefs: {
        initial,
        save: (p) => {
          writeJson(SHELL_PREFS_KEY, { frameMeter: p.frameMeter, focusMode: p.focusMode });
          const diff = fromShellPrefs(p, this.prefs.get());
          for (const [k, v] of Object.entries(diff) as [keyof DesktopPrefs, never][])
            void this.prefs.set(k, v);
        },
      },
      power: (action) => {
        this.power(action);
      },
      // UI-047: the Control Centre's memory budget, set as Settings sets it (`mm.budget`).
      setMemoryBudget: async (mb) => {
        try {
          await this.host.request({ op: 'mem.budget', mb });
          return undefined;
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      },
      // UI-026: the operations waiting in the outbox, as the kernel last reported them.
      outbox: () => queuedOps(this.host.outbox),
      // UI-045: file and folder names under the user's home; the shell adds its app results.
      search: fileSearch(
        this.host,
        () => this.chan.session?.home ?? '/',
        (app, argv) => {
          this.post({ t: 'launch', app, argv: [...argv] });
        },
      ),
      update: {
        offer: () => {
          const w = this.ctx.update.state().waiting;
          return w === null ? null : { version: w.version, build: w.build, size: '', notes: [] };
        },
        restart: () => {
          this.post({ t: 'power', action: 'reboot' });
        },
      },
      ai: __AI__,
      onPhase: (phase) => {
        if (phase !== 'desktop') return;
        this.desktopUp = true;
        for (const fn of this.upWaiters.splice(0)) fn();
      },
    };
  }

  mount(root: HTMLElement): void {
    if (this.handle !== null) return;
    const handle = mountShell(root, this.env());
    this.handle = handle;
    this.host.refreshOutbox();
    const hooks = this.ctx.testHooks;
    if (hooks !== null) {
      hooks.sessionId = () => handle.sessionId() ?? this.chan.osSessionId;
      hooks.layout = () => handle.layout();
    }
  }

  /** Resolves once the desktop (not the login screen) has mounted. */
  whenDesktop(): Promise<void> {
    if (this.desktopUp) return Promise.resolve();
    return new Promise((resolve) => {
      this.upWaiters.push(resolve);
    });
  }
}

let host: DesktopHost | null = null;

function hostFor(ctx: BootContext, port: MessagePort | null): DesktopHost {
  if (host !== null) return host;
  if (port === null) throw new Error('the compositor port was never attached');
  host = new DesktopHost(ctx, port);
  return host;
}

/** `ShellHooks.mountLogin`: the shell with its login screen, once the kernel waits for a user. */
export async function mountLogin(
  root: HTMLElement,
  ctx: BootContext,
  port: MessagePort | null,
): Promise<void> {
  const h = hostFor(ctx, port);
  await h.chan.ready();
  h.mount(root);
}

/** `ShellHooks.mountDesktop`: mount (when login did not) and resolve once the desktop is up. */
export async function mountDesktop(
  root: HTMLElement,
  ctx: BootContext,
  port: MessagePort | null,
): Promise<void> {
  const h = hostFor(ctx, port);
  if (!h.mounted) {
    await h.chan.ready();
    h.mount(root);
  }
  await h.whenDesktop();
}
