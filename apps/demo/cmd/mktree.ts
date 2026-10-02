/**
 * mktree: builds the seeded fixture tree (`~/fixtures/tree1000`) of the DB-02 fault-injection
 * demonstration through ordinary file system calls (VFS-07): one `mkdir` per directory and one
 * `writeFile` per file, in the fixture's creation order (lib/tree.ts).
 */
import type { ProgramContext, SysGen } from '@plotinium/kernel/sys';
import { errnoOf } from '@plotinium/kernel/sys';

import type { DemoState, Out } from '../lib/cli.ts';
import {
  basename,
  defineDemo,
  dirname,
  epochNow,
  errText,
  homeOf,
  intOption,
  parseFor,
  seconds,
  statusFor,
  takeSignal,
  thousands,
  UsageError,
} from '../lib/cli.ts';
import { DEFAULT_SEED } from '../lib/pattern.ts';
import type { TreeNode, TreeSummary } from '../lib/tree.ts';
import { contentOf, DEFAULT_NODES, fixtureTree, summarize } from '../lib/tree.ts';

export const MAX_NODES = 100_000;
/** Progress is redrawn on a terminal every this many nodes. */
const PROGRESS_EVERY = 50;

export interface MktreeOpts {
  readonly dir: string | null;
  readonly nodes: number;
  readonly seed: number;
  readonly force: boolean;
  readonly quiet: boolean;
  readonly json: boolean;
}

export interface MktreeWork {
  /** DIR as given, or the default under $HOME; fixed at the start of `run`. */
  dir: string | null;
  done: number;
  startedAt: number | null;
  failed: boolean;
}

export function parseMktree(args: readonly string[]): MktreeOpts {
  const p = parseFor('mktree', args);
  if (p.operands.length > 1) throw new UsageError(`mktree: extra operand '${p.operands[1] ?? ''}'`);
  const rawNodes = p.value('n');
  const rawSeed = p.value('seed');
  const dir = p.operands[0] ?? null;
  if (dir === '') throw new UsageError("mktree: invalid directory ''");
  return {
    dir,
    nodes:
      rawNodes === undefined
        ? DEFAULT_NODES
        : intOption('mktree', '--nodes', rawNodes, 1, MAX_NODES),
    seed:
      rawSeed === undefined ? DEFAULT_SEED : intOption('mktree', '--seed', rawSeed, 0, 0xffff_ffff),
    force: p.has('f'),
    quiet: p.has('q'),
    json: p.has('json'),
  };
}

/** Where node `path` (relative, starting with the tree's name) goes when the tree is `dir`. */
export function absPath(dir: string, path: string): string {
  const parent = dirname(dir);
  if (parent === '.') return path;
  return parent === '/' ? `/${path}` : `${parent}/${path}`;
}

export function summaryLine(dir: string, s: TreeSummary, ms: number): string {
  return (
    `mktree: created ${dir}: ${thousands(s.nodes)} nodes (${thousands(s.dirs)} directories, ${thousands(s.files)} files, ` +
    `${thousands(s.bytes)} bytes), depth ${String(s.depth)}, manifest sha256:${s.manifestSha256.slice(0, 16)}… in ${seconds(ms)}`
  );
}

const encoder = new TextEncoder();

function bytesOf(text: string): ArrayBuffer {
  const b = encoder.encode(text);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function* createNode(ctx: ProgramContext, dir: string, node: TreeNode): SysGen<void> {
  const path = absPath(dir, node.path);
  if (node.type === 'd') {
    yield* ctx.sys.mkdir({ path, mode: node.mode });
  } else {
    yield* ctx.sys.writeFile({
      path,
      data: bytesOf(contentOf(node.path, node.size)),
      mode: node.mode,
      create: true,
    });
  }
}

/** Is there anything at `path`? (lstat: a dangling symlink counts.) */
function* exists(ctx: ProgramContext, path: string): SysGen<boolean> {
  try {
    yield* ctx.sys.lstat({ path });
    return true;
  } catch (e) {
    if (errnoOf(e) === 'ENOENT') return false;
    throw e;
  }
}

function* run(
  ctx: ProgramContext,
  out: Out,
  o: MktreeOpts,
  w: MktreeWork,
  st: DemoState<MktreeOpts, MktreeWork>,
): SysGen<number> {
  const dir = (w.dir ??= o.dir ?? `${homeOf(ctx)}/fixtures/tree${String(o.nodes)}`);
  const nodes = fixtureTree(basename(dir), o.nodes, o.seed);
  w.startedAt ??= (yield* epochNow(ctx)).epochMs;

  if (w.done === 0) {
    try {
      if (yield* exists(ctx, dir)) {
        if (!o.force) {
          yield* out.error(`cannot create '${dir}': File exists (use -f to replace it)`);
          return 1;
        }
        yield* ctx.sys.unlink({ path: dir, recursive: true });
      }
      const parent = dirname(dir);
      if (parent !== '.' && parent !== '/')
        yield* ctx.sys.mkdir({ path: parent, parents: true, mode: 0o755 });
    } catch (e) {
      yield* out.error(`cannot create '${dir}': ${errText(e)}`);
      return 1;
    }
  }

  const progress = !o.quiet && !o.json && (yield* out.isTty(2));
  while (w.done < nodes.length) {
    const sig = takeSignal(st);
    if (sig !== null) {
      if (progress) yield* out.write(2, '\n');
      yield* out.error(
        `interrupted by ${sig} (${thousands(w.done)} of ${thousands(nodes.length)} nodes created)`,
      );
      return statusFor(sig);
    }
    const node = nodes[w.done];
    if (node === undefined) break;
    try {
      yield* createNode(ctx, dir, node);
    } catch (e) {
      if (progress) yield* out.write(2, '\n');
      yield* out.error(
        `cannot create '${absPath(dir, node.path)}': ${errText(e)} (${thousands(w.done)} of ${thousands(nodes.length)} nodes created)`,
      );
      w.failed = true;
      return 1;
    }
    w.done++;
    if (progress && (w.done % PROGRESS_EVERY === 0 || w.done === nodes.length)) {
      yield* out.write(2, `\rmktree: ${thousands(w.done)}/${thousands(nodes.length)} nodes`);
    }
  }
  if (progress) yield* out.write(2, '\n');

  const s = summarize(nodes);
  const ms = (yield* epochNow(ctx)).epochMs - w.startedAt;
  if (o.json) {
    yield* out.line(JSON.stringify({ dir, ...s, seed: o.seed, ms }));
  } else if (!o.quiet) {
    yield* out.line(summaryLine(dir, s, ms));
  }
  return 0;
}

const mktree = defineDemo<MktreeOpts, MktreeWork>({
  name: 'mktree',
  catches: ['SIGINT', 'SIGTERM', 'SIGHUP'],
  parse: parseMktree,
  start: () => ({ dir: null, done: 0, startedAt: null, failed: false }),
  run,
});

export default mktree;
