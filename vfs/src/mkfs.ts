/**
 * `mkfs` (virtual-file-system.md §3.3.6, VFS-02, PVFS-02): the standard hierarchy with the fixed
 * well-known ids of protocol/src/wellknown.ts, the seeded files of the build's seed manifest, the
 * root account and the root/users groups, in ONE strict transaction, with no outbox op (the server
 * seed creates identical rows). Also the seed-upgrade rule and the boot-time tmpfs clearing.
 */
import { GID_ROOT, GID_USERS, INO, UID_ROOT, WELL_KNOWN_DIRS } from '@plotinium/protocol';

import { EMPTY_BLOB } from './limits.ts';
import { basename, dirname } from './path.ts';
import type {
  BlobRec,
  ChunkRec,
  DentryRec,
  GroupRec,
  InodeRec,
  MetaRec,
  Sha256Hex,
  UserRec,
  Uuid,
} from './store/records.ts';
import type { Store } from './store/store.ts';

/** One row of `mkfs-seed.json` (§3.3.3). Directories have no hash. */
export interface SeedEntry {
  readonly path: string;
  readonly ino: Uuid;
  readonly type: 'f' | 'd';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly sha256: Sha256Hex | null;
  readonly size: number;
  readonly seedVersion: number;
  readonly priorSha256: readonly Sha256Hex[];
  /** Chunk hashes of the content, in order. */
  readonly chunks?: readonly Sha256Hex[];
}

export interface MkfsInput {
  /** The build date from the build identity, so every device writes identical times. */
  readonly buildTime: number;
  readonly deviceId: Uuid;
  readonly seed?: readonly SeedEntry[];
  readonly seedHash?: Sha256Hex;
  /** Seed chunk bytes, split and hashed before the transaction (§3.3.6 steps 2–3). */
  readonly chunks?: readonly ChunkRec[];
}

export interface MkfsPlan {
  readonly inodes: readonly InodeRec[];
  readonly dentries: readonly DentryRec[];
  readonly blobs: readonly BlobRec[];
  readonly chunks: readonly ChunkRec[];
  readonly users: readonly UserRec[];
  readonly groups: readonly GroupRec[];
  readonly meta: readonly MetaRec[];
}

function dirRec(
  ino: Uuid,
  mode: number,
  uid: number,
  gid: number,
  t: number,
  version: number,
  mir: 0 | 1,
): InodeRec {
  return {
    ino,
    fs: 'root',
    type: 'd',
    mode,
    uid,
    gid,
    size: 0,
    nlink: 2,
    version,
    atime: t,
    mtime: t,
    ctime: t,
    btime: t,
    blob: null,
    target: null,
    mir,
  };
}

export function mkfsPlan(input: MkfsInput): MkfsPlan {
  const t = input.buildTime;
  const byPath = new Map<string, InodeRec>();
  const dentries: DentryRec[] = [];
  const attach = (path: string, rec: InodeRec): void => {
    byPath.set(path, rec);
    if (path === '/') return;
    const parent = byPath.get(dirname(path));
    if (parent?.type !== 'd') throw new Error(`mkfs: no parent directory for ${path}`);
    dentries.push({ parent: parent.ino, name: basename(path), ino: rec.ino, dtype: rec.type });
  };
  for (const d of WELL_KNOWN_DIRS) {
    // /home is unknown until the first online login mirrors it (§3.17.2).
    attach(d.path, dirRec(d.ino, d.mode, d.uid, d.gid, t, 1, d.key === 'HOME' ? 0 : 1));
  }
  const blobs = new Map<Sha256Hex, BlobRec>();
  for (const s of input.seed ?? []) {
    if (s.type === 'd') {
      attach(s.path, dirRec(s.ino, s.mode, s.uid, s.gid, t, s.seedVersion, 1));
      continue;
    }
    const sha = s.sha256 ?? EMPTY_BLOB;
    attach(s.path, {
      ino: s.ino,
      fs: 'root',
      type: 'f',
      mode: s.mode,
      uid: s.uid,
      gid: s.gid,
      size: s.size,
      nlink: 1,
      version: s.seedVersion,
      atime: t,
      mtime: t,
      ctime: t,
      btime: t,
      blob: sha,
      target: null,
    });
    const b = blobs.get(sha);
    blobs.set(
      sha,
      b === undefined
        ? { sha, size: s.size, chunks: [...(s.chunks ?? [])], refcount: 1, uploaded: true }
        : { ...b, refcount: b.refcount + 1 },
    );
  }
  // nlink of a directory = 2 + its child directories (§3.2).
  const inodes = new Map([...byPath.values()].map((r) => [r.ino, r]));
  for (const d of dentries) {
    const parent = inodes.get(d.parent);
    if (d.dtype === 'd' && parent !== undefined)
      inodes.set(d.parent, { ...parent, nlink: parent.nlink + 1 });
  }
  const rows = [...inodes.values()];
  const rootBytes = rows
    .filter((r) => r.uid === UID_ROOT && r.type !== 'd')
    .reduce((n, r) => n + r.size, 0);
  const rootInodes = rows.filter((r) => r.uid === UID_ROOT).length;
  const root: UserRec = {
    uid: UID_ROOT,
    username: 'root',
    gid: GID_ROOT,
    groups: [GID_ROOT],
    kind: 'system',
    quotaBytes: 0,
    quotaInodes: 0,
    serverUsedBytes: rootBytes,
    serverUsedInodes: rootInodes,
    usedBytes: rootBytes,
    usedInodes: rootInodes,
    homeIno: INO.ROOT_HOME,
  };
  return {
    inodes: rows,
    dentries,
    blobs: [...blobs.values()],
    chunks: input.chunks ?? [],
    users: [root],
    groups: [
      { gid: GID_ROOT, name: 'root', members: [UID_ROOT] },
      { gid: GID_USERS, name: 'users', members: [] },
    ],
    meta: [
      { k: 'mkfsDone', v: true },
      { k: 'seedHash', v: input.seedHash ?? null },
      { k: 'deviceId', v: input.deviceId },
    ],
  };
}

