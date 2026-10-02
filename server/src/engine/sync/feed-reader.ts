/**
 * Kysely implementations of the feed reader, the SYN-18 directory context and the OS-session
 * registry (offline-and-sync.md §3.8.1, §3.8.4, §3.15; database.md §3.15 "Resume", §3.16).
 */
import { sql, type Kysely } from 'kysely';
import * as v from 'valibot';

import { Change, WsIno } from '@plotinium/protocol';

import type { DB } from '../../db/types.gen.ts';
import type { Ino } from '../../vfs/types.ts';
import type { FeedReader, FeedRow, OwnerHead } from './feed.ts';
import type { DirContext, DirContextSource, DirNode } from './visibility.ts';

type Time = Date | string;
const iso = (t: Time): string => (t instanceof Date ? t : new Date(t)).toISOString();

const Effects = v.object({ changes: v.array(Change), dirs: v.optional(v.array(WsIno)) });

interface PageRow {
  owner_uid: number;
  owner_seq: number | string;
  op_id: string;
  committed_at: Time;
  effects: unknown;
  lamport: number | string | null;
  purged_at: Time | null;
}

export function toFeedRow(r: PageRow): FeedRow {
  const effects = v.safeParse(Effects, r.effects);
  const purged = r.purged_at !== null || !effects.success;
  return {
    ownerUid: r.owner_uid,
    seq: Number(r.owner_seq),
    opId: r.op_id,
    commitTime: iso(r.committed_at),
    lamport: r.lamport === null ? 0 : Number(r.lamport),
    changes: effects.success ? effects.output.changes : [],
    dirs: effects.success ? (effects.output.dirs ?? []) : [],
    purged,
  };
}

export class KyselyFeedReader implements FeedReader, DirContextSource {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async heads(owners: readonly number[]): Promise<ReadonlyMap<number, OwnerHead>> {
    const out = new Map<number, OwnerHead>();
    if (owners.length === 0) return out;
    const r = await sql<{
      uid: number;
      feed_seq: number | string;
      feed_purged_seq: number | string;
    }>`
      SELECT uid, feed_seq, feed_purged_seq FROM users WHERE uid = ANY(${[...owners]}::int[])`.execute(
      this.#db,
    );
    for (const row of r.rows) {
      out.set(row.uid, { feedSeq: Number(row.feed_seq), purgedSeq: Number(row.feed_purged_seq) });
    }
    return out;
  }

