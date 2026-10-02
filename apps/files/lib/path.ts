/**
 * Path text helpers for the Files and Editor apps. Pure string work over absolute POSIX paths
 * (virtual-file-system.md §3.4): the kernel resolves and checks every path again, so these only
 * shape what the apps ask for and show.
 */

/** Absolute, with `.`, `..` and repeated slashes removed; no trailing slash except `/`. */
export function normalize(path: string, cwd = '/'): string {
  const joined = path.startsWith('/') ? path : `${cwd}/${path}`;
  const out: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** `join('/home/a', 'b.txt')` is `/home/a/b.txt`. */
export function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/** The last segment, or `/` for the root. */
export function basename(path: string): string {
  if (path === '/') return '/';
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** The parent directory; the root is its own parent. */
export function dirname(path: string): string {
  const norm = normalize(path);
  if (norm === '/') return '/';
  const at = norm.lastIndexOf('/');
  return at <= 0 ? '/' : norm.slice(0, at);
}

/** Whether `path` is `dir` itself or lies below it. */
export function isInside(path: string, dir: string): boolean {
  if (dir === '/') return true;
  return path === dir || path.startsWith(`${dir}/`);
}

/** `~/notes/a.md` for paths under the home directory, the absolute path otherwise. */
export function tildePath(path: string, home: string): string {
  if (path === home) return '~';
  return isInside(path, home) ? `~${path.slice(home.length)}` : path;
}

/** `notes/a.md` relative to `base`, or the absolute path when it lies outside. */
export function relativeTo(path: string, base: string): string {
  if (base !== '/' && isInside(path, base) && path !== base) return path.slice(base.length + 1);
  if (base === '/' && path !== '/') return path.slice(1);
  return path;
}

/** Splits `report.final.md` into `report.final` and `.md`; a leading dot is part of the name. */
export function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Why a new file or folder name is refused, or undefined when it is acceptable. The kernel
 * re-checks (VFS-08); this gives the user the reason before a round trip.
 */
export function nameProblem(name: string): string | undefined {
  if (name.trim() === '') return 'Enter a name.';
  if (name === '.' || name === '..') return 'That name is reserved.';
  if (name.includes('/')) return 'A name cannot contain “/”.';
  if (name.includes('\u0000')) return 'A name cannot contain a NUL character.';
  if (new TextEncoder().encode(name).byteLength > 255) return 'That name is too long.';
  return undefined;
}