/**
 * Run mkfs in one strict transaction unless `meta.mkfsDone` is already set (idempotent). Resolves to
 * whether the rows were written. No outbox op, no undo: the server seed has the same rows.
 */
export async function applyMkfs(store: Store, plan: MkfsPlan): Promise<boolean> {
  let wrote = false;
  await store.tx(
    ['inodes', 'dentries', 'blobs', 'blob_chunks', 'users', 'groups', 'meta'],
    'strict',
    (t) => {
      t.get<MetaRec>('meta', 'mkfsDone', undefined, (done) => {
        if (done !== undefined) return;
        wrote = true;
        for (const r of plan.inodes) t.add('inodes', r);
        for (const d of plan.dentries) t.add('dentries', d);
        for (const b of plan.blobs) t.put('blobs', b);
        for (const c of plan.chunks) t.put('blob_chunks', c);
        for (const u of plan.users) t.put('users', u);
        for (const g of plan.groups) t.put('groups', g);
        for (const m of plan.meta) t.put('meta', m);
      });
    },
    { label: 'mkfs' },
  );
  return wrote;
}

export interface SeedUpgrade {
  readonly create: readonly SeedEntry[];
  readonly replace: readonly { entry: SeedEntry; old: InodeRec }[];
  /** `seed: kept local edit of <path>` lines for the kernel log. */
  readonly kept: readonly string[];
}

/**
 * The seed-upgrade rule (§3.3.6): create missing seeded paths; replace content that root has not
 * edited (the local blob is a prior seed version) when the seed version grew; keep local edits.
 */
export function seedUpgrade(
  local: (ino: Uuid) => InodeRec | undefined,
  seed: readonly SeedEntry[],
): SeedUpgrade {
  const create: SeedEntry[] = [];
  const replace: { entry: SeedEntry; old: InodeRec }[] = [];
  const kept: string[] = [];
  for (const s of seed) {
    const cur = local(s.ino);
    if (cur === undefined) create.push(s);
    else if (s.type === 'f' && cur.version < s.seedVersion) {
      if (cur.blob !== null && s.priorSha256.includes(cur.blob))
        replace.push({ entry: s, old: cur });
      else kept.push(`seed: kept local edit of ${s.path}`);
    }
  }
  return { create, replace, kept };
}

/**
 * Boot-time tmpfs clearing (§3.3.4): every `fs: 'tmp'` inode and its dentries go in one relaxed
 * transaction, their blob references are released, `/tmp`'s own row returns to an empty directory
 * and `meta.tmpfsUsage` is reset. Resolves to the number of inodes removed.
 */
export async function clearTmpfs(store: Store, now: number): Promise<number> {
  let removed = 0;
  await store.tx(
    ['inodes', 'dentries', 'blobs', 'meta'],
    'relaxed',
    (t) => {
      t.getAllByIndex<InodeRec>('inodes', 'by_fs', 'tmp', (recs) => {
        removed = recs.length;
        for (const r of recs) {
          t.getAllByIndex<DentryRec>('dentries', 'by_ino', r.ino, (ds) => {
            for (const d of ds) t.del('dentries', [d.parent, d.name]);
          });
          t.del('inodes', r.ino);
          const sha = r.blob;
          if (sha !== null) {
            t.get<BlobRec>('blobs', sha, undefined, (b) => {
              if (b === undefined) return;
              const refcount = Math.max(0, b.refcount - 1);
              t.put(
                'blobs',
                refcount === 0 ? { ...b, refcount, zeroSince: now } : { ...b, refcount },
              );
            });
          }
        }
      });
      t.get<InodeRec>('inodes', INO.TMP, undefined, (tmp) => {
        if (tmp !== undefined) t.put('inodes', { ...tmp, nlink: 2 });
      });
      t.put('meta', { k: 'tmpfsUsage', v: { bytes: 0, inodes: 0 } });
    },
    { label: 'tmpfs clear' },
  );
  return removed;
}
