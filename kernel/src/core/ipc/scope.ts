/**
 * The lexical half of the `fs.scope` capability check (syscall-abi.md §3.3 stage 4, §4.5): every
 * path argument, normalised against the caller's cwd, must lie under an allowed prefix. The
 * resolved-path half (so a symlink cannot escape) runs at stage 5 in the VFS resolver.
 */

/** Argument fields that name paths in the syscall catalogue. */
const PATH_FIELDS = ['path', 'from', 'to', 'existing', 'dir'] as const;
const PATH_LIST_FIELDS = ['paths'] as const;

/** Absolute, `.` and `..` resolved, no trailing slash (except `/`). Pure string work. */
export function normalisePath(path: string, cwd: string): string {
  const joined = path.startsWith('/') ? path : `${cwd}/${path}`;
  const out: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

export function isUnder(path: string, prefix: string): boolean {
  if (prefix === '/') return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The first path argument outside every prefix, or null when all are inside. */
export function scopeViolation(
  args: unknown,
  cwd: string,
  prefixes: readonly string[],
): string | null {
  if (args === null || typeof args !== 'object') return null;
  const rec = args as Record<string, unknown>;
  const paths: string[] = [];
  for (const f of PATH_FIELDS) {
    const val = rec[f];
    if (typeof val === 'string') paths.push(val);
  }
  for (const f of PATH_LIST_FIELDS) {
    const val = rec[f];
    if (Array.isArray(val)) for (const p of val) if (typeof p === 'string') paths.push(p);
  }
  const allowed = prefixes.map((p) => normalisePath(p, '/'));
  for (const p of paths) {
    const abs = normalisePath(p, cwd);
    if (!allowed.some((prefix) => isUnder(abs, prefix))) return abs;
  }
  return null;
}
