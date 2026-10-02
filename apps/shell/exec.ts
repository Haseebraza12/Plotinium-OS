/**
 * The executor (shell-and-terminal.md §3.7; SHL-06, SHL-07; invariants I-SH1, I-SH3, I-SH4).
 *
 * Progress through a command line lives in `st.exec` (an `ExecCursor`): the list, the item and
 * the and-or step. A checkpoint can only land while the shell waits for a foreground job (a
 * restartable `wait`), so after a restore `runCursor` resumes that wait and carries on; a step
 * without `waiting` set has produced no effect yet and is simply run.
 */
import { ARGV_ENV_MAX_BYTES, ARGV_MAX, argvEnvBytes } from '@plotinium/protocol';

import type { SysGen } from '../src/_sys.ts';
import { errnoOf, errText } from '../src/_sys.ts';
import type { AndOr, Pipeline, SimpleCommand } from './ast.ts';
import { BUILTINS, isBuiltin, isConvenience } from './builtins/index.ts';
import { assign, unassign } from './env.ts';
import { expandTarget, expandValue, expandWords } from './expand.ts';
import { addJob, newJob } from './jobs.ts';
import { findInPath, forget, resolveProgram, shPath } from './lookup.ts';
import { incompleteMessage, parse } from './parser.ts';
import type { FdMap, XRedir } from './redir.ts';
import { applyInShell, closeAll, prepareFds, restoreInShell } from './redir.ts';
import type { ExecCursor, Sh } from './state.ts';
import { err, jobControl } from './state.ts';
import { allEnv, exportedEnv, getVar, setOwn } from './vars.ts';
import { COOKED, giveTty, setMode, waitForeground } from './wait.ts';

export interface XCommand {
  assigns: { name: string; value: string }[];
  argv: string[];
  redirs: XRedir[];
}

interface SpawnPlan {
  name: string;
  path: string;
  argv: string[];
  env: Record<string, string>;
  cached: boolean;
}

