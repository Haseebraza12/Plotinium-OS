/** User and group names for output (`ls -l`, `stat`, `ps`) and lookups (`chown`, `id -u USER`). */
import type { SysGen, Sys } from './sys.ts';

export interface UserRec {
  readonly uid: number;
  readonly name: string;
  readonly gid: number;
  readonly home: string;
  readonly groups: readonly number[];
}

export interface UserDb {
  readonly users: readonly UserRec[];
  readonly groups: readonly { readonly gid: number; readonly name: string }[];
}

const EMPTY: UserDb = { users: [], groups: [] };

/** `users.list`; an unavailable list only costs the names, so failures give an empty table. */
export function* loadUsers(sys: Sys): SysGen<UserDb> {
  try {
    return yield* sys.call('users.list', {});
  } catch {
    return EMPTY;
  }
}

export function userName(db: UserDb, uid: number): string {
  return db.users.find((u) => u.uid === uid)?.name ?? String(uid);
}

export function groupName(db: UserDb, gid: number): string {
  return db.groups.find((g) => g.gid === gid)?.name ?? String(gid);
}

/** A user by name, or by numeric id when the text is all digits. */
export function findUser(db: UserDb, text: string): UserRec | undefined {
  const byName = db.users.find((u) => u.name === text);
  if (byName !== undefined || !/^\d+$/.test(text)) return byName;
  return db.users.find((u) => u.uid === Number(text));
}

/** A group id by name or number; numbers are accepted even when no name is known. */
export function findGid(db: UserDb, text: string): number | undefined {
  const byName = db.groups.find((g) => g.name === text);
  if (byName !== undefined) return byName.gid;
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

/** A uid by name or number; numbers are accepted even when no name is known. */
export function findUid(db: UserDb, text: string): number | undefined {
  const user = findUser(db, text);
  if (user !== undefined) return user.uid;
  return /^\d+$/.test(text) ? Number(text) : undefined;
}
