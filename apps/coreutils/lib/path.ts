/** Pure path helpers. The kernel resolves paths; these only build operands and display names. */

export function basename(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const i = trimmed.lastIndexOf('/');
  return i === -1 ? trimmed : trimmed.slice(i + 1) || '/';
}

export function dirname(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const i = trimmed.lastIndexOf('/');
  if (i === -1) return '.';
  if (i === 0) return '/';
  return trimmed.slice(0, i);
}

export function join(dir: string, name: string): string {
  if (dir === '' || dir === '.') return name;
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

/** Lexical normalisation of an absolute or cwd-relative path (`.`, `..`, repeated `/`). */
export function resolve(cwd: string, path: string): string {
  const abs = path.startsWith('/') ? path : join(cwd, path);
  const out: string[] = [];
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

/** Expands a leading `~` or `~/` with HOME (the shell normally did this already). */
export function expandHome(path: string, home: string | undefined): string {
  if (home === undefined) return path;
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

/** True when `inner` is `outer` or lies below it (both normalised absolute paths). */
export function isWithin(outer: string, inner: string): boolean {
  if (outer === '/') return true;
  return inner === outer || inner.startsWith(`${outer}/`);
}
