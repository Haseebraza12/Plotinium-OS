/** `mv [-n] [-f] [-v] SRC... DEST` (shell-and-terminal.md §3.14.10): one `rename` per operand. */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { bulkSuffix, describe, mustErrno } from '../lib/errors.ts';
import { tryStat } from '../lib/fs.ts';
import { basename, join } from '../lib/path.ts';
import { lastOf } from './cp.ts';

export interface MvOpts {
  readonly noClobber: boolean;
  readonly verbose: boolean;
  readonly sources: readonly string[];
  readonly dest: string;
}

export default defineCommand<MvOpts>({
  name: 'mv',
  parse(args) {
    const p = parseFor('mv', args);
    if (p.operands.length === 0) throw new UsageError('missing file operand');
    if (p.operands.length === 1)
      throw new UsageError(`missing destination file operand after '${p.operands[0] ?? ''}'`);
    return {
      noClobber: p.has('n') && lastOf(args, 'n', 'f') !== 'f',
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
      const to = intoDir ? join(opts.dest, basename(src)) : opts.dest;
      try {
        yield* io.sys.call('rename', { from: src, to, noReplace: opts.noClobber });
        if (opts.verbose) yield* io.line(`renamed '${src}' -> '${to}'`);
      } catch (e) {
        const errno = mustErrno(e);
        if (errno === 'EEXIST' && opts.noClobber) continue;
        status = 1;
        if (errno === 'EINVAL')
          yield* io.error(`cannot move '${src}' to a subdirectory of itself, '${to}'`);
        else if (errno === 'EISDIR')
          yield* io.error(`cannot overwrite directory '${to}' with non-directory`);
        else if (errno === 'ENOENT' && !(yield* tryStat(io.sys, src)).ok) {
          yield* io.error(`cannot stat '${src}': ${describe(e)}`);
        } else yield* io.error(`cannot move '${src}' to '${to}': ${describe(e)}${bulkSuffix(e)}`);
      }
    }
    return status;
  },
});
