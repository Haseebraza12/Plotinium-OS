/**
 * AI subsystem B, the agentic shell (syscall-abi.md §4.4.10 B, §5.4; pipeline owned by
 * agentic-shell.md).
 *
 * The kernel re-parses every model tool call with the Valibot schema of the named syscall.
 * Read-only calls are handed back to the agent process, which executes each one as exactly one
 * syscall as its own uid; mutating calls are buffered into the plan and never executed from model
 * output. The observation loop is capped at 6 turns. An agent-class process changes the file system
 * ONLY through `batch` with a kernel-issued plan token (INV-ABI-6).
 *
 * agentic-shell.md §4.1 sketches different shapes for some of these calls (for example
 * `{observation}` turns and `ai.agent.undo`); syscall-abi.md wins on names and shapes, and the
 * differences are listed in protocol/README.md.
 */
import * as v from 'valibot';

import { AuditRecord, ReadOnlyTool } from '../audit.ts';
import { Errno } from '../errno.ts';
import { AGENT_TURNS_MAX } from '../limits.ts';
import {
  Count,
  Cursor,
  DirEntry,
  EpochMs,
  Ino,
  IsoTimestamp,
  Path,
  Sha256Hex,
  TimeZone,
} from '../sys/common.ts';
import {
  BATCH_OP_NAMES,
  BatchOp,
  ExpectedVersion,
  EXPECTED_VERSIONS_MAX,
  PlanToken,
} from '../sys/fs.ts';

/** At most 150 listing entries go into the envelope (agentic-shell.md §3.4). */
export const ENVELOPE_LISTING_MAX = 150;
/** A plan has 1..64 steps (syscall-abi.md §4.4.10). */
export const PLAN_STEPS_MAX = 64;

/** Gathered by the agent through syscalls; re-checked by the kernel. */
export const AgentEnvelope = v.strictObject({
  cwd: Path,
  /** ISO 8601 with offset. */
  now: IsoTimestamp,
  tz: TimeZone,
  /** `readdir {plus: true}` of the cwd. */
  listing: v.pipe(v.array(DirEntry), v.maxLength(ENVELOPE_LISTING_MAX)),
  listingTotal: Count,
});

export const CallId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/));

export const Observation = v.strictObject({
  callId: CallId,
  call: ReadOnlyTool,
  ok: v.boolean(),
  /** The syscall's result; the kernel checks it against that call's return schema. */
  value: v.optional(v.unknown()),
  errno: v.optional(Errno),
});

const LaterTurn = v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(AGENT_TURNS_MAX));

/** Turn 1 carries the request and the envelope; later turns carry observations or a clarification. */
export const PlanTurnArgs = v.union([
  v.strictObject({
    requestId: Ino,
    turn: v.literal(1),
    request: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
    envelope: AgentEnvelope,
  }),
  v.strictObject({
    requestId: Ino,
    turn: LaterTurn,
    observations: v.pipe(v.array(Observation), v.minLength(1), v.maxLength(16)),
  }),
  v.strictObject({
    requestId: Ino,
    turn: LaterTurn,
    clarification: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  }),
]);

/** Step ids `s1`..`s64`. */
export const StepId = v.pipe(v.string(), v.regex(/^s(?:[1-9]|[1-5][0-9]|6[0-4])$/));

/** The ops a plan step may name: the batch ops plus the selectors `find` and `glob`. */
export const PLAN_STEP_OPS = [...BATCH_OP_NAMES, 'find', 'glob'] as const;
export type PlanStepOp = (typeof PLAN_STEP_OPS)[number];

export const PlanStep = v.strictObject({
  id: StepId,
  op: v.picklist(PLAN_STEP_OPS),
  /** Re-parsed by the kernel with the schema of `op` (see `planStepArgsSchema` in tools.ts). */
  args: v.unknown(),
  /** Verbatim quote of the request (intent binding, agentic-shell.md §3.10). */
  span: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  /** Bind to explicit paths, or to the result set of an earlier `find`/`glob` step. */
  sources: v.optional(
    v.union([v.pipe(v.array(Path), v.maxLength(1000)), v.strictObject({ ref: StepId })]),
  ),
});

export const PlanTurn = v.variant('kind', [
  v.strictObject({
    kind: v.literal('tools'),
    calls: v.pipe(
      v.array(v.strictObject({ callId: CallId, call: ReadOnlyTool, args: v.unknown() })),
      v.minLength(1),
      v.maxLength(16),
    ),
    turnsLeft: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(AGENT_TURNS_MAX)),
  }),
  /** The model called `submit_plan`. */
  v.strictObject({
    kind: v.literal('plan'),
    steps: v.pipe(v.array(PlanStep), v.minLength(1), v.maxLength(PLAN_STEPS_MAX)),
  }),
  v.strictObject({
    kind: v.literal('clarify'),
    question: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
    options: v.pipe(v.array(v.pipe(v.string(), v.maxLength(200))), v.maxLength(5)),
  }),
  v.strictObject({ kind: v.literal('cannot'), reason: v.pipe(v.string(), v.maxLength(1000)) }),
]);

export const AgentSubmitArgs = v.strictObject({
  requestId: Ino,
  steps: v.pipe(v.array(PlanStep), v.minLength(1), v.maxLength(PLAN_STEPS_MAX)),
});

/** Reasons the kernel's confirmation predicate can give (syscall-abi.md §5.4 rule 2). */
export const ConfirmReason = v.picklist([
  'delete',
  'overwrite',
  'chmod',
  'chown',
  'over-20-inodes',
  'system-path',
]);

export const SubmitResult = v.strictObject({
  planId: Ino,
  planHash: Sha256Hex,
  dryRunHash: Sha256Hex,
  dryRun: v.strictObject({
    ops: v.array(BatchOp),
    inodes: Count,
    bytes: Count,
    deletions: Count,
    overwrites: Count,
    quotaOk: v.boolean(),
    resolvedTimes: v.optional(v.array(v.strictObject({ from: IsoTimestamp, to: IsoTimestamp }))),
  }),
  confirm: v.strictObject({
    required: v.boolean(),
    reasons: v.array(ConfirmReason),
  }),
  /** Present only when `confirm.required` is false. */
  token: v.optional(PlanToken),
  expectedVersions: v.pipe(v.array(ExpectedVersion), v.maxLength(EXPECTED_VERSIONS_MAX)),
});

export const AgentConfirmArgs = v.strictObject({ planId: Ino });
export const AgentConfirmRet = v.strictObject({
  token: PlanToken,
  expiresAt: EpochMs,
  granted: v.boolean(),
});

export const AgentLogArgs = v.strictObject({
  requestId: v.optional(Ino),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200))),
  cursor: v.optional(Cursor),
});
export const AgentLogRet = v.strictObject({
  records: v.pipe(v.array(AuditRecord), v.maxLength(200)),
  next: v.optional(Cursor),
});

/** `ai undo` (MAY, AGT-10): returns the inverse plan, which must then be confirmed and batched. */
export const UndoArgs = v.strictObject({ txnId: Ino });

export type AgentEnvelope = v.InferOutput<typeof AgentEnvelope>;
export type Observation = v.InferOutput<typeof Observation>;
export type PlanTurnArgs = v.InferOutput<typeof PlanTurnArgs>;
export type PlanTurn = v.InferOutput<typeof PlanTurn>;
export type PlanStep = v.InferOutput<typeof PlanStep>;
export type SubmitResult = v.InferOutput<typeof SubmitResult>;
export type ConfirmReason = v.InferOutput<typeof ConfirmReason>;
