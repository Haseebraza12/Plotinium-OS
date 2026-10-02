/**
 * The deterministic bench-seed generator (DB-05, DBD-18; database.md §3.27).
 *
 * Input: a freshly migrated database (the 14 well-known system directories and the root account
 * exist; see db/migrations/*_system_tree.sql). Output: rows that bring the tree to EXACTLY
 * 10,000 or 100,000 inodes, plus a manifest.
 *
 * Parameters (spec §11.4 and database.md §3.27):
 *   - mulberry32, seed 42; UUIDv7 ids from a fixed epoch (lib/uuid.ts)
 *   - users user01..user59 (uids 1001-1059) + root = 60 users (>= 50); groups root, users, team
 *   - owners follow a Zipf-like distribution (s = 1.1)
 *   - depth: each new node attaches to its owner's most recently created directory with p = 0.35,
 *     otherwise to a uniformly random directory of that owner; 12 % of new nodes are directories
 *   - file sizes log-normal (median 4 KiB, sigma 1.5, capped at 8 MiB); 10 % of files share the
 *     content of an earlier file (blob refcount > 1)
 *   - names: dictionary word + number + extension; 2 % non-ASCII NFC words (Ärger, Übung, café)
 *   - mtimes: exponential, 30-day mean back from 2026-09-24T12:00:00Z, plus 10 % in the last 7 days
 *   - fixtures under the first F users' homes: q1/a/b/c/d/e (a path of 8 components from '/'),
 *     big500 (exactly 500 entries), fixtures/tree1000 (exactly 1,000 inodes: 1 root, 99
 *     directories, 900 files), fixtures/flat1000 (1,000 files), deep32 (32 nested directories),
 *     and 300 `Ärger_*.md` files for Q3.
 * F = 20 for bench100k as the spec says. For bench10k the spec's 20 fixture users cannot fit in
 * 10,000 inodes (20 x 2,541 fixture inodes), so F = 2 there (recorded in the manifest).
 * Not yet generated (TODO(R2), W8): fixtures/treemix (symlinks, hard links) and the precomputed
 * vectors of db/seed/vectors/<modelKey>/ for file_chunks.
 */
import { exponential, mulberry32, normal, randInt, zipfSampler, type Rng } from './rng.ts';
import { seededSha256Hex, seededUuidv7 } from './uuid.ts';

export type BenchProfile = 'bench10k' | 'bench100k';

export const ROOT_INO = '00000000-0000-7000-8000-000000000001';
export const HOME_INO = '00000000-0000-7000-8000-000000000008';
/** Inodes created by the migrations (the well-known system tree). */
export const SYSTEM_INODES = 14;
export const USERS_GID = 100;
export const TEAM_GID = 200;
export const SEED_EPOCH_MS = Date.UTC(2026, 8, 24, 12, 0, 0);

const DAY_MS = 86_400_000;
const KIB = 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const USER_COUNT = 59;
const FIRST_UID = 1001;
const TEAM_MEMBERS = 10;
const P_ATTACH_RECENT = 0.35;
const P_DIRECTORY = 0.12;
const P_SHARED_CONTENT = 0.1;
const P_NON_ASCII = 0.02;
const P_RECENT_MTIME = 0.1;
const AERGER_FILES = 300;

const WORDS = [
  'alpha',
  'budget',
  'notes',
  'draft',
  'report',
  'thesis',
  'photo',
  'music',
  'lecture',
  'lab',
  'invoice',
  'summary',
  'plan',
  'design',
  'sketch',
  'archive',
  'backup',
  'config',
  'script',
  'data',
  'results',
  'chapter',
  'figure',
  'table',
  'slides',
  'review',
  'meeting',
  'todo',
  'journal',
  'project',
  'kernel',
  'shell',
  'window',
  'graph',
  'matrix',
  'vector',
  'queue',
  'stack',
  'tree',
  'index',
] as const;
/** NFC (precomposed) spellings; the database CHECK rejects NFD names. */
const WORDS_NON_ASCII = [
  '\u00C4rger',
  '\u00DCbung',
  'caf\u00E9',
  'na\u00EFve',
  '\u00E9t\u00E9',
  'Stra\u00DFe',
] as const;
const EXTENSIONS = ['.txt', '.md', '.json', '.ts', '.csv', '.log', '.png', '.pdf'] as const;

export interface SeedUser {
  readonly uid: number;
  readonly username: string;
  readonly groups: readonly number[];
}

export interface SeedInode {
  readonly ino: string;
  readonly type: 'f' | 'd';
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  /** Hex SHA-256 of the content blob (files only). */
  readonly blobSha: string | null;
  readonly mtimeMs: number;
  /** Components from '/', so /home is 1 and /home/user01 is 2. */
  readonly depth: number;
}

export interface SeedDentry {
  readonly parent: string;
  readonly name: string;
  readonly ino: string;
  readonly dType: 'f' | 'd';
  readonly ownerUid: number;
}

export interface SeedBlob {
  readonly sha: string;
  readonly size: number;
}

