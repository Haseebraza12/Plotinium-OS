/**
 * GET /api/sync/snapshot (backend-api.md §3.6.2, §4.2; offline-and-sync.md §3.8.5; OFF-02, VFS-04,
 * VFS-10). The target of `snapshot.required` and of the client's directory re-fetch.
 *
 *   scope=owner&owner=U   the inodes owned by U plus the entries of directories owned by U: exactly
 *                         the set U's feed describes. '/' is included (with null parent and name)
 *                         when U owns it.
 *   scope=dir&ino=D       D's own row and D's entries. The principal needs r and x on D and x on
 *                         every ancestor (403 EACCES), D must exist (404 ENOENT) and be a directory.
 *   scope=subtree&ino=D   D's own row and the entries of every directory under D that the
 *                         principal can list and traverse (r and x), walked top-down with pruning.
 *
 * Visibility: a row is returned only if the principal can see its directory entry: r and x on the
 * parent and x on every ancestor (the same rule, and the same code, as the feed filter SYN-18;
 * the owner of a feed sees every row of it). `blob` only with r on the inode.
 * Consistency: the first page (no `after`) runs in one REPEATABLE READ READ ONLY transaction that
 * also reads users.feed_seq of the owners involved (`owners`); later pages use keyset pagination on
 * (ino, parent_ino, name) in ordinary statements, and the client's version-guarded apply plus the
 * feed resumed from `headSeq` make the result complete.
 *
 * TODO(protocol): SnapshotQuery / SnapshotRow / SnapshotPage belong in protocol/src/http/sync.ts
 * (backend-api.md §4.2); they are declared here (and in vfs/src/sync/types.ts) until it exists.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import * as v from 'valibot';

import { INO } from '@plotinium/protocol';
import { may, R, type Cred } from '@plotinium/vfs/perm';

import type { DB } from '../db/types.gen.ts';
import { KyselyFeedReader } from '../engine/sync/feed-reader.ts';
import { canSeeIn, type DirContext } from '../engine/sync/visibility.ts';
import { HttpError } from '../http/errors.ts';

export const SNAPSHOT_LIMIT_MAX = 2000;
export const SNAPSHOT_LIMIT_DEFAULT = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const Uuid = v.pipe(v.string(), v.regex(UUID_RE));
const Decimal = (min: number, max: number) =>
  v.pipe(
    v.string(),
    v.regex(/^\d{1,10}$/),
    v.transform(Number),
    v.integer(),
    v.minValue(min),
    v.maxValue(max),
  );

/** The query string (every value arrives as a string). */
export const SnapshotQueryString = v.object({
  scope: v.picklist(['owner', 'dir', 'subtree']),
  owner: v.optional(Decimal(0, 2_147_483_647)),
  ino: v.optional(Uuid),
  after: v.optional(v.pipe(v.string(), v.maxLength(1024))),
  limit: v.optional(Decimal(1, SNAPSHOT_LIMIT_MAX), String(SNAPSHOT_LIMIT_DEFAULT)),
});
export type SnapshotQueryString = v.InferOutput<typeof SnapshotQueryString>;

export type SnapshotQuery =
  | {
      readonly scope: 'owner';
      readonly owner: number;
      readonly after: SnapshotCursor | null;
      readonly limit: number;
    }
  | {
      readonly scope: 'dir' | 'subtree';
      readonly ino: string;
      readonly after: SnapshotCursor | null;
      readonly limit: number;
    };

export interface SnapshotRow {
  readonly parentIno: string | null;
  readonly name: string | null;
  readonly ino: string;
  readonly type: 'f' | 'd' | 'l';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly nlink: number;
  readonly version: number;
  readonly blob?: string;
  readonly symlinkTarget?: string;
  readonly mtime: number;
  readonly ctime: number;
  readonly btime: number;
}

