/**
 * The `login` service's port (boot-and-services.md §3.2 stage 5; security-model.md §3.7, §3.8;
 * BOOT-14, OFF-03).
 *
 * The session uid is established by exactly one of: the cached server session (`GET /api/auth/me`
 * with the HttpOnly cookie), an online password login (`POST /api/auth/login`), the offline PBKDF2
 * verifier stored per uid (never root, never a guest), or the Guest tile (`POST /api/auth/guest`,
 * or a local guest when the server is unreachable).
 *
 * The login SCREEN is the shell's LoginGate (wm/src/shell/Login.tsx) on the main thread. It talks
 * to this module over the kernel-only ROUTER port (never a view port, never an app):
 *   router → kernel  `login.hello`, `login.submit {rid, user, secret}`, `login.guest {rid}`,
 *                    `login.unlock {rid, user, secret}`, `login.logout`
 *   kernel → router  `login.state {state}`, `login.result {rid, ok, …}`, `login.session`,
 *                    `login.loggedOut`
 * The secret is used once and zeroed; it is never logged, audited or stored in clear text.
 */
import type { AccountKind, LoginMode, LoginOutcome, LoginPort } from '@plotinium/services';
import { GID_USERS, UID_OFFLINE_GUEST } from '@plotinium/protocol';

import { KernelError } from '../errors.ts';
import type { KernelFs } from '../fs/kfs.ts';
import { provisionLocalUser } from '../fs/users.ts';
import { HOME_LOOKUP_LOGIN_MS, linkHome } from './home-link.ts';
import type { Kernel } from '../kernel.ts';
import type { NetMonitor } from '../net/monitor.ts';
import type { AuthMe, ServerApi } from './http.ts';
import type {
  IoToRouter,
  LoginOptions,
  LoginReply,
  LoginViewState,
  LoginViewUser,
  SessionInfo,
} from './types.ts';
import type { OfflineVerifier } from './verifier.ts';

/** The console user once login established it. */
export interface ConsoleSession {
  readonly uid: number;
  readonly username: string;
  readonly kind: AccountKind;
  readonly gid: number;
  readonly groups: readonly number[];
  readonly home: string;
  readonly mode: LoginMode;
  /** The server's view of the account; null for offline and local sessions. */
  readonly me: AuthMe | null;
  /**
   * The id the server minted for this user's home, when sign-in looked it up (UI-006): null, the
   * server has none; absent, not looked up or no answer (`sync` looks again).
   */
  readonly serverHomeIno?: string | null;
}

export const DEFAULT_KNOWN_USERS: readonly string[] = ['demo', 'alice', 'bob'];

/** How long the cached-session check may take (the `login` service has 2 s in total). */
export const RESUME_TIMEOUT_MS = 1_200;

const OFFLINE_HINT = 'Sign in online once to enable offline login';
const INVALID = 'Invalid username or password';
const USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const encoder = new TextEncoder();

export interface LoginIoDeps {
  readonly kernel: Kernel;
  readonly api: ServerApi;
  readonly verifier: OfflineVerifier;
  readonly net: NetMonitor;
  readonly fs: () => KernelFs | null;
  readonly options: LoginOptions;
  readonly post: (msg: IoToRouter) => void;
  /** The session is established: the session service, the desktop, syncd follow. */
  readonly established: (s: ConsoleSession) => void;
  /** Run `fn` after desktop-interactive (the verifier's PBKDF2 is off the boot path). */
  readonly afterInteractive: (fn: () => void) => void;
  readonly epochMs: () => number;
  /** The login screen now waits for a user: the boot reached its target (UI-058). */
  readonly prompted?: () => void;
  /**
   * A sync engine is linked: a new home takes the id the server minted for it, so the user's ops
   * can sync (C5, UI-006). Without one, homes are local ids (standalone).
   */
  readonly serverHomes?: boolean;
}

function sessionKind(k: AccountKind): SessionInfo['kind'] {
  return k === 'guest' ? 'guest' : k === 'demo' ? 'demo' : 'user';
}

function userKindOf(k: AccountKind): 'user' | 'guest' | 'system' {
  return k === 'guest' ? 'guest' : k === 'root' ? 'system' : 'user';
}