interface Failure {
  status: number;
  message: string;
}

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Single-quotes a word for a child `sh -c` unless it is plain. */
export function shellQuote(word: string): string {
  return SAFE_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

function* expandCommand(sh: Sh, cmd: SimpleCommand, source: string): SysGen<XCommand | Failure> {
  const assigns: XCommand['assigns'] = [];
  for (const a of cmd.assigns)
    assigns.push({ name: a.name, value: yield* expandValue(sh, a.value) });
  const argv = yield* expandWords(sh, cmd.words);
  const redirs: XRedir[] = [];
  for (const r of cmd.redirs) {
    const target = typeof r.target === 'number' ? r.target : yield* expandTarget(sh, r.target);
    if (target === null) {
      const word =
        typeof r.target === 'number' ? '' : source.slice(r.target.span.start, r.target.span.end);
      return { status: 1, message: `sh: ${word}: ambiguous redirect` };
    }
    redirs.push({ fd: r.fd, op: r.op, target });
  }
  return { assigns, argv, redirs };
}

function* expandAll(sh: Sh, pl: Pipeline, source: string): SysGen<XCommand[] | Failure> {
  const cmds: XCommand[] = [];
  for (const c of pl.cmds) {
    const x = yield* expandCommand(sh, c, source);
    if ('message' in x) return x;
    cmds.push(x);
  }
  return cmds;
}

/**
 * A command with no words: assignments are made left to right, each seeing the ones before it
 * (`A=1 B=$A`), and a redirection alone still opens its file (`> f` creates or truncates f).
 */
function* runAssignOnly(sh: Sh, cmd: SimpleCommand, source: string): SysGen<number> {
  const x = yield* expandCommand(sh, { ...cmd, assigns: [] }, source);
  if ('message' in x) {
    yield* err(sh, `${x.message}\n`);
    return x.status;
  }
  if (x.redirs.length > 0) {
    const prep = yield* prepareFds(sh, x.redirs, [0, 1, 2]);
    if (!prep.ok) {
      yield* err(sh, `${prep.message}\n`);
      return 1;
    }
    yield* closeAll(sh, prep.opened);
  }
  let status = 0;
  for (const a of cmd.assigns) {
    if (!assign(sh, a.name, yield* expandValue(sh, a.value))) {
      yield* err(sh, `sh: ${a.name}: readonly variable\n`);
      status = 1;
    }
  }
  return status;
}

/** Prefix assignments apply to a builtin for its duration only. */
function pushTemp(
  sh: Sh,
  assigns: XCommand['assigns'],
): { name: string; old: string | undefined; now: string }[] {
  return assigns.map((a) => {
    const old = getVar(sh.st.vars, a.name);
    assign(sh, a.name, a.value);
    return { name: a.name, old, now: a.value };
  });
}

function popTemp(sh: Sh, saved: ReturnType<typeof pushTemp>): void {
  [...saved].reverse().forEach((s) => {
    if (getVar(sh.st.vars, s.name) !== s.now) return;
    if (s.old === undefined) unassign(sh, s.name);
    else assign(sh, s.name, s.old);
  });
}

/** A builtin run inside the shell, with its redirections swapped in and out (§3.7.4). */
function* runBuiltin(sh: Sh, name: keyof typeof BUILTINS, c: XCommand): SysGen<number> {
  const applied = yield* applyInShell(sh, c.redirs);
  let status = 1;
  if (applied.message === null) {
    const temp = pushTemp(sh, c.assigns);
    try {
      status = yield* BUILTINS[name](sh, c.argv);
    } finally {
      popTemp(sh, temp);
    }
  }
  yield* restoreInShell(sh, applied.saved);
  if (applied.message !== null) yield* err(sh, `${applied.message}\n`);
  return status;
}

function envFor(sh: Sh, c: XCommand, all: boolean): Record<string, string> {
  const env = all ? allEnv(sh.st.vars) : exportedEnv(sh.st.vars);
  c.assigns.forEach((a) => setOwn(env, a.name, a.value));
  return env;
}

/** What to spawn for one command of a pipeline (§3.7.1 rule 1, §3.7.2). */
function* planFor(sh: Sh, c: XCommand): SysGen<SpawnPlan | Failure> {
  const name = c.argv[0];
  if (name === undefined) {
    return {
      name: 'sh',
      path: yield* shPath(sh),
      argv: ['sh', '-c', ''],
      env: envFor(sh, c, true),
      cached: false,
    };
  }
  if (isBuiltin(name)) {
    const program = isConvenience(name) ? yield* findInPath(sh, name) : null;
    if (program !== null)
      return { name, path: program, argv: c.argv, env: envFor(sh, c, false), cached: true };
    const text = c.argv.map(shellQuote).join(' ');
    return {
      name: 'sh',
      path: yield* shPath(sh),
      argv: ['sh', '-c', text],
      env: envFor(sh, c, true),
      cached: false,
    };
  }
  const t = yield* resolveProgram(sh, c.argv);
  if (t.kind === 'error') return t;
  return { name, path: t.path, argv: t.argv, env: envFor(sh, c, false), cached: t.cached };
}

function spawnFailure(name: string, e: unknown): Failure {
  const errno = errnoOf(e);
  if (errno === 'ENOENT') return { status: 127, message: `sh: ${name}: command not found` };
  return { status: 126, message: `sh: ${name}: ${errText(e)}` };
}

/** Spawns one process; a stale cache entry is dropped and looked up once more (§3.7.2). */
function* spawnOne(
  sh: Sh,
  plan: SpawnPlan,
  fds: FdMap,
  pgid: number | undefined,
): SysGen<{ pid: number } | Failure> {
  if (plan.argv.length > ARGV_MAX || argvEnvBytes(plan.argv, plan.env) > ARGV_ENV_MAX_BYTES) {
    return { status: 126, message: `sh: ${plan.name}: Argument list too long` };
  }
  const args = {
    path: plan.path,
    argv: plan.argv,
    env: plan.env,
    fds: { 0: fds[0], 1: fds[1], 2: fds[2] },
    ...(pgid === undefined ? {} : { pgid }),
  };
  try {
    return yield* sh.sys.call('spawn', args);
  } catch (e) {
    if (errnoOf(e) !== 'ENOENT' || !plan.cached) return spawnFailure(plan.name, e);
    forget(sh, plan.name);
  }
  const again = yield* resolveProgram(sh, plan.argv);
  if (again.kind === 'error') return again;
  try {
    return yield* sh.sys.call('spawn', { ...args, path: again.path });
  } catch (e) {
    return spawnFailure(plan.name, e);
  }
}

function* openPipes(sh: Sh, n: number): SysGen<{ r: number; w: number }[] | Failure> {
  const pipes: { r: number; w: number }[] = [];
  for (let i = 0; i < n; i++) {
    try {
      pipes.push(yield* sh.sys.call('pipe', {}));
    } catch (e) {
      yield* closeAll(
        sh,
        pipes.flatMap((p) => [p.r, p.w]),
      );
      return { status: 1, message: `sh: pipe: ${errText(e)}` };
    }
  }
  return pipes;
}

/**
 * Spawns a pipeline (§3.7.3): pipes first, then each command with its redirections applied on
 * top of the pipe ends, the first pid becoming the group; then the shell closes its pipe ends.
 */
function* spawnPipeline(
  sh: Sh,
  cmds: readonly XCommand[],
  text: string,
  background: boolean,
): SysGen<number> {
  const st = sh.st;
  const jc = jobControl(st);
  const pipes = yield* openPipes(sh, cmds.length - 1);
  if ('message' in pipes) {
    yield* err(sh, `${pipes.message}\n`);
    return pipes.status;
  }
  const job = newJob(0, [], text);
  // The job's terminal mode is set before anything runs, and the terminal is handed over right
  // after the first spawn, so the job never races the shell for either.
  // TODO(R1): use the requested `spawn({fg: true})` (§3.7.3 step 3) to close the remaining window
  // between the first spawn and `tcsetpgrp` when it lands in the protocol.
  const foreground = jc && !background;
  if (foreground) yield* setMode(sh, COOKED);
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i] ?? { assigns: [], argv: [], redirs: [] };
    const last = i === cmds.length - 1;
    const base: FdMap = [pipes[i - 1]?.r ?? 0, last ? 1 : (pipes[i]?.w ?? 1), 2];
    const prep = yield* prepareFds(sh, c.redirs, base);
    let result: { pid: number } | Failure;
    if (!prep.ok) {
      result = { status: 1, message: prep.message };
    } else {
      const plan = yield* planFor(sh, c);
      result =
        'message' in plan ? plan : yield* spawnOne(sh, plan, prep.fds, jc ? job.pgid : undefined);
      yield* closeAll(sh, prep.opened);
    }
    if ('message' in result) {
      yield* err(sh, `${result.message}\n`);
      if (last) job.fixed = result.status;
    } else {
      job.pids.push(result.pid);
      if (job.pgid === 0) {
        job.pgid = jc ? result.pid : st.pgid;
        if (foreground) yield* giveTty(sh, job.pgid);
      }
    }
  }
  yield* closeAll(
    sh,
    pipes.flatMap((p) => [p.r, p.w]),
  );
  if (job.pids.length === 0) return job.fixed ?? 1;
  if (background) {
    addJob(st.jobs, job);
    st.lastBg = job.pids.at(-1) ?? null;
    if (st.mode === 'interactive') yield* err(sh, `[${job.id}] ${st.lastBg ?? ''}\n`);
    return 0;
  }
  st.fg = job;
  return yield* waitForeground(sh);
}

