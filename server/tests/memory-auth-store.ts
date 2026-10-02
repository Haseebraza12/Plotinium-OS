/**
 * Test-only in-memory AuthStore double (the real one is gateway/kysely-store.ts, exercised by the
 * DB-gated tests). It mirrors the SQL semantics the gateway relies on: revoke only live sessions,
 * the one-grant-per-session su columns, the guest uid range and the live-guest count.
 */
import type {
  AccountKind,
  AuditEntry,
  AuthStore,
  Credentials,
  GuestRequest,
  GuestResult,
  LoginUser,
  NewSession,
  SessionRecord,
  UserProfile,
} from '../src/gateway/store.ts';

export interface MemUser {
  uid: number;
  username: string;
  kind: AccountKind;
  passwordHash: string | null;
  passwordVersion: number;
  disabled: boolean;
  primaryGid: number;
  groups: number[];
  quotaBytes: number;
  quotaInodes: number;
  usedInodes: number;
}

interface MemSession extends NewSession {
  uid: number;
  lastUsedAt: Date;
  revokedAt: Date | null;
  suUid: number | null;
  suExpiresAt: Date | null;
}

export class MemoryAuthStore implements AuthStore {
  readonly users = new Map<number, MemUser>();
  readonly sessions = new Map<string, MemSession>();
  readonly audits: AuditEntry[] = [];
  readonly groupNames = new Map<number, string>([
    [0, 'root'],
    [100, 'users'],
    [200, 'team'],
    [60_000, 'guests'],
  ]);
  touches = 0;
  /** When set, every method rejects (a database outage). */
  down = false;

  addUser(u: Partial<MemUser> & Pick<MemUser, 'uid' | 'username'>): MemUser {
    const user: MemUser = {
      kind: 'user',
      passwordHash: '!',
      passwordVersion: 1,
      disabled: false,
      primaryGid: 100,
      groups: [],
      quotaBytes: 1 << 30,
      quotaInodes: 100_000,
      usedInodes: 1,
      ...u,
    };
    this.users.set(user.uid, user);
    return user;
  }

