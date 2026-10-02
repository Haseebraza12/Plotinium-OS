/** `rmdir [-p] [-v] DIR...` (shell-and-terminal.md §3.14.5). */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { dirname } from '../lib/path.ts';

export interface RmdirOpts {
  readonly parents: boolean;
  readonly verbose: boolean;
  readonly dirs: readonly string[];
}

/** `a/b/c` with -p → `a/b/c`, `a/b`, `a`. */
export function chain(path: string, parents: boolean): string[] {
  const out = [path.length > 1 ? path.replace(/\/+$/, '') : path];
  if (!parents) return out;
  let cur = out[0] ?? path;
  for (;;) {
    const up = dirname(cur);
    if (up === '.' || up === '/' || up === cur) return out;
    out.push(up);
    cur = up;
  }
}

export default defineCommand<RmdirOpts>({
  name: 'rmdir',
  parse(args) {
    const p = parseFor('rmdir', args);
    if (p.operands.length === 0) throw new UsageError('missing operand');
    return { parents: p.has('p'), verbose: p.has('v'), dirs: p.operands };
  },
  *run(io, opts) {
    let status = 0;
    for (const dir of opts.dirs) {
      for (const path of chain(dir, opts.parents)) {
        if (opts.verbose) yield* io.line(`rmdir: removing directory, '${path}'`);
        try {
          yield* io.sys.call('rmdir', { path });
        } catch (e) {
          yield* io.error(`failed to remove '${path}': ${describe(e)}`);
          status = 1;
          break;
        }
      }
    }
    return status;
  },
});
