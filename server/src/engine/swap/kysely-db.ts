/**
 * SwapDb on PostgreSQL through Kysely (database.md §3.18, §4.5; backend-api.md §3.11, INV-SRV-5).
 * swap_pages PK (owner_uid, os_session_id, pid, page_id); FK (os_session_id, owner_uid) ->
 * os_sessions, so a page can never be filed under another user's OS session (23503 -> EACCES).
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.gen.ts';
import type {
  ListCursor,
  ListFilter,
  SwapDb,
  SwapKey,
  SwapPage,
  SwapRow,
  UpsertOutcome,
} from './types.ts';

interface PageRow {
  os_session_id: string;
  pid: number;
  page_id: number;
  gen: number | string;
  size: number;
  stored_size: number;
  checksum: string;
  updated_at: Date | string;
}

const PAGE_COLUMNS = sql`os_session_id::text AS os_session_id, pid, page_id, gen, size, stored_size,
  encode(checksum, 'hex') AS checksum, updated_at`;

function toPage(r: PageRow): SwapPage {
  return {
    osSessionId: r.os_session_id,
    pid: r.pid,
    pageId: r.page_id,
    gen: Number(r.gen),
    size: r.size,
    storedSize: r.stored_size,
    checksum: r.checksum,
    updatedAt:
      r.updated_at instanceof Date
        ? r.updated_at.toISOString()
        : new Date(r.updated_at).toISOString(),
  };
}

class Outcome extends Error {
  readonly outcome: UpsertOutcome;
  constructor(outcome: UpsertOutcome) {
    super('rollback');
    this.outcome = outcome;
  }
}

function sqlState(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export class KyselySwapDb implements SwapDb {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async sessionOwner(osSessionId: string): Promise<number | null> {
    const r = await sql<{ owner_uid: number }>`
      SELECT owner_uid FROM os_sessions WHERE os_session_id = ${osSessionId}::uuid`.execute(
      this.#db,
    );
    return r.rows[0]?.owner_uid ?? null;
  }

  async getPage(k: SwapKey): Promise<SwapPage | null> {
    const r = await sql<PageRow>`
      SELECT ${PAGE_COLUMNS} FROM swap_pages
       WHERE owner_uid = ${k.ownerUid} AND os_session_id = ${k.osSessionId}::uuid
         AND pid = ${k.pid} AND page_id = ${k.pageId}`.execute(this.#db);
    const row = r.rows[0];
    return row === undefined ? null : toPage(row);
  }

  async usedBytes(ownerUid: number): Promise<number> {
    const r = await sql<{ used: number | string }>`
      SELECT coalesce(sum(stored_size), 0)::bigint AS used FROM swap_pages WHERE owner_uid = ${ownerUid}`.execute(
      this.#db,
    );
    return Number(r.rows[0]?.used ?? 0);
  }

  async upsertPage(row: SwapRow, quotaBytes: number): Promise<UpsertOutcome> {
    try {
      return await this.#db.transaction().execute(async (tx) => {
        await sql`SELECT 1 FROM users WHERE uid = ${row.ownerUid} FOR UPDATE`.execute(tx);
        const u = await sql<{ used: number | string }>`
          SELECT coalesce(sum(stored_size), 0)::bigint AS used FROM swap_pages
           WHERE owner_uid = ${row.ownerUid}
             AND NOT (os_session_id = ${row.osSessionId}::uuid AND pid = ${row.pid} AND page_id = ${row.pageId})`.execute(
          tx,
        );
        const used = Number(u.rows[0]?.used ?? 0);
        if (used + row.storedSize > quotaBytes) {
          await sql`DELETE FROM swap_pages
                     WHERE owner_uid = ${row.ownerUid} AND os_session_id = ${row.osSessionId}::uuid
                       AND pid = ${row.pid} AND page_id = ${row.pageId}`.execute(tx);
          return { ok: false, reason: 'quota', usedBytes: used } as const;
        }
        const r = await sql<{ one: number }>`
          INSERT INTO swap_pages (owner_uid, os_session_id, pid, page_id, gen, storage_key, size, stored_size, checksum)
          VALUES (${row.ownerUid}, ${row.osSessionId}::uuid, ${row.pid}, ${row.pageId}, ${row.gen}, ${row.storageKey},
                  ${row.size}, ${row.storedSize}, decode(${row.checksum}, 'hex'))
          ON CONFLICT ON CONSTRAINT swap_pages_pkey DO UPDATE
             SET gen = EXCLUDED.gen, storage_key = EXCLUDED.storage_key, size = EXCLUDED.size,
                 stored_size = EXCLUDED.stored_size, checksum = EXCLUDED.checksum, updated_at = now()
           WHERE swap_pages.gen <= EXCLUDED.gen
          RETURNING 1 AS one`.execute(tx);
        if (r.rows.length === 0) throw new Outcome({ ok: false, reason: 'stale' });
        return { ok: true } as const;
      });
    } catch (e) {
      if (e instanceof Outcome) return e.outcome;
      if (sqlState(e) === '23503') return { ok: false, reason: 'foreign-session' };
      throw e;
    }
  }

  async deletePages(
    ownerUid: number,
    osSessionId: string,
    pid?: number,
    pageId?: number,
  ): Promise<SwapKey[]> {
    const r = await sql<{ pid: number; page_id: number }>`
      DELETE FROM swap_pages
       WHERE owner_uid = ${ownerUid} AND os_session_id = ${osSessionId}::uuid
         AND (${pid ?? null}::int IS NULL OR pid = ${pid ?? null}::int)
         AND (${pageId ?? null}::int IS NULL OR page_id = ${pageId ?? null}::int)
      RETURNING pid, page_id`.execute(this.#db);
    return r.rows.map((x) => ({ ownerUid, osSessionId, pid: x.pid, pageId: x.page_id }));
  }

  async listPages(
    ownerUid: number,
    filter: ListFilter,
    after: ListCursor | null,
    limit: number,
  ): Promise<SwapPage[]> {
    const s = filter.osSessionId ?? null;
    const p = filter.pid ?? null;
    const a = after;
    const r = await sql<PageRow>`
      SELECT ${PAGE_COLUMNS} FROM swap_pages
       WHERE owner_uid = ${ownerUid}
         AND (${s}::uuid IS NULL OR os_session_id = ${s}::uuid)
         AND (${p}::int IS NULL OR pid = ${p}::int)
         AND (${a?.osSessionId ?? null}::uuid IS NULL
              OR os_session_id < ${a?.osSessionId ?? null}::uuid
              OR (os_session_id = ${a?.osSessionId ?? null}::uuid
                  AND (pid, page_id) > (${a?.pid ?? 0}::int, ${a?.pageId ?? 0}::int)))
       ORDER BY os_session_id DESC, pid, page_id
       LIMIT ${limit}`.execute(this.#db);
    return r.rows.map(toPage);
  }

  async deleteExpired(olderThanDays: number): Promise<SwapKey[]> {
    const r = await sql<{ owner_uid: number; os_session_id: string; pid: number; page_id: number }>`
      DELETE FROM swap_pages sp
       USING (SELECT owner_uid, os_session_id FROM swap_pages
               GROUP BY owner_uid, os_session_id
              HAVING max(updated_at) < now() - make_interval(days => ${olderThanDays}::int)) old
       WHERE sp.owner_uid = old.owner_uid AND sp.os_session_id = old.os_session_id
      RETURNING sp.owner_uid, sp.os_session_id::text AS os_session_id, sp.pid, sp.page_id`.execute(
      this.#db,
    );
    return r.rows.map((x) => ({
      ownerUid: x.owner_uid,
      osSessionId: x.os_session_id,
      pid: x.pid,
      pageId: x.page_id,
    }));
  }
}
