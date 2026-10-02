/**
 * The agent's model-facing tools (AGT-01; syscall-abi.md §3.11 "LLM tools", ABI-14; catalogue in
 * agentic-shell.md §3.6).
 *
 * Every tool is defined once, here, as the input schema of EXACTLY ONE system call:
 * - read-only tools run immediately as that syscall with the agent's credentials;
 * - mutating operations are never tools of their own: they are the variants of
 *   `submit_plan.steps[].op`, buffered into one plan and executed only through `batch` after
 *   validation, a dry run and (when the kernel predicate says so) confirmation.
 *
 * Model-facing inputs follow Claude's strict tool subset: every object is strict and every key is
 * required; an optional argument is `nullable` and `null` means "absent". `toArgs` converts a
 * parsed input into the arguments of the target syscall, and the kernel re-parses those with the
 * syscall's own Valibot schema, so every limit that the JSON Schema export strips stays enforced.
 * The server turns these schemas into JSON Schema with `@valibot/to-json-schema` at build time.
 *
 * Differences from agentic-shell.md §3.6 (syscall-abi.md wins on shapes; see protocol/README.md):
 * - step ops are the ABI's batch ops (`mkdir write rename copy unlink symlink chmod chown utimes`)
 *   plus `find`/`glob`; agentic-shell's `touch` maps to `utimes`, `write_text` to `write`, and
 *   `rmdir` has no batch op in the ABI yet;
 * - set-valued arguments use the ABI's `sources` binding instead of `{each: sN}`;
 * - `chown` takes numeric uid/gid (as the syscall does), not names;
 * - `extract_list` (SHOULD) is not listed: its syscall `ai.agent.extract` is not in the catalogue.
 */
import * as v from 'valibot';

import { BatchOp, FindArgs, RelSpan } from '../sys/fs.ts';
import type { FindMtime } from '../sys/fs.ts';
import { Count, Gid, Glob, InodeType, Path, SymlinkTarget, Uid } from '../sys/common.ts';
import { parseMode } from '../sys/mode.ts';
import type { ArgsIn } from '../sys/registry.ts';
import { StepId } from './agent.ts';
import type { PlanStep, PlanStepOp } from './agent.ts';

/** agentic-shell.md §3.6 result limits that the tools pass as syscall arguments. */
export const TOOL_LISTING_LIMIT = 150;
export const TOOL_FIND_LIMIT = 500;
export const TOOL_GREP_LIMIT = 500;
/** `submit_plan` carries at most 25 steps (agentic-shell.md §3.6). */
export const SUBMIT_PLAN_STEPS_MAX = 25;
/** `write` steps carry text quoted verbatim from the request, at most 4 KiB. */
export const TOOL_WRITE_TEXT_MAX_BYTES = 4_096;

const TreeDepth = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(64));

/** Model-facing relative time: exactly one of `within` and `olderThan` is non-null. */
const ToolRelSpan = v.strictObject({
  unit: RelSpan.entries.unit,
  count: RelSpan.entries.count,
  mode: v.picklist(['rolling', 'calendar']),
});
const ToolRelTime = v.pipe(
  v.strictObject({ within: v.nullable(ToolRelSpan), olderThan: v.nullable(ToolRelSpan) }),
  v.check((t) => (t.within === null) !== (t.olderThan === null)),
);

const orUndefined = <T>(x: T | null): T | undefined => (x === null ? undefined : x);

// ---------------------------------------------------------------------------------------------
// Read-only tools
// ---------------------------------------------------------------------------------------------

export const FsReaddirInput = v.strictObject({ path: Path });
export const FsStatInput = v.strictObject({ path: Path });
export const FsFindInput = v.strictObject({
  path: Path,
  name: v.nullable(Glob),
  type: v.nullable(InodeType),
  mtime: v.nullable(ToolRelTime),
  size: v.nullable(v.strictObject({ gt: v.nullable(Count), lt: v.nullable(Count) })),
  maxdepth: v.nullable(TreeDepth),
});
export const FsGrepInput = v.strictObject({
  /** Files or directories (directories are searched recursively). */
  paths: v.pipe(v.array(Path), v.minLength(1), v.maxLength(64)),
  /** A fixed string, never a regular expression. */
  text: v.pipe(v.string(), v.minLength(1), v.maxBytes(1024)),
  ignoreCase: v.boolean(),
  mode: v.picklist(['l', 'c']),
});
export const FsDuInput = v.strictObject({ path: Path, depth: v.nullable(TreeDepth) });
export const FsWcInput = v.strictObject({
  paths: v.pipe(v.array(Path), v.minLength(1), v.maxLength(64)),
});

