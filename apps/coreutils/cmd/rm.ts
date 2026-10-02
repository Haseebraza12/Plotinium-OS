/**
 * `rm [-r | -R] [-f] [-d] [-v] PATH...` (shell-and-terminal.md §3.14.11): `-r` is the §8.1 bulk
 * operation, one `unlink {recursive}` that commits or rolls back as a whole.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { bulkSuffix, describe } from '../lib/errors.ts';
import { thousands } from '../lib/format.ts';
import { tryStat } from '../lib/fs.ts';
import type { Io } from '../lib/io.ts';
import { basename, resolve } from '../lib/path.ts';
import type { SysGen } from '../lib/sys.ts';

export interface RmOpts {
  readonly recursive: boolean;
  readonly force: boolean;
  readonly dir: boolean;
  readonly verbose: boolean;
  readonly paths: readonly string[];
}

/** The refusal message for `/`, `.` and `..`, or null when the operand may be removed. */
export function refusal(path: string, recursive: boolean): string | null {
  if (recursive && resolve('/', path) === '/' && path.startsWith('/')) {
    return "it is dangerous to operate recursively on '/'";
  }
  const base = basename(path);
  if (base === '.' || base === '..')
    return `refusing to remove '.' or '..' directory: skipping '${path}'`;
  return null;
}

/** Online, a removal the server has not confirmed within the sync wait is reported but succeeds. */
function* pendingNotice(io: Io, path: string, sync: string): SysGen<void> {
  if (sync !== 'pending') return;
  try {
    const net = yield* io.sys.call('net.status', {});
    if (net.state === 'online')
      yield* io.error(`'${path}' removed locally; server confirmation pending`);
  } catch {
    // offline pending is the normal case and needs no notice
  }
}

export default defineCommand<RmOpts>({
  name: 'rm',
  parse(args) {
    const p = parseFor('rm', args);
    if (p.operands.length === 0 && !p.has('f')) throw new UsageError('missing operand');
    return {
      recursive: p.has('r') || p.has('R'),
      force: p.has('f'),
      dir: p.has('d'),
      verbose: p.has('v'),
      paths: p.operands,
    };
  },
  *run(io, opts) {
    let status = 0;
    for (const path of opts.paths) {
      const refused = refusal(path, opts.recursive);
      if (refused !== null) {
        yield* io.error(refused);
        status = 1;
        continue;
      }
      const st = yield* tryStat(io.sys, path);
      if (!st.ok) {
        if (st.errno === 'ENOENT' && opts.force) continue;
        yield* io.error(`cannot remove '${path}': ${describe(st.error)}`);
        status = 1;
        continue;
      }
      try {
        if (st.stat.type === 'd' && opts.recursive) {
          const res = yield* io.sys.call('unlink', { path, recursive: true });
          if (opts.verbose) yield* io.line(`removed '${path}' (${thousands(res.removed)} entries)`);
          yield* pendingNotice(io, path, res.sync);
        } else if (st.stat.type === 'd' && opts.dir) {
          yield* io.sys.call('rmdir', { path });
          if (opts.verbose) yield* io.line(`removed directory '${path}'`);
        } else if (st.stat.type === 'd') {
          yield* io.error(`cannot remove '${path}': Is a directory`);
          status = 1;
        } else {
          yield* io.sys.call('unlink', { path });
          if (opts.verbose) yield* io.line(`removed '${path}'`);
        }
      } catch (e) {
        yield* io.error(`cannot remove '${path}': ${describe(e)}${bulkSuffix(e)}`);
        status = 1;
      }
    }
    return status;
  },
});
