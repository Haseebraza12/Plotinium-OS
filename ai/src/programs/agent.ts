/**
 * `ai.agent`: the agentic-shell process (agentic-shell.md §3.3, §3.8, §3.9; AGT-01..AGT-09;
 * AIN-B1..B4).
 *
 * Spawned by the `ai` front end of coreutils (`ai [-n] [--json] "INSTRUCTION"`, `ai undo TXN`) as
 * an AGENT-class process: its bounding set is `fs.read fs.scope ai.plan mem`, so it can change the
 * file system ONLY through `batch` with a kernel-issued plan token (INV-ABI-6). It never runs as
 * root: the kernel refuses `ai.agent.plan` for uid 0 or ruid 0 (AGT-04).
 *
 * - SEES through the kernel: the envelope (`time.now`, `readdir {plus}` of the cwd) and every
 *   read-only observation the model asks for, each executed as EXACTLY ONE syscall with this
 *   process's own credentials (AIN-B1). The results go back to the kernel, which datamarks them.
 * - DECIDES nothing itself: the kernel's `ai.agent.plan` asks the gateway (`/api/llm/plan` through
 *   the host fetch) and hands back the model's single tool call as DATA, re-parsed with the
 *   original schema (AGT-01); `ai.agent.submit` validates and dry-runs (AGT-02); the kernel's
 *   confirmation predicate decides whether the user must confirm, and `ai.agent.confirm` asks on
 *   the kernel-owned TTY, default N (AGT-03, AGT-05).
 * - ACTS through one typed syscall: `batch` with the token, the dry run's ops byte-for-byte and its
 *   expected versions. A kill before `batch` leaves the file system untouched (AGT-09).
 *
 * Exit statuses (§3.3): 0 done, 1 declined, 2 failed / cannot comply, 3 needs clarification,
 * 4 unavailable.
 */
import type {
  BatchOp,
  DirEntry,
  Errno,
  Observation,
  PlanStep,
  PlanTurn,
  SubmitResult,
} from '@plotinium/protocol';
import { AGENT_TURNS_MAX, ENVELOPE_LISTING_MAX, uuidv7 } from '@plotinium/protocol';

import { modeDisplay } from '../agent/validator.ts';
import {
  type AiProgram,
  type AiProgramContext,
  type SysGen,
  attempt,
  errnoOf,
  readLine,
  reasonOf,
  writeText,
} from './model.ts';

export const EXIT = { ok: 0, declined: 1, failed: 2, clarify: 3, unavailable: 4 } as const;

/** Pages of `readdir` counted for `listingTotal` beyond the first (a huge cwd is not walked). */
const LISTING_COUNT_PAGES = 20;

export interface AgentState {
  mode: 'run' | 'undo' | 'usage';
  instruction: string;
  dryRun: boolean;
  json: boolean;
  txn: string;
  requestId: string;
  turn: number;
}

/** argv as the coreutils front end passes it: `ai [--dry-run] [--json] INSTRUCTION` | `ai undo TXN`. */
export function initAgent(argv: readonly string[]): AgentState {
  const st: AgentState = {
    mode: 'usage',
    instruction: '',
    dryRun: false,
    json: false,
    txn: '',
    requestId: '',
    turn: 0,
  };
  const args = argv.slice(1);
  if (args[0] === 'undo' && args.length === 2) {
    st.mode = 'undo';
    st.txn = args[1] ?? '';
    return st;
  }
  const words: string[] = [];
  let options = true;
  for (const a of args) {
    if (options && a === '--') options = false;
    else if (options && (a === '--dry-run' || a === '-n')) st.dryRun = true;
    else if (options && a === '--json') st.json = true;
    else words.push(a);
  }
  if (words.length === 1 && (words[0] ?? '').trim() !== '') {
    st.mode = 'run';
    st.instruction = (words[0] ?? '').slice(0, 2000);
  }
  return st;
}

/** `2026-09-26T17:05:09+05:00` from the kernel clock (the envelope's `now`). */
export function isoWithOffset(epochMs: number, tzOffsetMin: number): string {
  const local = new Date(Math.floor(epochMs) + tzOffsetMin * 60_000);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const sign = tzOffsetMin < 0 ? '-' : '+';
  const off = Math.abs(tzOffsetMin);
  return (
    `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`
  );
}

/** A syscall named at run time (a read-only tool the kernel asked for): the raw request. */
function* rawCall(call: string, args: unknown): SysGen<unknown> {
  return yield { call, args };
}

/** One line of the plan as the user reads it (the kernel prints the same rows on confirmation). */
export function opLine(op: BatchOp): string {
  switch (op.op) {
    case 'mkdir':
      return `mkdir   ${op.path}`;
    case 'write':
      return `write   ${op.path}`;
    case 'rename':
      return `mv      ${op.from} → ${op.to}`;
    case 'copy':
      return `cp      ${op.from} → ${op.to}`;
    case 'unlink':
      return `rm      ${op.path}`;
    case 'symlink':
      return `ln -s   ${op.target} ${op.path}`;
    case 'chmod':
      return `chmod   ${modeDisplay(op.mode)} ${op.path}`;
    case 'chown':
      return `chown   ${op.path}`;
    case 'utimes':
      return `touch   ${op.path}`;
  }
}

