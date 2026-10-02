/**
 * The SQL of opt-in telemetry sync (backend-api.md §3.14; predictive-prefetch.md §3.2, §3.3;
 * database.md telemetry_events; PRE-05). Rows are accepted only while users.telemetry_opt_in is
 * true, checked IN THE SAME STATEMENT as the insert, so a concurrent opt-out can never let an
 * upload through. Opting out deletes the uid's events in the same transaction.
 */
import { createHash } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type { TelemetryEvent } from '@plotinium/protocol';

import type { DB } from '../db/types.gen.ts';

export interface Consent {
  readonly optIn: boolean;
  readonly since?: string;
}

export interface StoredEvents {
  readonly events: readonly TelemetryEvent[];
  readonly next?: string;
}

export interface TelemetryStore {
  consent(uid: number): Promise<Consent | null>;
  /** Sets the flag, audits `telemetry.consent`, and deletes the events when opting out. */
  setConsent(uid: number, optIn: boolean): Promise<Consent>;
  /** null: not opted in (the route answers 403 EPERM opt-in). */
  insert(
    uid: number,
    events: readonly TelemetryEvent[],
  ): Promise<{ accepted: number; duplicates: number } | null>;
  /** null: not opted in. Keyset on (ts, event_id). */
  list(uid: number, after: string | null, limit: number): Promise<StoredEvents | null>;
  deleteAll(uid: number): Promise<number>;
  /** The nightly retention job: events older than `days`. */
  sweepRetention(days: number): Promise<number>;
}

/**
 * The idempotency key of an event: a version-8 UUID from SHA-256(uid, osSessionId, seq, ts), so a
 * re-upload of the same event is a duplicate (ON CONFLICT (event_id) DO NOTHING).
 */
export function eventId(uid: number, e: TelemetryEvent): string {
  const h = createHash('sha256')
    .update(`${uid}\u0000${e.osSessionId}\u0000${e.seq}\u0000${e.ts}`)
    .digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x80; // version 8 (custom)
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface Cursor {
  readonly ts: number;
  readonly id: string;
}

export function encodeTelemetryCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.ts, c.id]), 'utf8').toString('base64url');
}

export function decodeTelemetryCursor(s: string): Cursor | null {
  try {
    const p: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (
      Array.isArray(p) &&
      p.length === 2 &&
      typeof p[0] === 'number' &&
      Number.isSafeInteger(p[0]) &&
      typeof p[1] === 'string' &&
      /^[0-9a-f-]{36}$/.test(p[1])
    )
      return { ts: p[0], id: p[1] };
  } catch {
    // fall through
  }
  return null;
}

type Time = Date | string;
const ms = (t: Time): number => (t instanceof Date ? t : new Date(t)).getTime();

export class KyselyTelemetryStore implements TelemetryStore {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async consent(uid: number): Promise<Consent | null> {
    const r = await sql<{ telemetry_opt_in: boolean; telemetry_opt_in_at: Time | null }>`
      SELECT telemetry_opt_in, telemetry_opt_in_at FROM users WHERE uid = ${uid}`.execute(this.#db);
    const row = r.rows[0];
    if (row === undefined) return null;
    return {
      optIn: row.telemetry_opt_in,
      ...(row.telemetry_opt_in && row.telemetry_opt_in_at !== null
        ? { since: new Date(ms(row.telemetry_opt_in_at)).toISOString() }
        : {}),
    };
  }