export interface SnapshotPage {
  readonly owners?: readonly { readonly ownerUid: number; readonly headSeq: number }[];
  readonly rows: readonly SnapshotRow[];
  readonly next?: string;
  readonly complete: boolean;
}

/** Keyset position: (ino, parent_ino, name) of the last candidate row of the previous page. */
export interface SnapshotCursor {
  readonly ino: string;
  readonly parent: string;
  readonly name: string;
}

/** '/' has no entry; its keyset position sorts before any entry of the same ino. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export function encodeCursor(c: SnapshotCursor): string {
  return Buffer.from(JSON.stringify([c.ino, c.parent, c.name]), 'utf8').toString('base64url');
}

export function decodeCursor(s: string): SnapshotCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      typeof parsed[0] === 'string' &&
      UUID_RE.test(parsed[0]) &&
      typeof parsed[1] === 'string' &&
      UUID_RE.test(parsed[1]) &&
      typeof parsed[2] === 'string' &&
      parsed[2].length <= 1024
    ) {
      return { ino: parsed[0], parent: parsed[1], name: parsed[2] };
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'EINVAL', 'bad snapshot cursor', { field: 'after' });
}

/** Parses the query string into a SnapshotQuery (400 EINVAL naming the field). */
export function parseSnapshotQuery(q: SnapshotQueryString): SnapshotQuery {
  const after = q.after === undefined || q.after === '' ? null : decodeCursor(q.after);
  if (q.scope === 'owner') {
    if (q.owner === undefined)
      throw new HttpError(400, 'EINVAL', 'scope=owner needs owner', { field: 'owner' });
    return { scope: 'owner', owner: q.owner, after, limit: q.limit };
  }
  if (q.ino === undefined)
    throw new HttpError(400, 'EINVAL', `scope=${q.scope} needs ino`, { field: 'ino' });
  return { scope: q.scope, ino: q.ino, after, limit: q.limit };
}

/** One candidate row as SQL returns it (before the visibility filter). */
export interface RawSnapshotRow {
  readonly parent_ino: string | null;
  readonly parent_uid: number | null;
  readonly name: string | null;
  readonly ino: string;
  readonly type: 'f' | 'd' | 'l';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number | string;
  readonly nlink: number;
  readonly version: number | string;
  readonly blob: string | null;
  readonly symlink_target: string | null;
  readonly modified_at: Date | string;
  readonly changed_at: Date | string;
  readonly created_at: Date | string;
}

type Executor = Kysely<DB> | Transaction<DB>;

const COLUMNS = sql`
  i.ino, i.type, i.mode, i.uid, i.gid, i.size, i.nlink, i.version,
  encode(b.sha256, 'hex') AS blob, i.symlink_target, i.modified_at, i.changed_at, i.created_at`;

function afterClause(after: SnapshotCursor | null) {
  return after === null
    ? sql`true`
    : sql`(i.ino, d.parent_ino, d.name) > (${after.ino}::uuid, ${after.parent}::uuid, ${after.name})`;
}

