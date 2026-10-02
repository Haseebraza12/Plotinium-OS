/**
 * `du [-s] [-h] [-a] [-c] [-d N] [PATH...]` (shell-and-terminal.md §3.14.18): the sum of file sizes
 * (the bytes the quota counts) in KiB rounded up, post-order. `-s` is one kernel `du` call; the
 * other forms walk the tree once with `find {plus}` and add the sizes up here.
 */
import { defineCommand, parseFor, UsageError } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { escapeName, humanSize } from '../lib/format.ts';
import type { FindHit } from '../lib/fs.ts';
import { findAll, tryStat } from '../lib/fs.ts';
import type { Io } from '../lib/io.ts';
import { dirname } from '../lib/path.ts';
import { errnoOf } from '../lib/sys.ts';
import type { SysGen } from '../lib/sys.ts';
import { displayPath } from './find.ts';

export interface DuOpts {
  readonly summarize: boolean;
  readonly human: boolean;
  readonly all: boolean;
  readonly total: boolean;
  readonly depth: number | null;
  readonly paths: readonly string[];
}

export function sizeText(bytes: number, human: boolean): string {
  return human ? humanSize(bytes) : String(Math.ceil(bytes / 1024));
}

export interface Node {
  readonly path: string;
  readonly dir: boolean;
  bytes: number;
  readonly children: Node[];
}

/** Post-order rows `[bytes, path]` down to `maxDepth`, files only with `all`. */
export function postOrder(
  node: Node,
  depth: number,
  opts: Pick<DuOpts, 'all' | 'depth'>,
  out: [number, string][],
): void {
  for (const child of node.children) postOrder(child, depth + 1, opts, out);
  const shown = opts.depth === null || depth <= opts.depth;
  if (shown && (node.dir || opts.all || depth === 0)) out.push([node.bytes, node.path]);
}

/** Builds the size tree of one start path from its pre-order walk. */
export function buildTree(start: string, hits: readonly FindHit[], cwd: string): Node {
  const root: Node = { path: start, dir: true, bytes: 0, children: [] };
  const byPath = new Map<string, Node>([[start.replace(/\/+$/, '') || '/', root]]);
  for (const hit of hits) {
    const path = displayPath(hit.path, start, cwd);
    const st = hit.entry?.stat;
    const node: Node = {
      path,
      dir: hit.entry?.type === 'd',
      bytes: st !== undefined && st.type !== 'd' ? st.size : 0,
      children: [],
    };
    byPath.set(path, node);
    const parent = byPath.get(dirname(path));
    parent?.children.push(node);
    for (
      let p = parent;
      p !== undefined;
      p = p === root ? undefined : byPath.get(dirname(p.path))
    ) {
      p.bytes += node.bytes;
    }
  }
  return root;
}

function* sizeTree(io: Io, start: string): SysGen<{ root: Node; denied: number }> {
  const walk = yield* findAll(io.sys, { path: start, plus: true });
  return { root: buildTree(start, walk.hits, io.ctx.cwd), denied: walk.denied };
}

/** One total for `-s`: the kernel's `du`, or the walk's sum when the kernel has none (UI-054). */
function* summary(io: Io, path: string): SysGen<{ bytes: number; denied: number }> {
  try {
    const res = yield* io.sys.call('du', { path, maxDepth: 0 });
    return { bytes: res.bytes, denied: res.denied };
  } catch (e) {
    if (errnoOf(e) !== 'ENOSYS') throw e;
  }
  const tree = yield* sizeTree(io, path);
  return { bytes: tree.root.bytes, denied: tree.denied };
}

export default defineCommand<DuOpts>({
  name: 'du',
  parse(args) {
    const p = parseFor('du', args);
    const depthText = p.value('d');
    const depth = depthText === undefined ? null : Number(depthText);
    if (depth !== null && (!Number.isInteger(depth) || depth < 0))
      throw new UsageError(`invalid maximum depth '${depthText ?? ''}'`);
    if (p.has('s') && p.has('a'))
      throw new UsageError('cannot both summarize and show all entries');
    return {
      summarize: p.has('s') || depth === 0,
      human: p.has('h'),
      all: p.has('a'),
      total: p.has('c'),
      depth,
      paths: p.operands.length === 0 ? ['.'] : p.operands,
    };
  },
  *run(io, opts) {
    const tty = yield* io.isTty(1);
    let status = 0;
    let grand = 0;
    for (const path of opts.paths) {
      const st = yield* tryStat(io.sys, path, true);
      if (!st.ok) {
        yield* io.error(`cannot access '${path}': ${describe(st.error)}`);
        status = 1;
        continue;
      }
      let rows: [number, string][];
      let denied = 0;
      if (st.stat.type !== 'd') {
        rows = [[st.stat.size, path]];
      } else if (opts.summarize) {
        const res = yield* summary(io, path);
        rows = [[res.bytes, path]];
        denied = res.denied;
      } else {
        const tree = yield* sizeTree(io, path);
        rows = [];
        postOrder(tree.root, 0, opts, rows);
        denied = tree.denied;
      }
      if (denied > 0) {
        yield* io.error(`cannot read directory '${path}': Permission denied (${denied} skipped)`);
        status = 1;
      }
      for (const [bytes, shown] of rows)
        yield* io.line(`${sizeText(bytes, opts.human)}\t${escapeName(shown, tty)}`);
      grand += rows.at(-1)?.[0] ?? 0;
    }
    if (opts.total) yield* io.line(`${sizeText(grand, opts.human)}\ttotal`);
    return status;
  },
});
