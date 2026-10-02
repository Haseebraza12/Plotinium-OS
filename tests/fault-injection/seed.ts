/**
 * Seeds users and fixture trees into an integration database with plain SQL, keeping every
 * maintained aggregate exact (directory nlink, users.used_*, blob refcounts), so the integrity
 * probes are clean before any fault is injected (database.md §3.29; DB-02).
 */
import { createHash } from 'node:crypto';

import { INO } from '../../protocol/src/wellknown.ts';
import { contentOf, type FixtureTree } from '../fixtures/trees.ts';
import { inTransaction, type Pool, type PoolClient } from '../support/sql.ts';

export const USERS_GID = 100;
const BIG_QUOTA_BYTES = 1e12;
const BIG_QUOTA_INODES = 10_000_000;
const DIR_MODE = 0o755;

export interface Owner {
  uid: number;
  gid: number;
}

/** Deterministic UUIDv7-shaped ids: an 8-hex namespace per seeded object group, then a counter. */
export function seededId(ns: number, i: number): string {
  const n = ns.toString(16).padStart(8, '0').slice(-8);
  return `${n}-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
}

let nsCounter = 0xf1000000;
/** A fresh namespace for each seeded group within one test process. */
export function nextNamespace(): number {
  nsCounter += 1;
  return nsCounter;
}

async function mkdir(
  c: PoolClient,
  parent: string,
  name: string,
  ino: string,
  owner: Owner,
): Promise<void> {
  await c.query(
    `INSERT INTO inodes (ino, type, mode, uid, gid, size, nlink) VALUES ($1, 'd', $2, $3, $4, 0, 2)`,
    [ino, DIR_MODE, owner.uid, owner.gid],
  );
  await c.query(
    `INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid) VALUES ($1, $2, $3, 'd', $4)`,
    [parent, name, ino, owner.uid],
  );
  await c.query(`UPDATE inodes SET nlink = nlink + 1 WHERE ino = $1`, [parent]);
  await c.query(`UPDATE users SET used_inodes = used_inodes + 1 WHERE uid = $1`, [owner.uid]);
}

/** A user with a large quota and a home directory `/home/<username>`; returns the home ino. */
export async function seedAccount(pool: Pool, uid: number, username: string): Promise<string> {
  const home = seededId(0xf0000000 + uid, 1);
  await inTransaction(pool, async (c) => {
    await c.query(
      `INSERT INTO users (uid, username, account_kind, password_hash, primary_gid, quota_bytes, quota_inodes)
       VALUES ($1, $2, 'user', '!', $3, $4, $5)`,
      [uid, username, USERS_GID, BIG_QUOTA_BYTES, BIG_QUOTA_INODES],
    );
    await c.query('INSERT INTO user_groups (uid, gid) VALUES ($1, $2)', [uid, USERS_GID]);
    await mkdir(c, INO.HOME, username, home, { uid, gid: USERS_GID });
  });
  return home;
}

/** An empty directory `name` under `parent`; returns its ino. */
export async function seedDir(
  pool: Pool,
  parent: string,
  name: string,
  owner: Owner,
): Promise<string> {
  const ino = seededId(nextNamespace(), 0);
  await inTransaction(pool, (c) => mkdir(c, parent, name, ino, owner));
  return ino;
}

export interface SeededTree {
  /** The fixture's top directory. */
  root: string;
  /** Relative fixture path → ino. */
  inoOf: Map<string, string>;
}

/** Inserts `tree` under `parent` in one transaction; returns its top directory's ino. */
export async function seedTree(
  pool: Pool,
  tree: FixtureTree,
  parent: string,
  owner: Owner,
): Promise<SeededTree> {
  const ns = nextNamespace();
  const inoOf = new Map(tree.nodes.map((n, i) => [n.path, seededId(ns, i + 1)]));
  const subdirs = new Map<string, number>();
  const parentOf = (path: string): string => {
    const cut = path.lastIndexOf('/');
    return cut < 0 ? parent : (inoOf.get(path.slice(0, cut)) ?? parent);
  };
  for (const n of tree.nodes)
    if (n.type === 'd') subdirs.set(parentOf(n.path), (subdirs.get(parentOf(n.path)) ?? 0) + 1);

  // Content depends only on the path and size, so short files share content and a second copy of a
  // fixture shares every blob: blobs are de-duplicated by SHA-256 with a refcount, as the server does.
  const files = tree.nodes.filter((n) => n.type === 'f' && n.size > 0);
  const shaOf = new Map(
    files.map((n) => [
      n.path,
      createHash('sha256').update(contentOf(n.path, n.size)).digest('hex'),
    ]),
  );
  const unique = new Map<string, { size: number; refs: number }>();
  for (const n of files) {
    const sha = shaOf.get(n.path) as string;
    const u = unique.get(sha);
    if (u === undefined) unique.set(sha, { size: n.size, refs: 1 });
    else u.refs += 1;
  }
  await inTransaction(pool, async (c) => {
    const blobIds = new Map<string, string>();
    if (unique.size > 0) {
      const res = await c.query<{ blob_id: string; hex: string }>(
        `INSERT INTO blobs (sha256, size, storage_key, refcount, first_ref_at, zero_since)
         SELECT decode(h, 'hex'), z, 'blobs/sha256/' || h, r, now(), NULL FROM unnest($1::text[], $2::bigint[], $3::int[]) AS t(h, z, r)
         ON CONFLICT (sha256) DO UPDATE SET refcount = blobs.refcount + EXCLUDED.refcount, zero_since = NULL
         RETURNING blob_id::text, encode(sha256, 'hex') AS hex`,
        [
          [...unique.keys()],
          [...unique.values()].map((u) => u.size),
          [...unique.values()].map((u) => u.refs),
        ],
      );
      for (const r of res.rows) blobIds.set(r.hex, r.blob_id);
    }
    const blobOf = new Map(
      files.map((n) => [n.path, blobIds.get(shaOf.get(n.path) as string) ?? null]),
    );
    const inos = tree.nodes.map((n) => inoOf.get(n.path) as string);
    await c.query(
      `INSERT INTO inodes (ino, type, mode, uid, gid, size, nlink, blob_id)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::smallint[], $4::int[], $5::int[], $6::bigint[], $7::int[], $8::bigint[])`,
      [
        inos,
        tree.nodes.map((n) => n.type),
        tree.nodes.map((n) => n.mode),
        tree.nodes.map(() => owner.uid),
        tree.nodes.map(() => owner.gid),
        tree.nodes.map((n) => n.size),
        tree.nodes.map((n, i) => (n.type === 'd' ? 2 + (subdirs.get(inos[i] as string) ?? 0) : 1)),
        tree.nodes.map((n) => blobOf.get(n.path) ?? null),
      ],
    );
    await c.query(
      `INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid)
       SELECT p, n, i, t, $5 FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[]) AS x(p, n, i, t)`,
      [
        tree.nodes.map((n) => parentOf(n.path)),
        tree.nodes.map((n) => n.path.slice(n.path.lastIndexOf('/') + 1)),
        inos,
        tree.nodes.map((n) => n.type),
        owner.uid,
      ],
    );
    await c.query(`UPDATE inodes SET nlink = nlink + $2 WHERE ino = $1`, [
      parent,
      subdirs.get(parent) ?? 0,
    ]);
    await c.query(
      `UPDATE users SET used_bytes = used_bytes + $2, used_inodes = used_inodes + $3 WHERE uid = $1`,
      [owner.uid, tree.nodes.reduce((s, n) => s + n.size, 0), tree.nodes.length],
    );
  });
  const root = inoOf.get(tree.id);
  if (root === undefined) throw new Error(`fixture ${tree.id} has no top directory`);
  return { root, inoOf };
}