export interface BenchManifest {
  readonly profile: BenchProfile;
  readonly seed: number;
  readonly totalInodes: number;
  readonly newInodes: number;
  readonly users: number;
  readonly directories: number;
  readonly files: number;
  readonly blobs: number;
  readonly sharedContentFiles: number;
  readonly nonAsciiNames: number;
  readonly maxDepth: number;
  readonly depthHistogram: Readonly<Record<string, number>>;
  readonly fixtureUsers: readonly string[];
  readonly fixtures: {
    readonly q1: readonly string[];
    readonly big500: readonly string[];
    readonly tree1000: readonly string[];
    readonly flat1000: readonly string[];
    readonly deep32: readonly string[];
    readonly aerger: { readonly dir: string; readonly files: number };
  };
}

export interface BenchData {
  readonly users: readonly SeedUser[];
  readonly inodes: readonly SeedInode[];
  readonly dentries: readonly SeedDentry[];
  readonly blobs: readonly SeedBlob[];
  readonly manifest: BenchManifest;
}

interface DirRef {
  readonly ino: string;
  readonly depth: number;
  readonly path: string;
}

export function totalInodesFor(profile: BenchProfile): number {
  return profile === 'bench100k' ? 100_000 : 10_000;
}

export function fixtureUsersFor(profile: BenchProfile): number {
  return profile === 'bench100k' ? 20 : 2;
}