/** The SQL of the three scopes (candidate rows in keyset order, before the visibility filter). */
export const snapshotSql = {
  async rootRow(db: Executor): Promise<RawSnapshotRow | null> {
    const r = await sql<RawSnapshotRow>`
      SELECT NULL::uuid AS parent_ino, NULL::int AS parent_uid, NULL::text AS name, ${COLUMNS}
      FROM inodes i LEFT JOIN blobs b ON b.blob_id = i.blob_id
      WHERE i.ino = ${INO.ROOT}`.execute(db);
    return r.rows[0] ?? null;
  },

  async ownerRows(
    db: Executor,
    owner: number,
    after: SnapshotCursor | null,
    limit: number,
  ): Promise<readonly RawSnapshotRow[]> {
    const r = await sql<RawSnapshotRow>`
      SELECT d.parent_ino, p.uid AS parent_uid, d.name, ${COLUMNS}
      FROM dentries d
      JOIN inodes i ON i.ino = d.ino
      JOIN inodes p ON p.ino = d.parent_ino
      LEFT JOIN blobs b ON b.blob_id = i.blob_id
      WHERE (i.uid = ${owner} OR p.uid = ${owner}) AND ${afterClause(after)}
      ORDER BY i.ino, d.parent_ino, d.name
      LIMIT ${limit}`.execute(db);
    return r.rows;
  },

  /** The directory's own entry (null for '/') and its entries. */
  async dirRows(
    db: Executor,
    dir: string,
    after: SnapshotCursor | null,
    limit: number,
  ): Promise<readonly RawSnapshotRow[]> {
    const r = await sql<RawSnapshotRow>`
      SELECT d.parent_ino, p.uid AS parent_uid, d.name, ${COLUMNS}
      FROM dentries d
      JOIN inodes i ON i.ino = d.ino
      JOIN inodes p ON p.ino = d.parent_ino
      LEFT JOIN blobs b ON b.blob_id = i.blob_id
      WHERE (d.parent_ino = ${dir}::uuid OR (d.ino = ${dir}::uuid AND d.d_type = 'd'))
        AND ${afterClause(after)}
      ORDER BY i.ino, d.parent_ino, d.name
      LIMIT ${limit}`.execute(db);
    return r.rows;
  },

  /** Entries of every directory under `root` the principal can list and traverse (r and x). */
  async subtreeRows(
    db: Executor,
    root: string,
    cred: Cred,
    after: SnapshotCursor | null,
    limit: number,
  ): Promise<readonly RawSnapshotRow[]> {
    const gids = [...cred.groups];
    const r = await sql<RawSnapshotRow>`
      WITH RECURSIVE walk(ino, depth) AS (
        SELECT ${root}::uuid, 0
        UNION ALL
        SELECT c.ino, w.depth + 1
        FROM walk w
        JOIN dentries c ON c.parent_ino = w.ino AND c.d_type = 'd'
        JOIN inodes ci ON ci.ino = c.ino
        WHERE w.depth < 4096
          AND plt_may(ci.type, ci.mode, ci.uid, ci.gid, ${cred.uid}::int, ${gids}::int[], 5)
      )
      SELECT d.parent_ino, p.uid AS parent_uid, d.name, ${COLUMNS}
      FROM dentries d
      JOIN inodes i ON i.ino = d.ino
      JOIN inodes p ON p.ino = d.parent_ino
      LEFT JOIN blobs b ON b.blob_id = i.blob_id
      WHERE (d.parent_ino IN (SELECT ino FROM walk) OR (d.ino = ${root}::uuid AND d.d_type = 'd'))
        AND ${afterClause(after)}
      ORDER BY i.ino, d.parent_ino, d.name
      LIMIT ${limit}`.execute(db);
    return r.rows;
  },

  async heads(
    db: Executor,
    owners: readonly number[],
  ): Promise<readonly { ownerUid: number; headSeq: number }[]> {
    if (owners.length === 0) return [];
    const r = await sql<{ uid: number; feed_seq: number | string }>`
      SELECT uid, feed_seq FROM users WHERE uid = ANY(${[...owners]}::int[]) ORDER BY uid`.execute(
      db,
    );
    return r.rows.map((row) => ({ ownerUid: row.uid, headSeq: Number(row.feed_seq) }));
  },
};

const ms = (t: Date | string): number => (t instanceof Date ? t : new Date(t)).getTime();

export function toSnapshotRow(r: RawSnapshotRow, blobVisible: boolean): SnapshotRow {
  return {
    parentIno: r.parent_ino,
    name: r.name,
    ino: r.ino,
    type: r.type,
    mode: r.mode,
    uid: r.uid,
    gid: r.gid,
    size: Number(r.size),
    nlink: r.nlink,
    version: Number(r.version),
    ...(blobVisible && r.blob !== null ? { blob: r.blob } : {}),
    ...(r.symlink_target === null ? {} : { symlinkTarget: r.symlink_target }),
    mtime: ms(r.modified_at),
    ctime: ms(r.changed_at),
    btime: ms(r.created_at),
  };
}

