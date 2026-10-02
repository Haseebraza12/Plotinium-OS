/**
 * `ln [-s] [-f] [-v] TARGET... LINK|DIR` (shell-and-terminal.md §3.14.12). `-f` replaces an
 * existing link name in one `batch` (unlink and create together). Hard links exist only if the
 * VFS builds them; otherwise the kernel answers ENOSYS.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe, mustErrno } from '../lib/errors.ts';
import { tryStat } from '../lib/fs.ts';
import type { Io } from '../lib/io.ts';
import { basename, join } from '../lib/path.ts';
import type { SysGen } from '../lib/sys.ts';
import { uuidv7 } from '../lib/uuid.ts';

export interface LnOpts {
  readonly symbolic: boolean;
  readonly force: boolean;
  readonly verbose: boolean;
  readonly targets: readonly string[];
  /** The link name or directory; null means "basename of the target, here". */
  readonly link: string | null;
}

function* makeLink(io: Io, opts: LnOpts, target: string, path: string): SysGen<void> {
  const exists = opts.force && (yield* tryStat(io.sys, path)).ok;
  if (opts.symbolic) {
    if (exists) {
      yield* io.sys.call('batch', {
        txnId: uuidv7(yield* io.wallClock()),
        ops: [
          { op: 'unlink', path },
          { op: 'symlink', target, path },
        ],
        expectedVersions: [],
      });
    } else {
      yield* io.sys.call('symlink', { target, path });
    }
    return;
  }
  if (exists) yield* io.sys.call('unlink', { path });
  yield* io.sys.call('link', { existing: target, path });
}

export default defineCommand<LnOpts>({
  name: 'ln',
  parse(args) {
    const p = parseFor('ln', args);
    if (p.operands.length === 0) throw new UsageError('missing file operand');
    const single = p.operands.length === 1;
    return {
      symbolic: p.has('s'),
      force: p.has('f'),
      verbose: p.has('v'),
      targets: single ? p.operands : p.operands.slice(0, -1),
      link: single ? null : (p.operands.at(-1) ?? null),
    };
  },
  *run(io, opts) {
    const dest = opts.link === null ? null : yield* tryStat(io.sys, opts.link, true);
    const intoDir = opts.link === null || (dest?.ok === true && dest.stat.type === 'd');
    if (opts.targets.length > 1 && !intoDir) {
      yield* io.error(`target '${opts.link ?? ''}' is not a directory`);
      return 1;
    }
    let status = 0;
    const kind = opts.symbolic ? 'symbolic link' : 'hard link';
    for (const target of opts.targets) {
      const path = intoDir
        ? join(opts.link ?? '.', basename(target))
        : (opts.link ?? basename(target));
      try {
        yield* makeLink(io, opts, target, path);
        if (opts.verbose) yield* io.line(`'${path}' -> '${target}'`);
      } catch (e) {
        status = 1;
        if (!opts.symbolic && mustErrno(e) === 'ENOSYS') {
          yield* io.error('hard links are not supported; use ln -s');
          continue;
        }
        yield* io.error(`failed to create ${kind} '${path}': ${describe(e)}`);
      }
    }
    return status;
  },
});
