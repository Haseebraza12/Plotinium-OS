/**
 * `cp [-r | -R] [-n] [-f] [-p] [-v] SRC... DEST` (shell-and-terminal.md §3.14.9): each operand is
 * one bulk, all-or-nothing `copy` call.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { bulkSuffix, describe, mustErrno } from '../lib/errors.ts';
import { tryStat } from '../lib/fs.ts';
import { basename, join } from '../lib/path.ts';

export interface CpOpts {
  readonly recursive: boolean;
  readonly noClobber: boolean;
  readonly force: boolean;
  readonly preserve: boolean;
  readonly verbose: boolean;
  readonly sources: readonly string[];
  readonly dest: string;
}

/** Of two opposing flags, the one given last wins (GNU). */
export function lastOf(args: readonly string[], a: string, b: string): string | null {
  let last: string | null = null;
  for (const arg of args) {
    if (arg === '--') break;
    if (/^-[A-Za-z]+$/.test(arg)) {
      for (const c of arg.slice(1)) if (c === a || c === b) last = c;
    }
  }
  return last;
}

export default defineCommand<CpOpts>({
  name: 'cp',
  parse(args) {
    const p = parseFor('cp', args);
    if (p.operands.length === 0) throw new UsageError('missing file operand');
    if (p.operands.length === 1)
      throw new UsageError(`missing destination file operand after '${p.operands[0] ?? ''}'`);
    const last = lastOf(args, 'n', 'f');
    return {
      recursive: p.has('r') || p.has('R'),
      noClobber: p.has('n') && last !== 'f',
      force: p.has('f'),
      preserve: p.has('p'),
      verbose: p.has('v'),
      sources: p.operands.slice(0, -1),
      dest: p.operands.at(-1) ?? '',
    };
  },
  *run(io, opts) {
    const dest = yield* tryStat(io.sys, opts.dest, true);
    const intoDir = dest.ok && dest.stat.type === 'd';
    if (opts.sources.length > 1 && !intoDir) {
      yield* io.error(
        `target '${opts.dest}': ${dest.ok ? 'Not a directory' : describe(dest.error)}`,
      );
      return 1;
    }
    let status = 0;
    for (const src of opts.sources) {
      const st = yield* tryStat(io.sys, src, !opts.recursive);
      if (!st.ok) {
        yield* io.error(`cannot stat '${src}': ${describe(st.error)}`);
        status = 1;
        continue;
      }
      if (st.stat.type === 'd' && !opts.recursive) {
        yield* io.error(`-r not specified; omitting directory '${src}'`);
        status = 1;
        continue;
      }
      const to = intoDir ? join(opts.dest, basename(src)) : opts.dest;
      const args = {
        from: src,
        to,
        recursive: opts.recursive,
        noReplace: opts.noClobber,
        preserve: opts.preserve,
      };
      try {
        try {
          yield* io.sys.call('copy', args);
        } catch (e) {
          if (!opts.force || mustErrno(e) !== 'EACCES' || !(yield* tryStat(io.sys, to)).ok) throw e;
          // -f: a destination that cannot be opened for writing is removed and replaced.
          yield* io.sys.call('unlink', { path: to });
          yield* io.sys.call('copy', args);
        }
        if (opts.verbose) yield* io.line(`'${src}' -> '${to}'`);
      } catch (e) {
        const errno = mustErrno(e);
        if (errno === 'EEXIST' && opts.noClobber) continue;
        status = 1;
        if (errno === 'EINVAL' && st.stat.type === 'd') {
          yield* io.error(`cannot copy a directory, '${src}', into itself, '${to}'`);
        } else if (errno === 'EDQUOT') {
          yield* io.error(`cannot copy '${src}': ${describe(e)} — nothing was copied`);
        } else {
          yield* io.error(`cannot copy '${src}': ${describe(e)}${bulkSuffix(e)}`);
        }
      }
    }
    return status;
  },
});
