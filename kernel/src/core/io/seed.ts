/**
 * The first-boot seed of client mkfs (virtual-file-system.md §3.3.3, §3.3.6):
 *   /system/services/*.json   the built-in service manifests (boot-and-services.md §3.3), always;
 *   /system/branding/*        docs/identity (logo, wordmark, wallpapers, manifest), from the host;
 *   /bin/*.json, man pages    program manifests and pages, from the host.
 *
 * Seeded files are root:root, 0644 unless the host says otherwise, with the missing intermediate
 * directories created 0755. Ids come from the seeded-file range of protocol/wellknown.ts
 * (`seedIno`, 0x1000..0xffff). TODO(protocol): protocol/wellknown/seed-ids.json (append-only) is
 * not written yet, so an id is derived from the path (FNV-1a, linear probing in path order): the
 * same seed always gets the same ids on every device.
 */
import { BUILTIN_MANIFEST_FILES } from '@plotinium/services';
import {
  GID_ROOT,
  SEED_ID_BASE,
  SEED_ID_LAST,
  UID_ROOT,
  WELL_KNOWN_DIRS,
  seedIno,
  sha256Hex,
} from '@plotinium/protocol';
import type { BlobRec, ChunkRec, DentryRec, InodeRec, MetaRec, SeedEntry } from '@plotinium/vfs';
import { contentOf, mkfsPlan } from '@plotinium/vfs';

import type { FsStore } from '../fs/store.ts';
import type { ProgramCatalog } from '../programs/catalog.ts';
import type { SeedFile } from './types.ts';

export interface BuiltSeed {
  readonly entries: readonly SeedEntry[];
  readonly chunks: readonly ChunkRec[];
  readonly hash: string;
  /** Files (not directories) in the seed. */
  readonly files: number;
}

const encoder = new TextEncoder();

/**
 * /bin/<name>.json for every program of the catalog (the `$PATH` the shell and `spawn` read).
 * 0755: `spawn` needs r and x on the manifest (syscall-abi.md §3.6).
 */
export function binSeed(catalog: ProgramCatalog): SeedFile[] {
  const out: SeedFile[] = [];
  for (const name of catalog.names()) {
    const m = catalog.manifest(name);
    if (m === undefined) continue;
    out.push({
      path: `/bin/${name}.json`,
      bytes: encoder.encode(`${JSON.stringify(m, null, 2)}\n`),
      mode: 0o755,
    });
  }
  return out;
}

