/**
 * The persistence the gateway needs, as one interface (backend-api.md §3.6.1, §3.8;
 * database.md §3.16). `KyselyAuthStore` (kysely-store.ts) implements it on PostgreSQL; unit tests
 * use an in-memory double. Every method is one short transaction or one statement: no row lock
 * or connection is held across an Argon2 hash.
 */

export type AccountKind = 'root' | 'user' | 'guest' | 'demo' | 'examiner';

/** Server security events written to audit_log.syscall (backend-api.md §4.4). */
export type SecurityEvent =
  | 'login.success'
  | 'login.failure'
  | 'logout'
  | 'session.revoke'
  | 'su.grant'
  | 'su.fail'
  | 'su.revoke'
  | 'guest.create'
  | 'password.change';

/** The row a login or su verifies against. */
export interface LoginUser {
  readonly uid: number;
  readonly username: string;
  readonly kind: AccountKind;
  /** PHC Argon2id string; NULL for guests; '!' = locked (never verifies). */
  readonly passwordHash: string | null;
  readonly disabled: boolean;
}

/** An auth_sessions row joined with the owner's identity (one primary-key lookup). */
export interface SessionRecord {
  readonly id: string;
  readonly uid: number;
  readonly secretHash: Uint8Array;
  readonly lastUsedAt: Date;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly suUid: number | null;
  readonly suExpiresAt: Date | null;
  readonly kind: AccountKind;
  readonly disabled: boolean;
  /** Primary gid first, then the supplementary groups (user_groups), without duplicates. */
  readonly gids: readonly number[];
}

export interface NewSession {
  readonly id: string;
  readonly secretHash: Uint8Array;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly userAgent: string | null;
}

export interface Credentials {
  readonly uid: number;
  readonly gids: readonly number[];
}

export interface UserProfile {
  readonly uid: number;
  readonly username: string;
  readonly kind: AccountKind;
  readonly primaryGid: number;
  readonly groups: readonly { readonly gid: number; readonly name: string }[];
  readonly quotaBytes: number;
  readonly quotaInodes: number;
  readonly usedBytes: number;
  readonly usedInodes: number;
  readonly passwordVersion: number;
  readonly telemetryOptIn: boolean;
}

export interface AuditEntry {
  readonly event: SecurityEvent;
  /** Effective uid (0 with actor 'system' when no account is known, e.g. an unknown login name). */
  readonly uid: number;
  readonly realUid: number;
  readonly actor: 'user' | 'system';
  readonly outcome: 'ok' | 'denied' | 'error';
  readonly errno?: string;
  /** Never a password, token, key or file content (security-model.md §4.3). */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface GuestRequest {
  readonly now: Date;
  readonly maxActive: number;
  readonly quotaBytes: number;
  readonly quotaInodes: number;
  /** Four random base32 characters per call; the store retries on a name collision. */
  readonly suffix: () => string;
  readonly session: NewSession;
}

export type GuestResult =
  | { readonly ok: true; readonly uid: number; readonly username: string }
  | { readonly ok: false; readonly reason: 'full' | 'no-uid' };

export interface AuthStore {
  findLoginUser(username: string): Promise<LoginUser | null>;
  findSession(id: string): Promise<SessionRecord | null>;
  insertSession(uid: number, session: NewSession): Promise<void>;
  /** Sliding expiry: written at most once an hour per session (§3.8.3). */
  touchSession(id: string, expiresAt: Date, lastUsedAt: Date): Promise<void>;
  /** Sets revoked_at on the live sessions among `ids`; returns the ids actually revoked. */
  revokeSessions(ids: readonly string[], at: Date): Promise<readonly string[]>;
  /** Ids of the uid's sessions that are neither revoked nor past their absolute expiry. */
  liveSessionIds(uid: number, at: Date): Promise<readonly string[]>;
  /** One grant per session: a new grant replaces the old one; null clears it. */
  setSuGrant(
    id: string,
    grant: { readonly uid: number; readonly expiresAt: Date } | null,
  ): Promise<void>;
  /** Stores a new hash; `bumpVersion` increments password_version (a real change, not a rehash). */
  updatePassword(uid: number, phc: string, bumpVersion: boolean): Promise<void>;
  credentials(uid: number): Promise<Credentials | null>;
  profile(uid: number): Promise<UserProfile | null>;
  usernameOf(uid: number): Promise<string | null>;
  /** One transaction: user, /home/guest-XXXX, quota and the guest's auth session (§3.6.1). */
  createGuest(request: GuestRequest): Promise<GuestResult>;
  audit(entry: AuditEntry): Promise<void>;
}
