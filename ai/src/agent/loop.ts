/**
 * The observation-loop driver (agentic-shell.md §3.8, §3.9; AIN-B1, AGT-07).
 *
 * Turn 1 sends the datamarked envelope. Each read-only tool call is executed as exactly ONE
 * syscall with the agent's own credentials (the injected `runTool` is the port-bound sys client)
 * and its result goes back datamarked. The loop ends with a plan (`submit_plan`), a question the
 * user must answer (`ask_clarification`, at most 2 rounds), or `cannot_comply`. At most 6 model
 * turns per request, observations and clarifications included, and a 120 s request deadline;
 * hitting a cap ends with ETIMEDOUT and nothing runs.
 */
import type { Errno, PlanStep, ReadOnlyTool } from '@plotinium/protocol';
import { AGENT_TURNS_MAX } from '@plotinium/protocol';

import type { RandomSource } from '../util/rng.ts';
import { decodeToolUse } from './decode.ts';
import {
  type KernelContext,
  type ListingEntry,
  renderClarification,
  renderFirstTurn,
} from './envelope.ts';
import { type ModelClient, Transcript, type TurnBudget, nextToolCall } from './model.ts';
import { type ToolOutcome, observedPaths, renderObservation } from './observe.ts';

export const CLARIFY_ROUNDS_MAX = 2;
export const REQUEST_DEADLINE_MS = 120_000;
export const LIMIT_MESSAGE = 'ai: could not produce a plan within the limits — nothing was run';

export interface ObservationLog {
  turn: number;
  call: ReadOnlyTool;
  args: unknown;
  ok: boolean;
  errno?: Errno;
}

export interface LoopDeps {
  model: ModelClient;
  /** Exactly one read-only syscall as the agent (`sys[call](args)`). */
  runTool(call: ReadOnlyTool, args: unknown): Promise<ToolOutcome>;
  /** Ask the user; undefined when stdin is not interactive or at EOF. */
  clarify?(question: string, options: readonly string[]): Promise<string | undefined>;
  rng: RandomSource;
  umask: number;
  now(): number;
  signal?: AbortSignal;
}

export interface LoopInput {
  request: string;
  context: KernelContext;
  listing: readonly ListingEntry[];
  listingTotal: number;
}

interface Common {
  turns: number;
  clarifications: string[];
  observations: ObservationLog[];
  transcript: Transcript;
}

export type LoopOutcome = Common &
  (
    | {
        kind: 'plan';
        steps: PlanStep[];
        summary: string;
        assumptions: string[];
        suspicious: boolean;
        observed: Set<string>;
      }
    | { kind: 'needs-clarification'; question: string; options: string[] }
    | { kind: 'cannot'; reason: string }
    | { kind: 'error'; errno: Errno; reason?: string; message?: string }
  );

export async function runObservationLoop(input: LoopInput, deps: LoopDeps): Promise<LoopOutcome> {
  const transcript = new Transcript();
  const budget: TurnBudget = { left: AGENT_TURNS_MAX };
  const start = deps.now();
  const clarifications: string[] = [];
  const observations: ObservationLog[] = [];
  const observed = new Set<string>();
  const common = (): Common => ({
    turns: AGENT_TURNS_MAX - budget.left,
    clarifications,
    observations,
    transcript,
  });
  const error = (errno: Errno, reason?: string, message?: string): LoopOutcome => {
    const e: LoopOutcome = { ...common(), kind: 'error', errno };
    if (reason !== undefined) e.reason = reason;
    if (message !== undefined) e.message = message;
    return e;
  };

  const first = renderFirstTurn({ ...input, rng: deps.rng });
  transcript.append({ role: 'user', text: first.text });

  for (;;) {
    if (deps.now() - start > REQUEST_DEADLINE_MS)
      return error('ETIMEDOUT', 'deadline', LIMIT_MESSAGE);
    const use = await nextToolCall(deps.model, transcript, budget, deps.signal);
    if (!use.ok) {
      const msg = use.error.errno === 'ETIMEDOUT' ? LIMIT_MESSAGE : use.error.message;
      return error(use.error.errno, use.error.reason, msg);
    }
    const d = decodeToolUse(use.value, deps.umask);
    if (!d.ok) return error(d.error.errno, d.error.reason, d.error.message);
    const turn = AGENT_TURNS_MAX - budget.left;
    switch (d.value.kind) {
      case 'tool': {
        const { call, args, callId } = d.value;
        if (deps.signal?.aborted === true) return error('ECANCELED', 'signal');
        const outcome = await deps.runTool(call, args);
        const log: ObservationLog = { turn, call, args, ok: outcome.ok };
        if (!outcome.ok) log.errno = outcome.errno;
        observations.push(log);
        if (outcome.ok) for (const p of observedPaths(call, args, outcome.value)) observed.add(p);
        const r = renderObservation(call, args, outcome, deps.rng, input.context.tz);
        transcript.append({
          role: 'tool_result',
          toolUseId: callId,
          content: r.content,
          isError: r.isError,
        });
        continue;
      }
      case 'clarify': {
        const { question, options, callId } = d.value;
        if (clarifications.length >= CLARIFY_ROUNDS_MAX || deps.clarify === undefined) {
          if (clarifications.length >= CLARIFY_ROUNDS_MAX)
            return error('ETIMEDOUT', 'clarify-limit', LIMIT_MESSAGE);
          return { ...common(), kind: 'needs-clarification', question, options };
        }
        const answer = await deps.clarify(question, options);
        if (answer === undefined)
          return { ...common(), kind: 'needs-clarification', question, options };
        clarifications.push(answer);
        transcript.append({
          role: 'tool_result',
          toolUseId: callId,
          content: renderClarification(answer),
          isError: false,
        });
        continue;
      }
      case 'plan':
        return {
          ...common(),
          kind: 'plan',
          steps: d.value.steps,
          summary: d.value.summary,
          assumptions: d.value.assumptions,
          suspicious: d.value.suspicious,
          observed,
        };
      case 'cannot':
        return { ...common(), kind: 'cannot', reason: d.value.reason };
    }
  }
}