/** Runs one pipeline in the foreground; the caller applies `!`. */
function* runPipeline(sh: Sh, pl: Pipeline, source: string): SysGen<number> {
  const first = pl.cmds[0];
  if (pl.cmds.length === 1 && first !== undefined && first.words.length === 0) {
    return yield* runAssignOnly(sh, first, source);
  }
  const cmds = yield* expandAll(sh, pl, source);
  if ('message' in cmds) {
    yield* err(sh, `${cmds.message}\n`);
    return cmds.status;
  }
  const only = cmds.length === 1 ? cmds[0] : undefined;
  const name = only?.argv[0];
  if (only !== undefined && name !== undefined && isBuiltin(name)) {
    return yield* runBuiltin(sh, name, only);
  }
  return yield* spawnPipeline(sh, cmds, source.slice(pl.span.start, pl.span.end), false);
}

/**
 * `item &` (§3.7.1 rule 2): a single pipeline of programs is spawned directly in a new group;
 * anything else runs in a child `sh -c '<source text>'`.
 */
function* runBackground(sh: Sh, node: AndOr, source: string): SysGen<void> {
  const st = sh.st;
  const text = source.slice(node.span.start, node.span.end);
  if (node.rest.length === 0 && !node.first.negate) {
    const cmds = yield* expandAll(sh, node.first, source);
    if ('message' in cmds) {
      yield* err(sh, `${cmds.message}\n`);
      st.status = cmds.status;
      return;
    }
    if (cmds.every((c) => c.argv[0] !== undefined && !isBuiltin(c.argv[0]))) {
      st.status = yield* spawnPipeline(sh, cmds, text, true);
      return;
    }
  }
  const plan: SpawnPlan = {
    name: 'sh',
    path: yield* shPath(sh),
    argv: ['sh', '-c', text],
    env: allEnv(st.vars),
    cached: false,
  };
  const jc = jobControl(st);
  const r = yield* spawnOne(sh, plan, [0, 1, 2], jc ? 0 : undefined);
  if ('message' in r) {
    yield* err(sh, `${r.message}\n`);
    st.status = r.status;
    return;
  }
  const job = addJob(st.jobs, newJob(jc ? r.pid : st.pgid, [r.pid], text));
  st.lastBg = r.pid;
  if (st.mode === 'interactive') yield* err(sh, `[${job.id}] ${r.pid}\n`);
  st.status = 0;
}

