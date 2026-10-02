/** `tree [-a] [-d] [-L LEVEL] [--noreport] [PATH]` (shell-and-terminal.md §3.14.14). */
import type { DirEntry } from '@plotinium/protocol';

import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { escapeName, plural } from '../lib/format.ts';
import { listDir, tryStat } from '../lib/fs.ts';
import type { Io } from '../lib/io.ts';
import { join } from '../lib/path.ts';
import type { SysGen } from '../lib/sys.ts';

export interface TreeOpts {
  readonly all: boolean;
  readonly dirsOnly: boolean;
  readonly level: number | null;
  readonly noReport: boolean;
  readonly path: string;
}

interface Counts {
  dirs: number;
  files: number;
}

function visible(entries: readonly DirEntry[], opts: TreeOpts): DirEntry[] {
  return entries.filter(
    (e) => (opts.all || !e.name.startsWith('.')) && (!opts.dirsOnly || e.type === 'd'),
  );
}

function* branch(
  io: Io,
  path: string,
  entries: readonly DirEntry[],
  prefix: string,
  depth: number,
  opts: TreeOpts,
  tty: boolean,
  counts: Counts,
): SysGen<void> {
  for (const [i, e] of entries.entries()) {
    const last = i === entries.length - 1;
    const line = `${prefix}${last ? '└── ' : '├── '}${escapeName(e.name, tty)}`;
    if (e.type !== 'd') {
      counts.files += 1;
      const target =
        e.type === 'l' && e.stat?.target != null ? ` -> ${escapeName(e.stat.target, tty)}` : '';
      yield* io.line(`${line}${target}`);
      continue;
    }
    counts.dirs += 1;
    if (opts.level !== null && depth >= opts.level) {
      yield* io.line(line);
      continue;
    }
    const child = join(path, e.name);
    let children: DirEntry[];
    try {
      children = visible(yield* listDir(io.sys, child, true), opts);
    } catch {
      yield* io.line(`${line}  [error opening dir]`);
      continue;
    }
    yield* io.line(line);
    yield* branch(
      io,
      child,
      children,
      `${prefix}${last ? '    ' : '│   '}`,
      depth + 1,
      opts,
      tty,
      counts,
    );
  }
}

export function report(counts: Counts, dirsOnly: boolean): string {
  const dirs = plural(counts.dirs, 'directory', 'directories');
  return dirsOnly ? dirs : `${dirs}, ${plural(counts.files, 'file', 'files')}`;
}

export default defineCommand<TreeOpts>({
  name: 'tree',
  parse(args) {
    const p = parseFor('tree', args);
    const levelText = p.value('L');
    const level = levelText === undefined ? null : Number(levelText);
    if (level !== null && (!Number.isInteger(level) || level < 1))
      throw new UsageError(`invalid level '${levelText ?? ''}', must be greater than 0`);
    if (p.operands.length > 1) throw new UsageError(`extra operand '${p.operands[1] ?? ''}'`);
    return {
      all: p.has('a'),
      dirsOnly: p.has('d'),
      level,
      noReport: p.has('noreport'),
      path: p.operands[0] ?? '.',
    };
  },
  *run(io, opts) {
    const tty = yield* io.isTty(1);
    const root = yield* tryStat(io.sys, opts.path, true);
    if (!root.ok || root.stat.type !== 'd') {
      yield* io.error(`'${opts.path}': ${root.ok ? 'Not a directory' : describe(root.error)}`);
      return 1;
    }
    const counts: Counts = { dirs: 0, files: 0 };
    let entries: DirEntry[];
    try {
      entries = visible(yield* listDir(io.sys, opts.path, true), opts);
    } catch (e) {
      yield* io.error(`'${opts.path}': ${describe(e)}`);
      return 1;
    }
    yield* io.line(escapeName(opts.path, tty));
    yield* branch(io, opts.path, entries, '', 1, opts, tty, counts);
    if (!opts.noReport) yield* io.line(`\n${report(counts, opts.dirsOnly)}`);
    return 0;
  },
});