function cursorOf(r: RawSnapshotRow): SnapshotCursor {
  return { ino: r.ino, parent: r.parent_ino ?? NIL_UUID, name: r.name ?? '' };
}

/** The snapshot reader behind the route. */
export class SnapshotService {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async page(cred: Cred, q: SnapshotQuery): Promise<SnapshotPage> {
    if (q.after === null) {
      return this.#db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute((tx) => this.#page(tx, cred, q, true));
    }
    return this.#page(this.#db, cred, q, false);
  }

  async #page(db: Executor, cred: Cred, q: SnapshotQuery, first: boolean): Promise<SnapshotPage> {
    const reader = new KyselyFeedReader(db);
    let candidates: readonly RawSnapshotRow[];
    let self: RawSnapshotRow | null = null;
    let ctx: DirContext;

    if (q.scope === 'owner') {
      candidates = await snapshotSql.ownerRows(db, q.owner, q.after, q.limit);
      if (first) {
        const root = await snapshotSql.rootRow(db);
        if (root !== null && root.uid === q.owner) self = root;
      }
      ctx = await reader.load([...new Set(candidates.map((c) => c.parent_ino ?? c.ino))]);
    } else {
      ctx = await reader.load([q.ino]);
      const dir = ctx.get(q.ino);
      if (dir === undefined)
        throw new HttpError(404, 'ENOENT', 'no such directory', { ino: q.ino });
      if (dir.row.type !== 'd')
        throw new HttpError(409, 'ENOTDIR', 'not a directory', { ino: q.ino });
      if (!canSeeIn(cred, q.ino, ctx))
        throw new HttpError(403, 'EACCES', 'the directory needs r and x', { ino: q.ino });
      candidates =
        q.scope === 'dir'
          ? await snapshotSql.dirRows(db, q.ino, q.after, q.limit)
          : await snapshotSql.subtreeRows(db, q.ino, cred, q.after, q.limit);
      if (first && q.ino === INO.ROOT) self = await snapshotSql.rootRow(db);
      const parents = [...new Set(candidates.map((c) => c.parent_ino ?? c.ino))];
      const missing = parents.filter((p) => !ctx.has(p));
      if (missing.length > 0) {
        const more = await reader.load(missing);
        ctx = new Map([...ctx, ...more]);
      }
    }

    const rows: SnapshotRow[] = [];
    const owners = new Set<number>();
    const add = (r: RawSnapshotRow, visible: boolean): void => {
      if (!visible) return;
      rows.push(toSnapshotRow(r, may(cred, r, R)));
      owners.add(r.uid);
      if (r.parent_uid !== null) owners.add(r.parent_uid);
    };
    if (self !== null) add(self, true);
    const seeAll = q.scope === 'owner' && cred.uid === q.owner;
    const scopeDir = q.scope === 'owner' ? null : q.ino;
    for (const c of candidates) {
      // The requested directory's own entry is visible once the scope check passed (x to it).
      const ownEntry = c.ino === scopeDir && c.type === 'd';
      add(c, seeAll || ownEntry || canSeeIn(cred, c.parent_ino, ctx));
    }

    const complete = candidates.length < q.limit;
    const last = candidates[candidates.length - 1];
    const next = !complete && last !== undefined ? encodeCursor(cursorOf(last)) : undefined;
    const ownerList =
      q.scope === 'owner' ? [q.owner] : [...owners].sort((a, b) => a - b).slice(0, 64);
    return {
      ...(first ? { owners: await snapshotSql.heads(db, ownerList) } : {}),
      rows,
      ...(next === undefined ? {} : { next }),
      complete,
    };
  }
}