export function sessionInfoOf(s: ConsoleSession): SessionInfo {
  return { uid: s.uid, user: s.username, kind: sessionKind(s.kind), home: s.home, mode: s.mode };
}

interface Waiting {
  readonly resolve: (o: LoginOutcome) => void;
  readonly reject: (e: Error) => void;
}

export class LoginIo implements LoginPort {
  private readonly deps: LoginIoDeps;
  private waiting: Waiting | null = null;
  private me: AuthMe | null = null;
  private offline = false;
  private password: Uint8Array | null = null;
  private current: ConsoleSession | null = null;
  private offlineRec: { uid: number; gid: number; groups: readonly number[] } | null = null;
  private busy = false;

  constructor(deps: LoginIoDeps) {
    this.deps = deps;
  }

  get session(): ConsoleSession | null {
    return this.current;
  }

  get isWaiting(): boolean {
    return this.waiting !== null;
  }

  // -- LoginPort ------------------------------------------------------------------------------

  async resume(): Promise<LoginOutcome | null> {
    const { api, net } = this.deps;
    if (!api.available) {
      this.offline = true;
      net.setReachable('offline');
      return null;
    }
    const r = await api.me(RESUME_TIMEOUT_MS);
    this.offline = r.status === 0;
    net.setReachable(r.status === 0 ? 'offline' : 'online');
    if (!r.ok || this.deps.options.autoResume === false) return null;
    this.me = r.body;
    return { uid: r.body.uid, username: r.body.username, kind: r.body.kind, mode: 'cached' };
  }

  /** Wait for the login screen (the shell's LoginGate) to sign someone in. User wait. */
  prompt(_pid: number): Promise<LoginOutcome> {
    this.deps.prompted?.();
    return new Promise<LoginOutcome>((resolve, reject) => {
      this.waiting = { resolve, reject };
      void this.sendState();
    });
  }

