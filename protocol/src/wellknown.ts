/**
 * Well-known inode ids (C5; virtual-file-system.md §3.3.1, §3.3.2, §3.3.5 and §4.7, PVFS-02).
 *
 * Fixed forever: client `mkfs` and the server seed both import this module, and no other code may
 * generate these ids. Each id is a syntactically valid UUIDv7 with a 48-bit timestamp of 0
 * (`00000000-0000-7000-8000-XXXXXXXXXXXX`), so it passes the `Ino` schema and sorts before every
 * generated id. Suffix ranges:
 *   0x000001–0x0000ff  well-known directories (WELL_KNOWN_DIRS)
 *   0x000100–0x0001ff  kernel-synthesised read-only files (SYNTH_FILES)
 *   0x001000–0x00ffff  seeded files, assigned in protocol/wellknown/seed-ids.json (append-only;
 *                      that registry is created by tools/wellknown.ts, owned by R2)
 * `/home/<user>` is created only on the server when the user is created (C5) and gets a server
 * `uuidv7()`.
 */

const PREFIX = '00000000-0000-7000-8000-';

/** The well-known id with suffix `n` (virtual-file-system.md §4.7 `WK`). */
export function wellKnownIno(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 0xffff_ffff_ffff) {
    throw new RangeError(`well-known suffix out of range: ${n}`);
  }
  return `${PREFIX}${n.toString(16).padStart(12, '0')}`;
}

/** Fixed ids of virtual-file-system.md §4.7 (names as in the spec). */
export const INO = {
  ROOT: wellKnownIno(0x01),
  BIN: wellKnownIno(0x02),
  SYSTEM: wellKnownIno(0x03),
  SYSTEM_SERVICES: wellKnownIno(0x04),
  SYSTEM_LOG: wellKnownIno(0x05),
  SYSTEM_BRANDING: wellKnownIno(0x06),
  ROOT_HOME: wellKnownIno(0x07),
  HOME: wellKnownIno(0x08),
  TMP: wellKnownIno(0x09),
  MNT: wellKnownIno(0x0a),
  USR: wellKnownIno(0x0b),
  USR_SHARE: wellKnownIno(0x0c),
  USR_SHARE_MAN: wellKnownIno(0x0d),
  LOST_FOUND: wellKnownIno(0x0e),
  // kernel-synthesised files (§3.3.5)
  SYSTEM_RELEASE: wellKnownIno(0x100),
  LOG_BOOT: wellKnownIno(0x101),
  LOG_KERNEL: wellKnownIno(0x102),
  LOG_AUDIT: wellKnownIno(0x103),
} as const;

export type WellKnownKey = keyof typeof INO;

/** First suffix of the seeded-file range (seed-ids.json is append-only). */
export const SEED_ID_BASE = 0x1000;
/** Last suffix of the seeded-file range. */
export const SEED_ID_LAST = 0xffff;

export const UID_ROOT = 0;
export const GID_ROOT = 0;
/** Primary group of ordinary accounts (virtual-file-system.md §3.3.1). */
export const GID_USERS = 100;
/** The offline guest (virtual-file-system.md X-SEC-1; security-model.md). */
export const UID_OFFLINE_GUEST = 65_534;

export type SpecLevel = 'MUST' | 'SHOULD' | 'MAY' | 'Plotinium';

export interface WellKnownDir {
  readonly key: WellKnownKey;
  readonly path: string;
  readonly ino: string;
  /** Parent directory's key (`null` for `/`). */
  readonly parent: WellKnownKey | null;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly level: SpecLevel;
}

/**
 * The standard hierarchy of virtual-file-system.md §3.3.1, in creation order (parents first).
 * Every row is root:root. `/home/<user>` and `~/lost+found` are not here: they are per user.
 */
export const WELL_KNOWN_DIRS: readonly WellKnownDir[] = [
  dir('ROOT', '/', null, 0o755, 'MUST'),
  dir('BIN', '/bin', 'ROOT', 0o755, 'MUST'),
  dir('SYSTEM', '/system', 'ROOT', 0o755, 'MUST'),
  dir('SYSTEM_SERVICES', '/system/services', 'SYSTEM', 0o755, 'MUST'),
  dir('SYSTEM_LOG', '/system/log', 'SYSTEM', 0o755, 'MUST'),
  dir('SYSTEM_BRANDING', '/system/branding', 'SYSTEM', 0o755, 'MUST'),
  dir('ROOT_HOME', '/root', 'ROOT', 0o700, 'MUST'),
  dir('HOME', '/home', 'ROOT', 0o755, 'MUST'),
  dir('TMP', '/tmp', 'ROOT', 0o1777, 'SHOULD'),
  dir('MNT', '/mnt', 'ROOT', 0o755, 'MAY'),
  dir('USR', '/usr', 'ROOT', 0o755, 'Plotinium'),
  dir('USR_SHARE', '/usr/share', 'USR', 0o755, 'Plotinium'),
  dir('USR_SHARE_MAN', '/usr/share/man', 'USR_SHARE', 0o755, 'Plotinium'),
  dir('LOST_FOUND', '/lost+found', 'ROOT', 0o700, 'Plotinium'),
];

export interface SynthFile {
  readonly key: WellKnownKey;
  readonly path: string;
  readonly ino: string;
  readonly parent: WellKnownKey;
  readonly mode: number;
}

/**
 * Kernel-synthesised read-only files (virtual-file-system.md §3.3.5): root:root, content generated
 * on open, never stored or synced; every mutation fails with EPERM for every uid, root included.
 */
export const SYNTH_FILES: readonly SynthFile[] = [
  {
    key: 'SYSTEM_RELEASE',
    path: '/system/release',
    ino: INO.SYSTEM_RELEASE,
    parent: 'SYSTEM',
    mode: 0o444,
  },
  {
    key: 'LOG_BOOT',
    path: '/system/log/boot.log',
    ino: INO.LOG_BOOT,
    parent: 'SYSTEM_LOG',
    mode: 0o444,
  },
  {
    key: 'LOG_KERNEL',
    path: '/system/log/kernel.log',
    ino: INO.LOG_KERNEL,
    parent: 'SYSTEM_LOG',
    mode: 0o444,
  },
  {
    key: 'LOG_AUDIT',
    path: '/system/log/audit.log',
    ino: INO.LOG_AUDIT,
    parent: 'SYSTEM_LOG',
    mode: 0o400,
  },
];

const WELL_KNOWN_SET: ReadonlySet<string> = new Set(Object.values(INO));

/** Whether `ino` is one of the fixed ids above (directories and synthesised files). */
export function isWellKnownIno(ino: string): boolean {
  return WELL_KNOWN_SET.has(ino);
}

/** Whether `ino` is a well-known DIRECTORY (cannot be removed or renamed: EBUSY, §3.3.5). */
export function isWellKnownDir(ino: string): boolean {
  return WELL_KNOWN_DIRS.some((d) => d.ino === ino);
}

/** The id of the seeded file with registry index `index` (0 → 0x1000). */
export function seedIno(index: number): string {
  const n = SEED_ID_BASE + index;
  if (!Number.isInteger(index) || index < 0 || n > SEED_ID_LAST) {
    throw new RangeError(`seed index out of range: ${index}`);
  }
  return wellKnownIno(n);
}

function dir(
  key: WellKnownKey,
  path: string,
  parent: WellKnownKey | null,
  mode: number,
  level: SpecLevel,
): WellKnownDir {
  return { key, path, ino: INO[key], parent, uid: UID_ROOT, gid: GID_ROOT, mode, level };
}
