/**
 * `find` and `glob` plan selectors evaluated on the overlay as the agent's credentials
 * (agentic-shell.md §3.12 "Expansion"). Unreadable or untraversable directories are skipped and
 * counted in `denied`, exactly as the `find` syscall reports them. Relative times are resolved in
 * the user's time zone and the absolute interval is returned for the dry run.
 */
import type { FindArgs } from '@plotinium/protocol';

import type { Cred, PermOracle } from '../util/cred.ts';
import { type Result, fail, ok } from '../util/errors.ts';
import { type OvNode, type Overlay, joinPath, normalizePath } from './fsview.ts';
import { globMatch } from './glob.ts';
import { type RelTimeArg, describeRelTime, matchesRelTime } from './reltime.ts';

export interface SelectContext {
  overlay: Overlay;
  cred: Cred;
  oracle: PermOracle;
  cwd: string;
  home: string;
  now: number;
  tz: string;
}

export interface Selection {
  paths: string[];
  denied: number;
  truncated: boolean;
  resolved?: { from: string; to: string };
}

function relTime(m: FindArgs['mtime']): RelTimeArg | undefined {
  if (m === undefined) return undefined;
  if ('within' in m) return { within: m.within };
  if ('olderThan' in m) return { olderThan: m.olderThan };
  return undefined;
}

function matches(
  node: OvNode,
  name: string,
  args: FindArgs,
  ctx: SelectContext,
  rel: RelTimeArg | undefined,
): boolean {
  if (args.name !== undefined && !globMatch(args.name, name)) return false;
  if (args.type !== undefined && node.type !== args.type) return false;
  if (args.size?.gt !== undefined && !(node.size > args.size.gt)) return false;
  if (args.size?.lt !== undefined && !(node.size < args.size.lt)) return false;
  if (rel !== undefined && !matchesRelTime(node.mtime, rel, ctx.now, ctx.tz)) return false;
  const m = args.mtime;
  if (m !== undefined && !('within' in m) && !('olderThan' in m)) {
    if (m.after !== undefined && node.mtime < m.after) return false;
    if (m.before !== undefined && node.mtime >= m.before) return false;
  }
  return true;
}

/** Evaluate a `find` selector; results are sorted by path for a stable dry run. */
export function runFind(args: FindArgs, ctx: SelectContext): Result<Selection> {
  const start = normalizePath(args.path, ctx.cwd, ctx.home);
  if (start === undefined) return fail('EINVAL');
  const r = ctx.overlay.resolve(start, ctx.cred, ctx.oracle, true);
  if (!r.ok) return r;
  if (r.value.node.type !== 'd') return fail('ENOTDIR');
  const rel = relTime(args.mtime);
  const limit = args.limit ?? 1_000;
  const maxDepth = args.maxDepth ?? Number.POSITIVE_INFINITY;
  const out: string[] = [];
  let denied = 0;
  let truncated = false;
  const stack: Array<{ node: OvNode; path: string; depth: number }> = [
    { node: r.value.node, path: r.value.path, depth: 0 },
  ];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    if (cur.depth >= maxDepth) continue;
    if (!ctx.oracle.may(ctx.cred, cur.node, 'r') || !ctx.oracle.may(ctx.cred, cur.node, 'x')) {
      denied++;
      continue;
    }
    const names = [...(cur.node.children?.keys() ?? [])].sort().reverse();
    for (const name of names) {
      const ino = cur.node.children?.get(name);
      const child = ino === undefined ? undefined : ctx.overlay.node(ino);
      if (child === undefined) continue;
      const path = joinPath(cur.path, name);
      if (matches(child, name, args, ctx, rel)) {
        if (out.length >= limit) truncated = true;
        else out.push(path);
      }
      if (child.type === 'd') stack.push({ node: child, path, depth: cur.depth + 1 });
    }
  }
  out.sort();
  const sel: Selection = { paths: out, denied, truncated };
  if (rel !== undefined) sel.resolved = describeRelTime(rel, ctx.now, ctx.tz);
  return ok(sel);
}