/** The dry run as text (Figure 12.2 layout). */
export function dryRunText(sr: SubmitResult): string {
  const d = sr.dryRun;
  const lines = [
    `Plan · ${String(d.ops.length)} op${d.ops.length === 1 ? '' : 's'} · 1 transaction`,
  ];
  d.ops.forEach((op, i) => {
    lines.push(`${String(i + 1).padStart(3)}  ${opLine(op)}`);
  });
  for (const t of d.resolvedTimes ?? []) lines.push(`     ${t.from} → ${t.to}`);
  lines.push(
    `Blast radius: ${String(d.inodes)} inodes · ${String(d.deletions)} deletions (recoverable) · ` +
      `${String(d.overwrites)} overwrites · ${d.quotaOk ? 'within quota' : 'OVER QUOTA'}`,
  );
  if (sr.confirm.required) lines.push(`Confirmation required: ${sr.confirm.reasons.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

/** The exit status and message of a failed agent syscall (§3.3, §3.20). */
export function failureOf(e: unknown): { exit: number; message: string } {
  const errno: Errno | undefined = errnoOf(e);
  const reason = reasonOf(e);
  const why = reason === undefined ? '' : ` (${reason})`;
  const text = e instanceof Error && e.message !== '' ? e.message : (errno ?? 'error');
  if (errno === 'EAIUNAVAIL')
    return { exit: EXIT.unavailable, message: `ai: agent unavailable${why} — nothing was run` };
  if (errno === 'ENOSYS')
    return {
      exit: EXIT.unavailable,
      message: 'ai: agent unavailable (not in this build) — nothing was run',
    };
  if (errno === 'ECANCELED')
    return { exit: EXIT.declined, message: 'ai: declined — nothing was run' };
  if (errno === 'ETIMEDOUT')
    return {
      exit: EXIT.failed,
      message: 'ai: could not produce a plan within the limits — nothing was run',
    };
  if (errno === 'EAIREFUSED')
    return { exit: EXIT.failed, message: `ai: the model refused${why} — nothing was run` };
  return { exit: EXIT.failed, message: `ai: ${errno ?? 'error'}${why}: ${text}` };
}

/** The cwd listing for the envelope: the first 150 entries plus the real total. */
function* envelopeListing(ctx: AiProgramContext): SysGen<{ entries: DirEntry[]; total: number }> {
  const first = yield* attempt(ctx.sys, 'readdir', {
    path: ctx.cwd,
    plus: true,
    limit: ENVELOPE_LISTING_MAX,
  });
  if (!first.ok) return { entries: [], total: 0 };
  let total = first.value.entries.length;
  let cursor = first.value.next;
  for (let page = 0; cursor !== undefined && page < LISTING_COUNT_PAGES; page++) {
    const more = yield* attempt(ctx.sys, 'readdir', { path: ctx.cwd, cursor, limit: 1_000 });
    if (!more.ok) break;
    total += more.value.entries.length;
    cursor = more.value.next;
  }
  return { entries: first.value.entries, total };
}

/** Execute the read-only calls of one `tools` turn, each as exactly ONE syscall (AIN-B1). */
function* observe(
  ctx: AiProgramContext,
  calls: Extract<PlanTurn, { kind: 'tools' }>['calls'],
): SysGen<Observation[]> {
  const out: Observation[] = [];
  for (const c of calls) {
    try {
      const value = yield* rawCall(c.call, c.args);
      out.push({ callId: c.callId, call: c.call, ok: true, value });
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === undefined) throw e;
      out.push({ callId: c.callId, call: c.call, ok: false, errno });
    }
    yield ctx.tick;
  }
  return out;
}

/** Ask the user on the terminal; undefined when there is no TTY or at end of input. */
function* clarify(
  ctx: AiProgramContext,
  q: Extract<PlanTurn, { kind: 'clarify' }>,
): SysGen<string | undefined> {
  if (ctx.tty === null) return undefined;
  const options =
    q.options.length === 0
      ? ''
      : `\n${q.options.map((o, i) => `  ${String(i + 1)}) ${o}`).join('\n')}`;
  yield* writeText(ctx.sys, 1, `ai: ${q.question}${options}\n> `);
  const line = yield* readLine(ctx.sys, 0, 500);
  if (line === undefined) return undefined;
  const trimmed = line.trim();
  const pick = /^\d+$/.test(trimmed) ? q.options[Number(trimmed) - 1] : undefined;
  const answer = pick ?? trimmed;
  return answer === '' ? undefined : answer.slice(0, 500);
}

/** Plan → (observe | clarify)* → steps, or an exit status. */
function* planLoop(ctx: AiProgramContext, st: AgentState): SysGen<PlanStep[] | number> {
  const clock = yield* ctx.sys.call('time.now', {});
  const listing = yield* envelopeListing(ctx);
  st.requestId = uuidv7();
  st.turn = 1;
  let res: PlanTurn = yield* ctx.sys.call('ai.agent.plan', {
    requestId: st.requestId,
    turn: 1,
    request: st.instruction,
    envelope: {
      cwd: ctx.cwd,
      now: isoWithOffset(clock.epochMs, clock.tzOffsetMin),
      tz: clock.tz,
      listing: listing.entries,
      listingTotal: listing.total,
    },
  });
  for (let guard = 0; guard <= AGENT_TURNS_MAX; guard++) {
    switch (res.kind) {
      case 'plan':
        return res.steps;
      case 'cannot':
        yield* writeText(ctx.sys, 2, `ai: cannot comply: ${res.reason}\n`);
        return EXIT.failed;
      case 'clarify': {
        const answer = yield* clarify(ctx, res);
        if (answer === undefined) {
          yield* writeText(ctx.sys, 2, `ai: needs clarification: ${res.question}\n`);
          return EXIT.clarify;
        }
        st.turn++;
        res = yield* ctx.sys.call('ai.agent.plan', {
          requestId: st.requestId,
          turn: st.turn,
          clarification: answer,
        });
        break;
      }
      case 'tools': {
        const observations = yield* observe(ctx, res.calls);
        st.turn++;
        res = yield* ctx.sys.call('ai.agent.plan', {
          requestId: st.requestId,
          turn: st.turn,
          observations,
        });
        break;
      }
    }
    yield ctx.tick;
  }
  yield* writeText(
    ctx.sys,
    2,
    'ai: could not produce a plan within the limits — nothing was run\n',
  );
  return EXIT.failed;
}

/** Confirm (when the kernel says so) and run the batch; returns the exit status. */
function* execute(ctx: AiProgramContext, st: AgentState, sr: SubmitResult): SysGen<number> {
  let token = sr.token;
  if (sr.confirm.required || token === undefined) {
    // The KERNEL prints the dry run on the controlling TTY and reads y/N itself (AGT-05).
    const granted = yield* attempt(ctx.sys, 'ai.agent.confirm', { planId: sr.planId });
    if (!granted.ok) {
      const declined = granted.errno === 'ECANCELED' || granted.errno === 'ETIMEDOUT';
      yield* writeText(
        ctx.sys,
        2,
        granted.errno === 'ENOTTY'
          ? 'ai: confirmation needs the terminal — nothing was run\n'
          : declined
            ? 'ai: declined — nothing was run\n'
            : `ai: ${granted.errno} — nothing was run\n`,
      );
      return declined || granted.errno === 'ENOTTY' ? EXIT.declined : EXIT.failed;
    }
    if (!granted.value.granted) {
      yield* writeText(ctx.sys, 2, 'ai: declined — nothing was run\n');
      return EXIT.declined;
    }
    token = granted.value.token;
  }
  const done = yield* ctx.sys.call('batch', {
    txnId: uuidv7(),
    ops: sr.dryRun.ops,
    expectedVersions: sr.expectedVersions,
    token,
    planId: sr.planId,
  });
  if (st.json) yield* writeText(ctx.sys, 1, `${JSON.stringify({ planId: sr.planId, ...done })}\n`);
  else
    yield* writeText(
      ctx.sys,
      1,
      `done: ${String(done.applied)} op${done.applied === 1 ? '' : 's'} · ${String(done.inodes)} inodes · undo ${done.undoId}\n`,
    );
  return EXIT.ok;
}

export function* runAgent(ctx: AiProgramContext, st: AgentState): SysGen<number> {
  if (st.mode === 'usage') {
    yield* writeText(
      ctx.sys,
      2,
      'usage: ai [-n | --dry-run] [--json] "INSTRUCTION" | ai undo TXN\n',
    );
    return EXIT.failed;
  }
  try {
    const cred = yield* ctx.sys.call('proc.cred', {});
    if (cred.ruid === 0) {
      yield* writeText(ctx.sys, 2, 'ai: the agent never runs as root; log in as a regular user\n');
      return EXIT.failed;
    }
    let sr: SubmitResult;
    if (st.mode === 'undo') {
      sr = yield* ctx.sys.call('ai.undo', { txnId: st.txn });
    } else {
      const steps = yield* planLoop(ctx, st);
      if (typeof steps === 'number') return steps;
      sr = yield* ctx.sys.call('ai.agent.submit', { requestId: st.requestId, steps });
    }
    if (st.dryRun) {
      yield* writeText(ctx.sys, 1, st.json ? `${JSON.stringify(sr)}\n` : dryRunText(sr));
      return EXIT.ok;
    }
    if (!sr.confirm.required && !st.json) yield* writeText(ctx.sys, 1, dryRunText(sr));
    return yield* execute(ctx, st, sr);
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
    const f = failureOf(e);
    yield* writeText(ctx.sys, 2, `${f.message}\n`);
    return f.exit;
  }
}

const program: AiProgram<AgentState> = {
  checkpointable: false,
  init: initAgent,
  run: runAgent,
};

export default program;