export function generateBench(profile: BenchProfile, seed = 42): BenchData {
  const rng: Rng = mulberry32(seed);
  const total = totalInodesFor(profile);
  const target = total - SYSTEM_INODES;

  const users: SeedUser[] = [];
  const inodes: SeedInode[] = [];
  const dentries: SeedDentry[] = [];
  const blobs: SeedBlob[] = [];
  const namesIn = new Map<string, Set<string>>();
  const candidateDirs = new Map<number, DirRef[]>();
  const lastDir = new Map<number, DirRef>();
  let idSeq = 0;
  let sharedContentFiles = 0;
  let nonAsciiNames = 0;

  const newIno = (): string => seededUuidv7(idSeq++, rng);

  const mtime = (): number => {
    if (rng() < P_RECENT_MTIME) return SEED_EPOCH_MS - Math.floor(rng() * 7 * DAY_MS);
    return SEED_EPOCH_MS - Math.floor(Math.min(exponential(rng, 30 * DAY_MS), 365 * DAY_MS));
  };

  const fileSize = (): number => {
    const bytes = Math.round(4 * KIB * Math.exp(1.5 * normal(rng)));
    return Math.min(MAX_FILE_BYTES, Math.max(1, bytes));
  };

  const claimName = (parent: string, wanted: string): string => {
    let set = namesIn.get(parent);
    if (set === undefined) {
      set = new Set();
      namesIn.set(parent, set);
    }
    let name = wanted;
    for (let k = 2; set.has(name); k++) {
      const dot = wanted.lastIndexOf('.');
      name = dot > 0 ? `${wanted.slice(0, dot)}-${k}${wanted.slice(dot)}` : `${wanted}-${k}`;
    }
    set.add(name);
    return name;
  };

  const addDir = (
    parent: DirRef,
    rawName: string,
    uid: number,
    mode: number,
    candidate: boolean,
  ): DirRef => {
    const name = claimName(parent.ino, rawName);
    const ino = newIno();
    const depth = parent.depth + 1;
    inodes.push({
      ino,
      type: 'd',
      mode,
      uid,
      gid: USERS_GID,
      size: 0,
      blobSha: null,
      mtimeMs: mtime(),
      depth,
    });
    dentries.push({ parent: parent.ino, name, ino, dType: 'd', ownerUid: uid });
    const ref = { ino, depth, path: `${parent.path}/${name}` };
    if (candidate) {
      const list = candidateDirs.get(uid) ?? [];
      list.push(ref);
      candidateDirs.set(uid, list);
      lastDir.set(uid, ref);
    }
    return ref;
  };

  const addFile = (parent: DirRef, rawName: string, uid: number, mode: number): void => {
    const name = claimName(parent.ino, rawName);
    let blob: SeedBlob;
    const reuse = blobs.length > 0 && rng() < P_SHARED_CONTENT;
    if (reuse) {
      blob = blobs[randInt(rng, blobs.length)] as SeedBlob;
      sharedContentFiles++;
    } else {
      blob = { sha: seededSha256Hex(rng), size: fileSize() };
      blobs.push(blob);
    }
    inodes.push({
      ino: newIno(),
      type: 'f',
      mode,
      uid,
      gid: USERS_GID,
      size: blob.size,
      blobSha: blob.sha,
      mtimeMs: mtime(),
      depth: parent.depth + 1,
    });
    const last = inodes[inodes.length - 1] as SeedInode;
    dentries.push({ parent: parent.ino, name, ino: last.ino, dType: 'f', ownerUid: uid });
  };

  const randomName = (withExtension: boolean): string => {
    let word: string;
    if (rng() < P_NON_ASCII) {
      word = WORDS_NON_ASCII[randInt(rng, WORDS_NON_ASCII.length)] as string;
      nonAsciiNames++;
    } else {
      word = WORDS[randInt(rng, WORDS.length)] as string;
    }
    const ext = withExtension ? (EXTENSIONS[randInt(rng, EXTENSIONS.length)] as string) : '';
    return `${word}-${randInt(rng, 1000)}${ext}`;
  };

  // Users and homes (/home/<user>, 0700, <user>:users; C5 server-created homes).
  const home: DirRef = { ino: HOME_INO, depth: 1, path: '/home' };
  const homes: DirRef[] = [];
  for (let i = 0; i < USER_COUNT; i++) {
    const uid = FIRST_UID + i;
    const username = `user${String(i + 1).padStart(2, '0')}`;
    users.push({ uid, username, groups: i < TEAM_MEMBERS ? [TEAM_GID] : [] });
    homes.push(addDir(home, username, uid, 0o700, true));
  }

  // Fixtures (database.md §3.27).
  const fixtureCount = fixtureUsersFor(profile);
  const fx = {
    q1: [] as string[],
    big500: [] as string[],
    tree1000: [] as string[],
    flat1000: [] as string[],
    deep32: [] as string[],
  };
  for (let i = 0; i < fixtureCount; i++) {
    const uid = FIRST_UID + i;
    const h = homes[i] as DirRef;
    let d = h;
    for (const part of ['q1', 'a', 'b', 'c', 'd', 'e']) d = addDir(d, part, uid, 0o755, false);
    fx.q1.push(d.path);

    const big = addDir(h, 'big500', uid, 0o755, false);
    for (let k = 0; k < 500; k++) addFile(big, `f${String(k).padStart(3, '0')}.txt`, uid, 0o644);
    fx.big500.push(big.path);

    const fixtures = addDir(h, 'fixtures', uid, 0o755, false);
    const tree = addDir(fixtures, 'tree1000', uid, 0o755, false); // 1 root
    for (let a = 0; a < 9; a++) {
      const l1 = addDir(tree, `d${a}`, uid, 0o755, false); // 9
      for (let b = 0; b < 10; b++) {
        const l2 = addDir(l1, `d${a}${b}`, uid, 0o755, false); // 90 -> 99 directories
        for (let c = 0; c < 10; c++) addFile(l2, `f${a}${b}${c}.txt`, uid, 0o644); // 900 files
      }
    }
    fx.tree1000.push(tree.path);

    const flat = addDir(fixtures, 'flat1000', uid, 0o755, false);
    for (let k = 0; k < 1000; k++) addFile(flat, `f${String(k).padStart(4, '0')}.txt`, uid, 0o644);
    fx.flat1000.push(flat.path);

    let deep = addDir(h, 'deep32', uid, 0o755, false);
    for (let k = 1; k < 32; k++)
      deep = addDir(deep, `l${String(k).padStart(2, '0')}`, uid, 0o755, false);
    fx.deep32.push(deep.path);
  }
  const firstHome = homes[0] as DirRef;
  const aergerDir = addDir(firstHome, 'notes', FIRST_UID, 0o755, false);
  for (let k = 0; k < AERGER_FILES; k++) {
    addFile(aergerDir, `\u00C4rger_${String(k).padStart(3, '0')}.md`, FIRST_UID, 0o644);
  }

  // Random fill up to the exact target.
  const pickOwner = zipfSampler(USER_COUNT, 1.1);
  while (inodes.length < target) {
    const uid = FIRST_UID + pickOwner(rng);
    const dirs = candidateDirs.get(uid) ?? [];
    const recent = lastDir.get(uid);
    const parent =
      recent !== undefined && rng() < P_ATTACH_RECENT
        ? recent
        : (dirs[randInt(rng, dirs.length)] as DirRef);
    if (rng() < P_DIRECTORY) {
      addDir(parent, randomName(false), uid, rng() < 0.9 ? 0o755 : 0o700, true);
    } else {
      addFile(parent, randomName(true), uid, rng() < 0.85 ? 0o644 : 0o600);
    }
  }

  const depthHistogram: Record<string, number> = {};
  let maxDepth = 0;
  let directories = 0;
  for (const n of inodes) {
    depthHistogram[String(n.depth)] = (depthHistogram[String(n.depth)] ?? 0) + 1;
    if (n.depth > maxDepth) maxDepth = n.depth;
    if (n.type === 'd') directories++;
  }

  return {
    users,
    inodes,
    dentries,
    blobs,
    manifest: {
      profile,
      seed,
      totalInodes: SYSTEM_INODES + inodes.length,
      newInodes: inodes.length,
      users: users.length + 1,
      directories,
      files: inodes.length - directories,
      blobs: blobs.length,
      sharedContentFiles,
      nonAsciiNames,
      maxDepth,
      depthHistogram,
      fixtureUsers: users.slice(0, fixtureCount).map((u) => u.username),
      fixtures: { ...fx, aerger: { dir: aergerDir.path, files: AERGER_FILES } },
    },
  };
}
