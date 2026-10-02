/**
 * The login flow (boot-and-services.md §3.1 stage 5, BOOT-14; OFF-03): pick a user, submit a
 * password or continue as guest or demo, show the real stage text while verifying (no spinner,
 * DSN-07), shake and clear on a failure, count down a rate-limit back-off, and play the unlock
 * transition before the desktop mounts. Framework-free: the Solid view mirrors `state` and calls
 * the methods; the password goes straight to `auth` and is never kept.
 */
import type { AuthEnv, LoginResult, Session } from './env.ts';
import type { LoginState } from './ui.ts';

export interface LoginModel {
  readonly state: LoginState;
  readonly selectedId: string;
  readonly stage: string | undefined;
  /** Bumped on each failed attempt (the field clears and shakes). */
  readonly errorKey: number;
  readonly errorText: string | undefined;
  /** Epoch ms when the selected user's rate-limit back-off ends. */
  readonly retryAt: number | undefined;
  /** The signed-in session once verified (then `state` is `unlocking`). */
  readonly session: Session | null;
}

export const DEFAULT_LOGIN_ERROR = 'Invalid username or password';

export interface LoginFlowOptions {
  readonly auth: AuthEnv;
  readonly now: () => number;
  readonly onChange: (m: LoginModel) => void;
  /** The unlock transition finished: mount (or reveal) the desktop. */
  readonly onSignedIn: (s: Session) => void;
  /** Lock mode: verify with `auth.unlock` when present. */
  readonly lock?: boolean;
}

export class LoginFlow {
  private m: LoginModel;
  private readonly o: LoginFlowOptions;
  private busy = false;
  /**
   * Back-offs per user id (UI-005): the Guest tile's limit is per network, a password's per
   * account, so a refused guest sign-in never locks the password field of another user.
   */
  private readonly backoff = new Map<string, number>();

  constructor(o: LoginFlowOptions, selectedId: string) {
    this.o = o;
    this.m = {
      state: 'idle',
      selectedId,
      stage: undefined,
      errorKey: 0,
      errorText: undefined,
      retryAt: undefined,
      session: null,
    };
  }

  get model(): LoginModel {
    return this.m;
  }

  private set(patch: Partial<LoginModel>): void {
    this.m = { ...this.m, ...patch };
    this.o.onChange(this.m);
  }

  /** Seconds left in the selected user's rate-limit back-off, or undefined. */
  retryInS(): number | undefined {
    if (this.m.retryAt === undefined) return undefined;
    const s = Math.ceil((this.m.retryAt - this.o.now()) / 1000);
    return s > 0 ? s : undefined;
  }

  /** When `userId`'s back-off ends (epoch ms), or undefined when it has none left. */
  private backoffOf(userId: string): number | undefined {
    const at = this.backoff.get(userId);
    if (at === undefined) return undefined;
    if (at > this.o.now()) return at;
    this.backoff.delete(userId);
    return undefined;
  }

  select(id: string): void {
    if (this.busy || id === this.m.selectedId) return;
    const retryAt = this.backoffOf(id);
    const { state } = this.m;
    this.set({
      selectedId: id,
      errorText: undefined,
      retryAt,
      state:
        retryAt !== undefined
          ? 'rate-limited'
          : state === 'error' || state === 'rate-limited'
            ? 'idle'
            : state,
    });
  }

  /** Called at 1 Hz while rate-limited: leaves the back-off when it ends. */
  tick(): void {
    if (this.m.state === 'rate-limited' && this.retryInS() === undefined) {
      this.backoff.delete(this.m.selectedId);
      this.set({ state: 'idle', retryAt: undefined });
    }
  }

  submit(userId: string, password: string): Promise<void> {
    const { auth, lock } = this.o;
    const verify =
      lock === true && auth.unlock !== undefined
        ? (report: (s: string) => void) => {
            report('Checking password');
            return auth.unlock?.(userId, password) ?? Promise.resolve<LoginResult>({ ok: false });
          }
        : (report: (s: string) => void) => auth.login(userId, password, report);
    return this.run(userId, verify, 'Checking password');
  }

  continueWithout(userId: string): Promise<void> {
    return this.run(userId, (report) => this.o.auth.guest(userId, report), 'Starting session');
  }

  private async run(
    userId: string,
    verify: (report: (stage: string) => void) => Promise<LoginResult>,
    firstStage: string,
  ): Promise<void> {
    if (this.busy || this.m.state === 'unlocking' || this.backoffOf(userId) !== undefined) return;
    this.busy = true;
    this.set({ state: 'verifying', selectedId: userId, stage: firstStage, errorText: undefined });
    let result: LoginResult;
    try {
      result = await verify((stage) => this.set({ stage }));
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    this.busy = false;
    if (result.ok) {
      this.backoff.delete(userId);
      this.set({
        state: 'unlocking',
        stage: 'Loading your desktop',
        retryAt: undefined,
        session: result.session,
      });
      return;
    }
    if (result.retryAt !== undefined && result.retryAt > this.o.now()) {
      this.backoff.set(userId, result.retryAt);
      this.set({
        state: 'rate-limited',
        retryAt: result.retryAt,
        errorKey: this.m.errorKey + 1,
        errorText: result.error,
        stage: undefined,
      });
      return;
    }
    this.set({
      state: 'error',
      errorKey: this.m.errorKey + 1,
      errorText: result.error ?? DEFAULT_LOGIN_ERROR,
      stage: undefined,
    });
  }

  /** The LoginScreen's unlock transition played (`onUnlocked`). */
  unlocked(): void {
    const s = this.m.session;
    if (this.m.state !== 'unlocking' || s === null) return;
    this.o.onSignedIn(s);
  }
}
