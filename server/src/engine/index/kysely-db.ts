/**
 * IndexDb on PostgreSQL + pgvector through Kysely (database.md §3.20, §4.11.18; backend-api.md
 * §3.12). The readable-set statements live in readable.sql.ts; this module adds the write path:
 *
 *   index.put, ONE short transaction (no blob I/O inside it; the text checks ran before):
 *     1. pg_advisory_xact_lock(plt_index_put_lock_key())  chunk_ids in commit order (DBD-15), so
 *        the pull cursor `chunk_id > after` never skips a row that commits late;
 *     2. the version re-check (409 EAGAIN 'stale-version' when the file changed meanwhile);
 *     3. vectors of `reuse` chunks copied from the rows being replaced (same content hash);
 *     4. DELETE the (ino, model_key) set; 5. INSERT the new rows.
 *   Deleting a file removes its rows through file_chunks_ino_fk ON DELETE CASCADE inside the
 *   unlink's own transaction; renames never touch file_chunks (paths are resolved at query time).
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/types.gen.ts';
import { parseVector, pullSql, searchSql, vectorLiteral, verifySql } from './readable.sql.ts';
import type {
  FileMeta,
  IndexDb,
  IndexPutInput,
  PulledChunk,
  PullQuery,
  ReplaceOutcome,
  Requester,
  SearchHit,
  SearchQuery,
  VerifyItem,
  VerifyResult,
} from './types.ts';

class Rollback extends Error {
  readonly outcome: ReplaceOutcome;
  constructor(outcome: ReplaceOutcome) {
    super('rollback');
    this.outcome = outcome;
  }
}

export class KyselyIndexDb implements IndexDb {
  readonly #db: Kysely<DB>;

  constructor(db: Kysely<DB>) {
    this.#db = db;
  }

  async fileMeta(ino: string): Promise<FileMeta | null> {
    const r = await sql<{
      ino: string;
      type: 'f' | 'd' | 'l';
      mode: number;
      uid: number;
      gid: number;
      version: number | string;
      size: number | string;
      blob_sha256: string | null;
    }>`SELECT i.ino::text AS ino, i.type, i.mode, i.uid, i.gid, i.version, i.size,
              encode(b.sha256, 'hex') AS blob_sha256
         FROM inodes i LEFT JOIN blobs b ON b.blob_id = i.blob_id
        WHERE i.ino = ${ino}::uuid`.execute(this.#db);
    const m = r.rows[0];
    return m === undefined
      ? null
      : {
          ino: m.ino,
          type: m.type,
          mode: m.mode,
          uid: m.uid,
          gid: m.gid,
          version: Number(m.version),
          size: Number(m.size),
          blobSha256: m.blob_sha256,
        };
  }

  async storedVersion(ino: string, modelKey: string): Promise<number | null> {
    const r = await sql<{ v: number | string | null }>`
      SELECT max(inode_version) AS v FROM file_chunks
       WHERE ino = ${ino}::uuid AND model_key = ${modelKey}`.execute(this.#db);
    const v = r.rows[0]?.v;
    return v === null || v === undefined ? null : Number(v);
  }

  async replaceChunks(input: IndexPutInput): Promise<ReplaceOutcome> {
    try {
      return await this.#db.transaction().execute(async (tx) => {
        await sql`SELECT pg_advisory_xact_lock(plt_index_put_lock_key())`.execute(tx);
        const cur = await sql<{ version: number | string }>`
          SELECT version FROM inodes WHERE ino = ${input.ino}::uuid AND type = 'f'`.execute(tx);
        const version = cur.rows[0]?.version;
        if (version === undefined || Number(version) !== input.inodeVersion) {
          throw new Rollback({ ok: false, reason: 'stale-version' });
        }
        const reuse = [
          ...new Set(input.chunks.filter((c) => c.embedding === null).map((c) => c.contentHash)),
        ];
        const stored = new Map<string, string>();
        if (reuse.length > 0) {
          const r = await sql<{ h: string; e: string }>`
            SELECT DISTINCT ON (content_hash) encode(content_hash, 'hex') AS h, embedding::text AS e
              FROM file_chunks
             WHERE ino = ${input.ino}::uuid AND model_key = ${input.modelKey}
               AND content_hash IN (SELECT decode(h, 'hex') FROM unnest(${reuse}::text[]) AS h)
             ORDER BY content_hash, chunk_id`.execute(tx);
          for (const row of r.rows) stored.set(row.h, row.e);
        }
        const rows = input.chunks.map((c) => {
          const embedding =
            c.embedding === null ? stored.get(c.contentHash) : vectorLiteral(c.embedding);
          if (embedding === undefined)
            throw new Rollback({ ok: false, reason: 'missing-embedding', seq: c.seq });
          return {
            seq: c.seq,
            byte_start: c.byteStart,
            byte_end: c.byteEnd,
            line_start: c.lineStart,
            line_end: c.lineEnd,
            header: c.header,
            text: c.text,
            content_hash: c.contentHash,
            embedding,
          };
        });
        await sql`DELETE FROM file_chunks WHERE ino = ${input.ino}::uuid AND model_key = ${input.modelKey}`.execute(
          tx,
        );
        if (rows.length > 0) {
          await sql`
            INSERT INTO file_chunks (ino, inode_version, model_key, seq, byte_start, byte_end, line_start,
                                     line_end, header, text, content_hash, embedding)
            SELECT ${input.ino}::uuid, ${input.inodeVersion}, ${input.modelKey}, c.seq, c.byte_start, c.byte_end,
                   c.line_start, c.line_end, c.header, c.text, decode(c.content_hash, 'hex'), c.embedding::vector
              FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
                   AS c(seq int, byte_start int, byte_end int, line_start int, line_end int,
                        header text, text text, content_hash text, embedding text)`.execute(tx);
        }
        return { ok: true, rows: rows.length } as const;
      });
    } catch (e) {
      if (e instanceof Rollback) return e.outcome;
      throw e;
    }
  }

  async pull(
    req: Requester,
    q: PullQuery,
  ): Promise<{ rows: readonly PulledChunk[]; manifestFiles: number }> {
    const r = await pullSql(req, q).execute(this.#db);
    const rows: PulledChunk[] = [];
    let manifestFiles = 0;
    for (const p of r.rows) {
      manifestFiles = p.manifest_files;
      if (p.chunk_id === null || p.ino === null) continue;
      const owned = p.owned === true;
      rows.push({
        chunkId: Number(p.chunk_id),
        ino: p.ino,
        inodeVersion: Number(p.inode_version),
        seq: p.seq ?? 0,
        byteStart: p.byte_start ?? 0,
        byteEnd: p.byte_end ?? 0,
        lineStart: p.line_start ?? 1,
        lineEnd: p.line_end ?? 1,
        header: owned ? (p.header ?? '') : '',
        contentHash: p.content_hash ?? '',
        modelKey: p.model_key ?? q.modelKey,
        owned,
        ...(owned && p.text !== null ? { text: p.text } : {}),
        embedding: parseVector(p.embedding ?? '[]'),
      });
    }
    return { rows, manifestFiles };
  }

  async search(req: Requester, q: SearchQuery): Promise<readonly SearchHit[]> {
    const r = await searchSql(req, q).execute(this.#db);
    return r.rows.map((h) => ({
      ino: h.ino,
      path: h.path,
      seq: h.seq,
      lineStart: h.line_start,
      lineEnd: h.line_end,
      score: Number(h.score),
      snippet: h.snippet,
    }));
  }

  async verify(
    req: Requester,
    modelKey: string,
    items: readonly VerifyItem[],
  ): Promise<readonly VerifyResult[]> {
    const r = await verifySql(req, modelKey, items).execute(this.#db);
    return r.rows.map((row) =>
      row.readable
        ? {
            ino: row.ino,
            seq: row.seq,
            readable: true,
            ...(row.path === null ? {} : { path: row.path }),
            ...(row.inode_version === null ? {} : { inodeVersion: Number(row.inode_version) }),
            ...(row.snippet === null ? {} : { snippet: row.snippet }),
          }
        : { ino: row.ino, seq: row.seq, readable: false },
    );
  }
}
