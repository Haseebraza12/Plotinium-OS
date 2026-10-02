/**
 * The plan validator and dry run (agentic-shell.md §3.11, §3.12; syscall-abi.md §5.4; AGT-02).
 *
 * Checks, in order; the FIRST failure rejects the whole plan with `{errno, step, reason}` and
 * nothing runs:
 * 1. Valibot re-parse of the plan and of every step's args with the schema of its op;
 * 2. step graph: ids unique and increasing; `sources.ref` names an earlier `find`/`glob` step;
 * 3. intent binding (spans and verb lexicon, intent.ts);
 * 4–8. on the overlay, op by op (apply.ts): paths, capability roots, permissions, quota,
 *    overwrite detection;
 * 9. size: at most 10,000 affected inodes.
 * The same pass yields the dry run: resolved ops, blast radius, expected versions, subtree
 * digests, inverse actions, the grant set and the hashes of syscall-abi.md §5.4.
 *
 * Set expansion (Plotinium design; the ABI's `sources` replaces agentic-shell's `{each: sN}`): a
 * step with `sources` runs once per member. `rename`/`copy` move or copy each member INTO the
 * directory `to` (under its own name) and ignore `from`; `unlink`, `chmod`, `chown` and `utimes`
 * act on each member and ignore `path`. Other ops may not carry `sources`.
 */
import {
  AgentSubmitArgs,
  type BatchOp,
  type FindArgs,
  type ModeChange,
  type PlanStep,
  planStepArgsSchema,
  sha256Hex,
} from '@plotinium/protocol';

import { canonicalHash } from '../util/canonical.ts';
import type { Cred, PermOracle } from '../util/cred.ts';
import { type Result, fail, ok } from '../util/errors.ts';
import { type Schema, parseWith } from '../util/schema.ts';
import {
  type ApplyContext,
  DryRunState,
  type InverseAction,
  type LeaseOracle,
  PLAN_INODES_MAX,
  type QuotaOracle,
  type ResolvedOp,
  applyChmod,
  applyChown,
  applyCopy,
  applyMkdir,
  applyRename,
  applySymlink,
  applyUnlink,
  applyUtimes,
  applyWrite,
  quotaCheck,
} from './apply.ts';
import { type FsSnapshot, Overlay, basename, joinPath, normalizePath } from './fsview.ts';
import { DESTRUCTIVE, bindIntent, isGrounded, opClassOf } from './intent.ts';
import { runFind } from './select.ts';

export interface ValidateInput {
  requestId: string;
  steps: unknown;
  request: string;
  clarifications: readonly string[];
  userEdited?: boolean;
  /** The model set `suspicious_content_seen` (can only add confirmation). */
  suspicious?: boolean;
  cred: Cred;
  home: string;
  cwd: string;
  umask: number;
  now: number;
  tz: string;
  /** UUIDv7 of the batch; names the trash directory. */
  txnId: string;
  snapshot: FsSnapshot;
  oracle: PermOracle;
  quota: QuotaOracle;
  leases?: LeaseOracle;
  /** Paths returned by this request's observations (grounding). */
  observed?: ReadonlySet<string>;
  /** A per-plan elevation grant is attached (§3.19). */
  elevation?: boolean;
  /** Agent deletions go to the trash (default true, §3.12). */
  trash?: boolean;
}

export interface DryRunFlags {
  unlicensed: boolean;
  ungrounded: boolean;
  suspicious: boolean;
  edited: boolean;
  elevation: boolean;
}

export interface DryRun {
  snapshotGen: number;
  ops: ResolvedOp[];
  /** The exact ops `batch` will receive. */
  batch: BatchOp[];
  affectedInodes: number;
  counts: { create: number; modify: number; delete: number; overwrite: number };
  bytes: number;
  quota: Array<{ uid: number; bytesAfter: number; inodesAfter: number; ok: boolean }>;
  quotaOk: boolean;
  intervals: Array<{ step: string; from: string; to: string; tz: string }>;
  expectedVersions: Array<{ ino: string; version: number }>;
  subtreeDigests: Record<string, string>;
  inverse: InverseAction[];
  undoAvailable: boolean;
  /** The confirmed `(op, ino)` set that `batch.grant` is narrowed to. */
  grant: Array<[string, string]>;
  flags: DryRunFlags;
  unlicensedSteps: string[];
  ungroundedArgs: string[];
  systemPath: boolean;
  planHash: string;
  dryRunHash: string;
}