  async setConsent(uid: number, optIn: boolean): Promise<Consent> {
    return this.#db.transaction().execute(async (tx) => {
      const r = await sql<{ telemetry_opt_in_at: Time | null }>`
        UPDATE users
        SET telemetry_opt_in = ${optIn},
            telemetry_opt_in_at = CASE WHEN ${optIn} THEN coalesce(
              CASE WHEN telemetry_opt_in THEN telemetry_opt_in_at END, now()) END
        WHERE uid = ${uid}
        RETURNING telemetry_opt_in_at`.execute(tx);
      let deleted = 0;
      if (!optIn) {
        const d = await sql`DELETE FROM telemetry_events WHERE uid = ${uid}`.execute(tx);
        deleted = Number(d.numAffectedRows ?? 0);
      }
      await sql`
        INSERT INTO audit_log (uid, real_uid, actor, syscall, outcome, detail)
        VALUES (${uid}, ${uid}, 'user', 'telemetry.consent', 'ok',
                ${JSON.stringify({ optIn, deleted })}::jsonb)`.execute(tx);
      const at = r.rows[0]?.telemetry_opt_in_at ?? null;
      return {
        optIn,
        ...(optIn && at !== null ? { since: new Date(ms(at)).toISOString() } : {}),
      };
    });
  }

  async insert(
    uid: number,
    events: readonly TelemetryEvent[],
  ): Promise<{ accepted: number; duplicates: number } | null> {
    const ids = events.map((e) => eventId(uid, e));
    const apps = events.map((e) => e.app);
    const kinds = events.map((e) => e.kind);
    const tss = events.map((e) => new Date(e.ts).toISOString());
    const contexts = events.map((e) => {
      const { ts: _ts, kind: _kind, app: _app, ...context } = e;
      return JSON.stringify(context);
    });
    const r = await sql<{ opted: boolean; inserted: number | string }>`
      WITH me AS (SELECT telemetry_opt_in FROM users WHERE uid = ${uid}),
      ins AS (
        INSERT INTO telemetry_events (event_id, uid, app_id, kind, ts, context)
        SELECT e.id, ${uid}, e.app, e.kind, e.ts, e.ctx
        FROM unnest(${ids}::uuid[], ${apps}::text[], ${kinds}::text[], ${tss}::timestamptz[],
                    ${contexts}::jsonb[]) AS e(id, app, kind, ts, ctx)
        WHERE (SELECT telemetry_opt_in FROM me)
        ON CONFLICT (event_id) DO NOTHING
        RETURNING 1)
      SELECT coalesce((SELECT telemetry_opt_in FROM me), false) AS opted,
             (SELECT count(*) FROM ins) AS inserted`.execute(this.#db);
    const row = r.rows[0];
    if (row === undefined || !row.opted) return null;
    const accepted = Number(row.inserted);
    return { accepted, duplicates: events.length - accepted };
  }

  async list(uid: number, after: string | null, limit: number): Promise<StoredEvents | null> {
    const c = await this.consent(uid);
    if (c === null || !c.optIn) return null;
    const cursor = after === null ? null : decodeTelemetryCursor(after);
    const r = await sql<{
      event_id: string;
      app_id: string;
      kind: 'launch' | 'focus' | 'close';
      ts: Time;
      context: Record<string, unknown>;
    }>`
      SELECT event_id, app_id, kind, ts, context FROM telemetry_events
      WHERE uid = ${uid}
        AND (${cursor === null}::boolean
             OR (ts, event_id) > (to_timestamp(${cursor?.ts ?? 0}::double precision / 1000),
                                  ${cursor?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid))
      ORDER BY ts, event_id
      LIMIT ${limit + 1}`.execute(this.#db);
    const rows = r.rows.slice(0, limit);
    const events = rows.map(
      (row) =>
        ({ ...row.context, ts: ms(row.ts), kind: row.kind, app: row.app_id }) as TelemetryEvent,
    );
    const last = rows[rows.length - 1];
    return r.rows.length > limit && last !== undefined
      ? { events, next: encodeTelemetryCursor({ ts: ms(last.ts), id: last.event_id }) }
      : { events };
  }

  async deleteAll(uid: number): Promise<number> {
    const r = await sql`DELETE FROM telemetry_events WHERE uid = ${uid}`.execute(this.#db);
    return Number(r.numAffectedRows ?? 0);
  }

  async sweepRetention(days: number): Promise<number> {
    const r = await sql`
      DELETE FROM telemetry_events WHERE received_at < now() - make_interval(days => ${days})`.execute(
      this.#db,
    );
    return Number(r.numAffectedRows ?? 0);
  }
}
