/**
 * The manual pages the Terminal's process host serves read-only under `/usr/share/man`
 * (shell-and-terminal.md §3.12; SHL-12; UI-053), the way it serves `/bin` for its bundled
 * programs (./programs.ts).
 *
 * The pages are the Markdown files of apps/coreutils/man and apps/demo/man, the single source of
 * each command's flags. When the volume holds a page the host uses the volume; when it does not
 * (the seed of /usr/share/man has not landed), the host answers from these, so `man ls`, `man -k`
 * and flag completion work on every volume. Each page is its own lazily loaded chunk:
 *
 *   /usr/share/man/index.json      [{ name, section: 1, summary }, …]
 *   /usr/share/man/1/<name>.md     the page
 */
import type { DirEntry, Stat } from '@plotinium/protocol';

export const MAN_DIR = '/usr/share/man';
export const MAN_SECTION_DIR = `${MAN_DIR}/1`;
export const MAN_INDEX = `${MAN_DIR}/index.json`;

/** One flag of a page's front matter. */
export interface ManFlag {
  readonly short: string | null;
  readonly long: string | null;
  readonly desc: string;
}

/** What the host needs from a set of pages; tests pass a small one. */
export interface ManLibrary {
  /** Page names in code-point order (`ls`, `man`, …). */
  names(): readonly string[];
  /** The page's Markdown, or null for an unknown name. */
  page(name: string): Promise<string | null>;
}

type Loader = () => Promise<string>;

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A library over lazily loaded page texts keyed by name. */
export function manLibrary(loaders: Readonly<Record<string, Loader>>): ManLibrary {
  const names = Object.keys(loaders).sort(byCodePoint);
  const cache = new Map<string, Promise<string>>();
  return {
    names: () => names,
    page(name) {
      const load = Object.hasOwn(loaders, name) ? loaders[name] : undefined;
      if (load === undefined) return Promise.resolve(null);
      let text = cache.get(name);
      if (text === undefined) {
        text = load();
        cache.set(name, text);
        // A failed chunk load may succeed later (after a redeploy, the next open retries).
        text.catch(() => cache.delete(name));
      }
      return text;
    },
  };
}

/** `…/man/ls.md` → `ls`. */
function pageName(path: string): string | null {
  const m = /\/([^/]+)\.md$/u.exec(path);
  return m?.[1] ?? null;
}

function loadersOf(
  modules: Readonly<Record<string, () => Promise<string>>>,
): Record<string, Loader> {
  const out: Record<string, Loader> = {};
  for (const [path, load] of Object.entries(modules)) {
    const name = pageName(path);
    if (name !== null) out[name] = load;
  }
  return out;
}

/** The pages bundled with the Terminal: coreutils and the demo programs. */
export function bundledManPages(): ManLibrary {
  const modules = {
    ...import.meta.glob<string>('../../demo/man/*.md', { query: '?raw', import: 'default' }),
    ...import.meta.glob<string>('../../coreutils/man/*.md', { query: '?raw', import: 'default' }),
  };
  return manLibrary(loadersOf(modules));
}

// ---------------------------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------------------------

