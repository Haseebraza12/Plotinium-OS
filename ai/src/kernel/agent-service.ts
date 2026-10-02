/**
 * Subsystem B in the kernel: `ai.agent.plan`, `ai.agent.submit`, `ai.agent.confirm`,
 * `ai.agent.log` and the plan-token check of `batch` (agentic-shell.md §3.2–§3.17;
 * AGT-01..AGT-09; AIN-B1..B4).
 *
 * The `ai.agent` PROCESS (programs/agent.ts) drives the pipeline through these syscalls and runs
 * every read-only observation itself, as exactly one syscall with its own credentials (AIN-B1).
 * This module is the deterministic kernel half (Figure 12.2 steps 3–7):
 *
 *   plan     renders the datamarked envelope (turn 1) or the datamarked observation results,
 *            asks the gateway for ONE tool call, re-parses it with the tool's original Valibot
 *            schema and returns it as data (never evaluated, AGT-01, I-B1); ≤ 6 turns, 120 s;
 *   submit   validation checks 1–9 on an overlay of the live tree and the dry run (AGT-02),
 *            then the ONLY confirmation predicate (I-B4); a token is issued at once only when no
 *            confirmation is needed;
 *   confirm  the kernel-owned TTY prompt (type-ahead flushed, default N, 120 s, ENOTTY without a
 *            controlling TTY); the HMAC token after `y` (AGT-03);
 *   batch    `verifyPlanToken` (sync, for the kernel's fs `batch` gate): the exact token issued
 *            for this plan, the same pid, not expired, single use, and ops byte-equal to the
 *            dry run (AGT-03 defence in depth; nothing else can run an agent plan);
 *   log      every request's plan record with prompt, plan hash, dry-run hash, confirmation and
 *            outcome (AGT-08), own records only (all for uid 0).
 * `onProcessExit(pid)` aborts an in-flight gateway call and audits `killed_before_execute`
 * (AGT-09).
 */
import type {
  AuditRecord,
  BatchOp,
  ErrDetail,
  Errno,
  PlanTurn,
  PlanTurnArgs,
  ReadOnlyTool,
  SubmitResult,
} from '@plotinium/protocol';
import { AGENT_TURNS_MAX, PLAN_TOKEN_TTL_MS, uuidv7 } from '@plotinium/protocol';

import type { AgentOutcome } from '../agent/audit.ts';
import { planRecord } from '../agent/audit.ts';
import type { QuotaOracle, LeaseOracle } from '../agent/apply.ts';
import { type ConfirmTty, confirmOnTty } from '../agent/confirm.ts';
import { decodeToolUse } from '../agent/decode.ts';
import {
  type KernelContext,
  type ListingEntry,
  renderClarification,
  renderFirstTurn,
} from '../agent/envelope.ts';
import type { FsSnapshot } from '../agent/fsview.ts';
import { type ModelClient, Transcript, type TurnBudget, nextToolCall } from '../agent/model.ts';
import { observedPaths, renderObservation } from '../agent/observe.ts';
import { ROOT_REFUSAL } from '../agent/root-drop.ts';
import { type Submitted, submitPlan, tokenAfterConfirm } from '../agent/submit.ts';
import { GrantTable, generateTokenKey } from '../agent/token.ts';
import { modeDisplay, type DryRun } from '../agent/validator.ts';
import { canonicalJson } from '../util/canonical.ts';
import type { Cred, PermOracle } from '../util/cred.ts';
import { type RandomSource, cryptoRandom } from '../util/rng.ts';
import { GatewayError, GatewayModelClient } from './gateway.ts';
import type { AiCaller, HostFetch, MakeError } from './types.ts';

export const SESSION_TTL_MS = 10 * 60_000;
export const AUDIT_KEEP = 1_000;
const DEFAULT_UMASK = 0o022;

/** What `ai.agent.submit` needs from the kernel's file system. */
export interface AgentFsDeps {
  /** A read snapshot of the live tree (the overlay's base). */
  snapshot(): FsSnapshot;
  readonly oracle: PermOracle;
  readonly quota: QuotaOracle;
  readonly leases?: LeaseOracle;
  home(uid: number): string;
  /** Load the directories a plan may touch before validating (the tree is lazily loaded). */
  prepare?(cred: Cred, paths: readonly string[]): Promise<void>;
}

