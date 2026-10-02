/**
 * The Kysely implementation of LockStore: the lease SQL of database.md §4.11.16 and §3.17.
 *
 * Every statement is a typed `sql` template with bind parameters. `clock_timestamp()` is the only
 * time source for leases (offline-and-sync.md §3.14.2). The acquire transaction (§3.14.3):
 *   1. SELECT the inode FOR UPDATE: serialises acquires of one file with each other and with
 *      writes (which take the same row at L4); it holds no other lock, so it joins no deadlock.
 *   2. DELETE this inode's expired rows (a crashed holder stops blocking at once) RETURNING them.
 *   3. EISDIR for a directory; EACCES unless the principal has r (S) or w (X) on the file and x on
 *      every ancestor, evaluated with the isomorphic vfs/perm.ts.
 *   4. If the remaining live rows of OTHER sessions are compatible: INSERT ... ON CONFLICT
 *      (locks_pkey) DO UPDATE (renew or upgrade the caller's own row: a NEW grant, new leaseId and
 *      fence); for X also stamp inodes.lock_fence. The EXCLUDE constraint and the partial UNIQUE
 *      index remain the safety net: 23P01 / 23505 inside a SAVEPOINT map to `busy`, and the
 *      expired-row deletion of step 2 still commits.
 */
import { sql, type Kysely, type Transaction } from 'kysely';

import { may, R, W, X, type Cred } from '@plotinium/vfs/perm';

import type { DB } from '../../db/types.gen.ts';
import { sqlstate } from '../../db/errors.ts';
import type {
  AcquireOutcome,
  AcquireRequest,
  HolderInfo,
  LeaseMode,
  LeaseRow,
  LockStore,
} from './types.ts';

interface LeaseSqlRow {
  lease_id: string;
  ino: string;
  os_session_id: string;
  holder_uid: number;
  mode: string;
  fence: number | string;
  lease_expires_at: Date | string;
}

interface PermRow {
  type: 'f' | 'd' | 'l';
  mode: number;
  uid: number;
  gid: number;
}

const toMs = (t: Date | string): number => (t instanceof Date ? t.getTime() : Date.parse(t));

export function toLeaseRow(r: LeaseSqlRow): LeaseRow {
  return {
    leaseId: r.lease_id,
    ino: r.ino,
    osSessionId: r.os_session_id,
    holderUid: r.holder_uid,
    mode: r.mode === 'X' ? 'X' : 'S',
    fence: Number(r.fence),
    expiresAt: toMs(r.lease_expires_at),
  };
}

const interval = (ms: number): string => `${Math.round(ms)} milliseconds`;
const COLS = sql`lease_id, ino, os_session_id, holder_uid, mode, fence, lease_expires_at`;

/** True when a lease of `mode` can coexist with the live rows of other sessions (INV-S6). */
export function compatible(mode: LeaseMode, others: readonly { mode: LeaseMode }[]): boolean {
  if (others.length === 0) return true;
  return mode === 'S' && others.every((o) => o.mode === 'S');
}

export class KyselyLockStore implements LockStore {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  acquire(req: AcquireRequest): Promise<AcquireOutcome> {
    return this.#db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (tx) => this.#acquireIn(tx, req));
  }

