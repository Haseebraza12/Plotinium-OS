/**
 * The planner's model client: `POST /api/llm/plan` through the kernel host's `fetch`
 * (agentic-shell.md §3.8, §4.3; §12.6 "keys stay on the server").
 *
 * The transcript lives ON THE SERVER (§3.8.1, append-only, TTL 10 min; server/src/llm/routes.ts),
 * so each call sends only the ONE entry the server has not seen, exactly as its `PlanReq` schema
 * (a strict object) requires:
 *
 *   {requestId, turn, userTurn}                               turn 1: the datamarked envelope
 *   {requestId, turn, toolResult: {toolUseId, content, isError?}}  an observation or clarification
 *
 * The gateway applies the stop-reason rules and returns the model's single tool call as data:
 *
 *   200 {kind: 'observe'|'plan'|'clarify'|'cannot', payload, toolUseId, model, usage, …}
 *     observe: payload = {toolUseId, call, args}   (a read-only tool of the catalogue)
 *     plan:    payload = submit_plan input
 *     clarify: payload = ask_clarification input
 *     cannot:  payload = cannot_comply input (or {reason} when the model called no tool)
 *
 * The provider's tool-use ids can be longer than the kernel's `CallId` (64 characters), so the
 * client keeps its own short ids and maps them back when it sends the tool result.
 *
 * The kernel re-parses every tool input with the ORIGINAL Valibot schema (`decodeToolUse`); the
 * payload is data and is never evaluated (AGT-01, I-B1). HTTP failures map to the §3.20 errnos:
 * network → EAIUNAVAIL offline; 401 → EACCES; 409 → EAIUNAVAIL expired; 413 → EINVAL;
 * 429 → EAIUNAVAIL rate|budget; 501/503 → EAIUNAVAIL upstream|no-key; 504 → EAIUNAVAIL timeout;
 * 422 → EAIREFUSED.
 */
import type { Errno } from '@plotinium/protocol';

import type { ModelClient, ModelRequest, ModelResponse, TranscriptEntry } from '../agent/model.ts';
import type { HostFetch } from './types.ts';

export const PLAN_URL = '/api/llm/plan';

/** A failed gateway call, carrying the errno the agent sees. */
export class GatewayError extends Error {
  readonly errno: Errno;
  readonly reason: string;
  readonly retryAfterMs: number | undefined;