  #guard(): void {
    if (this.down) throw new Error('connection refused');
  }

  #byName(username: string): MemUser | undefined {
    return [...this.users.values()].find((u) => u.username === username);
  }

  findLoginUser(username: string): Promise<LoginUser | null> {
    this.#guard();
    const u = this.#byName(username);
    return Promise.resolve(
      u === undefined
        ? null
        : {
            uid: u.uid,
            username: u.username,
            kind: u.kind,
            passwordHash: u.passwordHash,
            disabled: u.disabled,
          },
    );
  }

  findSession(id: string): Promise<SessionRecord | null> {
    this.#guard();
    const s = this.sessions.get(id);
    const u = s === undefined ? undefined : this.users.get(s.uid);
    if (s === undefined || u === undefined) return Promise.resolve(null);
    return Promise.resolve({
      id: s.id,
      uid: s.uid,
      secretHash: s.secretHash,
      lastUsedAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
      absoluteExpiresAt: s.absoluteExpiresAt,
      revokedAt: s.revokedAt,
      suUid: s.suUid,
      suExpiresAt: s.suExpiresAt,
      kind: u.kind,
      disabled: u.disabled,
      gids: [u.primaryGid, ...u.groups.filter((g) => g !== u.primaryGid)],
    });
  }

  insertSession(uid: number, s: NewSession): Promise<void> {
    this.#guard();
    this.sessions.set(s.id, {
      ...s,
      uid,
      lastUsedAt: s.createdAt,
      revokedAt: null,
      suUid: null,
      suExpiresAt: null,
    });
    return Promise.resolve();
  }

  touchSession(id: string, expiresAt: Date, lastUsedAt: Date): Promise<void> {
    const s = this.sessions.get(id);
    if (s !== undefined && s.revokedAt === null) Object.assign(s, { expiresAt, lastUsedAt });
    this.touches++;
    return Promise.resolve();
  }

  revokeSessions(ids: readonly string[], at: Date): Promise<readonly string[]> {
    const out: string[] = [];
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s !== undefined && s.revokedAt === null) {
        Object.assign(s, { revokedAt: at, suUid: null, suExpiresAt: null });
        out.push(id);
      }
    }
    return Promise.resolve(out);
  }

  liveSessionIds(uid: number, at: Date): Promise<readonly string[]> {
    return Promise.resolve(
      [...this.sessions.values()]
        .filter(
          (s) =>
            s.uid === uid && s.revokedAt === null && s.absoluteExpiresAt.getTime() > at.getTime(),
        )
        .map((s) => s.id),
    );
  }

  setSuGrant(
    id: string,
    grant: { readonly uid: number; readonly expiresAt: Date } | null,
  ): Promise<void> {
    const s = this.sessions.get(id);
    if (s !== undefined)
      Object.assign(s, { suUid: grant?.uid ?? null, suExpiresAt: grant?.expiresAt ?? null });
    return Promise.resolve();
  }

  updatePassword(uid: number, phc: string, bumpVersion: boolean): Promise<void> {
    const u = this.users.get(uid);
    if (u !== undefined) {
      u.passwordHash = phc;
      if (bumpVersion) u.passwordVersion++;
    }
    return Promise.resolve();
  }

  credentials(uid: number): Promise<Credentials | null> {
    const u = this.users.get(uid);
    return Promise.resolve(u === undefined ? null : { uid, gids: [u.primaryGid, ...u.groups] });
  }

  profile(uid: number): Promise<UserProfile | null> {
    const u = this.users.get(uid);
    if (u === undefined) return Promise.resolve(null);
    const gids = [...new Set([u.primaryGid, ...u.groups])].sort((a, b) => a - b);
    return Promise.resolve({
      uid,
      username: u.username,
      kind: u.kind,
      primaryGid: u.primaryGid,
      groups: gids.map((gid) => ({ gid, name: this.groupNames.get(gid) ?? `g${gid}` })),
      quotaBytes: u.quotaBytes,
      quotaInodes: u.quotaInodes,
      usedBytes: 0,
      usedInodes: u.usedInodes,
      passwordVersion: u.passwordVersion,
      telemetryOptIn: false,
    });
  }

  usernameOf(uid: number): Promise<string | null> {
    return Promise.resolve(this.users.get(uid)?.username ?? null);
  }

  createGuest(req: GuestRequest): Promise<GuestResult> {
    const liveGuests = new Set(
      [...this.sessions.values()]
        .filter((s) => s.revokedAt === null && s.absoluteExpiresAt.getTime() > req.now.getTime())
        .map((s) => s.uid)
        .filter((uid) => this.users.get(uid)?.kind === 'guest'),
    );
    if (liveGuests.size >= req.maxActive) return Promise.resolve({ ok: false, reason: 'full' });
    let uid = 60_000;
    while (this.users.has(uid)) uid++;
    if (uid > 60_999) return Promise.resolve({ ok: false, reason: 'no-uid' });
    let username = `guest-${req.suffix()}`;
    while (this.#byName(username) !== undefined) username = `guest-${req.suffix()}`;
    this.addUser({
      uid,
      username,
      kind: 'guest',
      passwordHash: null,
      primaryGid: 60_000,
      quotaBytes: req.quotaBytes,
      quotaInodes: req.quotaInodes,
    });
    this.sessions.set(req.session.id, {
      ...req.session,
      uid,
      lastUsedAt: req.session.createdAt,
      revokedAt: null,
      suUid: null,
      suExpiresAt: null,
    });
    return Promise.resolve({ ok: true, uid, username });
  }

  audit(entry: AuditEntry): Promise<void> {
    this.audits.push(entry);
    return Promise.resolve();
  }
}
