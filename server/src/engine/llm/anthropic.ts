/**
 * The ONLY provider adapter: @anthropic-ai/sdk 0.128.0 (backend-api.md §3.13.4; agentic-shell.md
 * §4.3). Nothing else in the server imports the SDK; other modules take its types from here.
 *
 * Request shape (verified against the Claude API reference, 2026-09-24):
 *   - model from configuration (LLM_MODEL, default claude-opus-5-5; LLM_FALLBACK_MODEL
 *     claude-opus-5 is the same-provider fallback, switched by configuration);
 *   - output_config.effort set EXPLICITLY (Opus 5.5 defaults to medium; thinking is always on);
 *   - no sampling parameters (Opus 5.5 answers 400), except LLM_TEMPERATURE for a model that
 *     accepts it (§3.13.6);
 *   - every tool `strict: true` (additionalProperties false, every key required), sorted by name
 *     and serialised byte-stably; tool_choice {type: 'auto', disable_parallel_tool_use: true}
 *     (forced tool_choice answers 400 on Opus 5.5);
 *   - prompt caching: cache_control {type: 'ephemeral'} on the last tool (caches the tool list)
 *     and on the frozen system block (caches tools + system); volatile content follows in messages;
 *   - refusal fallbacks: betas ['server-side-fallback-2026-07-01'] + fallbacks 'default' on
 *     interactive calls (not for batch evaluations); the served model is read from the response.
 *   - streamed with `finalMessage()`, an AbortSignal, a per-turn deadline and maxRetries 1.
 * Key handling: the key comes from the server configuration (ANTHROPIC_API_KEY_FILE /
 * ANTHROPIC_API_KEY, read once by config.ts) and is passed explicitly, so the SDK never falls
 * back to another credential source; it never reaches a log, a response, a cassette or a client.
 */
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTool,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import { defaultStatusFor, ErrnoError, type Errno } from '../../errno.ts';
import { HttpError } from '../../http/errors.ts';
import { sortKeysDeep, type FetchLike } from './cassette.ts';
import type { TokenUsage } from './pricing.ts';
import { assertStrictTools } from './strict-tools.ts';

export type { BetaMessage, BetaMessageParam, BetaMessageStreamParams, BetaTool };

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export function parseEffort(s: string): Effort {
  return (EFFORTS as readonly string[]).includes(s) ? (s as Effort) : 'medium';
}

// ---------------------------------------------------------------------------------------------
// The narrow client surface the adapter uses (the real SDK client satisfies it; tests fake it)
// ---------------------------------------------------------------------------------------------

export interface StreamRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
  readonly maxRetries?: number;
}

export interface MessageStreamLike {
  finalMessage(): Promise<BetaMessage>;
  readonly request_id?: string | null | undefined;
}

export interface MessagesStreamClient {
  readonly beta: {
    readonly messages: {
      stream(body: BetaMessageStreamParams, options?: StreamRequestOptions): MessageStreamLike;
    };
  };
}

export interface ProviderReply {
  readonly message: BetaMessage;
  /** The provider's `request-id` header, when known. */
  readonly requestId: string | null;
}

/** What the gateway needs from a provider: one streamed Messages call. */
export interface LlmProvider {
  readonly name: string;
  send(
    params: BetaMessageStreamParams,
    opts: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<ProviderReply>;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly #client: MessagesStreamClient;
  readonly #maxRetries: number;

  constructor(client: MessagesStreamClient, maxRetries = 1) {
    this.#client = client;
    this.#maxRetries = maxRetries;
  }

  async send(
    params: BetaMessageStreamParams,
    opts: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<ProviderReply> {
    const stream = this.#client.beta.messages.stream(params, {
      signal: opts.signal,
      timeout: opts.timeoutMs,
      maxRetries: this.#maxRetries,
    });
    const message = await stream.finalMessage();
    return { message, requestId: stream.request_id ?? null };
  }
}

