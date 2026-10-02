/**
 * Cassettes: record and replay of provider responses (ai-safety-and-evaluation.md §3.11, §4.2;
 * AIS-07, AIS-08).
 *
 * `cassetteFetch` wraps the `fetch` given to the provider SDK:
 * - `replay` (CI default): no key, no network; a miss fails with
 *   `cassette miss <key> — re-record with LLM_MODE=record` and never falls through to a live call;
 * - `record`: calls the provider and stores a cassette;
 * - `live`: pass-through, nothing recorded.
 * The key is SHA-256 of the canonical request body (model, system, tools, tool_choice, messages,
 * output_config, max_tokens, fallbacks) plus the `anthropic-beta` header; auth headers are never
 * part of it. The recorder never writes request headers, keeps only an allow-list of response
 * headers and scrubs `sk-ant-…` keys, `x-api-key`, `authorization` and cookie values from bodies.
 */
import { sha256Hex } from '@plotinium/protocol';

import { canonicalJson } from '../util/canonical.ts';

export type LlmMode = 'replay' | 'record' | 'live';

export interface Cassette {
  key: string;
  recordedAt: string;
  provider: string;
  request: { canonicalBody: unknown; beta?: string };
  response: {
    status: number;
    headers: { 'content-type'?: string; 'request-id'?: string };
    sse: string;
  };
  model: { requested: string; served: string };
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface CassetteStore {
  get(key: string): Promise<Cassette | undefined>;
  put(cassette: Cassette): Promise<void>;
}

const KEY_FIELDS = [
  'model',
  'system',
  'tools',
  'tool_choice',
  'messages',
  'output_config',
  'max_tokens',
  'fallbacks',
] as const;

export function canonicalRequest(body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof body !== 'object' || body === null) return out;
  const b = body as Record<string, unknown>;
  for (const k of KEY_FIELDS) if (b[k] !== undefined) out[k] = b[k];
  return out;
}

export function cassetteKey(body: unknown, beta?: string): string {
  return sha256Hex(`${canonicalJson(canonicalRequest(body))}\n${beta ?? ''}`);
}

// Order matters: bearer tokens first, so a header scrub cannot leave the token behind.
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-REDACTED'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer REDACTED'],
  [
    /("?(?:x-api-key|authorization|cookie|set-cookie)"?\s*[:=]\s*)("[^"]*"|[^\s,}]+)/gi,
    '$1"REDACTED"',
  ],
];

export function scrub(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** True when a text still carries a credential pattern (the CI cassette check, AIS-08). */
export function containsCredential(text: string): boolean {
  return (
    /sk-ant-(?!REDACTED)[A-Za-z0-9_-]+/.test(text) ||
    /"?(?:x-api-key|authorization|cookie)"?\s*[:=]\s*"(?!REDACTED)[^"]+"/i.test(text) ||
    /\bBearer\s+(?!REDACTED)[A-Za-z0-9._~+/=-]{8,}/.test(text)
  );
}

function scrubValue(v: unknown): unknown {
  if (typeof v === 'string') return scrub(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = /^(x-api-key|authorization|cookie|set-cookie)$/i.test(k)
        ? 'REDACTED'
        : scrubValue(x);
    }
    return out;
  }
  return v;
}

function lastNumber(text: string, field: string): number {
  const all = [...text.matchAll(new RegExp(`"${field}"\\s*:\\s*(\\d+)`, 'g'))];
  return Number(all[all.length - 1]?.[1] ?? 0);
}

function servedModel(text: string): string {
  return /"model"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? '';
}

function parseJson(text: string): unknown {
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function requestParts(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ body: unknown; beta?: string }> {
  let text = '';
  let beta: string | undefined;
  if (input instanceof Request) {
    text = await input.clone().text();
    beta = input.headers.get('anthropic-beta') ?? undefined;
  }
  if (typeof init?.body === 'string') text = init.body;
  const h = new Headers(init?.headers);
  beta = h.get('anthropic-beta') ?? beta;
  const body = parseJson(text);
  return beta === undefined ? { body } : { body, beta };
}

export interface CassetteOptions {
  mode: LlmMode;
  store: CassetteStore;
  inner: FetchLike;
  provider: string;
  now(): number;
}

export class CassetteMiss extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`cassette miss ${key} — re-record with LLM_MODE=record`);
    this.key = key;
  }
}

export function cassetteFetch(opts: CassetteOptions): FetchLike {
  return async (input, init) => {
    if (opts.mode === 'live') return opts.inner(input, init);
    const { body, beta } = await requestParts(input, init);
    const key = cassetteKey(body, beta);
    if (opts.mode === 'replay') {
      const c = await opts.store.get(key);
      if (c === undefined) throw new CassetteMiss(key);
      const headers = new Headers();
      if (c.response.headers['content-type'] !== undefined)
        headers.set('content-type', c.response.headers['content-type']);
      if (c.response.headers['request-id'] !== undefined)
        headers.set('request-id', c.response.headers['request-id']);
      return new Response(c.response.sse, { status: c.response.status, headers });
    }
    const res = await opts.inner(input, init);
    const text = await res.text();
    const scrubbed = scrub(text);
    const ct = res.headers.get('content-type');
    const rid = res.headers.get('request-id');
    const headers: Cassette['response']['headers'] = {};
    if (ct !== null) headers['content-type'] = ct;
    if (rid !== null) headers['request-id'] = rid;
    const requested =
      typeof (body as Record<string, unknown>)['model'] === 'string'
        ? ((body as Record<string, unknown>)['model'] as string)
        : '';
    const request: Cassette['request'] = { canonicalBody: scrubValue(canonicalRequest(body)) };
    if (beta !== undefined) request.beta = beta;
    await opts.store.put({
      key,
      recordedAt: new Date(opts.now()).toISOString(),
      provider: opts.provider,
      request,
      response: { status: res.status, headers, sse: scrubbed },
      model: { requested, served: servedModel(text) || requested },
      usage: {
        input: lastNumber(text, 'input_tokens'),
        output: lastNumber(text, 'output_tokens'),
        cacheRead: lastNumber(text, 'cache_read_input_tokens'),
        cacheWrite: lastNumber(text, 'cache_creation_input_tokens'),
      },
    });
    return new Response(scrubbed, { status: res.status, headers: new Headers(headers) });
  };
}

/** In-memory store (tests and the eval harness; the CLI writes `ai/eval/cassettes/<suite>/<key>.json`). */
export class MemoryCassetteStore implements CassetteStore {
  readonly cassettes = new Map<string, Cassette>();

  get(key: string): Promise<Cassette | undefined> {
    return Promise.resolve(this.cassettes.get(key));
  }

  put(c: Cassette): Promise<void> {
    this.cassettes.set(c.key, c);
    return Promise.resolve();
  }
}