function findMtime(
  t: v.InferOutput<typeof ToolRelTime> | null,
): v.InferOutput<typeof FindMtime> | undefined {
  if (t === null) return undefined;
  if (t.within !== null) return { within: t.within };
  if (t.olderThan !== null) return { olderThan: t.olderThan };
  return undefined;
}

function toFindArgs(i: v.InferOutput<typeof FsFindInput>): FindArgs {
  const args: FindArgs = { path: i.path, limit: TOOL_FIND_LIMIT };
  if (i.name !== null) args.name = i.name;
  if (i.type !== null) args.type = i.type;
  const mtime = findMtime(i.mtime);
  if (mtime !== undefined) args.mtime = mtime;
  if (i.size !== null) {
    const size: { gt?: number; lt?: number } = {};
    if (i.size.gt !== null) size.gt = i.size.gt;
    if (i.size.lt !== null) size.lt = i.size.lt;
    args.size = size;
  }
  if (i.maxdepth !== null) args.maxDepth = i.maxdepth;
  return args;
}

interface ReadOnlyToolDef<
  I extends v.GenericSchema,
  C extends 'readdir' | 'stat' | 'find' | 'grep' | 'du' | 'wc',
> {
  readonly name: string;
  readonly call: C;
  readonly description: string;
  readonly input: I;
  toArgs(input: v.InferOutput<I>): ArgsIn<C>;
}

function readOnlyTool<
  I extends v.GenericSchema,
  C extends 'readdir' | 'stat' | 'find' | 'grep' | 'du' | 'wc',
>(def: ReadOnlyToolDef<I, C>): ReadOnlyToolDef<I, C> {
  return def;
}

/** agentic-shell.md §3.6 "Read-only tools", each mapped to exactly one syscall. */
export const READ_ONLY_TOOLS = {
  fs_readdir: readOnlyTool({
    name: 'fs_readdir',
    call: 'readdir',
    description:
      'Read-only. List a directory as the user. Runs immediately. Returns datamarked entries.',
    input: FsReaddirInput,
    toArgs: (i) => ({ path: i.path, plus: true, limit: TOOL_LISTING_LIMIT }),
  }),
  fs_stat: readOnlyTool({
    name: 'fs_stat',
    call: 'stat',
    description: 'Read-only. Show type, size, mode, owner, group, mtime and links of one entry.',
    input: FsStatInput,
    toArgs: (i) => ({ path: i.path }),
  }),
  fs_find: readOnlyTool({
    name: 'fs_find',
    call: 'find',
    description:
      'Read-only. Find entries under a directory as the user. Runs immediately. Returns datamarked paths.',
    input: FsFindInput,
    toArgs: toFindArgs,
  }),
  fs_grep: readOnlyTool({
    name: 'fs_grep',
    call: 'grep',
    description:
      'Read-only. Find files containing a fixed string. Returns names or counts, never matching lines.',
    input: FsGrepInput,
    toArgs: (i) => ({
      paths: i.paths,
      pattern: i.text,
      recursive: true,
      ignoreCase: i.ignoreCase,
      mode: i.mode,
      limit: TOOL_GREP_LIMIT,
    }),
  }),
  fs_du: readOnlyTool({
    name: 'fs_du',
    call: 'du',
    description: 'Read-only. Show the space used under a path.',
    input: FsDuInput,
    toArgs: (i) => (i.depth === null ? { path: i.path } : { path: i.path, maxDepth: i.depth }),
  }),
  fs_wc: readOnlyTool({
    name: 'fs_wc',
    call: 'wc',
    description: 'Read-only. Count lines, words and bytes of files.',
    input: FsWcInput,
    toArgs: (i) => ({ paths: i.paths }),
  }),
} as const;

export type ReadOnlyToolName = keyof typeof READ_ONLY_TOOLS;

// ---------------------------------------------------------------------------------------------
// Plan steps (the variants of submit_plan.steps[].op)
// ---------------------------------------------------------------------------------------------

/** Model-facing chmod mode: an octal string such as "0644" or a symbolic one such as "o-w". */
const ToolChmodMode = v.union([
  v.strictObject({ set: v.pipe(v.string(), v.regex(/^[0-7]{1,4}$/)) }),
  v.strictObject({ symbolic: v.pipe(v.string(), v.minLength(1), v.maxLength(64)) }),
]);