/** /system/services/<name>.json for each built-in manifest (the Normal-boot volume copy). */
export function manifestSeed(): SeedFile[] {
  return BUILTIN_MANIFEST_FILES.map((f) => ({
    path: `/system/services/${f.file}`,
    bytes: encoder.encode(`${JSON.stringify(f.json, null, 2)}\n`),
  }));
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function normalise(path: string): string | null {
  if (!path.startsWith('/') || path.includes('\0')) return null;
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..' || p.length > 255)) return null;
  return parts.length === 0 ? null : `/${parts.join('/')}`;
}

/** Build the mkfs seed from the host's files plus the built-in manifests. */
export function buildSeed(files: readonly SeedFile[], buildTime: number): BuiltSeed {
  const wellKnown = new Set(WELL_KNOWN_DIRS.map((d) => d.path));
  const byPath = new Map<string, SeedFile>();
  for (const f of [...manifestSeed(), ...files]) {
    const p = normalise(f.path);
    if (p === null || wellKnown.has(p)) continue;
    byPath.set(p, { ...f, path: p });
  }
  // Intermediate directories that are not well-known.
  const dirs = new Set<string>();
  for (const p of byPath.keys()) {
    const parts = p.split('/').slice(1, -1);
    for (let i = 1; i <= parts.length; i++) {
      const d = `/${parts.slice(0, i).join('/')}`;
      if (!wellKnown.has(d)) dirs.add(d);
    }
  }
  for (const d of dirs) byPath.delete(d);
  const paths = [...dirs, ...byPath.keys()].sort();

  const range = SEED_ID_LAST - SEED_ID_BASE + 1;
  const used = new Set<number>();
  const idOf = (path: string): string => {
    let slot = fnv1a(path) % range;
    while (used.has(slot)) slot = (slot + 1) % range;
    used.add(slot);
    return seedIno(slot);
  };

  const entries: SeedEntry[] = [];
  const chunks = new Map<string, ChunkRec>();
  let fileCount = 0;
  // Parents sort before their children, so mkfs can attach each entry to an existing parent.
  for (const path of paths.sort(
    (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1),
  )) {
    const ino = idOf(path);
    if (dirs.has(path)) {
      entries.push({
        path,
        ino,
        type: 'd',
        mode: 0o755,
        uid: UID_ROOT,
        gid: GID_ROOT,
        sha256: null,
        size: 0,
        seedVersion: 1,
        priorSha256: [],
      });
      continue;
    }
    const f = byPath.get(path);
    if (f === undefined) continue;
    const c = contentOf(f.bytes, buildTime);
    for (const ch of c.chunks) chunks.set(ch.sha, ch);
    fileCount++;
    entries.push({
      path,
      ino,
      type: 'f',
      mode: (f.mode ?? 0o644) & 0o7777,
      uid: UID_ROOT,
      gid: GID_ROOT,
      sha256: c.size === 0 ? null : c.sha,
      size: c.size,
      seedVersion: 1,
      priorSha256: [],
      chunks: [...c.chunkShas],
    });
  }
  const hash = sha256Hex(entries.map((e) => `${e.path} ${e.sha256 ?? '-'}`).join('\n'));
  return { entries, chunks: [...chunks.values()], hash, files: fileCount };
}

// ---------------------------------------------------------------------------------------------
// Seed upgrade on later boots (§3.3.6 "create missing seeded paths")
// ---------------------------------------------------------------------------------------------

/** Where a host's seed files come from: a same-origin URL and the VFS path to seed it at. */
export interface SeedSource {
  readonly url: string;
  readonly path: string;
  readonly mode?: number;
}

/** docs/identity files seeded into /system/branding (identity-and-branding.md §3.7). */
export const BRANDING_FILES = [
  'logo.svg',
  'logo-mono.svg',
  'wordmark.svg',
  'lockup.svg',
  'favicon.svg',
  'app-icon.svg',
  'maskable-icon.svg',
  'wallpaper-light.svg',
  'wallpaper-dark.svg',
  'manifest.webmanifest',
  'identity.json',
  'usage.md',
] as const;

/**
 * Fetch seed files from the web build (for `IoDeps.seed`): each missing or failing URL is skipped,
 * so a partial seed still boots; the next boot's upgrade adds what is missing.
 */
export async function fetchSeed(
  fetchFn: (url: string) => Promise<Response>,
  sources: readonly SeedSource[],
): Promise<SeedFile[]> {
  const got = await Promise.all(
    sources.map(async (s): Promise<SeedFile | null> => {
      try {
        const r = await fetchFn(s.url);
        if (!r.ok) return null;
        const bytes = new Uint8Array(await r.arrayBuffer());
        return s.mode === undefined
          ? { path: s.path, bytes }
          : { path: s.path, bytes, mode: s.mode };
      } catch {
        return null;
      }
    }),
  );
  return got.filter((f): f is SeedFile => f !== null);
}

export interface SeedUpgradeReport {
  readonly created: number;
  readonly skipped: readonly string[];
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

/**
 * A later boot of a volume made by an older build: create the seeded paths it does not have yet
 * (new programs in /bin, new service manifests, branding) in ONE strict transaction with no outbox
 * op (the server seed has the same rows, §3.3.6). Existing paths are never touched, so a root edit
 * is kept; a path whose id is already used by another inode is skipped and logged. Runs before the
 * tree is built, so every directory it extends loads with the new entries.
 */
export async function applySeedUpgrade(
  store: FsStore,
  seed: BuiltSeed,
  buildTime: number,
): Promise<SeedUpgradeReport> {
  const stored = await store.get<MetaRec>('meta', 'seedHash');
  if (stored?.v === seed.hash) return { created: 0, skipped: [] };
  const inoOf = new Map<string, string>(WELL_KNOWN_DIRS.map((d) => [d.path, d.ino]));
  const create: SeedEntry[] = [];
  const skipped: string[] = [];
  for (const e of seed.entries) {
    const parent = inoOf.get(parentOf(e.path));
    const name = e.path.slice(e.path.lastIndexOf('/') + 1);
    if (parent === undefined) {
      skipped.push(`${e.path}: no parent`);
      continue;
    }
    const d = await store.get<DentryRec>('dentries', [parent, name]);
    if (d !== undefined) {
      inoOf.set(e.path, d.ino);
      continue;
    }
    if ((await store.get<InodeRec>('inodes', e.ino)) !== undefined) {
      skipped.push(`${e.path}: id in use`);
      continue;
    }
    inoOf.set(e.path, e.ino);
    create.push(e);
  }
  if (create.length === 0) {
    await store.tx(['meta'], 'relaxed', (t) => t.put('meta', { k: 'seedHash', v: seed.hash }), {
      label: 'seed hash',
    });
    return { created: 0, skipped };
  }
  const plan = mkfsPlan({ buildTime, deviceId: 'seed-upgrade', seed: create, chunks: [] });
  const created = new Set(create.map((e) => e.ino));
  const rows = plan.inodes.filter((r) => created.has(r.ino));
  const dentries = create.map((e) => ({
    parent: inoOf.get(parentOf(e.path)) ?? '',
    name: e.path.slice(e.path.lastIndexOf('/') + 1),
    ino: e.ino,
    dtype: e.type,
  }));
  // New sub-directories raise their parent's link count (§3.2).
  const nlinkUp = new Map<string, number>();
  for (const d of dentries)
    if (d.dtype === 'd' && !created.has(d.parent))
      nlinkUp.set(d.parent, (nlinkUp.get(d.parent) ?? 0) + 1);
  const parents = await store.getMany<InodeRec>('inodes', [...nlinkUp.keys()]);
  const blobs = new Map<string, BlobRec>();
  for (const b of plan.blobs) {
    const have = await store.get<BlobRec>('blobs', b.sha);
    blobs.set(b.sha, have === undefined ? b : { ...have, refcount: have.refcount + b.refcount });
  }
  const wanted = new Set(plan.blobs.flatMap((b) => b.chunks ?? []));
  const chunks = seed.chunks.filter((c) => wanted.has(c.sha));
  await store.tx(
    ['inodes', 'dentries', 'blobs', 'blob_chunks', 'meta'],
    'strict',
    (t) => {
      for (const r of rows) t.add('inodes', r);
      for (const d of dentries) t.add('dentries', d);
      for (const p of parents) {
        if (p === undefined) continue;
        t.put('inodes', { ...p, nlink: p.nlink + (nlinkUp.get(p.ino) ?? 0) });
      }
      for (const b of blobs.values()) t.put('blobs', b);
      for (const c of chunks) t.put('blob_chunks', c);
      t.put('meta', { k: 'seedHash', v: seed.hash });
    },
    { label: 'seed upgrade' },
  );
  return { created: create.length, skipped };
}