export interface AgentServiceDeps {
  readonly makeError: MakeError;
  /** Same-origin fetch with the session cookie; absent → the agent is unavailable (offline). */
  readonly fetch?: HostFetch;
  /** Test and cassette override of the gateway client. */
  model?(requestId: string): ModelClient;
  now(): number;
  epochMs(): number;
  /** The user's IANA time zone. */
  timeZone(): string;
  userName(uid: number): string;
  groupNames(gids: readonly number[]): string[];
  osSessionId(): string;
  readonly rng?: RandomSource;
  readonly fs?: AgentFsDeps;
  /** The kernel-owned TTY of the caller's session (undefined: no controlling TTY → ENOTTY). */
  tty?(caller: AiCaller): ConfirmTty | undefined;
  /** Durable audit sink (the IndexedDB `audit` store and outbox); records are also kept here. */
  audit?(record: AuditRecord): void;
  /** AIN-B4: files touched by a committed plan jump the indexer queue. */
  touched?(paths: readonly string[]): void;
}

interface Session {
  requestId: string;
  pid: number;
  uid: number;
  ruid: number;
  cred: Cred;
  request: string;
  cwd: string;
  home: string;
  tz: string;
  transcript: Transcript;
  budget: TurnBudget;
  rng: RandomSource;
  model: ModelClient;
  clarifications: string[];
  observations: Array<{
    turn: number;
    call: ReadOnlyTool;
    args: unknown;
    ok: boolean;
    errno?: Errno;
  }>;
  observed: Set<string>;
  pendingTools: Map<string, { call: ReadOnlyTool; args: unknown }>;
  pendingClarify: string | null;
  suspicious: boolean;
  startedAt: number;
  touchedAt: number;
  abort: AbortController;
  planHash?: string;
  dryRunHash?: string;
}

interface IssuedToken {
  token: string;
  pid: number;
  exp: number;
  ops: string;
}

interface StoredPlan {
  submitted: Submitted;
  session: Session;
  rendered: string;
}