interface FrontMatter {
  readonly summary: string;
  readonly flags: readonly ManFlag[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function nullableString(x: unknown): string | null {
  return typeof x === 'string' ? x : null;
}

/** The page's `---json` front matter (summary and flags), or null when it has none. */
export function frontMatter(page: string): FrontMatter | null {
  const m = /^---json\n([\s\S]*?)\n---\n/u.exec(page);
  if (m?.[1] === undefined) return null;
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const flags = Array.isArray(data['flags']) ? (data['flags'] as unknown[]) : [];
  return {
    summary: typeof data['summary'] === 'string' ? data['summary'] : '',
    flags: flags.filter(isRecord).map((f) => ({
      short: nullableString(f['short']),
      long: nullableString(f['long']),
      desc: typeof f['desc'] === 'string' ? f['desc'] : '',
    })),
  };
}

/** `/usr/share/man/index.json`: one entry per page, in code-point order. */
export async function manIndexText(lib: ManLibrary): Promise<string> {
  const entries = await Promise.all(
    lib.names().map(async (name) => {
      const page = await lib.page(name);
      return { name, section: 1, summary: page === null ? '' : (frontMatter(page)?.summary ?? '') };
    }),
  );
  return `${JSON.stringify(entries, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------------------------

const MAN_INO = '00000000-0000-7000-8000-00000000a0a0';
const SECTION_INO = '00000000-0000-7000-8000-00000000a0a1';
const INDEX_INO = '00000000-0000-7000-8000-00000000a0a2';

/** A stable UUIDv7-shaped inode id for a page (FNV-1a of its name). */
function pageIno(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `00000000-0000-7000-8000-a1a1${h.toString(16).padStart(8, '0')}`;
}

function baseStat(now: number): Omit<Stat, 'ino' | 'type' | 'mode' | 'size'> {
  return {
    uid: 0,
    gid: 0,
    nlink: 1,
    atime: now,
    mtime: now,
    ctime: now,
    version: 1,
    blob: null,
    target: null,
    synth: true,
  };
}

/** The page name of `/usr/share/man/1/<name>.md`, or null. */
export function manPagePath(path: string): string | null {
  if (!path.startsWith(`${MAN_SECTION_DIR}/`)) return null;
  const rest = path.slice(MAN_SECTION_DIR.length + 1);
  if (rest.includes('/') || !rest.endsWith('.md')) return null;
  return rest.slice(0, -3);
}

/** The text of an overlay file (the index or a page), or null when `path` is not one. */
export async function manOverlayText(path: string, lib: ManLibrary): Promise<string | null> {
  if (path === MAN_INDEX) return manIndexText(lib);
  const name = manPagePath(path);
  return name === null ? null : lib.page(name);
}

/** The `stat` of an overlay path, or null when it is not one. */
export async function manOverlayStat(
  path: string,
  lib: ManLibrary,
  now: number,
): Promise<Stat | null> {
  const base = baseStat(now);
  if (path === MAN_DIR) return { ...base, ino: MAN_INO, type: 'd', mode: 0o755, size: 0, nlink: 3 };
  if (path === MAN_SECTION_DIR) {
    return { ...base, ino: SECTION_INO, type: 'd', mode: 0o755, size: 0, nlink: 2 };
  }
  const text = await manOverlayText(path, lib);
  if (text === null) return null;
  const size = new TextEncoder().encode(text).byteLength;
  const name = manPagePath(path);
  return { ...base, ino: name === null ? INDEX_INO : pageIno(name), type: 'f', mode: 0o444, size };
}

/** The entries the overlay adds to a directory listing (none for other directories). */
export async function manOverlayEntries(
  path: string,
  lib: ManLibrary,
  plus: boolean,
  now: number,
): Promise<DirEntry[]> {
  const children =
    path === MAN_DIR
      ? [`${MAN_SECTION_DIR}`, MAN_INDEX]
      : path === MAN_SECTION_DIR
        ? lib.names().map((n) => `${MAN_SECTION_DIR}/${n}.md`)
        : [];
  const out: DirEntry[] = [];
  for (const child of children) {
    const s = await manOverlayStat(child, lib, now);
    if (s === null) continue;
    const entry: DirEntry = {
      name: child.slice(child.lastIndexOf('/') + 1),
      ino: s.ino,
      type: s.type,
    };
    out.push(plus ? { ...entry, stat: s } : entry);
  }
  return out;
}

/** The flags of a command's page for completion (`ls -` → `-a`, `--all`, …), or none. */
export async function manFlags(lib: ManLibrary, command: string): Promise<ManFlag[]> {
  const page = await lib.page(command);
  return page === null ? [] : [...(frontMatter(page)?.flags ?? [])];
}
