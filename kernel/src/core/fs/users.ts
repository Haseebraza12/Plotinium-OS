/**
 * Users as the kernel file system sees them (virtual-file-system.md §3.3.1, §3.8).
 *
 * - `FsUserDirectory`: the kernel's `UserDirectory` (uid → name for `ps`, `uname`, `proc.list`)
 *   backed by the VFS `users` mirror (the TODO(R2) of core/proc/users.ts).
 * - `provisionLocalUser`: create a user's `users` row and `/home/<name>` (0700, owned by the user)
 *   in ONE strict transaction, local-only. Normally the server creates users and the first login
 *   mirrors the home directory (C5); this is for standalone mounts: Node tests and the offline demo
 *   when no server exists. It writes no outbox op.
 */
import { GID_USERS, INO, uuidv7 } from '@plotinium/protocol';
import type { DentryRec, InodeRec, OutboxRec, StoreWrite, UserRec, Uuid } from '@plotinium/vfs';
import { dirBounds, validateName } from '@plotinium/vfs';

import { KernelError } from '../errors.ts';
import type { UserDirectory } from '../proc/users.ts';
import type { KernelFs } from './kfs.ts';

export class FsUserDirectory implements UserDirectory {
  private readonly fs: KernelFs;
  private readonly fallback: UserDirectory | undefined;

  constructor(fs: KernelFs, fallback?: UserDirectory) {
    this.fs = fs;
    this.fallback = fallback;
  }

  nameOf(uid: number): string {
    const u = this.fs.mounted ? this.fs.tree.user(uid) : undefined;
    return u?.username ?? this.fallback?.nameOf(uid) ?? (uid === 0 ? 'root' : `u${String(uid)}`);
  }
}

export interface LocalUser {
  readonly uid: number;
  readonly username: string;
  /** Primary group (default `users`, 100). */
  readonly gid?: number;
  readonly groups?: readonly number[];
  readonly kind?: UserRec['kind'];
  readonly quotaBytes?: number;
  readonly quotaInodes?: number;
  /** Home directory mode (default 0700). */
  readonly homeMode?: number;
  readonly homeIno?: Uuid;
}

/** Default quotas of a locally provisioned user: 100 MiB and 10,000 inodes. */
export const LOCAL_QUOTA_BYTES = 100 * 1_048_576;
export const LOCAL_QUOTA_INODES = 10_000;

/** Create a user and its home directory; returns the home's ino. EEXIST when either exists. */
export async function provisionLocalUser(fs: KernelFs, u: LocalUser): Promise<Uuid> {
  const name = validateName(u.username);
  if (!name.ok || !/^[a-z_][a-z0-9_-]{0,31}$/.test(u.username)) {
    throw new KernelError('EINVAL', undefined, 'invalid user name');
  }
  if (!Number.isInteger(u.uid) || u.uid <= 0)
    throw new KernelError('EINVAL', undefined, 'invalid uid');
  await fs.loader.ensureLoaded(INO.HOME);
  const tree = fs.tree;
  const home = tree.inode(INO.HOME);
  if (home === undefined) throw new KernelError('EIO', { reason: 'storage' }, 'no /home');
  if (tree.user(u.uid) !== undefined) throw new KernelError('EEXIST', undefined, 'uid exists');
  const now = fs.now();
  const gid = u.gid ?? GID_USERS;
  const ino = u.homeIno ?? uuidv7();
  const dir: InodeRec = {
    ino,
    fs: 'root',
    type: 'd',
    mode: u.homeMode ?? 0o700,
    uid: u.uid,
    gid,
    size: 0,
    nlink: 2,
    version: 1,
    atime: now,
    mtime: now,
    ctime: now,
    btime: now,
    blob: null,
    target: null,
    mir: 1,
  };
  const dentry: DentryRec = { parent: INO.HOME, name: u.username, ino, dtype: 'd' };
  const parent: InodeRec = {
    ...home,
    nlink: home.nlink + 1,
    version: home.version + 1,
    mtime: now,
    ctime: now,
  };
  const user: UserRec = {
    uid: u.uid,
    username: u.username,
    gid,
    groups: [...new Set([gid, ...(u.groups ?? [])])],
    kind: u.kind ?? 'user',
    quotaBytes: u.quotaBytes ?? LOCAL_QUOTA_BYTES,
    quotaInodes: u.quotaInodes ?? LOCAL_QUOTA_INODES,
    serverUsedBytes: 0,
    serverUsedInodes: 1,
    usedBytes: 0,
    usedInodes: 1,
    homeIno: ino,
  };
  await fs.exclusive(() =>
    fs.store.tx(
      ['inodes', 'dentries', 'users', 'groups'],
      'strict',
      (t) => {
        t.add('users', user);
        t.add('inodes', dir);
        t.add('dentries', dentry);
        t.put('inodes', parent);
        t.get<{ gid: number }>('groups', gid, undefined, (g) => {
          if (g === undefined) t.put('groups', { gid, name: `g${String(gid)}`, members: [u.uid] });
        });
      },
      { label: `useradd ${u.username}` },
    ),
  );
  const writes: StoreWrite[] = [
    { store: 'inodes', op: 'add', value: dir },
    { store: 'dentries', op: 'add', value: dentry },
    { store: 'inodes', op: 'put', value: parent },
  ];
  fs.applyExternal(
    {
      writes,
      events: [
        {
          topic: 'vfs.create',
          data: {
            items: [
              {
                ino,
                parent: INO.HOME,
                name: u.username,
                type: 'd',
                mode: dir.mode,
                uid: u.uid,
                gid,
                size: 0,
                version: 1,
              },
            ],
          },
        },
      ],
    },
    0,
    [user],
  );
  return ino;
}