  constructor(errno: Errno, reason: string, retryAfterMs?: number) {
    super(`${errno} ${reason}`);
    this.name = 'GatewayError';
    this.errno = errno;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const TOOL_OF_KIND: Record<string, string> = {
  plan: 'submit_plan',
  clarify: 'ask_clarification',
  cannot: 'cannot_comply',
};

/** Map a gateway reply to the model client's single tool call (`id` is the SERVER's id). */
export function toModelResponse(body: unknown, turn: number): ModelResponse {
  if (!isRecord(body) || typeof body['kind'] !== 'string')
    throw new GatewayError('EIO', 'bad-gateway-reply');
  const kind = body['kind'];
  const payload = body['payload'];
  const model = body['model'];
  const served = isRecord(model)
    ? Array.isArray(model['served'])
      ? model['served'].filter((m): m is string => typeof m === 'string').join(',')
      : typeof model['served'] === 'string'
        ? model['served']
        : typeof model['id'] === 'string'
          ? model['id']
          : undefined
    : typeof model === 'string'
      ? model
      : undefined;
  let id = typeof body['toolUseId'] === 'string' ? body['toolUseId'] : `plt_${String(turn)}`;
  let name: string;
  let input: unknown = payload;
  if (kind === 'observe') {
    if (!isRecord(payload)) throw new GatewayError('EIO', 'bad-gateway-reply');
    const n = payload['call'] ?? payload['name'] ?? payload['tool'];
    if (typeof n !== 'string') throw new GatewayError('EIO', 'bad-gateway-reply');
    name = n;
    input = payload['args'] ?? payload['input'];
    const tid = payload['toolUseId'] ?? payload['id'];
    if (typeof tid === 'string') id = tid;
  } else {
    const tool = TOOL_OF_KIND[kind];
    if (tool === undefined) throw new GatewayError('EIO', 'bad-gateway-reply');
    name = tool;
  }
  const res: ModelResponse = { stopReason: 'tool_use', toolUses: [{ id, name, input }], raw: body };
  if (served !== undefined && served !== '') res.servedModel = served;
  return res;
}

function httpError(status: number, body: unknown): GatewayError {
  const detail = isRecord(body) && isRecord(body['detail']) ? body['detail'] : body;
  const reason =
    isRecord(detail) && typeof detail['reason'] === 'string'
      ? detail['reason']
      : isRecord(body) && typeof body['reason'] === 'string'
        ? body['reason']
        : undefined;
  const retry =
    isRecord(detail) && typeof detail['retryAfterMs'] === 'number'
      ? detail['retryAfterMs']
      : isRecord(body) && typeof body['retryAfterMs'] === 'number'
        ? body['retryAfterMs']
        : undefined;
  switch (status) {
    case 401:
    case 403:
      return new GatewayError('EACCES', 'session');
    case 409:
      // 409 EAIUNAVAIL `expired` (the transcript is gone) or EAGAIN `busy` (a turn is running).
      return reason === 'busy'
        ? new GatewayError('EAGAIN', 'busy')
        : new GatewayError('EAIUNAVAIL', 'expired');
    case 400:
    case 413:
      return new GatewayError('EINVAL', status === 413 ? 'too-large' : 'bad-request');
    case 422: {
      // 422 EINVAL: the model's tool input failed the ORIGINAL schema on the server (AGT-01);
      // 422 EAIREFUSED: the model refused (`category`).
      if (isRecord(body) && body['errno'] === 'EINVAL')
        return new GatewayError('EINVAL', 'bad-tool-input');
      const category =
        isRecord(detail) && typeof detail['category'] === 'string' ? detail['category'] : 'refusal';
      return new GatewayError('EAIREFUSED', category);
    }
    case 429:
      return new GatewayError('EAIUNAVAIL', reason === 'budget' ? 'budget' : 'rate', retry);
    case 504:
      return new GatewayError('EAIUNAVAIL', 'timeout');
    case 404:
      // The server runs without AI=1: the /api/llm routes are not registered (C12).
      return new GatewayError('EAIUNAVAIL', 'no-key');
    default:
      return new GatewayError(
        'EAIUNAVAIL',
        reason === 'nokey' || reason === 'no-key' ? 'no-key' : 'upstream',
      );
  }
}

const KERNEL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One request's client: sends each new transcript entry once, in order. */
export class GatewayModelClient implements ModelClient {
  private readonly fetch: HostFetch;
  private readonly requestId: string;
  private readonly url: string;
  private readonly osSessionId: string | undefined;
  private sent = 0;
  private turn = 0;
  /** Kernel-side call id → the provider's tool-use id. */
  private readonly serverIds = new Map<string, string>();

  constructor(
    fetch: HostFetch,
    requestId: string,
    opts: { url?: string; osSessionId?: string } = {},
  ) {
    this.fetch = fetch;
    this.requestId = requestId;
    this.url = opts.url ?? PLAN_URL;
    this.osSessionId = opts.osSessionId;
  }

  /** The one entry this turn sends: the newest non-assistant entry the server has not seen. */
  private nextEntry(transcript: readonly TranscriptEntry[]): TranscriptEntry | undefined {
    const fresh = transcript.slice(this.sent).filter((e) => e.role !== 'assistant');
    this.sent = transcript.length;
    return fresh.at(-1);
  }

  async complete(req: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const entry = this.nextEntry(req.transcript);
    if (entry === undefined) throw new GatewayError('EINVAL', 'nothing-to-send');
    this.turn++;
    const body: Record<string, unknown> = { requestId: this.requestId, turn: this.turn };
    if (entry.role === 'tool_result') {
      const result: Record<string, unknown> = {
        toolUseId: this.serverIds.get(entry.toolUseId) ?? entry.toolUseId,
        content: entry.content,
      };
      if (entry.isError) result['isError'] = true;
      body['toolResult'] = result;
    } else if (entry.role === 'user') {
      body['userTurn'] = entry.text;
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.osSessionId !== undefined) headers['x-plotinium-os-session'] = this.osSessionId;
    let res: Awaited<ReturnType<HostFetch>>;
    try {
      res = await this.fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (e) {
      if (signal?.aborted === true) throw new GatewayError('ECANCELED', 'signal');
      throw new GatewayError(
        'EAIUNAVAIL',
        e instanceof Error && /timeout/i.test(e.message) ? 'timeout' : 'offline',
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (!res.ok) throw httpError(res.status, json);
    const out = toModelResponse(json, this.turn);
    for (const use of out.toolUses) {
      if (KERNEL_CALL_ID.test(use.id)) continue;
      const local = `plt_${String(this.turn)}_${String(this.serverIds.size)}`;
      this.serverIds.set(local, use.id);
      use.id = local;
    }
    return out;
  }
}

/** `GET /api/llm/health` for `ai status` and the ShellNL seam; false on any failure. */
export async function gatewayHealthy(fetch: HostFetch, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch('/api/llm/health', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return isRecord(body) && body['ok'] === true;
  } catch {
    return false;
  }
}
