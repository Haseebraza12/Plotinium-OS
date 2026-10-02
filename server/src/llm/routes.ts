/**
 * llm/: the LLM gateway routes (backend-api.md §3.13; agentic-shell.md §3.8, §4.3;
 * rag-semantic-search.md §3.11; spec §12.6, SRV-13). Primary owner R4, secondary reviewer R5.
 * Registered only when AI=1 (SRV-18). The provider key lives only in the server environment; the
 * pipeline (per-uid buckets, the in-flight semaphore, budget reserve and settle, the provider call
 * outside any transaction, llm_requests logging, stop-reason rules, cassettes in replay mode) is
 * engine/llm/gateway.ts. With no key the gateway answers 503 EAIUNAVAIL `no-key` and everything
 * else keeps working (C12).
 *
 * POST /api/llm/plan     {requestId, turn, userTurn | toolResult} -> one planner turn:
 *                        {kind: 'observe'|'plan'|'clarify'|'cannot', payload, toolUseId, model,
 *                         requestIdUpstream, usage, costMicroUsd, latencyMs}
 *                        The transcript stays on the server (./transcripts.ts); 409 EAIUNAVAIL
 *                        `expired` when it is gone.
 * POST /api/llm/extract  the quarantined extraction: {requestId, toolUseId, source: {path}, text,
 *                        what} -> {items} (values the planner never sees)
 * POST /api/llm/answer   the optional RAG answer: {requestId, question, passages} -> {sentences}
 * GET  /api/llm/health   {ok, model, degradedReason?, budgetLeftMicroUsd}
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as v from 'valibot';

import { AGENT_TURNS_MAX, UuidV7 } from '@plotinium/protocol';

import type { BetaMessageParam } from '../engine/llm/anthropic.ts';
import type { LlmCaller, LlmGateway, LlmTurnResult } from '../engine/llm/index.ts';
import type { AuthState } from '../gateway/sessions.ts';
import { HttpError } from '../http/errors.ts';
import { parseInput } from '../http/validate.ts';
import {
  buildAnswerTools,
  buildExtractTools,
  buildPlanTools,
  type ModelTool,
  type ToolKind,
} from './tools.ts';
import { TranscriptStore } from './transcripts.ts';

const KIB = 1024;

function prompt(name: string): string {
  return readFileSync(new URL(`./prompts/${name}`, import.meta.url), 'utf8');
}

/** The frozen prompts; their SHA-256 is logged at startup (a change is a new version). */
export const SYSTEM_V1 = prompt('system-v1.md');
export const EXTRACT_V1 = prompt('extract-v1.md');
export const ANSWER_V1 = prompt('answer-v1.md');

export function promptHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const Text = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max));
const ToolUseId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,128}$/));

export const PlanReq = v.pipe(
  v.strictObject({
    requestId: UuidV7,
    turn: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(AGENT_TURNS_MAX)),
    /** Turn 1: the rendered envelope; later: a clarification answer as a new user turn. */
    userTurn: v.optional(Text(60_000)),
    /** The datamarked result of the observation the previous turn asked for. */
    toolResult: v.optional(
      v.strictObject({
        toolUseId: ToolUseId,
        content: Text(60_000),
        isError: v.optional(v.boolean()),
      }),
    ),
  }),
  v.check(
    (b) => (b.userTurn === undefined) !== (b.toolResult === undefined),
    'exactly one of userTurn and toolResult',
  ),
  v.check((b) => b.turn > 1 || b.userTurn !== undefined, 'turn 1 carries userTurn'),
);

export const ExtractReq = v.strictObject({
  requestId: UuidV7,
  toolUseId: ToolUseId,
  source: v.strictObject({ path: Text(4096) }),
  /** Datamarked by the kernel, at most 32 KiB of file text. */
  text: v.pipe(v.string(), v.maxBytes(32 * KIB + 4 * KIB)),
  what: Text(500),
});

