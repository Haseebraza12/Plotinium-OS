/**
 * Test doubles for the LLM engine: provider responses as SDK messages, the same responses as a
 * raw SSE stream (what a cassette stores), and a fake SDK client (MessagesStreamClient).
 */
import type {
  BetaMessage,
  BetaMessageStreamParams,
  MessageStreamLike,
  MessagesStreamClient,
  StreamRequestOptions,
} from '../anthropic.ts';

export interface FakeReply {
  readonly model?: string;
  readonly stopReason?: 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal' | 'pause_turn';
  readonly category?:
    'cyber' | 'bio' | 'frontier_llm' | 'reasoning_extraction' | 'general_harms' | null;
  readonly text?: string;
  readonly tool?: { readonly name: string; readonly input: unknown; readonly id?: string };
  readonly usage?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly cacheWrite1h?: number;
  };
}

export function fakeMessage(r: FakeReply = {}): BetaMessage {
  const content: unknown[] = [];
  if (r.text !== undefined) content.push({ type: 'text', text: r.text, citations: null });
  if (r.tool !== undefined) {
    content.push({
      type: 'tool_use',
      id: r.tool.id ?? 'toolu_01',
      name: r.tool.name,
      input: r.tool.input,
    });
  }
  const u = r.usage ?? {};
  const msg = {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: r.model ?? 'claude-opus-5-5',
    content,
    container: null,
    context_management: null,
    diagnostics: null,
    stop_reason: r.stopReason ?? (r.tool === undefined ? 'end_turn' : 'tool_use'),
    stop_sequence: null,
    stop_details:
      r.stopReason === 'refusal'
        ? { type: 'refusal', category: r.category ?? null, explanation: null }
        : null,
    usage: {
      input_tokens: u.input ?? 1000,
      output_tokens: u.output ?? 200,
      cache_read_input_tokens: u.cacheRead ?? 0,
      cache_creation_input_tokens: u.cacheWrite ?? 0,
      cache_creation:
        u.cacheWrite1h === undefined
          ? null
          : { ephemeral_1h_input_tokens: u.cacheWrite1h, ephemeral_5m_input_tokens: 0 },
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
      speed: null,
    },
  };
  return msg as unknown as BetaMessage;
}

/** The SSE stream the Messages API would send for `r` (what a cassette stores in `sse`). */
export function sseFor(r: FakeReply = {}): string {
  const u = r.usage ?? {};
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: r.model ?? 'claude-opus-5-5',
          content: [],
          container: null,
          context_management: null,
          diagnostics: null,
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: u.input ?? 1000,
            output_tokens: 1,
            cache_read_input_tokens: u.cacheRead ?? 0,
            cache_creation_input_tokens: u.cacheWrite ?? 0,
          },
        },
      },
    ],
  ];
  let index = 0;
  if (r.text !== undefined) {
    events.push([
      'content_block_start',
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ]);
    events.push([
      'content_block_delta',
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text: r.text } },
    ]);
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
    index++;
  }
  if (r.tool !== undefined) {
    events.push([
      'content_block_start',
      {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: r.tool.id ?? 'toolu_01',
          name: r.tool.name,
          input: {},
        },
      },
    ]);
    events.push([
      'content_block_delta',
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(r.tool.input) },
      },
    ]);
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  }
  events.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: {
        stop_reason: r.stopReason ?? (r.tool === undefined ? 'end_turn' : 'tool_use'),
        stop_sequence: null,
        stop_details:
          r.stopReason === 'refusal'
            ? { type: 'refusal', category: r.category ?? null, explanation: null }
            : null,
      },
      usage: { output_tokens: u.output ?? 200 },
    },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

export interface FakeCall {
  readonly params: BetaMessageStreamParams;
  readonly options: StreamRequestOptions | undefined;
}

/**
 * A fake SDK client: each stream() takes the next scripted reply (a message, an error to throw,
 * or a function of the call). `calls` records every request.
 */
export class FakeSdk implements MessagesStreamClient {
  readonly calls: FakeCall[] = [];
  readonly #script: (BetaMessage | Error | ((c: FakeCall) => Promise<BetaMessage>))[];
  readonly beta: MessagesStreamClient['beta'];

  constructor(script: (BetaMessage | Error | ((c: FakeCall) => Promise<BetaMessage>))[]) {
    this.#script = [...script];
    this.beta = {
      messages: {
        stream: (
          params: BetaMessageStreamParams,
          options?: StreamRequestOptions,
        ): MessageStreamLike => {
          const call: FakeCall = { params: structuredClone(params), options };
          this.calls.push(call);
          const next = this.#script.shift();
          return {
            request_id: `req_${this.calls.length}`,
            finalMessage: () => {
              if (next === undefined)
                return Promise.reject(new Error('fake SDK: script exhausted'));
              if (next instanceof Error) return Promise.reject(next);
              if (typeof next === 'function') return next(call);
              return Promise.resolve(next);
            },
          };
        },
      },
    };
  }
}

/** A reply that resolves only when the call's signal aborts (then rejects like the SDK does). */
export function hangUntilAborted(c: FakeCall): Promise<BetaMessage> {
  return new Promise((_resolve, reject) => {
    const signal = c.options?.signal;
    if (signal === undefined) return;
    signal.addEventListener('abort', () => reject(new Error('Request was aborted.')), {
      once: true,
    });
  });
}
