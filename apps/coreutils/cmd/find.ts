/**
 * `find [PATH...] [EXPRESSION]` (shell-and-terminal.md §3.14.13). The kernel walks each start path
 * as the caller (`find {plus}`, pre-order, code-point order, symlinks not followed); the expression
 * (`-name -iname -type -mtime -mmin -size -user -empty -newer`, `! -not -a -o \( \)`, `-print`,
 * `-maxdepth -mindepth`) is evaluated here.
 */
import type { Stat } from '@plotinium/protocol';

import { matchGlob } from '../../shell/glob.ts';
import { defineCommand } from '../lib/command.ts';
import { describe } from '../lib/errors.ts';
import { escapeName } from '../lib/format.ts';
import { findAll, tryStat } from '../lib/fs.ts';
import type { Io } from '../lib/io.ts';
import { basename, resolve } from '../lib/path.ts';
import type { SysGen } from '../lib/sys.ts';
import { findUid, loadUsers } from '../lib/users.ts';

type Cmp = -1 | 0 | 1;

export type FindNode =
  | { readonly k: 'and' | 'or'; readonly a: FindNode; readonly b: FindNode }
  | { readonly k: 'not'; readonly a: FindNode }
  | { readonly k: 'name'; readonly glob: string; readonly ci: boolean }
  | { readonly k: 'type'; readonly t: 'f' | 'd' | 'l' }
  | { readonly k: 'age'; readonly unitMs: number; readonly cmp: Cmp; readonly n: number }
  | { readonly k: 'size'; readonly unit: number; readonly cmp: Cmp; readonly n: number }
  | { readonly k: 'user'; readonly name: string }
  | { readonly k: 'empty' }
  | { readonly k: 'newer'; readonly file: string }
  | { readonly k: 'print' }
  | { readonly k: 'true' };

export interface FindOpts {
  readonly paths: readonly string[];
  readonly expr: FindNode;
  readonly hasPrint: boolean;
  readonly maxDepth: number | null;
  readonly minDepth: number;
  /** A parse error, printed as `find: <problem>` with status 2. */
  readonly problem: string | null;
}

class ExprError extends Error {}

const SIZE_UNITS: Readonly<Record<string, number>> = {
  '': 512,
  b: 512,
  c: 1,
  k: 1024,
  M: 1_048_576,
  G: 1_073_741_824,
};

function numeric(text: string | undefined, near: string): { cmp: Cmp; n: number } {
  const m = /^([+-]?)(\d+)$/.exec(text ?? '');
  if (m === null) throw new ExprError(`invalid argument '${text ?? ''}' to '${near}'`);
  return { cmp: m[1] === '+' ? 1 : m[1] === '-' ? -1 : 0, n: Number(m[2]) };
}

/** Recursive-descent parser over the expression tokens; options are pulled out first. */
export class ExprParser {
  private i = 0;
  hasPrint = false;
  maxDepth: number | null = null;
  minDepth = 0;
  private readonly tokens: readonly string[];

  constructor(tokens: readonly string[]) {
    this.tokens = tokens;
  }

  parse(): FindNode {
    if (this.tokens.length === 0) return { k: 'true' };
    const node = this.or();
    if (this.i < this.tokens.length)
      throw new ExprError(`invalid expression near '${this.tokens[this.i] ?? ''}'`);
    return node;
  }

  private peek(): string | undefined {
    return this.tokens[this.i];
  }

  private take(): string {
    const t = this.tokens[this.i];
    if (t === undefined) throw new ExprError('invalid expression near end of input');
    this.i++;
    return t;
  }

  private or(): FindNode {
    let node = this.and();
    while (this.peek() === '-o' || this.peek() === '-or') {
      this.i++;
      node = { k: 'or', a: node, b: this.and() };
    }
    return node;
  }

  private and(): FindNode {
    let node = this.unary();
    for (;;) {
      const t = this.peek();
      if (t === undefined || t === '-o' || t === '-or' || t === ')') return node;
      if (t === '-a' || t === '-and') this.i++;
      node = { k: 'and', a: node, b: this.unary() };
    }
  }

  private unary(): FindNode {
    const t = this.peek();
    if (t === '!' || t === '-not') {
      this.i++;
      return { k: 'not', a: this.unary() };
    }
    return this.primary();
  }

  private arg(near: string): string {
    const v = this.tokens[this.i];
    if (v === undefined) throw new ExprError(`missing argument to '${near}'`);
    this.i++;
    return v;
  }