const SET_OPS = new Set(['rename', 'copy', 'unlink', 'chmod', 'chown', 'utimes']);
const stepNumber = (id: string): number => Number(id.slice(1));

/** Checks 1 and 2. */
function parseSteps(input: ValidateInput): Result<PlanStep[]> {
  const parsed = parseWith(AgentSubmitArgs as Schema<{ requestId: string; steps: PlanStep[] }>, {
    requestId: input.requestId,
    steps: input.steps,
  });
  if (!parsed.ok) return fail('EINVAL', 'bad-plan', undefined, parsed.message);
  const steps: PlanStep[] = [];
  const kinds = new Map<string, string>();
  let last = 0;
  for (const s of parsed.value.steps) {
    const args = parseWith(planStepArgsSchema(s.op) as Schema<unknown>, s.args);
    if (!args.ok) return fail('EINVAL', 'bad-arguments', s.id, args.message);
    if (stepNumber(s.id) <= last) return fail('EINVAL', 'step-order', s.id);
    last = stepNumber(s.id);
    if (s.sources !== undefined) {
      if (!SET_OPS.has(s.op)) return fail('EINVAL', 'sources-not-allowed', s.id);
      if (!Array.isArray(s.sources)) {
        const k = kinds.get(s.sources.ref);
        if (k !== 'find' && k !== 'glob') return fail('EINVAL', 'bad-ref', s.id);
      }
    }
    kinds.set(s.id, s.op);
    steps.push({ ...s, args: args.value });
  }
  return ok(steps);
}

type Args = Record<string, unknown>;
const str = (a: Args, k: string): string => (typeof a[k] === 'string' ? a[k] : '');
const bool = (a: Args, k: string): boolean => a[k] === true;
const num = (a: Args, k: string): number | undefined =>
  typeof a[k] === 'number' ? a[k] : undefined;

/** A readable, canonical rendering of a mode change (dry run and grading). */
export function modeDisplay(m: ModeChange): string {
  const o = (n: number): string => n.toString(8).padStart(4, '0');
  return m.op === 'set' ? o(m.bits) : `+${o(m.add)}-${o(m.clear)}`;
}

function applyOne(
  st: DryRunState,
  step: PlanStep,
  a: Args,
  member: string | undefined,
): Result<undefined> {
  const id = step.id;
  const into = (to: string, m: string): string =>
    joinPath(normalizePath(to, st.context.cwd, st.context.home) ?? to, basename(m));
  switch (step.op) {
    case 'mkdir':
      return applyMkdir(st, id, str(a, 'path'), bool(a, 'parents'));
    case 'write':
      return applyWrite(st, id, str(a, 'path'), str(a, 'text'));
    case 'rename': {
      const noReplace = typeof a['noReplace'] === 'boolean' ? a['noReplace'] : undefined;
      return member === undefined
        ? applyRename(st, id, str(a, 'from'), str(a, 'to'), noReplace)
        : applyRename(st, id, member, into(str(a, 'to'), member), noReplace);
    }
    case 'copy':
      return member === undefined
        ? applyCopy(st, id, str(a, 'from'), str(a, 'to'), bool(a, 'recursive'))
        : applyCopy(st, id, member, into(str(a, 'to'), member), bool(a, 'recursive'));
    case 'unlink':
      return applyUnlink(st, id, member ?? str(a, 'path'), bool(a, 'recursive'));
    case 'symlink':
      return applySymlink(st, id, str(a, 'target'), str(a, 'path'));
    case 'chmod': {
      const mode = a['mode'] as ModeChange;
      return applyChmod(
        st,
        id,
        member ?? str(a, 'path'),
        mode,
        bool(a, 'recursive'),
        modeDisplay(mode),
      );
    }
    case 'chown':
      return applyChown(
        st,
        id,
        member ?? str(a, 'path'),
        num(a, 'uid'),
        num(a, 'gid'),
        bool(a, 'recursive'),
      );
    case 'utimes':
      return applyUtimes(st, id, member ?? str(a, 'path'));
    case 'find':
    case 'glob':
      return ok(undefined);
  }
}

