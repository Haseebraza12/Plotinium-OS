/**
 * Opaque server-side sessions: creation, validation with sliding expiry, revocation
 * (backend-api.md §3.8.1-§3.8.4, §5.3; security-model.md §3.7; SRV-08, C10).
 *
 * validate(cookie), exactly as §3.8.3:
 *   malformed -> no session; unknown id or SHA-256(secret) mismatch (constant time) -> no session;
 *   revoked -> no session; past expires_at or absolute_expires_at -> revoke, no session;
 *   disabled account -> revoke, no session;
 *   non-guest and last_used_at older than 1 h -> expires_at = min(now + 10 d, absolute), written at
 *   most once an hour (bounded write amplification); guests never slide (2 h absolute).
 * Revocation sets revoked_at, audits session.revoke and notifies the listeners after the write
 * (the sync plugin closes the sockets with 4401, the lock manager releases leases; neither uses a
 * foreign-key cascade, C7).
 */
import { newSessionToken, parseSessionToken, secretMatches, type SessionToken } from './tokens.ts';
import type { AccountKind, AuthStore, NewSession } from './store.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const USER_AGENT_MAX_BYTES = 512;

export interface SessionPolicy {
  readonly slidingMs: number;
  readonly absoluteMs: number;
  readonly guestMs: number;
  /** How stale last_used_at must be before a slide is written (1 h). */
  readonly slideAfterMs: number;
}

export function sessionPolicy(days: {
  slidingDays: number;
  absoluteDays: number;
  guestHours: number;
}): SessionPolicy {
  return {
    slidingMs: days.slidingDays * DAY_MS,
    absoluteMs: days.absoluteDays * DAY_MS,
    guestMs: days.guestHours * HOUR_MS,
    slideAfterMs: HOUR_MS,
  };
}

/** The authenticated session of a request (request.plt.auth). */
export interface AuthState {
  readonly authSessionId: string;
  readonly uid: number;
  readonly kind: AccountKind;
  readonly gids: readonly number[];
  readonly suGrant: { readonly uid: number; readonly expiresAt: Date } | null;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface ValidateResult {
  readonly auth: AuthState | null;
  /** Set when the slide moved expires_at: the cookie is re-sent with the new Max-Age. */
  readonly slid: boolean;
}

export interface CreatedSession {
  readonly token: SessionToken;
  readonly record: NewSession;
}

export type RevocationReason = 'logout' | 'login' | 'expired' | 'disabled' | 'password' | 'admin';
export type RevocationListener = (ids: readonly string[], reason: RevocationReason) => void;

export class SessionService {
  readonly #store: AuthStore;
  readonly #policy: SessionPolicy;
  readonly #now: () => number;
  readonly #listeners: RevocationListener[] = [];

  constructor(store: AuthStore, policy: SessionPolicy, now: () => number = Date.now) {
    this.#store = store;
    this.#policy = policy;
    this.#now = now;
  }

  get policy(): SessionPolicy {
    return this.#policy;
  }

  /** Called by the sync plugin (sockets: bye revoked, close 4401) and the lock manager (leases). */
  onRevoke(listener: RevocationListener): void {
    this.#listeners.push(listener);
  }

  /** A NEW record every time: an id presented by the client is never reused (fixation defence). */
  newSession(
    kind: AccountKind,
    userAgent: string | undefined,
    absoluteCapMs?: number,
  ): CreatedSession {
    const now = this.#now();
    const token = newSessionToken();
    const guest = kind === 'guest';
    const absolute = Math.min(
      now + (guest ? this.#policy.guestMs : this.#policy.absoluteMs),
      absoluteCapMs ?? Infinity,
    );
    const expires = guest ? absolute : Math.min(now + this.#policy.slidingMs, absolute);
    return {
      token,
      record: {
        id: token.id,
        secretHash: token.secretHash,
        createdAt: new Date(now),
        expiresAt: new Date(expires),
        absoluteExpiresAt: new Date(absolute),
        userAgent: truncateUtf8(userAgent, USER_AGENT_MAX_BYTES),
      },
    };
  }

  async create(
    uid: number,
    kind: AccountKind,
    userAgent: string | undefined,
  ): Promise<CreatedSession> {
    const created = this.newSession(kind, userAgent);
    await this.#store.insertSession(uid, created.record);
    return created;
  }

  async validate(cookieValue: string | undefined): Promise<ValidateResult> {
    const none: ValidateResult = { auth: null, slid: false };
    const parsed = parseSessionToken(cookieValue);
    if (parsed === null) return none;
    const row = await this.#store.findSession(parsed.id);
    if (row === null || !secretMatches(parsed.secret, row.secretHash)) return none;
    if (row.revokedAt !== null) return none;
    const now = this.#now();
    if (now >= row.expiresAt.getTime() || now >= row.absoluteExpiresAt.getTime()) {
      await this.revoke([row.id], 'expired', row.uid);
      return none;
    }
    if (row.disabled) {
      await this.revoke([row.id], 'disabled', row.uid);
      return none;
    }
    let expiresAt = row.expiresAt;
    let slid = false;
    if (row.kind !== 'guest' && now - row.lastUsedAt.getTime() > this.#policy.slideAfterMs) {
      expiresAt = new Date(Math.min(now + this.#policy.slidingMs, row.absoluteExpiresAt.getTime()));
      await this.#store.touchSession(row.id, expiresAt, new Date(now));
      slid = expiresAt.getTime() !== row.expiresAt.getTime();
    }
    const grantLive =
      row.suUid !== null && row.suExpiresAt !== null && row.suExpiresAt.getTime() > now;
    return {
      slid,
      auth: {
        authSessionId: row.id,
        uid: row.uid,
        kind: row.kind,
        gids: row.gids,
        suGrant:
          grantLive && row.suUid !== null && row.suExpiresAt !== null
            ? { uid: row.suUid, expiresAt: row.suExpiresAt }
            : null,
        expiresAt,
        absoluteExpiresAt: row.absoluteExpiresAt,
      },
    };
  }

  /** Revokes `ids`, audits each revocation, then notifies the listeners. */
  async revoke(
    ids: readonly string[],
    reason: RevocationReason,
    uid: number,
  ): Promise<readonly string[]> {
    const revoked = await this.#store.revokeSessions(ids, new Date(this.#now()));
    if (revoked.length === 0) return revoked;
    await this.#store.audit({
      event: 'session.revoke',
      uid,
      realUid: uid,
      actor: reason === 'logout' || reason === 'password' ? 'user' : 'system',
      outcome: 'ok',
      detail: { reason, sessions: revoked.length },
    });
    for (const listener of this.#listeners) listener(revoked, reason);
    return revoked;
  }

  /** Seconds until `expiresAt`, for the cookie's Max-Age. */
  maxAgeSeconds(expiresAt: Date): number {
    return Math.max(0, Math.floor((expiresAt.getTime() - this.#now()) / 1000));
  }
}

function truncateUtf8(value: string | undefined, maxBytes: number): string | null {
  if (value === undefined || value === '') return null;
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  // Cut on a character boundary: decode the prefix and drop a trailing replacement character.
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
}
