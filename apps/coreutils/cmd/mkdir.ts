/** `mkdir [-p] [-m MODE] [-v] DIR...` (shell-and-terminal.md §3.14.4). */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { tryStat } from '../lib/fs.ts';
import type { Io } from '../lib/io.ts';
import { applyMode, parseMode } from '../lib/mode.ts';
import type { SysGen } from '../lib/sys.ts';

export interface MkdirOpts {
  readonly parents: boolean;
  readonly mode: string | null;
  readonly verbose: boolean;
  readonly dirs: readonly string[];
}

/** `a/b/c` → `a`, `a/b`, `a/b/c` (the components `-p` may create). */
export function prefixes(path: string): string[] {
  const abs = path.startsWith('/');
  const parts = path.split('/').filter((p) => p.length > 0);
  return parts.map((_, i) => `${abs ? '/' : ''}${parts.slice(0, i + 1).join('/')}`);
}

function* missing(io: Io, path: string): SysGen<string[]> {
  const out: string[] = [];
  for (const prefix of prefixes(path)) {
    const st = yield* tryStat(io.sys, prefix, true);
    if (!st.ok) out.push(prefix);
  }
  return out;
}

export default defineCommand<MkdirOpts>({
  name: 'mkdir',
  parse(args) {
    const p = parseFor('mkdir', args);
    if (p.operands.length === 0) throw new UsageError('missing operand');
    return {
      parents: p.has('p'),
      mode: p.value('m') ?? null,
      verbose: p.has('v'),
      dirs: p.operands,
    };
  },
  *run(io, opts) {
    let mode = 0o777;
    let exact = false;
    if (opts.mode !== null) {
      const spec = parseMode(opts.mode);
      if (spec === null) {
        yield* io.error(`invalid mode '${opts.mode}'`);
        return 1;
      }
      const { old: umask } = yield* io.sys.call('umask', {});
      mode = applyMode(spec, 0o777, true, umask);
      exact = (mode & umask) !== 0 || (mode & 0o1000) !== 0;
    }
    let status = 0;
    for (const dir of opts.dirs) {
      const before = opts.verbose && opts.parents ? yield* missing(io, dir) : [dir];
      try {
        yield* io.sys.call('mkdir', { path: dir, mode, parents: opts.parents });
        // The kernel applies the umask; -m sets the mode exactly (POSIX), so fix it afterwards.
        if (exact) yield* io.sys.call('chmod', { path: dir, mode: { op: 'set', bits: mode } });
      } catch (e) {
        yield* io.error(`cannot create directory '${dir}': ${describe(e)}`);
        status = 1;
        continue;
      }
      if (opts.verbose) {
        for (const made of before) yield* io.line(`mkdir: created directory '${made}'`);
      }
    }
    return status;
  },
});
