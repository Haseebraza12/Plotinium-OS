/**
 * Live `su` grants per auth session, as the /ws connections and POST /api/ops see them
 * (backend-api.md §3.8.6, §3.17; offline-and-sync.md §3.8.6).
 *
 * A socket authenticates once, at the upgrade, but a grant can start or end afterwards (su, exit,
 * DELETE /api/auth/su, the fixed 15-minute expiry). The registry is the in-process source of truth
 * the connections read from `ConnAuth.suGrants()`; it is seeded from the cookie session at the
 * upgrade and updated by the gateway's su routes. When a grant ends it calls `onEnded`, which
 * sends proc.signal SIGHUP to the session's sockets (SyncHub.suEnded).
 *
 * One grant per auth session (auth_sessions.su_uid): a new su replaces the previous grant.
 */

export type SuEndReason = 'su-expired' | 'su-revoked';

export interface SuGrant {
  readonly uid: number;
  readonly expiresAt: Date;
  /** Primary gid first, then supplementary groups of the granted uid (server-side lookup). */
  readonly gids: readonly number[];
}

export interface TimerHandle {
  unref?(): unknown;
}

export interface SuGrantsOptions {
  readonly onEnded: (authSessionId: string, uid: number, reason: SuEndReason) => void;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimer?: (t: TimerHandle) => void;
}

interface Entry {
  readonly grant: SuGrant;
  readonly timer: TimerHandle;
}

/** setTimeout caps delays at 2^31-1 ms; grants are 15 minutes, so a longer one is re-armed. */
const MAX_DELAY_MS = 2_147_483_647;

export class SuGrants {
  readonly #entries = new Map<string, Entry>();
  readonly #o: SuGrantsOptions;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => TimerHandle;
  readonly #clearTimer: (t: TimerHandle) => void;

  constructor(options: SuGrantsOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return t;
      });
    this.#clearTimer =
      options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  get size(): number {
    return this.#entries.size;
  }

  /** A new grant (POST /api/auth/su) or the grant a socket found at its upgrade. */
  set(authSessionId: string, grant: SuGrant): void {
    const previous = this.#entries.get(authSessionId);
    if (previous !== undefined) {
      this.#clearTimer(previous.timer);
      this.#entries.delete(authSessionId);
      // A replaced grant for another uid ends for that uid's processes.
      if (previous.grant.uid !== grant.uid)
        this.#o.onEnded(authSessionId, previous.grant.uid, 'su-revoked');
    }
    if (grant.expiresAt.getTime() <= this.#now()) return;
    this.#entries.set(authSessionId, { grant, timer: this.#arm(authSessionId, grant) });
  }

  /**
   * Seeds the registry from a cookie session at the upgrade; a grant the registry already knows
   * (set by the su route of this process) wins, because it is at least as new.
   */
  seed(authSessionId: string, grant: SuGrant | null): void {
    if (grant === null || this.#entries.has(authSessionId)) return;
    this.set(authSessionId, grant);
  }

  /** DELETE /api/auth/su/{uid} (the elevated shell exited): SIGHUP 'su-revoked'. */
  revoke(authSessionId: string, uid: number): void {
    const e = this.#entries.get(authSessionId);
    if (e?.grant.uid !== uid) {
      this.#o.onEnded(authSessionId, uid, 'su-revoked');
      return;
    }
    this.#clearTimer(e.timer);
    this.#entries.delete(authSessionId);
    this.#o.onEnded(authSessionId, uid, 'su-revoked');
  }

  /** The auth session itself ended (logout, revocation): drop its grant without a signal. */
  forget(authSessionIds: readonly string[]): void {
    for (const id of authSessionIds) {
      const e = this.#entries.get(id);
      if (e === undefined) continue;
      this.#clearTimer(e.timer);
      this.#entries.delete(id);
    }
  }

  /** Live grants of an auth session (0 or 1). */
  grantsOf(authSessionId: string): readonly { readonly uid: number; readonly expiresAt: Date }[] {
    const e = this.#entries.get(authSessionId);
    if (e === undefined || e.grant.expiresAt.getTime() <= this.#now()) return [];
    return [{ uid: e.grant.uid, expiresAt: e.grant.expiresAt }];
  }

  /** Groups of the granted uid, or undefined when `uid` holds no live grant on the session. */
  gidsOf(authSessionId: string, uid: number): readonly number[] | undefined {
    const e = this.#entries.get(authSessionId);
    if (e === undefined || e.grant.uid !== uid || e.grant.expiresAt.getTime() <= this.#now())
      return undefined;
    return e.grant.gids;
  }

  stop(): void {
    for (const e of this.#entries.values()) this.#clearTimer(e.timer);
    this.#entries.clear();
  }

  #arm(authSessionId: string, grant: SuGrant): TimerHandle {
    const delay = Math.min(MAX_DELAY_MS, Math.max(0, grant.expiresAt.getTime() - this.#now()));
    return this.#setTimer(() => {
      const e = this.#entries.get(authSessionId);
      if (e?.grant !== grant) return;
      if (grant.expiresAt.getTime() > this.#now()) {
        this.#entries.set(authSessionId, { grant, timer: this.#arm(authSessionId, grant) });
        return;
      }
      this.#entries.delete(authSessionId);
      this.#o.onEnded(authSessionId, grant.uid, 'su-expired');
    }, delay);
  }
}