function* runAndOr(sh: Sh, cur: ExecCursor, node: AndOr): SysGen<void> {
  const st = sh.st;
  for (;;) {
    const link = cur.step === 0 ? undefined : node.rest[cur.step - 1];
    const pl = cur.step === 0 ? node.first : link?.right;
    if (pl === undefined || st.exitCode !== null) return;
    if (!cur.waiting && link !== undefined && (link.op === '&&') !== (st.status === 0)) {
      cur.step++;
      continue;
    }
    const status = cur.waiting ? yield* waitForeground(sh) : yield* runPipeline(sh, pl, cur.source);
    st.status = pl.negate ? Number(status === 0) : status;
    cur.step++;
    if (st.sig.intr && jobControl(st)) return;
  }
}

/** Runs (or resumes) `st.exec` to the end of its list. */
export function* runCursor(sh: Sh): SysGen<void> {
  const st = sh.st;
  const cur = st.exec;
  if (cur === null) return;
  while (cur.item < cur.list.items.length) {
    const item = cur.list.items[cur.item];
    if (item === undefined || st.exitCode !== null) break;
    if (item.background) yield* runBackground(sh, item.node, cur.source);
    else yield* runAndOr(sh, cur, item.node);
    // Ctrl-C of a foreground job abandons the rest of an interactive line, as in other shells.
    if (st.sig.intr && jobControl(st)) break;
    cur.item++;
    cur.step = 0;
  }
}

/**
 * Parses a whole text (a line, `-c` text or a script) into `st.exec`. A syntax error runs nothing,
 * prints the message and sets `$?` to 2 (I-SH1); the result is false then.
 */
export function* prepareSource(sh: Sh, source: string, histLine: string | null): SysGen<boolean> {
  const st = sh.st;
  const parsed = parse(source);
  if (!parsed.ok) {
    const message = parsed.kind === 'error' ? parsed.message : incompleteMessage(parsed.unclosed);
    yield* err(sh, `${message}\n`);
    st.status = 2;
    return false;
  }
  st.exec = { source, list: parsed.list, item: 0, step: 0, waiting: false, histLine };
  return true;
}

/** Parses and runs a whole text to the end. */
export function* runSource(sh: Sh, source: string): SysGen<void> {
  if (yield* prepareSource(sh, source, null)) yield* runCursor(sh);
  sh.st.exec = null;
}