  async page(ownerUid: number, afterSeq: number, limit: number): Promise<readonly FeedRow[]> {
    const r = await sql<PageRow>`
      SELECT f.owner_uid, f.owner_seq, f.op_id, f.committed_at, o.effects,
             (o.result ->> 'lamport') AS lamport, o.purged_at
      FROM feed f JOIN op_log o USING (op_id)
      WHERE f.owner_uid = ${ownerUid} AND f.owner_seq > ${afterSeq}
      ORDER BY f.owner_seq
      LIMIT ${Math.max(1, Math.min(limit, 1000))}`.execute(this.#db);
    return r.rows.map(toFeedRow);
  }

  /** The rows of `inos` and of all their ancestors, each with its (first) parent. */
  async load(inos: readonly Ino[]): Promise<DirContext> {
    const out = new Map<Ino, DirNode>();
    if (inos.length === 0) return out;
    const r = await sql<{
      ino: string;
      type: 'f' | 'd' | 'l';
      mode: number;
      uid: number;
      gid: number;
      parent: string | null;
    }>`
      WITH RECURSIVE up(ino) AS (
        SELECT unnest(${[...inos]}::uuid[])
        UNION
        SELECT d.parent_ino FROM up JOIN dentries d ON d.ino = up.ino)
      SELECT i.ino, i.type, i.mode, i.uid, i.gid,
             (SELECT p.parent_ino FROM dentries p WHERE p.ino = i.ino ORDER BY p.parent_ino, p.name LIMIT 1) AS parent
      FROM up JOIN inodes i ON i.ino = up.ino`.execute(this.#db);
    for (const row of r.rows) {
      out.set(row.ino, {
        row: { type: row.type, mode: row.mode, uid: row.uid, gid: row.gid },
        parent: row.parent,
      });
    }
    return out;
  }
}

/** The OS-session registry the handshake and the op pipeline's step 1 use (database.md §3.16). */
export interface OsSessionStore {
  /**
   * `INSERT ... ON CONFLICT (os_session_id) DO UPDATE ... WHERE owner_uid = EXCLUDED.owner_uid`.
   * False when the id belongs to another uid (0 rows: EACCES, close 1008).
   */
  register(r: {
    readonly osSessionId: string;
    readonly ownerUid: number;
    /** Null only for sessions registered outside a cookie session (seed, tests). */
    readonly authSessionId: string | null;
    readonly deviceId: string;
    readonly kernelEpoch: number;
  }): Promise<boolean>;
  /** True when the OS session is registered to `uid` (and to `deviceId` when both are known). */
  owns(osSessionId: string, uid: number, deviceId: string | null): Promise<boolean>;
  /**
   * Register an OS session nobody registered yet to `ownerUid` on `deviceId` (UI-006): a session
   * that ran offline never sent a `hello`, yet its ops are replayed under its own id (§3.8.1).
   * `INSERT ... ON CONFLICT DO NOTHING`: false when the id exists (another uid or device).
   */
  claim?(r: {
    readonly osSessionId: string;
    readonly ownerUid: number;
    readonly deviceId: string;
  }): Promise<boolean>;
}

/**
 * Step 1 of the op pipeline (engine.ts): the op's OS session is the uid's, or it is an unknown one
 * that this uid's device now claims (an offline session replayed on reconnect, §3.8.1; UI-006).
 * An id owned by another uid or registered to another device is never claimed.
 */
export async function ownsOrClaims(
  store: OsSessionStore,
  osSessionId: string,
  uid: number,
  deviceId: string | null,
): Promise<boolean> {
  if (await store.owns(osSessionId, uid, deviceId)) return true;
  if (deviceId === null || store.claim === undefined) return false;
  return store.claim({ osSessionId, ownerUid: uid, deviceId });
}

export class KyselyOsSessionStore implements OsSessionStore {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async register(r: {
    readonly osSessionId: string;
    readonly ownerUid: number;
    readonly authSessionId: string | null;
    readonly deviceId: string;
    readonly kernelEpoch: number;
  }): Promise<boolean> {
    const res = await sql<{ os_session_id: string }>`
      INSERT INTO os_sessions (os_session_id, owner_uid, auth_session_id, device_id, kernel_epoch)
      VALUES (${r.osSessionId}, ${r.ownerUid}, ${r.authSessionId}, ${r.deviceId}, ${r.kernelEpoch})
      ON CONFLICT (os_session_id) DO UPDATE
        SET auth_session_id = EXCLUDED.auth_session_id, device_id = EXCLUDED.device_id,
            kernel_epoch = EXCLUDED.kernel_epoch, updated_at = now(), ended_at = NULL
        WHERE os_sessions.owner_uid = EXCLUDED.owner_uid
      RETURNING os_session_id`.execute(this.#db);
    return res.rows.length === 1;
  }

  async claim(r: {
    readonly osSessionId: string;
    readonly ownerUid: number;
    readonly deviceId: string;
  }): Promise<boolean> {
    const res = await sql<{ os_session_id: string }>`
      INSERT INTO os_sessions (os_session_id, owner_uid, auth_session_id, device_id, kernel_epoch)
      VALUES (${r.osSessionId}, ${r.ownerUid}, NULL, ${r.deviceId}, 0)
      ON CONFLICT (os_session_id) DO NOTHING
      RETURNING os_session_id`.execute(this.#db);
    return res.rows.length === 1;
  }

  async owns(osSessionId: string, uid: number, deviceId: string | null): Promise<boolean> {
    const res = await sql<{ ok: number }>`
      SELECT 1 AS ok FROM os_sessions
      WHERE os_session_id = ${osSessionId} AND owner_uid = ${uid}
        AND (${deviceId}::uuid IS NULL OR device_id IS NULL OR device_id = ${deviceId}::uuid)`.execute(
      this.#db,
    );
    return res.rows.length === 1;
  }
}