export const AnswerReq = v.strictObject({
  requestId: UuidV7,
  question: Text(2000),
  /** Datamarked retrieved passages (already readable-filtered and verified by the kernel). */
  passages: v.pipe(v.string(), v.maxBytes(48 * KIB)),
});

export interface LlmPluginOptions {
  readonly gateway: LlmGateway;
  readonly transcripts?: TranscriptStore;
  readonly log?: (fields: Record<string, unknown>, msg: string) => void;
}

interface TurnReply {
  readonly model: LlmTurnResult['model'];
  readonly requestIdUpstream: string | null;
  readonly usage: LlmTurnResult['usage'];
  readonly costMicroUsd: number;
  readonly latencyMs: number;
}

function meta(r: LlmTurnResult): TurnReply {
  return {
    model: r.model,
    requestIdUpstream: r.requestIdUpstream,
    usage: r.usage,
    costMicroUsd: r.costMicroUsd,
    latencyMs: r.latencyMs,
  };
}

/** The model's single tool call, re-parsed with the ORIGINAL Valibot schema (422 EINVAL). */
export function parsedCall(
  r: LlmTurnResult,
  tools: readonly ModelTool[],
): {
  readonly kind: ToolKind;
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
} | null {
  const call = r.toolCall;
  if (call === null) return null;
  const tool = tools.find((t) => t.definition.name === call.name);
  if (tool === undefined)
    throw new HttpError(422, 'EINVAL', 'the model called an unknown tool', {
      field: 'tool',
      tool: call.name,
    });
  const parsed = v.safeParse(tool.schema, call.input);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    throw new HttpError(422, 'EINVAL', 'the model returned an invalid tool input', {
      tool: call.name,
      field: issue === undefined ? '' : (v.getDotPath(issue) ?? ''),
    });
  }
  return { kind: tool.kind, id: call.id, name: call.name, input: parsed.output };
}