  private primary(): FindNode {
    const t = this.take();
    switch (t) {
      case '(': {
        const inner = this.or();
        if (this.take() !== ')') throw new ExprError("invalid expression near '('");
        return inner;
      }
      case '-name':
      case '-iname':
        return { k: 'name', glob: this.arg(t), ci: t === '-iname' };
      case '-type': {
        const v = this.arg(t);
        if (v !== 'f' && v !== 'd' && v !== 'l')
          throw new ExprError(`unknown argument to -type: ${v}`);
        return { k: 'type', t: v };
      }
      case '-mtime':
      case '-mmin':
        return {
          k: 'age',
          unitMs: t === '-mtime' ? 86_400_000 : 60_000,
          ...numeric(this.arg(t), t),
        };
      case '-size': {
        const v = this.arg(t);
        const m = /^([+-]?\d+)([bckMG]?)$/.exec(v);
        if (m === null) throw new ExprError(`invalid -size type in '${v}'`);
        return { k: 'size', unit: SIZE_UNITS[m[2] ?? ''] ?? 512, ...numeric(m[1], t) };
      }
      case '-user':
        return { k: 'user', name: this.arg(t) };
      case '-empty':
        return { k: 'empty' };
      case '-newer':
        return { k: 'newer', file: this.arg(t) };
      case '-print':
        this.hasPrint = true;
        return { k: 'print' };
      case '-maxdepth':
      case '-mindepth': {
        const v = numeric(this.arg(t), t);
        if (v.cmp !== 0)
          throw new ExprError(`invalid argument '${this.tokens[this.i - 1] ?? ''}' to '${t}'`);
        if (t === '-maxdepth') this.maxDepth = v.n;
        else this.minDepth = v.n;
        return { k: 'true' };
      }
      default:
        throw new ExprError(`invalid expression near '${t}'`);
    }
  }
}

export function parseFind(args: readonly string[]): FindOpts {
  let split = args.findIndex((a) => a.startsWith('-') || a === '!' || a === '(');
  if (split === -1) split = args.length;
  const paths = args.slice(0, split);
  const parser = new ExprParser(args.slice(split));
  const base = { paths: paths.length === 0 ? ['.'] : paths };
  try {
    const expr = parser.parse();
    return {
      ...base,
      expr,
      hasPrint: parser.hasPrint,
      maxDepth: parser.maxDepth,
      minDepth: parser.minDepth,
      problem: null,
    };
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    return {
      ...base,
      expr: { k: 'true' },
      hasPrint: false,
      maxDepth: null,
      minDepth: 0,
      problem: e.message,
    };
  }
}

/** Facts the evaluator needs besides the entry itself. */
interface EvalEnv {
  readonly io: Io;
  readonly now: number;
  readonly users: ReadonlyMap<string, number | undefined>;
  readonly newer: ReadonlyMap<string, number>;
}

interface Candidate {
  readonly path: string;
  readonly stat: Stat;
}

function compare(value: number, cmp: Cmp, n: number): boolean {
  return cmp === 1 ? value > n : cmp === -1 ? value < n : value === n;
}

function* isEmpty(io: Io, c: Candidate): SysGen<boolean> {
  if (c.stat.type === 'f') return c.stat.size === 0;
  if (c.stat.type !== 'd') return false;
  try {
    const page = yield* io.sys.call('readdir', { path: c.path, limit: 1 });
    return page.entries.length === 0;
  } catch {
    return false;
  }
}

/** Evaluates the expression; `printed` records whether a `-print` fired. */
export function* evaluate(
  node: FindNode,
  c: Candidate,
  env: EvalEnv,
  printed: { value: boolean },
): SysGen<boolean> {
  switch (node.k) {
    case 'and':
      return (
        (yield* evaluate(node.a, c, env, printed)) && (yield* evaluate(node.b, c, env, printed))
      );
    case 'or':
      return (
        (yield* evaluate(node.a, c, env, printed)) || (yield* evaluate(node.b, c, env, printed))
      );
    case 'not':
      return !(yield* evaluate(node.a, c, env, printed));
    case 'name': {
      const name = basename(c.path);
      return node.ci
        ? matchGlob(node.glob.toLowerCase(), name.toLowerCase())
        : matchGlob(node.glob, name);
    }
    case 'type':
      return c.stat.type === node.t;
    case 'age':
      return compare(Math.floor((env.now - c.stat.mtime) / node.unitMs), node.cmp, node.n);
    case 'size':
      return compare(Math.ceil(c.stat.size / node.unit), node.cmp, node.n);
    case 'user':
      return env.users.get(node.name) === c.stat.uid;
    case 'empty':
      return yield* isEmpty(env.io, c);
    case 'newer':
      return c.stat.mtime > (env.newer.get(node.file) ?? Number.POSITIVE_INFINITY);
    case 'print':
      printed.value = true;
      return true;
    case 'true':
      return true;
  }
}

