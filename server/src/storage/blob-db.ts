/**
 * The SQL behind /api/blobs (backend-api.md §3.6.3, §3.10; database.md §3.19; SRV-10, VFS-04,
 * VFS-06). Every method is one statement or one short transaction; no transaction is ever open
 * while an upload streams (INV-SRV-3).
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../db/types.gen.ts';
import { KyselyFeedReader } from '../engine/sync/feed-reader.ts';
import type { DirContext } from '../engine/sync/visibility.ts';

export interface BlobHolder {
  readonly ino: string;
  readonly type: 'f' | 'd' | 'l';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  /** Hex SHA-256 of the inode's CURRENT content, or null for an empty file. */
  readonly sha256: string | null;
  readonly size: number;
}

export interface BlobDb {
  /** Remaining byte quota of `uid` (quota_bytes - used_bytes); null for root (exempt) or unknown. */
  remainingBytes(uid: number): Promise<number | null>;
  /**
   * Records an uploaded blob: under pg_advisory_xact_lock(plt_blob_lock_key(sha256)), re-checks
   * that the file is still there (`fileExists`, the GC race of §3.10) and inserts the row with
   * refcount 0 ON CONFLICT DO NOTHING. False when the file vanished (the client re-uploads).
   */
  record(
    sha256: string,
    size: number,
    storageKey: string,
    fileExists: () => Promise<boolean>,
  ): Promise<boolean>;
  /** The inode and its current content hash, or null. */
  holder(ino: string): Promise<BlobHolder | null>;
  /** Up to `limit` inodes whose current content is `sha256` (HEAD without ?ino=). */
  holdersOf(sha256: string, limit: number): Promise<readonly BlobHolder[]>;
  /** Rows of `inos` and their ancestors (the x checks). */
  context(inos: readonly string[]): Promise<DirContext>;
}

interface HolderRow {
  ino: string;
  type: 'f' | 'd' | 'l';
  mode: number;
  uid: number;
  gid: number;
  sha256: string | null;
  size: number | string;
}

const toHolder = (r: HolderRow): BlobHolder => ({
  ino: r.ino,
  type: r.type,
  mode: r.mode,
  uid: r.uid,
  gid: r.gid,
  sha256: r.sha256,
  size: Number(r.size),
});

export class KyselyBlobDb implements BlobDb {
  readonly #db: Kysely<DB>;
  readonly #reader: KyselyFeedReader;

  constructor(db: Kysely<DB>) {
    this.#db = db;
    this.#reader = new KyselyFeedReader(db);
  }

  async remainingBytes(uid: number): Promise<number | null> {
    if (uid === 0) return null;
    const r = await sql<{ left: number | string }>`
      SELECT quota_bytes - used_bytes AS left FROM users WHERE uid = ${uid}`.execute(this.#db);
    const row = r.rows[0];
    return row === undefined ? null : Number(row.left);
  }

  async record(
    sha256: string,
    size: number,
    storageKey: string,
    fileExists: () => Promise<boolean>,
  ): Promise<boolean> {
    return this.#db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(plt_blob_lock_key(decode(${sha256}, 'hex')))`.execute(
        tx,
      );
      // The lock is held across one stat(): the GC unlinks files only under this same lock.
      if (!(await fileExists())) return false;
      await sql`
        INSERT INTO blobs (sha256, size, storage_key, refcount, first_ref_at, zero_since)
        VALUES (decode(${sha256}, 'hex'), ${size}, ${storageKey}, 0, NULL, now())
        ON CONFLICT ON CONSTRAINT blobs_sha256_key DO NOTHING`.execute(tx);
      return true;
    });
  }

  async holder(ino: string): Promise<BlobHolder | null> {
    const r = await sql<HolderRow>`
      SELECT i.ino, i.type, i.mode, i.uid, i.gid, encode(b.sha256, 'hex') AS sha256, i.size
      FROM inodes i LEFT JOIN blobs b ON b.blob_id = i.blob_id
      WHERE i.ino = ${ino}::uuid`.execute(this.#db);
    const row = r.rows[0];
    return row === undefined ? null : toHolder(row);
  }

  async holdersOf(sha256: string, limit: number): Promise<readonly BlobHolder[]> {
    const r = await sql<HolderRow>`
      SELECT i.ino, i.type, i.mode, i.uid, i.gid, encode(b.sha256, 'hex') AS sha256, i.size
      FROM blobs b JOIN inodes i ON i.blob_id = b.blob_id
      WHERE b.sha256 = decode(${sha256}, 'hex')
      ORDER BY i.ino
      LIMIT ${limit}`.execute(this.#db);
    return r.rows.map(toHolder);
  }

  context(inos: readonly string[]): Promise<DirContext> {
    return this.#reader.load(inos);
  }
}