  async #acquireIn(tx: Transaction<DB>, req: AcquireRequest): Promise<AcquireOutcome> {
    const inode = await sql<PermRow>`
      SELECT type, mode, uid, gid FROM inodes WHERE ino = ${req.ino} FOR UPDATE`.execute(tx);
    const file = inode.rows[0];
    const expiredRows = await sql<LeaseSqlRow>`
      DELETE FROM locks WHERE ino = ${req.ino} AND lease_expires_at <= clock_timestamp()
      RETURNING ${COLS}`.execute(tx);
    const expired = expiredRows.rows.map(toLeaseRow);
    if (file === undefined) return { kind: 'denied', errno: 'ENOENT', expired };
    if (file.type === 'd') return { kind: 'denied', errno: 'EISDIR', expired };
    // The kernel resolves a symlink path before locking (§3.14.1): a symlink ino is a stale path.
    if (file.type !== 'f') return { kind: 'denied', errno: 'ENOENT', expired };
    if (!(await this.#allowed(tx, req.holderUid, req.ino, file, req.mode === 'S' ? R : W))) {
      return { kind: 'denied', errno: 'EACCES', expired };
    }

    const current = await sql<LeaseSqlRow>`
      SELECT ${COLS} FROM locks WHERE ino = ${req.ino}`.execute(tx);
    const rows = current.rows.map(toLeaseRow);
    const own = rows.find((r) => r.osSessionId === req.osSessionId) ?? null;
    const others = rows.filter((r) => r.osSessionId !== req.osSessionId);
    if (!compatible(req.mode, others)) {
      return { kind: 'busy', holder: await this.#holder(tx, others), expired };
    }

    await sql`SAVEPOINT plt_lock_acquire`.execute(tx);
    try {
      const granted = await sql<LeaseSqlRow>`
        WITH g AS (
          INSERT INTO locks (ino, os_session_id, holder_uid, mode, fence, lease_expires_at)
          VALUES (${req.ino}, ${req.osSessionId}, ${req.holderUid}, ${req.mode}, nextval('lock_fence_seq'),
                  clock_timestamp() + ${interval(req.ttlMs)}::interval)
          ON CONFLICT ON CONSTRAINT locks_pkey DO UPDATE
            SET mode = EXCLUDED.mode, fence = EXCLUDED.fence, lease_id = EXCLUDED.lease_id,
                holder_uid = EXCLUDED.holder_uid, granted_at = clock_timestamp(),
                lease_expires_at = EXCLUDED.lease_expires_at
          RETURNING ${COLS}),
        f AS (UPDATE inodes i SET lock_fence = g.fence FROM g WHERE i.ino = g.ino AND g.mode = 'X' RETURNING i.ino)
        SELECT ${COLS} FROM g`.execute(tx);
      await sql`RELEASE SAVEPOINT plt_lock_acquire`.execute(tx);
      const row = granted.rows[0];
      if (row === undefined) throw new Error('lease insert returned no row');
      return { kind: 'granted', lease: toLeaseRow(row), replaced: own, expired };
    } catch (err) {
      const code = sqlstate(err);
      if (code !== '23P01' && code !== '23505') throw err;
      // A race the pre-check did not see: EBUSY lease (syscall-abi.md §4.9).
      await sql`ROLLBACK TO SAVEPOINT plt_lock_acquire`.execute(tx);
      const again = await sql<LeaseSqlRow>`
        SELECT ${COLS} FROM locks WHERE ino = ${req.ino} AND os_session_id <> ${req.osSessionId}`.execute(
        tx,
      );
      return { kind: 'busy', holder: await this.#holder(tx, again.rows.map(toLeaseRow)), expired };
    }
  }

  /** r or w on the file and x on every ancestor, for the principal's server-side credentials. */
  async #allowed(
    tx: Transaction<DB>,
    uid: number,
    ino: string,
    file: PermRow,
    want: number,
  ): Promise<boolean> {
    const creds = await sql<{ primary_gid: number; groups: number[] | null }>`
      SELECT u.primary_gid, array(SELECT g.gid FROM user_groups g WHERE g.uid = u.uid) AS groups
      FROM users u WHERE u.uid = ${uid}`.execute(tx);
    const c = creds.rows[0];
    if (c === undefined) return false;
    const cred: Cred = { uid, gid: c.primary_gid, groups: [c.primary_gid, ...(c.groups ?? [])] };
    if (!may(cred, file, want)) return false;
    // One path to the file (the first dentry in key order; directories have exactly one parent).
    const ancestors = await sql<PermRow>`
      WITH RECURSIVE up(ino, depth) AS (
        SELECT d.parent_ino, 1 FROM (
          SELECT parent_ino FROM dentries WHERE ino = ${ino} ORDER BY parent_ino, name LIMIT 1) d
        UNION ALL
        SELECT p.parent_ino, up.depth + 1 FROM up JOIN dentries p ON p.ino = up.ino AND p.d_type = 'd'
        WHERE up.depth < 4096)
      SELECT i.type, i.mode, i.uid, i.gid FROM up JOIN inodes i ON i.ino = up.ino`.execute(tx);
    return ancestors.rows.every((a) => may(cred, a, X));
  }

  async #holder(tx: Transaction<DB>, others: readonly LeaseRow[]): Promise<HolderInfo | null> {
    // Prefer the writer; among readers, the one that holds on longest.
    const holder = [...others].sort((a, b) =>
      a.mode === b.mode ? b.expiresAt - a.expiresAt : a.mode === 'X' ? -1 : 1,
    )[0];
    if (holder === undefined) return null;
    const u = await sql<{ username: string }>`
      SELECT username FROM users WHERE uid = ${holder.holderUid}`.execute(tx);
    const username = u.rows[0]?.username;
    return username === undefined
      ? null
      : { username, mode: holder.mode, expiresAt: holder.expiresAt };
  }