function collect(node: FindNode, kind: 'user' | 'newer', out: Set<string>): void {
  if (node.k === 'and' || node.k === 'or') {
    collect(node.a, kind, out);
    collect(node.b, kind, out);
  } else if (node.k === 'not') collect(node.a, kind, out);
  else if (node.k === 'user' && kind === 'user') out.add(node.name);
  else if (node.k === 'newer' && kind === 'newer') out.add(node.file);
}

/** The kernel's path shown with the start path exactly as typed. */
export function displayPath(kernelPath: string, start: string, cwd: string): string {
  if (kernelPath === start || kernelPath.startsWith(start.endsWith('/') ? start : `${start}/`))
    return kernelPath;
  const abs = resolve(cwd, start);
  if (kernelPath.startsWith(abs)) return start.replace(/\/+$/, '') + kernelPath.slice(abs.length);
  return kernelPath;
}

function depthOf(display: string, start: string): number {
  const rest = display
    .slice(start.replace(/\/+$/, '').length)
    .split('/')
    .filter((s) => s.length > 0);
  return rest.length;
}

function* prepare(io: Io, opts: FindOpts): SysGen<EvalEnv | string> {
  const userNames = new Set<string>();
  collect(opts.expr, 'user', userNames);
  const users = new Map<string, number | undefined>();
  if (userNames.size > 0) {
    const db = yield* loadUsers(io.sys);
    const unknown = [...userNames].find((name) => findUid(db, name) === undefined);
    if (unknown !== undefined) return `'${unknown}' is not the name of a known user`;
    userNames.forEach((name) => users.set(name, findUid(db, name)));
  }
  const files = new Set<string>();
  collect(opts.expr, 'newer', files);
  const newer = new Map<string, number>();
  for (const file of files) {
    const st = yield* tryStat(io.sys, file, true);
    if (!st.ok) return `'${file}': ${describe(st.error)}`;
    newer.set(file, st.stat.mtime);
  }
  return { io, now: yield* io.wallClock(), users, newer };
}

export default defineCommand<FindOpts>({
  name: 'find',
  helpFlag: true,
  parse: parseFind,
  *run(io, opts) {
    if (opts.problem !== null) {
      yield* io.error(opts.problem);
      return 2;
    }
    const env = yield* prepare(io, opts);
    if (typeof env === 'string') {
      yield* io.error(env);
      return 1;
    }
    const tty = yield* io.isTty(1);
    let status = 0;
    for (const start of opts.paths) {
      const root = yield* tryStat(io.sys, start);
      if (!root.ok) {
        yield* io.error(`'${start}': ${describe(root.error)}`);
        status = 1;
        continue;
      }
      const candidates: Candidate[] = [{ path: start, stat: root.stat }];
      let denied = 0;
      if (root.stat.type === 'd' && opts.maxDepth !== 0) {
        const walk = yield* findAll(io.sys, {
          path: start,
          plus: true,
          ...(opts.maxDepth === null ? {} : { maxDepth: opts.maxDepth }),
        });
        denied = walk.denied;
        for (const hit of walk.hits) {
          const path = displayPath(hit.path, start, io.ctx.cwd);
          if (path === start) continue;
          const stat = hit.entry?.stat ?? (yield* tryStat(io.sys, path));
          if ('ok' in stat) {
            if (stat.ok) candidates.push({ path, stat: stat.stat });
          } else candidates.push({ path, stat });
        }
      }
      for (const c of candidates) {
        const depth = depthOf(c.path, start);
        if (depth < opts.minDepth || (opts.maxDepth !== null && depth > opts.maxDepth)) continue;
        const printed = { value: false };
        const ok = yield* evaluate(opts.expr, c, env, printed);
        if (opts.hasPrint ? printed.value : ok) yield* io.line(escapeName(c.path, tty));
      }
      if (denied > 0) {
        yield* io.error(
          `'${start}': Permission denied (${denied} ${denied === 1 ? 'directory' : 'directories'} skipped)`,
        );
        status = 1;
      }
    }
    return status;
  },
});
