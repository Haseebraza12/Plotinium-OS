/**
 * The readable-set SQL: the single source of the index API's permission filter (backend-api.md
 * §3.12, SRV-12; rag-semantic-search.md §4.5; database.md §3.20, §4.11.18; RAG-03).
 *
 * Every statement reads the CURRENT inodes and dentries through may_r / may_x (IMMUTABLE SQL
 * mirrors of vfs/perm.ts), so the filter is applied BEFORE ranking (I-A1) and never from a copy
 * of owner, group or mode (I-A2). Two shapes, both mirrored line for line by reference.ts:
 *
 *   top-down  (search, pull)  walk from / through directories with x (pruning), then keep files
 *                             with r whose parent was reached; O(D + F) rows.
 *   upward    (verify)        from each candidate, one chain per link up to /, blocked when any
 *                             directory on it lacks x; readable = r on the file and one open chain
 *                             that reaches /; O(n · d).
 *
 * Paths are built with COLLATE "C" (UTF-8 byte order) so the recursive terms agree on collation
 * and ties between hard links resolve to the byte-wise smallest path.
 */
import { sql, type RawBuilder } from 'kysely';

import { MAX_DEPTH, ROOT_INO } from './reference.ts';
import type { PullQuery, Requester, SearchQuery, VerifyItem } from './types.ts';

/** pgvector's text form: '[x1,x2,...]'. Non-finite values are refused (EINVAL upstream). */
export function vectorLiteral(v: Float32Array | readonly number[]): string {
  let s = '[';
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    if (!Number.isFinite(x)) throw new RangeError('vector component is not finite');
    s += (i === 0 ? '' : ',') + String(x);
  }
  return `${s}]`;
}

/** Parses pgvector's text output ('[1,2,3]') into a Float32Array. */
export function parseVector(text: string): Float32Array {
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (inner === '') return new Float32Array(0);
  const parts = inner.split(',');
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]);
  return out;
}

/** CTEs `me`, `walk` and `readable(ino, path, owner_uid)`; follow with `WITH RECURSIVE`. */
export function readableCtes(req: Requester, scopeIno: string | null): RawBuilder<unknown> {
  const gids = [...req.gids];
  return sql`me AS (SELECT ${req.uid}::int AS uid, ${gids}::int[] AS gids),
walk AS (
  SELECT i.ino, ''::text COLLATE "C" AS path,
         (${scopeIno}::uuid IS NULL OR i.ino = ${scopeIno}::uuid) AS under, 0 AS depth
    FROM inodes i, me
   WHERE i.ino = ${ROOT_INO}::uuid AND i.type = 'd' AND may_x(i, me.uid, me.gids)
  UNION ALL
  SELECT d.ino, (w.path || '/' || d.name) COLLATE "C", (w.under OR d.ino = ${scopeIno}::uuid), w.depth + 1
    FROM walk w
    JOIN dentries d ON d.parent_ino = w.ino
    JOIN inodes i ON i.ino = d.ino, me
   WHERE d.d_type = 'd' AND w.depth < ${MAX_DEPTH - 1} AND may_x(i, me.uid, me.gids)
),
readable AS (
  SELECT DISTINCT ON (d.ino) d.ino, (w.path || '/' || d.name) COLLATE "C" AS path, i.uid AS owner_uid
    FROM walk w
    JOIN dentries d ON d.parent_ino = w.ino
    JOIN inodes i ON i.ino = d.ino, me
   WHERE d.d_type = 'f' AND w.under AND may_r(i, me.uid, me.gids)
   ORDER BY d.ino, 2
)`;
}

/** The readable set alone: (ino, path, owner_uid). Used by tests and probes. */
export function readableSetSql(req: Requester, scopeIno: string | null = null) {
  return sql<{
    ino: string;
    path: string;
    owner_uid: number;
  }>`WITH RECURSIVE ${readableCtes(req, scopeIno)}
SELECT r.ino::text AS ino, r.path, r.owner_uid FROM readable r ORDER BY r.ino`;
}

export interface SearchRow {
  ino: string;
  path: string;
  seq: number;
  line_start: number;
  line_end: number;
  snippet: string;
  score: number;
}

/** The exact search oracle (backend-api.md §3.12): filter, then rank; ties by (ino, seq). */
export function searchSql(req: Requester, q: SearchQuery) {
  const vec = vectorLiteral(q.vector);
  return sql<SearchRow>`WITH RECURSIVE ${readableCtes(req, q.scopeIno ?? null)}
SELECT c.ino::text AS ino, r.path, c.seq, c.line_start, c.line_end, left(c.text, 240) AS snippet,
       -(c.embedding <#> ${vec}::vector) AS score
  FROM file_chunks c JOIN readable r USING (ino)
 WHERE c.model_key = ${q.modelKey}
 ORDER BY c.embedding <#> ${vec}::vector, c.ino, c.seq
 LIMIT ${q.k}`;
}