/** Why a home cannot take the server's id (`relinkEmptyHome`). */
export type RelinkRefusal = 'no-user' | 'not-empty' | 'pending-ops' | 'in-use';

/**
 * Give a locally provisioned, still EMPTY home the id the server minted for it (C5; UI-006), so the
 * user's changes can sync. A home that holds entries, that an unsynced op touches, or that a
 * process has as its working directory keeps its id (sync then stays unlinked for it: moving
 * content between ids is not attempted). One strict transaction; no outbox op.
 */
export async function relinkEmptyHome(
  fs: KernelFs,
  uid: number,
  serverIno: Uuid,
  busy: (ino: Uuid) => boolean = () => false,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly why: RelinkRefusal }> {
  const store = fs.store;
  const user = await store.get<UserRec>('users', uid);
  if (user === undefined) return { ok: false, why: 'no-user' };
  const old = user.homeIno;
  if (old === undefined) return { ok: false, why: 'no-user' };
  if (old === serverIno) return { ok: true };
  const oldNode = await store.get<InodeRec>('inodes', old);
  if (oldNode === undefined) return { ok: false, why: 'no-user' };
  let entries = 0;
  await store.scan<DentryRec>('dentries', dirBounds(old), () => {
    entries++;
  });
  if (entries > 0) return { ok: false, why: 'not-empty' };
  let pending = 0;
  await store.scan<OutboxRec>('outbox', null, (r) => {
    if ((r.state === 'pending' || r.state === 'parked') && r.touches.includes(old)) pending++;
  });
  if (pending > 0) return { ok: false, why: 'pending-ops' };
  if (busy(old)) return { ok: false, why: 'in-use' };
  const name = user.username;
  const dir: InodeRec = { ...oldNode, ino: serverIno };
  const before: DentryRec = { parent: INO.HOME, name, ino: old, dtype: 'd' };
  const after: DentryRec = { parent: INO.HOME, name, ino: serverIno, dtype: 'd' };
  const moved: UserRec = { ...user, homeIno: serverIno };
  await fs.exclusive(() =>
    fs.store.tx(
      ['inodes', 'dentries', 'users'],
      'strict',
      (t) => {
        t.del('dentries', [INO.HOME, name]);
        t.del('inodes', old);
        t.add('inodes', dir);
        t.add('dentries', after);
        t.put('users', moved);
      },
      { label: `relink home ${name}` },
    ),
  );
  fs.applyExternal(
    {
      writes: [
        { store: 'dentries', op: 'del', value: before },
        { store: 'inodes', op: 'del', key: old },
        { store: 'inodes', op: 'add', value: dir },
        { store: 'dentries', op: 'add', value: after },
      ],
      events: [],
    },
    0,
    [moved],
  );
  return { ok: true };
}