export interface AnthropicClientOptions {
  /** From the server configuration only. In replay mode any placeholder works: nothing is sent. */
  readonly apiKey: string;
  /** A cassette fetch (replay / record); omitted: the platform fetch (live). */
  readonly fetch?: FetchLike;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

export function createAnthropicClient(o: AnthropicClientOptions): Anthropic {
  return new Anthropic({
    apiKey: o.apiKey,
    authToken: null,
    baseURL: ANTHROPIC_BASE_URL,
    maxRetries: o.maxRetries ?? 1,
    ...(o.timeoutMs === undefined ? {} : { timeout: o.timeoutMs }),
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
}

// ---------------------------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------------------------

export interface BuildParamsInput {
  readonly model: string;
  readonly maxTokens: number;
  readonly effort: Effort;
  /** The frozen system prompt (byte-stable: it is the cached prefix). */
  readonly system: string;
  /** Strict tools; sorted and marked here. */
  readonly tools: readonly BetaTool[];
  /** The append-only transcript, full content blocks. */
  readonly messages: readonly BetaMessageParam[];
  /** Server-side refusal fallbacks (interactive calls only). */
  readonly fallbacks: boolean;
  /** Only for a model that accepts sampling parameters (LLM_TEMPERATURE). */
  readonly temperature?: number | undefined;
}

export function buildMessageParams(p: BuildParamsInput): BetaMessageStreamParams {
  assertStrictTools(p.tools);
  const sorted = [...p.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const tools: BetaToolUnion[] = sorted.map((t, i) => {
    const { cache_control: _cacheControl, strict: _strict, input_schema, ...rest } = t;
    const tool: BetaTool = {
      ...rest,
      input_schema: sortKeysDeep(input_schema) as BetaTool['input_schema'],
      strict: true,
    };
    if (i === sorted.length - 1) tool.cache_control = { type: 'ephemeral' };
    return tool;
  });
  const params: BetaMessageStreamParams = {
    model: p.model,
    max_tokens: p.maxTokens,
    output_config: { effort: p.effort },
    system: [{ type: 'text', text: p.system, cache_control: { type: 'ephemeral' } }],
    messages: [...p.messages],
  };
  if (tools.length > 0) {
    params.tools = tools;
    params.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
  }
  if (p.fallbacks) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  if (p.temperature !== undefined) params.temperature = p.temperature;
  return params;
}

// ---------------------------------------------------------------------------------------------
// Reading a response
// ---------------------------------------------------------------------------------------------

export function usageOf(message: BetaMessage): TokenUsage {
  const u = message.usage;
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  };
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** The (single, parallel use is disabled) tool_use block of a response, or null. */
export function toolCallOf(message: BetaMessage): ToolCall | null {
  for (const b of message.content) {
    if (b.type === 'tool_use') return { id: b.id, name: b.name, input: b.input };
  }
  return null;
}

export function textOf(message: BetaMessage): string {
  let s = '';
  for (const b of message.content) if (b.type === 'text') s += b.text;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Errors (typed SDK errors, most specific first) -> the gateway's degraded states (§3.13.7)
// ---------------------------------------------------------------------------------------------

export interface FailureContext {
  /** The per-turn deadline fired. */
  readonly deadline: boolean;
  /** The caller's signal fired (client gone, agent killed). */
  readonly cancelled: boolean;
}

export interface ClassifiedFailure {
  readonly error: HttpError;
  /** A provider 400/404 means our request is wrong: logged at error level and alerted. */
  readonly bug: boolean;
}

function errnoInChain(e: unknown): ErrnoError | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && cur !== null && cur !== undefined; depth++) {
    if (cur instanceof ErrnoError) return cur;
    cur =
      typeof cur === 'object' && 'cause' in cur ? (cur as { cause?: unknown }).cause : undefined;
  }
  return null;
}

function retryAfterOf(e: APIError): number | undefined {
  const h = e.headers?.get('retry-after');
  if (h === null || h === undefined) return undefined;
  const s = Number(h);
  return Number.isFinite(s) && s >= 0 ? Math.ceil(s * 1000) : undefined;
}

const aiUnavailable = (
  status: number,
  reason: string,
  msg: string,
  retryAfterMs?: number,
): HttpError => new HttpError(status, 'EAIUNAVAIL', msg, { reason }, retryAfterMs);

/** Maps any failure of a provider call to the HttpError the route answers with. */
export function classifyProviderError(e: unknown, ctx: FailureContext): ClassifiedFailure {
  if (e instanceof HttpError) return { error: e, bug: false };
  if (ctx.deadline || e instanceof APIConnectionTimeoutError) {
    return {
      error: aiUnavailable(504, 'timeout', 'agent unavailable (model service timeout)'),
      bug: false,
    };
  }
  if (ctx.cancelled || e instanceof APIUserAbortError) {
    return {
      error: new HttpError(defaultStatusFor('ECANCELED'), 'ECANCELED', 'model call cancelled', {
        reason: 'killed',
      }),
      bug: false,
    };
  }
  const inner = errnoInChain(e);
  if (inner !== null) {
    const errno: Errno = inner.errno;
    const reason = inner.reason ?? (errno === 'EAIUNAVAIL' ? 'upstream' : undefined);
    const status =
      errno === 'EAIUNAVAIL'
        ? reason === 'rate' || reason === 'budget'
          ? 429
          : reason === 'timeout'
            ? 504
            : 503
        : defaultStatusFor(errno);
    const detail = reason === undefined ? { ...inner.detail } : { ...inner.detail, reason };
    return { error: new HttpError(status, errno, inner.message, detail), bug: false };
  }
  if (e instanceof AuthenticationError) {
    return {
      error: aiUnavailable(503, 'no-key', 'agent unavailable (model service key rejected)'),
      bug: true,
    };
  }
  if (e instanceof BadRequestError || e instanceof NotFoundError) {
    return {
      error: aiUnavailable(503, 'upstream', 'agent unavailable (model service)'),
      bug: true,
    };
  }
  if (e instanceof RateLimitError) {
    return {
      error: aiUnavailable(
        503,
        'upstream',
        'agent unavailable (model service busy)',
        retryAfterOf(e),
      ),
      bug: false,
    };
  }
  if (e instanceof APIError || e instanceof APIConnectionError) {
    return {
      error: aiUnavailable(503, 'upstream', 'agent unavailable (model service)'),
      bug: false,
    };
  }
  return { error: aiUnavailable(503, 'upstream', 'agent unavailable (model service)'), bug: true };
}
