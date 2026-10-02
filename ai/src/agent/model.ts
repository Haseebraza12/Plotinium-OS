/**
 * The injected model client and the stop-reason rules of one gateway turn (agentic-shell.md §3.8
 * step 6, §3.8.1).
 *
 * - `tool_use` is expected, with exactly one tool call (parallel tool use is disabled).
 * - `end_turn` without a tool call: one retry after a fixed kernel reminder as a NEW user turn.
 * - `max_tokens`: the response is discarded (never appended) and the same request is retried once
 *   with `max_tokens` 16,000.
 * - `refusal`: EAIREFUSED with the category.
 * The transcript is strictly append-only (I-B7): there is no API to edit or remove an entry.
 */
import type { Errno } from '@plotinium/protocol';

import { type Result, fail, ok } from '../util/errors.ts';

export type StopReason =
  'tool_use' | 'end_turn' | 'max_tokens' | 'refusal' | 'pause_turn' | 'stop_sequence';

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelResponse {
  stopReason: StopReason;
  toolUses: ToolUse[];
  /** The provider's full content blocks, appended unchanged (thinking blocks included). */
  raw: unknown;
  /** Refusal category (`stop_details.category`). */
  category?: string;
  servedModel?: string;
}

export type TranscriptEntry =
  | { role: 'user'; text: string }
  | { role: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { role: 'assistant'; raw: unknown };

export interface ModelRequest {
  transcript: readonly TranscriptEntry[];
  maxTokens: number;
}

/** What the gateway (or a cassette replay) provides. */
export interface ModelClient {
  complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

export const MAX_TOKENS = 8_000;
export const MAX_TOKENS_RETRY = 16_000;
export const REMINDER = 'Respond by calling exactly one of the provided tools.';

/** Append-only transcript (I-B7). */
export class Transcript {
  private readonly entries: TranscriptEntry[] = [];

  append(e: TranscriptEntry): void {
    this.entries.push(Object.freeze({ ...e }));
  }

  view(): readonly TranscriptEntry[] {
    return this.entries.slice();
  }

  get length(): number {
    return this.entries.length;
  }
}

export interface TurnBudget {
  /** Model calls left for this request (the 6-turn cap). */
  left: number;
}

function spend(budget: TurnBudget): boolean {
  if (budget.left <= 0) return false;
  budget.left--;
  return true;
}

const unavailable = (errno: Errno, reason: string): Result<ToolUse> => fail(errno, reason);

/** One logical turn: returns the model's single tool call, applying the stop-reason rules. */
export async function nextToolCall(
  client: ModelClient,
  transcript: Transcript,
  budget: TurnBudget,
  signal?: AbortSignal,
): Promise<Result<ToolUse>> {
  let maxTokens = MAX_TOKENS;
  let reminded = false;
  let retriedTokens = false;
  for (;;) {
    if (signal?.aborted === true) return unavailable('ECANCELED', 'signal');
    if (!spend(budget)) return unavailable('ETIMEDOUT', 'turn-limit');
    const res = await client.complete({ transcript: transcript.view(), maxTokens }, signal);
    switch (res.stopReason) {
      case 'refusal':
        return fail('EAIREFUSED', res.category ?? 'refusal');
      case 'max_tokens':
        if (retriedTokens) return unavailable('ETIMEDOUT', 'max-tokens');
        retriedTokens = true;
        maxTokens = MAX_TOKENS_RETRY;
        continue;
      case 'tool_use': {
        transcript.append({ role: 'assistant', raw: res.raw });
        const [only, ...rest] = res.toolUses;
        if (only === undefined || rest.length > 0) return fail('EINVAL', 'one-tool-per-turn');
        return ok(only);
      }
      case 'end_turn':
      case 'stop_sequence':
      case 'pause_turn':
        if (res.toolUses.length === 1 && res.toolUses[0] !== undefined) {
          transcript.append({ role: 'assistant', raw: res.raw });
          return ok(res.toolUses[0]);
        }
        if (reminded) return unavailable('ETIMEDOUT', 'no-tool-call');
        reminded = true;
        transcript.append({ role: 'assistant', raw: res.raw });
        transcript.append({ role: 'user', text: REMINDER });
        continue;
    }
  }
}