  async release(leaseId: string, osSessionId: string): Promise<LeaseRow | null> {
    const r = await sql<LeaseSqlRow>`
      DELETE FROM locks WHERE lease_id = ${leaseId} AND os_session_id = ${osSessionId}
      RETURNING ${COLS}`.execute(this.#db);
    const row = r.rows[0];
    return row === undefined ? null : toLeaseRow(row);
  }

  async releaseSessions(osSessionIds: readonly string[]): Promise<readonly LeaseRow[]> {
    if (osSessionIds.length === 0) return [];
    const r = await sql<LeaseSqlRow>`
      DELETE FROM locks WHERE os_session_id = ANY(${[...osSessionIds]}::uuid[])
      RETURNING ${COLS}`.execute(this.#db);
    return r.rows.map(toLeaseRow);
  }

  async releaseAuthSessions(authSessionIds: readonly string[]): Promise<readonly LeaseRow[]> {
    if (authSessionIds.length === 0) return [];
    const r = await sql<LeaseSqlRow>`
      DELETE FROM locks l USING os_sessions s
      WHERE l.os_session_id = s.os_session_id AND s.auth_session_id = ANY(${[...authSessionIds]}::text[])
      RETURNING l.lease_id, l.ino, l.os_session_id, l.holder_uid, l.mode, l.fence, l.lease_expires_at`.execute(
      this.#db,
    );
    return r.rows.map(toLeaseRow);
  }

  async releaseDevicePredecessors(q: {
    readonly deviceId: string;
    readonly uid: number;
    readonly osSessionId: string;
    readonly kernelEpoch: number;
  }): Promise<readonly LeaseRow[]> {
    const r = await sql<LeaseSqlRow>`
      DELETE FROM locks l USING os_sessions s
      WHERE l.os_session_id = s.os_session_id AND s.device_id = ${q.deviceId} AND s.owner_uid = ${q.uid}
        AND s.os_session_id <> ${q.osSessionId} AND coalesce(s.kernel_epoch, 0) < ${q.kernelEpoch}
      RETURNING l.lease_id, l.ino, l.os_session_id, l.holder_uid, l.mode, l.fence, l.lease_expires_at`.execute(
      this.#db,
    );
    return r.rows.map(toLeaseRow);
  }

  async renew(
    osSessionId: string,
    leaseIds: readonly string[] | 'all',
    ttlMs: number,
  ): Promise<readonly LeaseRow[]> {
    if (leaseIds !== 'all' && leaseIds.length === 0) return [];
    const r =
      leaseIds === 'all'
        ? await sql<LeaseSqlRow>`
            UPDATE locks SET lease_expires_at = clock_timestamp() + ${interval(ttlMs)}::interval
            WHERE os_session_id = ${osSessionId} AND lease_expires_at > clock_timestamp()
            RETURNING ${COLS}`.execute(this.#db)
        : await sql<LeaseSqlRow>`
            UPDATE locks SET lease_expires_at = clock_timestamp() + ${interval(ttlMs)}::interval
            WHERE os_session_id = ${osSessionId} AND lease_id = ANY(${[...leaseIds]}::uuid[])
              AND lease_expires_at > clock_timestamp()
            RETURNING ${COLS}`.execute(this.#db);
    return r.rows.map(toLeaseRow);
  }

  async verifyHeld(
    osSessionId: string,
    refs: readonly { readonly leaseId: string; readonly ino: string; readonly fence: number }[],
    ttlMs: number,
  ): Promise<readonly LeaseRow[]> {
    if (refs.length === 0) return [];
    const r = await sql<LeaseSqlRow>`
      UPDATE locks l SET lease_expires_at = clock_timestamp() + ${interval(ttlMs)}::interval
      FROM unnest(${refs.map((x) => x.leaseId)}::uuid[], ${refs.map((x) => x.ino)}::uuid[],
                  ${refs.map((x) => x.fence)}::bigint[]) AS h(lease_id, ino, fence)
      WHERE l.os_session_id = ${osSessionId} AND l.lease_id = h.lease_id AND l.ino = h.ino
        AND l.fence = h.fence AND l.lease_expires_at > clock_timestamp()
      RETURNING l.lease_id, l.ino, l.os_session_id, l.holder_uid, l.mode, l.fence, l.lease_expires_at`.execute(
      this.#db,
    );
    return r.rows.map(toLeaseRow);
  }

  async expire(leaseIds: readonly string[]): Promise<readonly LeaseRow[]> {
    if (leaseIds.length === 0) return [];
    const r = await sql<LeaseSqlRow>`
      DELETE FROM locks WHERE lease_id = ANY(${[...leaseIds]}::uuid[]) AND lease_expires_at <= clock_timestamp()
      RETURNING ${COLS}`.execute(this.#db);
    return r.rows.map(toLeaseRow);
  }

  async get(leaseIds: readonly string[]): Promise<readonly LeaseRow[]> {
    if (leaseIds.length === 0) return [];
    const r = await sql<LeaseSqlRow>`
      SELECT ${COLS} FROM locks WHERE lease_id = ANY(${[...leaseIds]}::uuid[])`.execute(this.#db);
    return r.rows.map(toLeaseRow);
  }

  async loadAll(): Promise<readonly LeaseRow[]> {
    const r = await sql<LeaseSqlRow>`SELECT ${COLS} FROM locks`.execute(this.#db);
    return r.rows.map(toLeaseRow);
  }

  async usernameOf(uid: number): Promise<string | null> {
    const r = await sql<{
      username: string;
    }>`SELECT username FROM users WHERE uid = ${uid}`.execute(this.#db);
    return r.rows[0]?.username ?? null;
  }
}