/** The path arguments a step names itself (not bound through `sources`), for grounding. */
function namedPaths(step: PlanStep, a: Args): string[] {
  const set = step.sources !== undefined;
  switch (step.op) {
    case 'rename':
    case 'copy':
      return set ? [str(a, 'to')] : [str(a, 'from'), str(a, 'to')];
    case 'mkdir':
    case 'write':
    case 'symlink':
      return [str(a, 'path')];
    case 'unlink':
    case 'chmod':
    case 'chown':
    case 'utimes':
      return set ? [] : [str(a, 'path')];
    case 'find':
    case 'glob':
      return [];
  }
}

function counts(ops: readonly ResolvedOp[], overwrites: number): DryRun['counts'] {
  return {
    create: ops.filter((o) => o.kind === 'create').length,
    modify: ops.filter((o) => o.kind === 'modify').length,
    delete: ops.filter((o) => o.kind === 'delete').length,
    overwrite: overwrites,
  };
}

/** Validate a plan and compute its dry run (checks 1–9). */
export function validatePlan(input: ValidateInput): Result<DryRun> {
  const parsed = parseSteps(input);
  if (!parsed.ok) return parsed;
  const steps = parsed.value;
  const bound = bindIntent({
    steps,
    request: input.request,
    clarifications: input.clarifications,
    userEdited: input.userEdited === true,
    overwrites: new Set(),
  });
  if (!bound.ok) return bound;

  const overlay = new Overlay(input.snapshot);
  const ctx: ApplyContext = {
    overlay,
    cred: input.cred,
    oracle: input.oracle,
    quota: input.quota,
    leases: input.leases,
    cwd: input.cwd,
    home: input.home,
    umask: input.umask,
    now: input.now,
    txnId: input.txnId,
    trash: input.trash ?? true,
    elevated: input.elevation === true,
  };
  const st = new DryRunState(ctx);
  const selections = new Map<string, string[]>();
  const intervals: DryRun['intervals'] = [];
  const ungrounded: string[] = [];
  const ungroundedSteps = new Set<string>();
  const grounding = {
    request: input.request,
    clarifications: input.clarifications,
    cwd: input.cwd,
    home: input.home,
    observed: input.observed ?? new Set<string>(),
  };

  for (const step of steps) {
    const a = step.args as Args;
    if (step.op === 'find' || step.op === 'glob') {
      const sel = runFind(step.args as FindArgs, {
        overlay,
        cred: st.effective,
        oracle: input.oracle,
        cwd: input.cwd,
        home: input.home,
        now: input.now,
        tz: input.tz,
      });
      if (!sel.ok) return fail(sel.error.errno, sel.error.reason, step.id);
      if (sel.value.truncated) return fail('EINVAL', 'plan-too-large', step.id);
      selections.set(step.id, sel.value.paths);
      if (sel.value.resolved !== undefined)
        intervals.push({ step: step.id, ...sel.value.resolved, tz: input.tz });
      continue;
    }
    const flag = (abs: string | undefined): void => {
      if (abs === undefined || isGrounded(abs, grounding)) return;
      ungrounded.push(`${step.id}:${abs}`);
      ungroundedSteps.add(step.id);
    };
    for (const p of namedPaths(step, a)) flag(normalizePath(p, input.cwd, input.home));
    let members: Array<string | undefined> = [undefined];
    if (step.sources !== undefined) {
      if (Array.isArray(step.sources)) {
        members = step.sources.map((p) => normalizePath(p, input.cwd, input.home));
        for (const m of members) flag(m);
      } else members = selections.get(step.sources.ref) ?? [];
    }
    // Plotinium hardening (INJ-20 blind-yes gate): a destructive step may only name paths the
    // user's words, a selector or an observation account for; confirmation alone is not enough.
    if (
      input.userEdited !== true &&
      ungroundedSteps.has(step.id) &&
      DESTRUCTIVE.has(opClassOf(step.op))
    ) {
      return fail('EPERM', 'not-requested', step.id);
    }
    for (const m of members) {
      const r = applyOne(st, step, a, m);
      if (!r.ok) return r;
      if (st.affected.size > PLAN_INODES_MAX) return fail('EINVAL', 'plan-too-large', step.id);
    }
  }

  // Check 3, second half: a step that replaces an existing name also needs an overwrite lexeme.
  const rebound = bindIntent({
    steps,
    request: input.request,
    clarifications: input.clarifications,
    userEdited: input.userEdited === true,
    overwrites: st.overwriteSteps,
  });
  if (!rebound.ok) return rebound;
  if (input.userEdited !== true) {
    for (const id of st.overwriteSteps)
      if (ungroundedSteps.has(id)) return fail('EPERM', 'not-requested', id);
  }
  const quota = quotaCheck(st);
  const overQuota = quota.find((q) => !q.ok);
  if (overQuota !== undefined) return fail('EDQUOT');

  const expectedVersions = [...st.expected.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([ino, version]) => ({ ino, version }));
  const subtreeDigests: Record<string, string> = {};
  for (const [ino, pairs] of [...st.digests].sort((x, y) => (x[0] < y[0] ? -1 : 1)))
    subtreeDigests[ino] = sha256Hex(pairs.join('\n'));
  const view = abiDryRunView({
    batch: st.batch,
    affectedInodes: st.affected.size,
    bytes: st.bytes,
    deletions: st.deletions,
    overwrites: st.overwrites,
    quotaOk: true,
    intervals,
  });
  const unlicensedSteps = rebound.value.unlicensed;
  return ok({
    snapshotGen: input.snapshot.generation,
    ops: st.ops,
    batch: st.batch,
    affectedInodes: st.affected.size,
    counts: counts(st.ops, st.overwrites),
    bytes: st.bytes,
    quota,
    quotaOk: true,
    intervals,
    expectedVersions,
    subtreeDigests,
    inverse: st.inverse,
    undoAvailable: st.undoAvailable,
    grant: [...st.grant].sort().map((g) => g.split('\u0000') as [string, string]),
    flags: {
      unlicensed: unlicensedSteps.length > 0,
      ungrounded: ungrounded.length > 0,
      suspicious: input.suspicious === true,
      edited: input.userEdited === true,
      elevation: input.elevation === true && st.systemPath,
    },
    unlicensedSteps,
    ungroundedArgs: ungrounded,
    systemPath: st.systemPath,
    planHash: canonicalHash(st.batch),
    dryRunHash: canonicalHash({ expectedVersions, dryRun: view }),
  });
}

/** `SubmitResult.dryRun` (syscall-abi.md §4.4.10). */
export function abiDryRunView(d: {
  batch: readonly BatchOp[];
  affectedInodes: number;
  bytes: number;
  deletions: number;
  overwrites: number;
  quotaOk: boolean;
  intervals: DryRun['intervals'];
}): {
  ops: BatchOp[];
  inodes: number;
  bytes: number;
  deletions: number;
  overwrites: number;
  quotaOk: boolean;
  resolvedTimes?: Array<{ from: string; to: string }>;
} {
  const view: ReturnType<typeof abiDryRunView> = {
    ops: [...d.batch],
    inodes: d.affectedInodes,
    bytes: d.bytes,
    deletions: d.deletions,
    overwrites: d.overwrites,
    quotaOk: d.quotaOk,
  };
  if (d.intervals.length > 0)
    view.resolvedTimes = d.intervals.map((i) => ({ from: i.from, to: i.to }));
  return view;
}