export const STEP_ARG_SCHEMAS = {
  mkdir: v.strictObject({ path: Path, parents: v.boolean() }),
  write: v.strictObject({
    path: Path,
    text: v.pipe(v.string(), v.maxBytes(TOOL_WRITE_TEXT_MAX_BYTES)),
  }),
  rename: v.strictObject({ from: Path, to: Path, noReplace: v.nullable(v.boolean()) }),
  copy: v.strictObject({ from: Path, to: Path, recursive: v.boolean() }),
  unlink: v.strictObject({ path: Path, recursive: v.boolean() }),
  symlink: v.strictObject({ target: SymlinkTarget, path: Path }),
  chmod: v.strictObject({ path: Path, mode: ToolChmodMode, recursive: v.boolean() }),
  chown: v.strictObject({
    path: Path,
    uid: v.nullable(Uid),
    gid: v.nullable(Gid),
    recursive: v.boolean(),
  }),
  /** `touch` of an existing file: set its modification time to now. */
  utimes: v.strictObject({ path: Path }),
  find: FsFindInput,
  /** A name glob in one directory (a `find` with `maxDepth` 1). */
  glob: v.strictObject({ path: Path, name: Glob }),
} as const satisfies Record<PlanStepOp, v.GenericSchema>;

type StepArgs = { [K in PlanStepOp]: v.InferOutput<(typeof STEP_ARG_SCHEMAS)[K]> };

/** The syscall whose argument schema re-parses each step op (exactly one per op). */
export const STEP_SYSCALL = {
  mkdir: 'batch',
  write: 'batch',
  rename: 'batch',
  copy: 'batch',
  unlink: 'batch',
  symlink: 'batch',
  chmod: 'batch',
  chown: 'batch',
  utimes: 'batch',
  find: 'find',
  glob: 'find',
} as const satisfies Record<PlanStepOp, 'batch' | 'find'>;

/**
 * Convert a mutating step's model-facing args into the ABI batch op, or undefined when a chmod
 * mode is invalid or unsupported (EINVAL at validation).
 */
export function stepToBatchOp(
  op: Exclude<PlanStepOp, 'find' | 'glob'>,
  args: unknown,
  umask: number,
): BatchOp | undefined {
  const a = args;
  switch (op) {
    case 'mkdir': {
      const s = a as StepArgs['mkdir'];
      return { op: 'mkdir', path: s.path, parents: s.parents };
    }
    case 'write': {
      const s = a as StepArgs['write'];
      return { op: 'write', path: s.path, text: s.text };
    }
    case 'rename': {
      const s = a as StepArgs['rename'];
      const noReplace = orUndefined(s.noReplace);
      return noReplace === undefined
        ? { op: 'rename', from: s.from, to: s.to }
        : { op: 'rename', from: s.from, to: s.to, noReplace };
    }
    case 'copy': {
      const s = a as StepArgs['copy'];
      return { op: 'copy', from: s.from, to: s.to, recursive: s.recursive };
    }
    case 'unlink': {
      const s = a as StepArgs['unlink'];
      return { op: 'unlink', path: s.path, recursive: s.recursive };
    }
    case 'symlink': {
      const s = a as StepArgs['symlink'];
      return { op: 'symlink', target: s.target, path: s.path };
    }
    case 'chmod': {
      const s = a as StepArgs['chmod'];
      const mode = parseMode('set' in s.mode ? s.mode.set : s.mode.symbolic, umask);
      return mode === undefined
        ? undefined
        : { op: 'chmod', path: s.path, mode, recursive: s.recursive };
    }
    case 'chown': {
      const s = a as StepArgs['chown'];
      const out: BatchOp = { op: 'chown', path: s.path, recursive: s.recursive };
      if (s.uid !== null) out.uid = s.uid;
      if (s.gid !== null) out.gid = s.gid;
      return out;
    }
    case 'utimes': {
      const s = a as StepArgs['utimes'];
      return { op: 'utimes', path: s.path, mtime: 'now' };
    }
  }
}

/** Convert a `find` or `glob` step into `find` syscall arguments. */
export function stepToFindArgs(op: 'find' | 'glob', args: unknown): FindArgs {
  if (op === 'glob') {
    const g = args as StepArgs['glob'];
    return { path: g.path, name: g.name, maxDepth: 1, limit: TOOL_FIND_LIMIT };
  }
  return toFindArgs(args as StepArgs['find']);
}

