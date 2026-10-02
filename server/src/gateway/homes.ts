/**
 * Creating `/home/<user>` on the server (C5: home directories are minted only here, with a
 * server uuidv7(); virtual-file-system.md §3.3.1; security-model.md §3.6.1: mode 0700,
 * `<user>:<primary group>`). Used by guest creation and by the first-start seed, inside the
 * caller's transaction, AFTER the users row was inserted.
 *
 * Lock order (database.md §3.8): L1 the users rows of root (owner of /home) and of the new user,
 * ascending uid; L3 the /home inode. Directory nlink = 2 + child directories (DBD-17), so /home
 * gains one; the new inode counts against the user's inode quota (probe P5).
 * TODO(R2, W7): once the sync engine defines server-originated ops, record this mkdir in op_log
 * and write the feed row for root, so devices that mirror /home see the new entry without a
 * snapshot (offline-and-sync.md §3.8).
 */
import { sql, type Kysely } from 'kysely';

import { INO } from '@plotinium/protocol';

import type { DB } from '../db/types.gen.ts';

export const HOME_MODE = 0o700;

export interface HomeOwner {
  readonly uid: number;
  readonly username: string;
  readonly gid: number;
}

/** Returns the new home's ino. */
export async function createHome(tx: Kysely<DB>, owner: HomeOwner): Promise<string> {
  await sql`SELECT uid FROM users WHERE uid = ANY(${[0, owner.uid]}::int[]) ORDER BY uid FOR UPDATE`.execute(
    tx,
  );
  await sql`SELECT ino FROM inodes WHERE ino = ${INO.HOME} FOR UPDATE`.execute(tx);
  const created = await sql<{ ino: string }>`
    INSERT INTO inodes (type, mode, uid, gid, nlink)
    VALUES ('d', ${HOME_MODE}, ${owner.uid}, ${owner.gid}, 2)
    RETURNING ino`.execute(tx);
  const ino = created.rows[0]?.ino;
  if (ino === undefined) throw new Error('home inode was not created');
  await sql`
    INSERT INTO dentries (parent_ino, name, ino, d_type, owner_uid)
    VALUES (${INO.HOME}, ${owner.username}, ${ino}, 'd', ${owner.uid})`.execute(tx);
  await sql`
    UPDATE inodes SET nlink = nlink + 1, version = version + 1, modified_at = now(), changed_at = now()
    WHERE ino = ${INO.HOME}`.execute(tx);
  await sql`UPDATE users SET used_inodes = used_inodes + 1 WHERE uid = ${owner.uid}`.execute(tx);
  return ino;
}