export interface PullRow {
  manifest_files: number;
  chunk_id: number | string | null;
  ino: string | null;
  inode_version: number | string | null;
  seq: number | null;
  byte_start: number | null;
  byte_end: number | null;
  line_start: number | null;
  line_end: number | null;
  header: string | null;
  text: string | null;
  content_hash: string | null;
  model_key: string | null;
  embedding: string | null;
  owned: boolean | null;
}

/**
 * One page of the pull cursor plus the manifest count, in one statement. Text and heading trail
 * leave the database only for chunks of files the requester owns (I-A3).
 */
export function pullSql(req: Requester, q: PullQuery) {
  return sql<PullRow>`WITH RECURSIVE ${readableCtes(req, null)},
page AS (
  SELECT c.chunk_id, c.ino::text AS ino, c.inode_version, c.seq, c.byte_start, c.byte_end,
         c.line_start, c.line_end,
         CASE WHEN r.owner_uid = me.uid THEN c.header ELSE '' END AS header,
         CASE WHEN r.owner_uid = me.uid THEN c.text END AS text,
         encode(c.content_hash, 'hex') AS content_hash, c.model_key, c.embedding::text AS embedding,
         (r.owner_uid = me.uid) AS owned
    FROM file_chunks c JOIN readable r USING (ino), me
   WHERE c.model_key = ${q.modelKey} AND c.chunk_id > ${q.after}
   ORDER BY c.chunk_id
   LIMIT ${q.limit}
),
manifest AS (
  SELECT count(DISTINCT c.ino)::int AS files
    FROM file_chunks c JOIN readable r USING (ino)
   WHERE c.model_key = ${q.modelKey}
)
SELECT m.files AS manifest_files, p.*
  FROM manifest m LEFT JOIN page p ON true
 ORDER BY p.chunk_id`;
}

export interface VerifyRow {
  ino: string;
  seq: number;
  readable: boolean;
  path: string | null;
  inode_version: number | string | null;
  snippet: string | null;
}

/** Upward per-link verification of at most 50 (ino, seq) items, in the order given. */
export function verifySql(req: Requester, modelKey: string, items: readonly VerifyItem[]) {
  const gids = [...req.gids];
  const inos = items.map((i) => i.ino);
  const seqs = items.map((i) => i.seq);
  return sql<VerifyRow>`WITH RECURSIVE
items AS (SELECT * FROM unnest(${inos}::uuid[], ${seqs}::int[]) WITH ORDINALITY AS t(ino, seq, ord)),
cand AS (SELECT DISTINCT ino FROM items),
up AS (
  SELECT c.ino AS leaf, d.parent_ino AS lp, d.name AS ln, d.parent_ino AS dir,
         d.name COLLATE "C" AS seg, 1 AS depth
    FROM cand c JOIN dentries d ON d.ino = c.ino
  UNION ALL
  SELECT u.leaf, u.lp, u.ln, p.parent_ino, p.name COLLATE "C", u.depth + 1
    FROM up u JOIN dentries p ON p.ino = u.dir
   WHERE u.depth < ${MAX_DEPTH}
),
blocked AS (
  SELECT DISTINCT u.leaf, u.lp, u.ln
    FROM up u JOIN inodes di ON di.ino = u.dir
   WHERE NOT may_x(di, ${req.uid}::int, ${gids}::int[])
),
open_links AS (
  SELECT u.leaf, ('/' || string_agg(u.seg, '/' ORDER BY u.depth DESC)) COLLATE "C" AS path
    FROM up u
   WHERE NOT EXISTS (SELECT 1 FROM blocked b WHERE b.leaf = u.leaf AND b.lp = u.lp AND b.ln = u.ln)
   GROUP BY u.leaf, u.lp, u.ln
  HAVING bool_or(u.dir = ${ROOT_INO}::uuid)
),
res AS (
  SELECT c.ino, i.version,
         (i.type = 'f' AND may_r(i, ${req.uid}::int, ${gids}::int[])
          AND EXISTS (SELECT 1 FROM open_links o WHERE o.leaf = c.ino)) AS readable,
         (SELECT min(o.path) FROM open_links o WHERE o.leaf = c.ino) AS path
    FROM cand c JOIN inodes i ON i.ino = c.ino
)
SELECT it.ino::text AS ino, it.seq, coalesce(res.readable, false) AS readable,
       CASE WHEN res.readable THEN res.path END AS path,
       CASE WHEN res.readable THEN res.version END AS inode_version,
       CASE WHEN res.readable THEN (
         SELECT left(fc.text, 240) FROM file_chunks fc
          WHERE fc.ino = it.ino AND fc.seq = it.seq AND fc.model_key = ${modelKey}
            AND fc.inode_version = res.version) END AS snippet
  FROM items it LEFT JOIN res ON res.ino = it.ino
 ORDER BY it.ord`;
}
