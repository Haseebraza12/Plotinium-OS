/**
 * Decode one model tool call into a planning turn, as data only (AGT-01, I-B1).
 *
 * The input is parsed with the tool's ORIGINAL Valibot schema from protocol (every limit the JSON
 * Schema export stripped is enforced here) and converted to syscall arguments or ABI plan steps.
 * Model output is never evaluated, never concatenated into a command and never run as text.
 */
import {
  AskClarificationInput,
  CannotComplyInput,
  type PlanStep,
  type ReadOnlyTool,
  SubmitPlanInput,
  toPlanStep,
} from '@plotinium/protocol';

import { type Result, fail, ok } from '../util/errors.ts';
import { type Schema, parseWith } from '../util/schema.ts';
import { isReadOnlyToolName, readOnlyCall } from './catalogue.ts';
import type { ToolUse } from './model.ts';

export type Decoded =
  | { kind: 'tool'; callId: string; call: ReadOnlyTool; args: unknown }
  | {
      kind: 'plan';
      callId: string;
      steps: PlanStep[];
      summary: string;
      assumptions: string[];
      suspicious: boolean;
    }
  | { kind: 'clarify'; callId: string; question: string; options: string[]; reason: string }
  | { kind: 'cannot'; callId: string; reason: string };

type SubmitPlan = {
  summary: string;
  steps: Array<Parameters<typeof toPlanStep>[0]>;
  assumptions: string[];
  suspicious_content_seen: boolean;
};

const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function decodeToolUse(use: ToolUse, umask: number): Result<Decoded> {
  if (!CALL_ID.test(use.id)) return fail('EINVAL', 'bad-call-id');
  if (isReadOnlyToolName(use.name)) {
    const c = readOnlyCall(use.name, use.input);
    return c.ok ? ok({ kind: 'tool', callId: use.id, call: c.value.call, args: c.value.args }) : c;
  }
  switch (use.name) {
    case 'submit_plan': {
      const p = parseWith(SubmitPlanInput as unknown as Schema<SubmitPlan>, use.input);
      if (!p.ok) return fail('EINVAL', 'bad-arguments', undefined, p.message);
      const steps: PlanStep[] = [];
      for (const s of p.value.steps) {
        const step = toPlanStep(s, umask);
        if (step === undefined) return fail('EINVAL', 'bad-mode', s.id);
        steps.push(step);
      }
      return ok({
        kind: 'plan',
        callId: use.id,
        steps,
        summary: p.value.summary,
        assumptions: p.value.assumptions,
        suspicious: p.value.suspicious_content_seen,
      });
    }
    case 'ask_clarification': {
      const p = parseWith(
        AskClarificationInput as unknown as Schema<{
          question: string;
          options: string[];
          reason: string;
        }>,
        use.input,
      );
      if (!p.ok) return fail('EINVAL', 'bad-arguments', undefined, p.message);
      return ok({
        kind: 'clarify',
        callId: use.id,
        question: p.value.question,
        options: p.value.options,
        reason: p.value.reason,
      });
    }
    case 'cannot_comply': {
      const p = parseWith(CannotComplyInput as unknown as Schema<{ reason: string }>, use.input);
      if (!p.ok) return fail('EINVAL', 'bad-arguments', undefined, p.message);
      return ok({ kind: 'cannot', callId: use.id, reason: p.value.reason });
    }
    default:
      return fail('EINVAL', 'unknown-tool');
  }
}
