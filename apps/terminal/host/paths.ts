/**
 * Path helpers of the process host. Each host process has its own working directory, while every
 * delegated call runs under one kernel identity, so relative path arguments are made absolute
 * against the caller's directory before they leave the host (syscall-abi.md §4.2: a relative path
 * is resolved against the caller's cwd).
 */

/** Argument fields that name paths (the same set as the kernel's scope check). */
const PATH_FIELDS = ['path', 'from', 'to', 'existing', 'dir'] as const;

/** `cwd` joined with a relative `path`; absolute paths are returned unchanged. */
export function absolute(cwd: string, path: string): string {
  if (path.startsWith('/') || path === '') return path;
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

/** Absolute, with `.` and `..` resolved lexically and no trailing slash (except `/`). */
export function normalise(cwd: string, path: string): string {
  const out: string[] = [];
  for (const part of absolute(cwd, path).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && !(x instanceof ArrayBuffer);
}

function rewriteRecord(rec: Record<string, unknown>, cwd: string): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  const set = (key: string, value: unknown): void => {
    out ??= { ...rec };
    out[key] = value;
  };
  for (const field of PATH_FIELDS) {
    const val = rec[field];
    if (typeof val === 'string' && val !== '' && !val.startsWith('/'))
      set(field, absolute(cwd, val));
  }
  const paths = rec['paths'];
  if (Array.isArray(paths) && paths.some((p) => typeof p === 'string' && !p.startsWith('/'))) {
    set(
      'paths',
      paths.map((p: unknown) => (typeof p === 'string' ? absolute(cwd, p) : p)),
    );
  }
  const ops = rec['ops'];
  if (Array.isArray(ops)) {
    set(
      'ops',
      ops.map((op: unknown) => (isRecord(op) ? rewriteRecord(op, cwd) : op)),
    );
  }
  return out ?? rec;
}

/** The arguments with every relative path field made absolute against `cwd`. */
export function withAbsolutePaths(args: unknown, cwd: string): unknown {
  return isRecord(args) ? rewriteRecord(args, cwd) : args;
}

/** `/home/demo/notes` shown as `~/notes` when `home` is `/home/demo`. */
export function tildify(path: string, home: string | undefined): string {
  if (home === undefined || home === '' || home === '/') return path;
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}
