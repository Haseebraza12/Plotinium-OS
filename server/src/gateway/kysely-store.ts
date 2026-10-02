/**
 * AuthStore on PostgreSQL through Kysely (database.md §3.16, §4.3; backend-api.md §3.8).
 * Hand-written `sql` templates, one short statement or transaction per method; the app role has
 * DML on users, user_groups, auth_sessions and INSERT on audit_log (append-only, AGT-08).
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../db/types.gen.ts';
import { createHome } from './homes.ts';
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
} from './store.ts';

export const GUEST_GID = 60_000;
export const GUEST_UID_FIRST = 60_000;
export const GUEST_UID_LAST = 60_999;
const GUEST_NAME_ATTEMPTS = 8;

const withGids = (primary: number, others: readonly number[] | null): number[] => [
  primary,
  ...(others ?? []).filter((g) => g !== primary),
];

export class KyselyAuthStore implements AuthStore {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async findLoginUser(username: string): Promise<LoginUser | null> {
    const r = await sql<{
      uid: number;
      username: string;
      account_kind: AccountKind;
      password_hash: string | null;
      disabled: boolean;
    }>`SELECT uid, username, account_kind, password_hash, disabled_at IS NOT NULL AS disabled
       FROM users WHERE username = ${username}`.execute(this.#db);
    const u = r.rows[0];
    return u === undefined
      ? null
      : {
          uid: u.uid,
          username: u.username,
          kind: u.account_kind,
          passwordHash: u.password_hash,
          disabled: u.disabled,
        };
  }

  async findSession(id: string): Promise<SessionRecord | null> {
    const r = await sql<{
      id: string;
      uid: number;
      secret_hash: Buffer;
      last_used_at: Date;
      expires_at: Date;
      absolute_expires_at: Date;
      revoked_at: Date | null;
      su_uid: number | null;
      su_expires_at: Date | null;
      account_kind: AccountKind;
      disabled: boolean;
      primary_gid: number;
      gids: number[] | null;
    }>`SELECT s.id, s.uid, s.secret_hash, s.last_used_at, s.expires_at, s.absolute_expires_at, s.revoked_at,
              s.su_uid, s.su_expires_at, u.account_kind, u.disabled_at IS NOT NULL AS disabled, u.primary_gid,
              array(SELECT g.gid FROM user_groups g WHERE g.uid = u.uid ORDER BY g.gid) AS gids
       FROM auth_sessions s JOIN users u ON u.uid = s.uid
       WHERE s.id = ${id}`.execute(this.#db);
    const s = r.rows[0];
    if (s === undefined) return null;
    return {
      id: s.id,
      uid: s.uid,
      secretHash: s.secret_hash,
      lastUsedAt: s.last_used_at,
      expiresAt: s.expires_at,
      absoluteExpiresAt: s.absolute_expires_at,
      revokedAt: s.revoked_at,
      suUid: s.su_uid,
      suExpiresAt: s.su_expires_at,
      kind: s.account_kind,
      disabled: s.disabled,
      gids: withGids(s.primary_gid, s.gids),
    };
  }

  async insertSession(uid: number, s: NewSession): Promise<void> {
    await insertSessionIn(this.#db, uid, s);
  }

  async touchSession(id: string, expiresAt: Date, lastUsedAt: Date): Promise<void> {
    await sql`UPDATE auth_sessions SET expires_at = ${expiresAt}, last_used_at = ${lastUsedAt}
              WHERE id = ${id} AND revoked_at IS NULL`.execute(this.#db);
  }

  async revokeSessions(ids: readonly string[], at: Date): Promise<readonly string[]> {
    if (ids.length === 0) return [];
    const r = await sql<{ id: string }>`
      UPDATE auth_sessions SET revoked_at = ${at}, su_uid = NULL, su_expires_at = NULL
      WHERE id = ANY(${[...ids]}::text[]) AND revoked_at IS NULL
      RETURNING id`.execute(this.#db);
    return r.rows.map((row) => row.id);
  }

  async liveSessionIds(uid: number, at: Date): Promise<readonly string[]> {
    const r = await sql<{ id: string }>`
      SELECT id FROM auth_sessions
      WHERE uid = ${uid} AND revoked_at IS NULL AND absolute_expires_at > ${at}`.execute(this.#db);
    return r.rows.map((row) => row.id);
  }

  async setSuGrant(
    id: string,
    grant: { readonly uid: number; readonly expiresAt: Date } | null,
  ): Promise<void> {
    await sql`UPDATE auth_sessions SET su_uid = ${grant?.uid ?? null}, su_expires_at = ${grant?.expiresAt ?? null}
              WHERE id = ${id}`.execute(this.#db);
  }

  async updatePassword(uid: number, phc: string, bumpVersion: boolean): Promise<void> {
    await sql`UPDATE users SET password_hash = ${phc},
                     password_version = password_version + ${bumpVersion ? 1 : 0}
              WHERE uid = ${uid}`.execute(this.#db);
  }

  async credentials(uid: number): Promise<Credentials | null> {
    const r = await sql<{ primary_gid: number; gids: number[] | null }>`
      SELECT u.primary_gid, array(SELECT g.gid FROM user_groups g WHERE g.uid = u.uid ORDER BY g.gid) AS gids
      FROM users u WHERE u.uid = ${uid}`.execute(this.#db);
    const u = r.rows[0];
    return u === undefined ? null : { uid, gids: withGids(u.primary_gid, u.gids) };
  }

  async profile(uid: number): Promise<UserProfile | null> {
    const r = await sql<{
      uid: number;
      username: string;
      account_kind: AccountKind;
      primary_gid: number;
      quota_bytes: number;
      quota_inodes: number;
      used_bytes: number;
      used_inodes: number;
      password_version: number;
      telemetry_opt_in: boolean;
      groups: { gid: number; name: string }[];
    }>`SELECT u.uid, u.username, u.account_kind, u.primary_gid, u.quota_bytes, u.quota_inodes, u.used_bytes,
              u.used_inodes, u.password_version, u.telemetry_opt_in,
              coalesce((SELECT json_agg(json_build_object('gid', g.gid, 'name', g.name) ORDER BY g.gid)
                        FROM groups g
                        WHERE g.gid = u.primary_gid
                           OR g.gid IN (SELECT ug.gid FROM user_groups ug WHERE ug.uid = u.uid)), '[]'::json) AS groups
       FROM users u WHERE u.uid = ${uid}`.execute(this.#db);
    const u = r.rows[0];
    if (u === undefined) return null;
    return {
      uid: u.uid,
      username: u.username,
      kind: u.account_kind,
      primaryGid: u.primary_gid,
      groups: u.groups,
      quotaBytes: u.quota_bytes,
      quotaInodes: u.quota_inodes,
      usedBytes: u.used_bytes,
      usedInodes: u.used_inodes,
      passwordVersion: u.password_version,
      telemetryOptIn: u.telemetry_opt_in,
    };
  }

  async usernameOf(uid: number): Promise<string | null> {
    const r = await sql<{
      username: string;
    }>`SELECT username FROM users WHERE uid = ${uid}`.execute(this.#db);
    return r.rows[0]?.username ?? null;
  }

  createGuest(req: GuestRequest): Promise<GuestResult> {
    return this.#db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (tx): Promise<GuestResult> => {
        // Serialises guest creation, so the live count and the uid choice cannot race.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('plotinium:guest.create', 0))`.execute(
          tx,
        );
        const live = await sql<{ n: number }>`
          SELECT count(DISTINCT u.uid)::int AS n
          FROM users u JOIN auth_sessions s ON s.uid = u.uid
          WHERE u.account_kind = 'guest' AND s.revoked_at IS NULL AND s.absolute_expires_at > ${req.now}`.execute(
          tx,
        );
        if ((live.rows[0]?.n ?? 0) >= req.maxActive) return { ok: false, reason: 'full' };
        const free = await sql<{ uid: number | null }>`
          SELECT min(g)::int AS uid FROM generate_series(${GUEST_UID_FIRST}::int, ${GUEST_UID_LAST}::int) g
          WHERE NOT EXISTS (SELECT 1 FROM users WHERE uid = g)`.execute(tx);
        const uid = free.rows[0]?.uid ?? null;
        if (uid === null) return { ok: false, reason: 'no-uid' };
        let username: string | null = null;
        for (let i = 0; i < GUEST_NAME_ATTEMPTS && username === null; i++) {
          const candidate = `guest-${req.suffix()}`;
          const taken = await sql`SELECT 1 FROM users WHERE username = ${candidate}`.execute(tx);
          if (taken.rows.length === 0) username = candidate;
        }
        if (username === null) return { ok: false, reason: 'no-uid' };
        await sql`
          INSERT INTO users (uid, username, account_kind, password_hash, primary_gid, quota_bytes, quota_inodes)
          VALUES (${uid}, ${username}, 'guest', NULL, ${GUEST_GID}, ${req.quotaBytes}, ${req.quotaInodes})`.execute(
          tx,
        );
        await createHome(tx, { uid, username, gid: GUEST_GID });
        await insertSessionIn(tx, uid, req.session);
        return { ok: true, uid, username };
      });
  }

  async audit(e: AuditEntry): Promise<void> {
    await sql`
      INSERT INTO audit_log (uid, real_uid, actor, syscall, outcome, errno, detail)
      VALUES (${e.uid}, ${e.realUid}, ${e.actor}, ${e.event}, ${e.outcome}, ${e.errno ?? null},
              ${e.detail === undefined ? null : JSON.stringify(e.detail)}::jsonb)`.execute(
      this.#db,
    );
  }
}

async function insertSessionIn(db: Kysely<DB>, uid: number, s: NewSession): Promise<void> {
  await sql`
    INSERT INTO auth_sessions (id, secret_hash, uid, created_at, last_used_at, expires_at, absolute_expires_at, user_agent)
    VALUES (${s.id}, ${Buffer.from(s.secretHash)}, ${uid}, ${s.createdAt}, ${s.createdAt}, ${s.expiresAt},
            ${s.absoluteExpiresAt}, ${s.userAgent})`.execute(db);
}