function toListing(
  entries: ReadonlyArray<{
    name: string;
    type: 'f' | 'd' | 'l';
    stat?: { size: number; mtime: number } | undefined;
  }>,
): ListingEntry[] {
  return entries.map((e) => ({
    name: e.name,
    type: e.type,
    size: e.stat?.size ?? 0,
    mtime: e.stat?.mtime ?? 0,
  }));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Lexically absolute: `~` → home, relative → under cwd, `.`/`..` folded (no symlinks followed). */
export function absolutePath(path: string, home: string, cwd: string): string {
  const joined =
    path === '~'
      ? home
      : path.startsWith('~/')
        ? `${home}${path.slice(1)}`
        : path.startsWith('/')
          ? path
          : `${cwd}/${path}`;
  const parts: string[] = [];
  for (const p of joined.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return `/${parts.join('/')}`;
}

/**
 * The read-only call the agent process runs: every `path` / `paths` argument made absolute, so the
 * syscall resolves exactly what the model named (the VFS has no `~`) and the observed paths that
 * ground the plan (§3.10) are the same absolute strings the validator compares.
 */
export function expandToolArgs(args: unknown, home: string, cwd: string): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (typeof out['path'] === 'string') out['path'] = absolutePath(out['path'], home, cwd);
  if (Array.isArray(out['paths']))
    out['paths'] = out['paths'].map((p: unknown) =>
      typeof p === 'string' ? absolutePath(p, home, cwd) : p,
    );
  return out;
}

/** The Figure 12.2 rendering of a dry run, written to the TTY by the KERNEL (§3.3). */
export function renderDryRun(dr: DryRun, reasons: readonly string[]): string {
  const lines = [
    `Plan · ${String(dr.batch.length)} op${dr.batch.length === 1 ? '' : 's'} · 1 transaction`,
  ];
  dr.batch.forEach((op, i) => {
    const n = String(i + 1).padStart(3);
    switch (op.op) {
      case 'mkdir':
        lines.push(`${n}  mkdir   ${op.path}`);
        break;
      case 'write':
        lines.push(`${n}  write   ${op.path}`);
        break;
      case 'rename':
        lines.push(`${n}  mv      ${op.from} → ${op.to}`);
        break;
      case 'copy':
        lines.push(`${n}  cp      ${op.from} → ${op.to}`);
        break;
      case 'unlink':
        lines.push(`${n}  rm      ${op.path}`);
        break;
      case 'symlink':
        lines.push(`${n}  ln -s   ${op.target} ${op.path}`);
        break;
      case 'chmod':
        lines.push(`${n}  chmod   ${modeDisplay(op.mode)} ${op.path}`);
        break;
      case 'chown':
        lines.push(`${n}  chown   ${op.path}`);
        break;
      case 'utimes':
        lines.push(`${n}  touch   ${op.path}`);
        break;
    }
  });
  for (const iv of dr.intervals) lines.push(`     ${iv.step}: ${iv.from} → ${iv.to} (${iv.tz})`);
  lines.push(
    `Blast radius: ${String(dr.affectedInodes)} inodes · ${String(dr.counts.delete)} deletions (recoverable) · ${String(dr.counts.overwrite)} overwrites · ${dr.quotaOk ? 'within quota' : 'OVER QUOTA'}`,
  );
  if (reasons.length > 0) lines.push(`Confirmation required: ${reasons.join(', ')}`);
  return lines.join('\n');
}

export class AgentService {
  private readonly deps: AgentServiceDeps;
  private readonly sessions = new Map<string, Session>();
  private readonly plans = new Map<string, StoredPlan>();
  private readonly tokens = new Map<string, IssuedToken>();
  private readonly records: AuditRecord[] = [];
  private grantsPromise: Promise<GrantTable> | null = null;

  constructor(deps: AgentServiceDeps) {
    this.deps = deps;
  }

  private grants(): Promise<GrantTable> {
    this.grantsPromise ??= generateTokenKey().then((key) => new GrantTable(key));
    return this.grantsPromise;
  }

  private err(errno: Errno, reason?: string, message?: string, step?: string): Error {
    const detail: ErrDetail = {};
    if (reason !== undefined && /^[a-z][a-z0-9-]{0,39}$/.test(reason)) detail.reason = reason;
    if (step !== undefined && /^s\d+$/.test(step)) detail.step = Number(step.slice(1));
    return this.deps.makeError(errno, Object.keys(detail).length > 0 ? detail : undefined, message);
  }

  private sweep(): void {
    const now = this.deps.now();
    for (const [id, s] of this.sessions)
      if (now - s.touchedAt > SESSION_TTL_MS) this.sessions.delete(id);
    for (const [id, t] of this.tokens) if (this.deps.epochMs() > t.exp) this.tokens.delete(id);
  }

  private audit(
    s: Session,
    call: 'ai.agent.plan' | 'ai.agent.submit' | 'ai.agent.confirm' | 'batch',
    outcome: AgentOutcome,
    extra: {
      errno?: Errno;
      args?: unknown;
      confirmation?: AuditRecord['confirmation'];
      inodes?: number;
      txnId?: string;
    } = {},
  ): void {
    const rec = planRecord({
      auditId: uuidv7(),
      t: Math.floor(this.deps.epochMs()),
      osSessionId: this.deps.osSessionId(),
      pid: s.pid,
      uid: s.uid,
      ...(s.ruid !== s.uid ? { ruid: s.ruid } : {}),
      requestId: s.requestId,
      request: s.request,
      call,
      args: extra.args ?? { requestId: s.requestId },
      outcome,
      durationUs: Math.max(0, (this.deps.now() - s.startedAt) * 1_000),
      observations: s.observations,
      ...(extra.errno === undefined ? {} : { errno: extra.errno }),
      ...(s.planHash === undefined ? {} : { planHash: s.planHash }),
      ...(s.dryRunHash === undefined ? {} : { dryRunHash: s.dryRunHash }),
      ...(extra.confirmation === undefined ? {} : { confirmation: extra.confirmation }),
      ...(extra.inodes === undefined ? {} : { inodes: extra.inodes }),
      ...(extra.txnId === undefined ? {} : { txnId: extra.txnId }),
    });
    this.records.push(rec);
    if (this.records.length > AUDIT_KEEP) this.records.shift();
    this.deps.audit?.(rec);
  }

  private session(caller: AiCaller, requestId: string): Session {
    const s = this.sessions.get(requestId);
    if (s === undefined || s.pid !== caller.pcb.pid) throw this.err('EINVAL', 'unknown-plan');
    s.touchedAt = this.deps.now();
    return s;
  }

  private newSession(caller: AiCaller, args: Extract<PlanTurnArgs, { request: string }>): Session {
    const { pcb } = caller;
    if (pcb.cred.ruid === 0 || pcb.cred.uid === 0)
      throw this.err('EPERM', 'root-only', ROOT_REFUSAL);
    const cred: Cred = { uid: pcb.cred.uid, gid: pcb.cred.gid, groups: [...pcb.cred.groups] };
    const home = this.deps.fs?.home(cred.uid) ?? `/home/${this.deps.userName(cred.uid)}`;
    const model =
      this.deps.model?.(args.requestId) ??
      (this.deps.fetch === undefined
        ? undefined
        : new GatewayModelClient(this.deps.fetch, args.requestId, {
            osSessionId: this.deps.osSessionId(),
          }));
    if (model === undefined)
      throw this.err('EAIUNAVAIL', 'offline', 'ai: agent unavailable (offline) — nothing was run');
    const now = this.deps.now();
    const s: Session = {
      requestId: args.requestId,
      pid: pcb.pid,
      uid: cred.uid,
      ruid: pcb.cred.ruid,
      cred,
      request: args.request,
      cwd: args.envelope.cwd,
      home,
      tz: args.envelope.tz,
      transcript: new Transcript(),
      budget: { left: AGENT_TURNS_MAX },
      rng: this.deps.rng ?? cryptoRandom,
      model,
      clarifications: [],
      observations: [],
      observed: new Set(),
      pendingTools: new Map(),
      pendingClarify: null,
      suspicious: false,
      startedAt: now,
      touchedAt: now,
      abort: new AbortController(),
    };
    const context: KernelContext = {
      uid: cred.uid,
      user: this.deps.userName(cred.uid),
      groups: this.deps.groupNames(cred.groups),
      cwd: args.envelope.cwd,
      home,
      now: args.envelope.now,
      tz: args.envelope.tz,
      scope: [...new Set([args.envelope.cwd, home])],
    };
    const first = renderFirstTurn({
      request: args.request,
      context,
      listing: toListing(args.envelope.listing),
      listingTotal: args.envelope.listingTotal,
      rng: s.rng,
    });
    s.transcript.append({ role: 'user', text: first.text });
    this.sessions.set(args.requestId, s);
    return s;
  }

  /** `ai.agent.plan` (BLOCKING on `net:llm`). */
  async plan(caller: AiCaller, args: PlanTurnArgs): Promise<PlanTurn> {
    this.sweep();
    let s: Session;
    if ('request' in args) {
      if (this.sessions.has(args.requestId)) throw this.err('EINVAL', 'duplicate-request');
      s = this.newSession(caller, args);
    } else {
      s = this.session(caller, args.requestId);
      if ('observations' in args) {
        for (const o of args.observations) {
          const pending = s.pendingTools.get(o.callId);
          if (pending === undefined || pending.call !== o.call)
            throw this.err('EINVAL', 'unknown-call');
          s.pendingTools.delete(o.callId);
          const outcome = o.ok
            ? ({ ok: true, value: o.value } as const)
            : ({ ok: false, errno: o.errno ?? 'EIO' } as const);
          const log: Session['observations'][number] = {
            turn: args.turn,
            call: o.call,
            args: pending.args,
            ok: o.ok,
          };
          if (!outcome.ok) log.errno = outcome.errno;
          s.observations.push(log);
          if (outcome.ok)
            for (const p of observedPaths(o.call, pending.args, outcome.value)) s.observed.add(p);
          const r = renderObservation(o.call, pending.args, outcome, s.rng, s.tz);
          s.transcript.append({
            role: 'tool_result',
            toolUseId: o.callId,
            content: r.content,
            isError: r.isError,
          });
        }
      } else if ('clarification' in args) {
        if (s.pendingClarify === null) throw this.err('EINVAL', 'unknown-call');
        s.clarifications.push(args.clarification);
        s.transcript.append({
          role: 'tool_result',
          toolUseId: s.pendingClarify,
          content: renderClarification(args.clarification),
          isError: false,
        });
        s.pendingClarify = null;
      }
    }
    if (s.pendingTools.size > 0) throw this.err('EINVAL', 'observation-missing');

    let use: Awaited<ReturnType<typeof nextToolCall>>;
    try {
      use = await nextToolCall(s.model, s.transcript, s.budget, s.abort.signal);
    } catch (e) {
      const g = e instanceof GatewayError ? e : new GatewayError('EAIUNAVAIL', 'upstream');
      this.audit(
        s,
        'ai.agent.plan',
        g.errno === 'EAIREFUSED'
          ? 'refused_model'
          : g.errno === 'ECANCELED'
            ? 'killed_before_execute'
            : 'unavailable',
        { errno: g.errno },
      );
      this.sessions.delete(s.requestId);
      throw this.err(g.errno, g.reason);
    }
    if (!use.ok) {
      this.audit(
        s,
        'ai.agent.plan',
        use.error.errno === 'EAIREFUSED' ? 'refused_model' : 'cannot_comply',
        { errno: use.error.errno },
      );
      this.sessions.delete(s.requestId);
      throw this.err(use.error.errno, use.error.reason, use.error.message);
    }
    const d = decodeToolUse(use.value, DEFAULT_UMASK);
    if (!d.ok) {
      this.audit(s, 'ai.agent.plan', 'rejected_invalid', { errno: d.error.errno });
      this.sessions.delete(s.requestId);
      throw this.err(d.error.errno, d.error.reason, d.error.message);
    }
    const v = d.value;
    switch (v.kind) {
      case 'tool': {
        const args = expandToolArgs(v.args, s.home, s.cwd);
        s.pendingTools.set(v.callId, { call: v.call, args });
        return {
          kind: 'tools',
          calls: [{ callId: v.callId, call: v.call, args }],
          turnsLeft: s.budget.left,
        };
      }
      case 'clarify':
        s.pendingClarify = v.callId;
        return { kind: 'clarify', question: v.question, options: v.options };
      case 'plan':
        s.suspicious = s.suspicious || v.suspicious;
        return { kind: 'plan', steps: v.steps };
      case 'cannot':
        this.audit(s, 'ai.agent.plan', 'cannot_comply');
        this.sessions.delete(s.requestId);
        return { kind: 'cannot', reason: v.reason };
    }
  }

  /** `ai.agent.submit`: validate + dry run + predicate (nothing runs, AGT-02). */
  async submit(
    caller: AiCaller,
    args: { requestId: string; steps: unknown },
  ): Promise<SubmitResult> {
    const s = this.session(caller, args.requestId);
    const fs = this.deps.fs;
    if (fs === undefined)
      throw this.err('EAIUNAVAIL', 'upstream', 'the plan validator is not wired in this build');
    await fs.prepare?.(s.cred, [s.cwd, s.home]);
    const planId = uuidv7();
    const r = await submitPlan(
      {
        requestId: s.requestId,
        steps: args.steps,
        request: s.request,
        clarifications: s.clarifications,
        suspicious: s.suspicious,
        cred: s.cred,
        home: s.home,
        cwd: s.cwd,
        umask: DEFAULT_UMASK,
        now: this.deps.epochMs(),
        tz: s.tz,
        txnId: uuidv7(),
        snapshot: fs.snapshot(),
        oracle: fs.oracle,
        quota: fs.quota,
        ...(fs.leases === undefined ? {} : { leases: fs.leases }),
        observed: s.observed,
      },
      planId,
      caller.pcb.pid,
      await this.grants(),
    );
    if (!r.ok) {
      this.audit(s, 'ai.agent.submit', 'rejected_invalid', {
        errno: r.error.errno,
        args: { steps: args.steps },
      });
      throw this.err(r.error.errno, r.error.reason, r.error.message, r.error.step);
    }
    const submitted = r.value;
    s.planHash = submitted.dryRun.planHash;
    s.dryRunHash = submitted.dryRun.dryRunHash;
    const rendered = renderDryRun(submitted.dryRun, submitted.reasons);
    this.plans.set(planId, { submitted, session: s, rendered });
    if (submitted.result.token !== undefined)
      this.remember(planId, submitted.result.token, caller.pcb.pid, submitted.dryRun.batch);
    this.audit(s, 'ai.agent.submit', 'dry_run_only', { inodes: submitted.dryRun.affectedInodes });
    return submitted.result;
  }

  private remember(planId: string, token: string, pid: number, ops: readonly BatchOp[]): void {
    this.tokens.set(planId, {
      token,
      pid,
      exp: this.deps.epochMs() + PLAN_TOKEN_TTL_MS,
      ops: canonicalJson(ops),
    });
  }

  /** `ai.agent.confirm`: the kernel-owned TTY prompt (BLOCKING on `tty:confirm`). */
  async confirm(
    caller: AiCaller,
    planId: string,
  ): Promise<{ token: string; expiresAt: number; granted: boolean }> {
    const p = this.plans.get(planId);
    if (p === undefined || p.session.pid !== caller.pcb.pid)
      throw this.err('EINVAL', 'unknown-plan');
    const tty = this.deps.tty?.(caller);
    if (tty === undefined) {
      this.audit(p.session, 'ai.agent.confirm', 'no_tty', {
        errno: 'ENOTTY',
        confirmation: 'no-tty',
      });
      throw this.err('ENOTTY', undefined, 'confirmation needs the controlling terminal');
    }
    const outcome = await confirmOnTty(tty, p.rendered);
    if (!outcome.granted) {
      const agentOutcome: AgentOutcome = outcome.answer === 'edit' ? 'declined' : outcome.outcome;
      this.audit(p.session, 'ai.agent.confirm', agentOutcome, {
        errno: outcome.answer === 'edit' ? 'ECANCELED' : outcome.errno,
        confirmation:
          outcome.answer === 'timeout'
            ? 'timeout'
            : outcome.answer === 'no-tty'
              ? 'no-tty'
              : 'declined',
      });
      this.plans.delete(planId);
      throw this.err(
        outcome.answer === 'edit' ? 'ECANCELED' : outcome.errno,
        outcome.answer === 'no-tty' ? undefined : 'declined',
      );
    }
    const t = await tokenAfterConfirm(
      p.submitted,
      caller.pcb.pid,
      await this.grants(),
      this.deps.epochMs(),
    );
    this.remember(planId, t.token, caller.pcb.pid, p.submitted.dryRun.batch);
    this.audit(p.session, 'ai.agent.confirm', 'committed', {
      confirmation: 'confirmed',
      inodes: p.submitted.dryRun.affectedInodes,
    });
    return t;
  }

  /**
   * The kernel fs `batch` gate for agent-class callers (`FsSyscallOptions.verifyPlanToken`):
   * synchronous, single use. Null when the batch may run.
   */
  verifyPlanToken(
    caller: AiCaller,
    args: {
      ops: readonly BatchOp[];
      token?: string | undefined;
      planId?: string | undefined;
      txnId?: string | undefined;
    },
  ): Error | null {
    if (args.token === undefined || args.planId === undefined) return this.err('EPERM', 'no-token');
    const t = this.tokens.get(args.planId);
    if (t === undefined) return this.err('EPERM', 'no-token');
    this.tokens.delete(args.planId);
    if (!constantTimeEqual(t.token, args.token) || t.pid !== caller.pcb.pid)
      return this.err('EPERM', 'no-token');
    if (this.deps.epochMs() > t.exp) return this.err('EPERM', 'no-token', 'plan token expired');
    if (canonicalJson(args.ops) !== t.ops)
      return this.err('EINVAL', 'ops-differ', 'batch ops differ from the dry run');
    const p = this.plans.get(args.planId);
    if (p !== undefined) {
      this.plans.delete(args.planId);
      const touched = p.submitted.dryRun.batch.flatMap((op) =>
        op.op === 'rename' || op.op === 'copy' ? [op.to] : 'path' in op ? [op.path] : [],
      );
      this.deps.touched?.(touched);
      // AGT-08: the result of the request — the plan runs as ONE batch transaction now.
      this.audit(p.session, 'batch', 'committed', {
        confirmation: p.submitted.result.confirm.required ? 'confirmed' : 'not-required',
        inodes: p.submitted.dryRun.affectedInodes,
        ...(args.txnId === undefined ? {} : { txnId: args.txnId }),
      });
      this.sessions.delete(p.session.requestId);
    }
    return null;
  }

  /** `ai.agent.log`: own records, newest first (uid 0 sees all). */
  log(
    caller: AiCaller,
    args: { requestId?: string | undefined; limit?: number | undefined },
  ): { records: AuditRecord[] } {
    const uid = caller.pcb.cred.uid;
    const mine = this.records.filter(
      (r) =>
        (uid === 0 || r.uid === uid || r.ruid === caller.pcb.cred.ruid) &&
        (args.requestId === undefined || r.promptId === args.requestId),
    );
    return { records: mine.slice(-(args.limit ?? 20)).reverse() };
  }

  /** The kill path of a process (AGT-09): abort its gateway call and forget its plans. */
  onProcessExit(pid: number): void {
    for (const [id, s] of this.sessions) {
      if (s.pid !== pid) continue;
      s.abort.abort();
      this.audit(s, 'ai.agent.plan', 'killed_before_execute', { errno: 'ECANCELED' });
      this.sessions.delete(id);
    }
    for (const [id, p] of this.plans) if (p.session.pid === pid) this.plans.delete(id);
    for (const [id, t] of this.tokens) if (t.pid === pid) this.tokens.delete(id);
  }

  get activeSessions(): number {
    return this.sessions.size;
  }
}
