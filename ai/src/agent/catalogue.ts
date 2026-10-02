/**
 * The agent's tool catalogue (agentic-shell.md §3.6; AGT-01, ABI-14).
 *
 * Every model-facing tool is the input schema of EXACTLY ONE system call, defined once in
 * `protocol/ai/tools.ts`:
 * - read-only tools run immediately as their syscall (`readdir`, `stat`, `find`, `grep`, `du`, `wc`);
 * - mutating operations are only the variants of `submit_plan.steps[].op`, re-parsed by the
 *   kernel with `batch` (or `find` for selectors) and executed only through `batch`;
 * - the terminal tools end a turn: `submit_plan` → `ai.agent.submit`, `ask_clarification` and
 *   `cannot_comply` → the planning turn of `ai.agent.plan`.
 *
 * Model input is parsed as data with the original Valibot schemas (through Standard Schema, see
 * util/schema.ts) and never evaluated (I-B1).
 */
import {
  CALLS,
  type CallName,
  READ_ONLY_TOOLS,
  type ReadOnlyTool,
  type ReadOnlyToolName,
  STEP_SYSCALL,
  TERMINAL_TOOLS,
  type TerminalToolName,
} from '@plotinium/protocol';

import { type Result, fail, ok } from '../util/errors.ts';
import { type Schema, parseWith } from '../util/schema.ts';

export type ToolKind = 'read-only' | 'step' | 'terminal';

export interface CatalogueEntry {
  readonly name: string;
  readonly kind: ToolKind;
  /** The one system call whose argument schema the tool maps to. */
  readonly syscall: CallName;
}

const TERMINAL_SYSCALL: Record<TerminalToolName, CallName> = {
  submit_plan: 'ai.agent.submit',
  ask_clarification: 'ai.agent.plan',
  cannot_comply: 'ai.agent.plan',
};

/** Every tool and plan-step op with its syscall, sorted by name. */
export function toolCatalogue(): CatalogueEntry[] {
  const out: CatalogueEntry[] = [];
  for (const name of Object.keys(READ_ONLY_TOOLS) as ReadOnlyToolName[]) {
    out.push({ name, kind: 'read-only', syscall: READ_ONLY_TOOLS[name].call });
  }
  for (const [op, call] of Object.entries(STEP_SYSCALL))
    out.push({ name: `step:${op}`, kind: 'step', syscall: call });
  for (const name of Object.keys(TERMINAL_TOOLS) as TerminalToolName[]) {
    out.push({ name, kind: 'terminal', syscall: TERMINAL_SYSCALL[name] });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function isReadOnlyToolName(name: string): name is ReadOnlyToolName {
  return Object.hasOwn(READ_ONLY_TOOLS, name);
}

export function isTerminalToolName(name: string): name is TerminalToolName {
  return Object.hasOwn(TERMINAL_TOOLS, name);
}

export interface SyscallCall {
  call: ReadOnlyTool;
  args: unknown;
}

/**
 * A read-only tool call as its one syscall: parse the model input with the tool schema, convert it
 * with `toArgs`, then re-parse with the syscall's own argument schema (every limit the JSON Schema
 * export stripped is enforced here). Any failure is EINVAL and nothing runs.
 */
export function readOnlyCall(name: string, input: unknown): Result<SyscallCall> {
  if (!isReadOnlyToolName(name)) return fail('EINVAL', 'unknown-tool');
  const tool = READ_ONLY_TOOLS[name];
  const parsed = parseWith(tool.input as Schema<never>, input);
  if (!parsed.ok) return fail('EINVAL', 'bad-arguments', undefined, parsed.message);
  const reparsed = parseWith(CALLS[tool.call].args as Schema<unknown>, tool.toArgs(parsed.value));
  if (!reparsed.ok) return fail('EINVAL', 'bad-arguments', undefined, reparsed.message);
  return ok({ call: tool.call, args: reparsed.value });
}