export function llmPlugin(app: FastifyInstance, opts: LlmPluginOptions): Promise<void> {
  const { gateway } = opts;
  const transcripts = opts.transcripts ?? new TranscriptStore();
  const planTools = buildPlanTools();
  const extractTools = buildExtractTools();
  const answerTools = buildAnswerTools();
  opts.log?.(
    {
      system: promptHash(SYSTEM_V1).slice(0, 16),
      extract: promptHash(EXTRACT_V1).slice(0, 16),
      answer: promptHash(ANSWER_V1).slice(0, 16),
      tools: planTools.map((t) => t.definition.name),
    },
    'llm prompts and tools loaded',
  );

  const post = {
    bodyLimit: 64 * KIB,
    config: { rateClass: 'llm' as const, rateErrno: 'EAIUNAVAIL' as const },
  };

  const authOf = (request: FastifyRequest): AuthState => {
    const auth = request.plt.auth ?? null;
    if (auth === null) throw new HttpError(401, 'EACCES', 'not logged in');
    return auth;
  };
  const callerOf = (request: FastifyRequest, auth: AuthState): LlmCaller => {
    const os = request.headers['x-plotinium-os-session'];
    return {
      uid: auth.uid,
      kind: auth.kind,
      osSessionId: typeof os === 'string' && /^[0-9a-f-]{36}$/.test(os) ? os : null,
      pid: null,
    };
  };
  /** Aborts the provider call when the client goes away before the reply was sent. */
  const abortOnClose = (reply: FastifyReply): AbortSignal => {
    const ac = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) ac.abort();
    });
    return ac.signal;
  };

  app.post('/api/llm/plan', post, async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = authOf(request);
    const body = parseInput(PlanReq, request.body);
    if (!transcripts.begin(body.requestId))
      throw new HttpError(409, 'EAGAIN', 'a turn of this request is already running', {
        reason: 'busy',
      });
    try {
      let prior: readonly BetaMessageParam[] = [];
      let pending: string | null = null;
      if (body.turn > 1) {
        const found = transcripts.get(body.requestId, auth.uid);
        if (!found.ok)
          throw new HttpError(409, 'EAIUNAVAIL', 'conversation expired — please retry', {
            reason: 'expired',
          });
        if (found.transcript.turn + 1 !== body.turn)
          throw new HttpError(409, 'EINVAL', 'turns must follow each other', {
            reason: 'turn-order',
            field: 'turn',
            expected: found.transcript.turn + 1,
          });
        prior = found.transcript.messages;
        pending = found.transcript.pendingToolUseId;
      }
      let user: BetaMessageParam;
      if (body.toolResult !== undefined) {
        if (pending === null || body.toolResult.toolUseId !== pending)
          throw new HttpError(400, 'EINVAL', 'toolResult does not answer the pending call', {
            field: 'toolResult.toolUseId',
          });
        user = {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: pending,
              content: body.toolResult.content,
              ...(body.toolResult.isError === true ? { is_error: true } : {}),
            },
          ],
        };
      } else {
        const text = body.userTurn ?? '';
        // After any tool call the API needs a tool_result: a clarification answer answers it.
        user =
          pending === null
            ? { role: 'user', content: text }
            : {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: pending, content: text }],
              };
      }
      const messages = [...prior, user];
      const result = await gateway.call({
        caller: callerOf(request, auth),
        purpose: 'plan',
        promptId: body.requestId,
        turn: body.turn,
        system: SYSTEM_V1,
        tools: planTools.map((t) => ({ definition: t.definition })),
        messages,
        signal: abortOnClose(reply),
      });
      const call = parsedCall(result, planTools);
      transcripts.put(body.requestId, {
        uid: auth.uid,
        turn: body.turn,
        messages: [
          ...messages,
          ...result.appended,
          { role: 'assistant', content: result.message.content },
        ],
        pendingToolUseId: call?.id ?? null,
      });
      const kind = call === null ? 'cannot' : call.kind;
      const payload =
        call === null
          ? { reason: result.text.trim().slice(0, 1000) || 'the model did not call a tool' }
          : call.kind === 'observe'
            ? { toolUseId: call.id, call: call.name, args: call.input }
            : call.input;
      return await reply.send({ kind, payload, toolUseId: call?.id ?? null, ...meta(result) });
    } finally {
      transcripts.end(body.requestId);
    }
  });

  app.post('/api/llm/extract', post, async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = authOf(request);
    const body = parseInput(ExtractReq, request.body);
    const result = await gateway.call({
      caller: callerOf(request, auth),
      purpose: 'extract',
      promptId: body.requestId,
      system: EXTRACT_V1,
      tools: extractTools.map((t) => ({ definition: t.definition })),
      messages: [
        {
          role: 'user',
          content: `<what>${JSON.stringify(body.what)}</what>\n<source>${JSON.stringify(body.source.path)}</source>\n${body.text}`,
        },
      ],
      signal: abortOnClose(reply),
    });
    const call = parsedCall(result, extractTools);
    const items = call === null ? [] : (call.input as { items: string[] }).items;
    return reply.send({ items, ...meta(result) });
  });

  app.post('/api/llm/answer', post, async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = authOf(request);
    const body = parseInput(AnswerReq, request.body);
    const result = await gateway.call({
      caller: callerOf(request, auth),
      purpose: 'answer',
      promptId: body.requestId,
      system: ANSWER_V1,
      tools: answerTools.map((t) => ({ definition: t.definition })),
      messages: [
        {
          role: 'user',
          content: `<question>${JSON.stringify(body.question)}</question>\n${body.passages}`,
        },
      ],
      signal: abortOnClose(reply),
    });
    const call = parsedCall(result, answerTools);
    const sentences =
      call === null
        ? []
        : (call.input as { sentences: { text: string; chunk_ids: string[] }[] }).sentences;
    return reply.send({ sentences, ...meta(result) });
  });

  app.get(
    '/api/llm/health',
    { config: { rateClass: 'api' } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = authOf(request);
      return reply.send(await gateway.health(callerOf(request, auth)));
    },
  );

  return Promise.resolve();
}