  async establish(o: LoginOutcome): Promise<{ readonly home: string }> {
    const fs = this.deps.fs();
    const me = o.mode === 'offline' || o.mode === 'local' ? null : this.me;
    const gid = me?.gid ?? this.offlineRec?.gid ?? GID_USERS;
    const groups = me?.groups.map((g) => g.gid) ?? [...(this.offlineRec?.groups ?? [gid])];
    const home = o.uid === 0 ? '/root' : `/home/${o.username}`;
    // Online with a sync engine: the server's id for the home (C5, UI-006); bounded, so a slow
    // server only means sync links it later.
    const serverHomeIno =
      this.deps.serverHomes === true && me !== null && o.uid !== 0 && fs !== null && !fs.readOnly
        ? await this.deps.api.homeIno(o.username, HOME_LOOKUP_LOGIN_MS)
        : undefined;
    if (fs !== null && o.uid !== 0 && fs.tree.user(o.uid) === undefined && !fs.readOnly) {
      try {
        await provisionLocalUser(fs, {
          uid: o.uid,
          username: o.username,
          gid,
          groups,
          kind: userKindOf(o.kind),
          ...(me === null
            ? {}
            : { quotaBytes: me.quota.quotaBytes, quotaInodes: me.quota.quotaInodes }),
          ...(typeof serverHomeIno === 'string' ? { homeIno: serverHomeIno } : {}),
        });
      } catch (e) {
        if (!(e instanceof KernelError && e.errno === 'EEXIST')) throw e;
      }
    } else if (fs !== null && typeof serverHomeIno === 'string') {
      // A home made before (offline, or by an older build): take the server's id while nothing
      // runs as the user yet, if it is still empty (home-link.ts).
      await linkHome({
        kernel: this.deps.kernel,
        fs,
        api: this.deps.api,
        uid: o.uid,
        username: o.username,
        serverIno: serverHomeIno,
        timeoutMs: HOME_LOOKUP_LOGIN_MS,
      }).catch(() => undefined);
    }
    const s: ConsoleSession = {
      uid: o.uid,
      username: o.username,
      kind: o.kind,
      gid,
      groups,
      home,
      mode: o.mode,
      me,
      ...(serverHomeIno === undefined ? {} : { serverHomeIno }),
    };
    this.current = s;
    this.deps.established(s);
    const pw = this.password;
    this.password = null;
    if (pw !== null && me !== null && me.offlineVerifier.allowed && o.mode === 'online') {
      const account = {
        uid: me.uid,
        username: me.username,
        gid: me.gid,
        groups,
        kind: me.kind,
        passwordVersion: me.passwordVersion,
      };
      this.deps.afterInteractive(() => {
        void this.deps.verifier.create(account, pw).catch((e: unknown) => {
          this.deps.kernel.log(
            'login',
            'warn',
            `offline verifier not saved: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      });
    } else pw?.fill(0);
    return { home };
  }

  stop(): Promise<void> {
    const w = this.waiting;
    this.waiting = null;
    w?.reject(new Error('login stopped'));
    this.password?.fill(0);
    this.password = null;
    return Promise.resolve();
  }

  // -- the login screen -----------------------------------------------------------------------

  private async tiles(): Promise<LoginViewUser[]> {
    const known = this.deps.options.knownUsers ?? DEFAULT_KNOWN_USERS;
    const withVerifier = new Set(await this.deps.verifier.usernames().catch(() => []));
    const fs = this.deps.fs();
    const names = new Set<string>(known);
    for (const n of withVerifier) names.add(n);
    if (fs !== null) {
      for (const u of fs.tree.users.values()) {
        if (u.uid === 0 || u.kind !== 'user' || u.uid === UID_OFFLINE_GUEST) continue;
        names.add(u.username);
      }
    }
    const tiles: LoginViewUser[] = [...names].map((name) =>
      this.offline && !withVerifier.has(name)
        ? { id: name, name, kind: 'user', disabled: true, disabledReason: OFFLINE_HINT }
        : { id: name, name, kind: 'user' },
    );
    if (this.deps.options.guest !== false)
      tiles.push({ id: 'guest', name: 'Guest', kind: 'guest' });
    return tiles;
  }

  async state(): Promise<LoginViewState> {
    const id = this.deps.kernel.host.identity;
    return {
      users: await this.tiles(),
      offline: this.offline,
      waiting: this.waiting !== null,
      session: this.current === null ? null : sessionInfoOf(this.current),
      version: id.version,
      build: id.build,
    };
  }

  /** `login.hello` (and every change of the waiting state): the screen's current state. */
  async sendState(): Promise<void> {
    try {
      this.deps.post({ t: 'login.state', state: await this.state() });
    } catch (e) {
      this.deps.kernel.log(
        'login',
        'warn',
        `login state unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // -- authentication ------------------------------------------------------------------------

  private async authenticate(user: string, secret: string): Promise<LoginOutcome> {
    const { api, verifier, net } = this.deps;
    if (user === 'guest') {
      if (this.deps.options.guest === false)
        throw new KernelError('EPERM', undefined, 'Guest accounts are disabled');
      if (api.available) {
        const r = await api.guest();
        if (r.ok) {
          net.setReachable('online');
          this.me = r.body;
          return { uid: r.body.uid, username: r.body.username, kind: 'guest', mode: 'guest' };
        }
        if (r.status === 429)
          throw new KernelError(
            'EAGAIN',
            {
              reason: 'rate',
              ...(r.retryAfterMs === null ? {} : { retryAfterMs: r.retryAfterMs }),
            },
            'No guest slot is free, try again soon',
          );
        if (r.status !== 0 && r.status < 500)
          throw new KernelError('EPERM', undefined, 'Guest accounts are disabled');
        net.setReachable('offline');
        this.offline = true;
      }
      return { uid: UID_OFFLINE_GUEST, username: 'guest', kind: 'guest', mode: 'local' };
    }
    if (!USERNAME.test(user)) throw new KernelError('EACCES', undefined, INVALID);
    if (api.available) {
      const r = await api.login(user, secret);
      if (r.ok) {
        net.setReachable('online');
        this.offline = false;
        this.me = r.body;
        this.password?.fill(0);
        this.password = encoder.encode(secret);
        await verifier
          .invalidateIfStale(r.body.username, r.body.passwordVersion)
          .catch(() => undefined);
        return { uid: r.body.uid, username: r.body.username, kind: r.body.kind, mode: 'online' };
      }
      if (r.status === 401 || r.status === 403) {
        net.setReachable('online');
        throw new KernelError('EACCES', undefined, INVALID);
      }
      if (r.status === 429)
        throw new KernelError(
          'EAGAIN',
          { reason: 'rate', ...(r.retryAfterMs === null ? {} : { retryAfterMs: r.retryAfterMs }) },
          'Too many attempts',
        );
      if (r.status !== 0 && r.status < 500) throw new KernelError('EACCES', undefined, INVALID);
      net.setReachable('offline');
      this.offline = true;
    }
    // Server unreachable: the offline verifier (OFF-03).
    const c = await verifier.check(user, encoder.encode(secret));
    if (c.ok) {
      this.offlineRec = { uid: c.rec.uid, gid: c.rec.gid, groups: c.rec.groups };
      return {
        uid: c.rec.uid,
        username: c.rec.username,
        kind: c.rec.kind === 'demo' ? 'demo' : 'user',
        mode: 'offline',
      };
    }
    if (c.why === 'locked')
      throw new KernelError(
        'EAGAIN',
        {
          reason: 'rate',
          ...(c.retryAfterMs === undefined ? {} : { retryAfterMs: Math.ceil(c.retryAfterMs) }),
        },
        'Too many attempts',
      );
    if (c.why === 'wrong') throw new KernelError('EACCES', undefined, INVALID);
    throw new KernelError('EACCES', undefined, OFFLINE_HINT);
  }

  private failure(e: unknown): LoginReply {
    const ke = e instanceof KernelError ? e : new KernelError('EIO', undefined, 'Sign-in failed');
    const retryAfterMs = ke.errno === 'EAGAIN' ? ke.detail?.retryAfterMs : undefined;
    return {
      ok: false,
      error: ke.message,
      ...(retryAfterMs === undefined
        ? {}
        : { retryAt: Math.floor(this.deps.epochMs()) + retryAfterMs }),
    };
  }

  /** `login.submit` / `login.guest`: resolve the waiting `login` service on success. */
  async submit(user: string, secret: string): Promise<LoginReply> {
    const w = this.waiting;
    if (w === null) {
      const s = this.current;
      return s !== null && s.username === user
        ? { ok: true, session: sessionInfoOf(s) }
        : { ok: false, error: 'Nobody can sign in right now' };
    }
    if (this.busy) return { ok: false, error: 'A sign-in is in progress' };
    this.busy = true;
    try {
      const o = await this.authenticate(user, secret);
      this.waiting = null;
      w.resolve(o);
      const home = o.uid === 0 ? '/root' : `/home/${o.username}`;
      return {
        ok: true,
        session: { uid: o.uid, user: o.username, kind: sessionKind(o.kind), home, mode: o.mode },
      };
    } catch (e) {
      return this.failure(e);
    } finally {
      this.busy = false;
    }
  }

  /** `login.unlock`: the lock screen checks the console user's password (online, else offline). */
  async unlock(user: string, secret: string): Promise<LoginReply> {
    const s = this.current;
    if (s === null || s.username !== user) return { ok: false, error: INVALID };
    if (s.mode === 'local' || s.kind === 'guest') return { ok: true, session: sessionInfoOf(s) };
    const { api, verifier } = this.deps;
    try {
      if (api.available) {
        const r = await api.login(user, secret);
        if (r.ok) return { ok: true, session: sessionInfoOf(s) };
        if (r.status !== 0)
          return this.failure(
            new KernelError(
              r.status === 429 ? 'EAGAIN' : 'EACCES',
              undefined,
              r.status === 429 ? 'Too many attempts' : INVALID,
            ),
          );
      }
      const c = await verifier.check(user, encoder.encode(secret));
      return c.ok
        ? { ok: true, session: sessionInfoOf(s) }
        : this.failure(
            new KernelError('EACCES', undefined, c.why === 'none' ? OFFLINE_HINT : INVALID),
          );
    } catch (e) {
      return this.failure(e);
    }
  }

  /** `login.logout` / `auth.logout`: end the server session; the router reloads to the login screen. */
  async logout(): Promise<void> {
    if (this.current !== null && this.current.mode !== 'local' && this.current.mode !== 'offline')
      await this.deps.api.logout();
    this.current = null;
    this.me = null;
  }
}