/** One model-facing plan step. */
export const ToolStep = v.strictObject({
  id: StepId,
  /** Verbatim quote of the request that licenses this step (intent binding). */
  span: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  op: v.variant(
    'call',
    (Object.keys(STEP_ARG_SCHEMAS) as PlanStepOp[]).map((call) =>
      v.strictObject({ call: v.literal(call), args: STEP_ARG_SCHEMAS[call] }),
    ),
  ),
  /** Bind to explicit paths or to the result set of an earlier find/glob step; null when unused. */
  sources: v.nullable(
    v.union([v.pipe(v.array(Path), v.maxLength(1000)), v.strictObject({ ref: StepId })]),
  ),
});

/**
 * Convert a parsed model step into the ABI `PlanStep` that `ai.agent.submit` takes. The kernel
 * re-parses `args` with `planStepArgsSchema(op)`.
 */
export function toPlanStep(
  step: v.InferOutput<typeof ToolStep>,
  umask: number,
): PlanStep | undefined {
  const call = step.op.call;
  let args: unknown;
  if (call === 'find' || call === 'glob') {
    args = stepToFindArgs(call, step.op.args);
  } else {
    const batchOp = stepToBatchOp(call, step.op.args, umask);
    if (batchOp === undefined) return undefined;
    const { op: _op, ...rest } = batchOp;
    args = rest;
  }
  const out: PlanStep = { id: step.id, op: call, args, span: step.span };
  if (step.sources !== null) out.sources = step.sources;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Terminal tools
// ---------------------------------------------------------------------------------------------

export const SubmitPlanInput = v.strictObject({
  summary: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  steps: v.pipe(v.array(ToolStep), v.minLength(1), v.maxLength(SUBMIT_PLAN_STEPS_MAX)),
  assumptions: v.pipe(v.array(v.pipe(v.string(), v.maxLength(300))), v.maxLength(10)),
  suspicious_content_seen: v.boolean(),
});

export const AskClarificationInput = v.strictObject({
  question: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  options: v.pipe(v.array(v.pipe(v.string(), v.maxLength(200))), v.maxLength(5)),
  reason: v.picklist([
    'ambiguous_target',
    'ambiguous_scope',
    'ambiguous_time',
    'missing_argument',
    'destructive_scope',
  ]),
});

export const CannotComplyInput = v.strictObject({
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
});

export const TERMINAL_TOOLS = {
  submit_plan: {
    name: 'submit_plan',
    description:
      'Terminal. Submit the whole plan; every mutating step is validated, dry-run and possibly confirmed by the OS.',
    input: SubmitPlanInput,
  },
  ask_clarification: {
    name: 'ask_clarification',
    description: 'Terminal. Ask the user one clarifying question.',
    input: AskClarificationInput,
  },
  cannot_comply: {
    name: 'cannot_comply',
    description: 'Terminal. Explain why the request cannot be done.',
    input: CannotComplyInput,
  },
} as const;

export type TerminalToolName = keyof typeof TERMINAL_TOOLS;

/** Every model-facing tool, sorted by name (the server keeps this order byte-stable). */
export const AGENT_TOOL_NAMES = [
  ...Object.keys(READ_ONLY_TOOLS),
  ...Object.keys(TERMINAL_TOOLS),
].sort() as (ReadOnlyToolName | TerminalToolName)[];

/** The mutating plan-step ops (everything except the `find`/`glob` selectors). */
export type MutatingStepOp = Exclude<PlanStepOp, 'find' | 'glob'>;

/** The `args` of each batch op inside a PlanStep: the BatchOp variant without its `op` key. */
const BATCH_OP_ARGS = Object.fromEntries(
  BatchOp.options.map((option) => [option.entries.op.literal, v.omit(option, ['op'])]),
) as unknown as Record<MutatingStepOp, v.GenericSchema>;

/**
 * The schema that re-parses a plan step's `args` (syscall-abi.md §4.4.10 `PlanStep.args`): the
 * `find` arguments for selectors, the matching batch-op variant (without `op`) otherwise.
 */
export function planStepArgsSchema(op: PlanStepOp): v.GenericSchema {
  return op === 'find' || op === 'glob' ? FindArgs : BATCH_OP_ARGS[op];
}
