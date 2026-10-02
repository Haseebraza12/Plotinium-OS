/**
 * Cassettes: record and replay of provider calls (spec §12.6 "CI uses recorded model responses";
 * backend-api.md §3.13.5; ai-safety-and-evaluation.md §3.11, §4.2).
 *
 * Mechanism: a custom `fetch` handed to the SDK client (`new Anthropic({ fetch })`), so the SDK
 * parses a replayed SSE stream exactly as a live one and the same wrapper can wrap another
 * provider's client in the bake-off harness.
 *
 *   replay  the cassette key is looked up; a hit returns the stored status, the allow-listed
 *           response headers and the raw body; a miss throws CassetteMiss and NEVER reaches the
 *           network (CI and any run without a key).
 *   record  developer machines only (config refuses it in production and CI): the call goes to the
 *           real API under LLM_RECORD_BUDGET_USD and every 2xx response is written as a cassette.
 *
 * Key = SHA-256 of the canonical JSON (keys sorted at every level) of
 *   {body: <the request body fields that decide the answer>, beta: <anthropic-beta header or null>}
 * where the body fields are model, system, tools, tool_choice, messages, output_config, max_tokens,
 * fallbacks and temperature (when present). Headers never enter the key or the file.
 *
 * Scrubbing: the recorder stores the request BODY only, never request headers, so x-api-key and
 * authorization cannot be captured; object fields named like credentials are removed from what is
 * stored; and before writing, the serialised cassette is refused (CassetteSecretError) if it still
 * contains the API key's value or any `sk-ant-` string. gitleaks scans ai/eval/cassettes/ in CI;
 * the file therefore never names a high-entropy value with a credential-like key: the spec's
 * `key` field is stored as `requestSha256`.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ErrnoError } from '../../errno.ts';
import { uuidv7 } from '../../util/uuidv7.ts';
import type { Pricing, TokenUsage } from './pricing.ts';

export const CASSETTE_VERSION = 1;

/** Body fields that make up the key (ai-safety-and-evaluation.md §3.11, backend-api.md §3.13.5). */
export const CASSETTE_KEY_FIELDS = [
  'fallbacks',
  'max_tokens',
  'messages',
  'model',
  'output_config',
  'system',
  'temperature',
  'tool_choice',
  'tools',
] as const;

/** Response headers kept in a cassette (an allow-list). */
export const CASSETTE_RESPONSE_HEADERS = ['content-type', 'request-id'] as const;

export interface CassetteUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** ai-safety-and-evaluation.md §4.2, with `key` stored as `requestSha256` (gitleaks-safe). */
export interface Cassette {
  readonly version: number;
  readonly requestSha256: string;
  readonly recordedAt: string;
  readonly provider: string;
  readonly request: { readonly canonicalBody: unknown; readonly beta: string | null };
  readonly response: {
    readonly status: number;
    readonly headers: { readonly 'content-type'?: string; readonly 'request-id'?: string };
    /** The raw response body: the SSE stream for streamed calls, JSON otherwise. */
    readonly sse: string;
  };
  readonly model: { readonly requested: string; readonly served: string | null };
  readonly usage: CassetteUsage | null;
  readonly costMicroUsd: number;
}

export interface CassetteStore {
  get(key: string): Promise<Cassette | null>;
  put(cassette: Cassette): Promise<void>;
}

/** A replay miss: the app answers 503 EAIUNAVAIL 'upstream'; in CI the test fails. */
export class CassetteMiss extends ErrnoError {
  readonly key: string;
  /** The start of the canonical request, for the developer re-recording it. Never sent to clients. */
  readonly preview: string;
  constructor(key: string, preview: string) {
    super(
      'EAIUNAVAIL',
      { reason: 'upstream', cassette: key },
      `cassette miss ${key} — re-record with LLM_MODE=record`,
    );
    this.name = 'CassetteMiss';
    this.key = key;
    this.preview = preview;
  }
}

/** The recorder refused to write a cassette that contains a credential (§12.6, AIS-08). */
export class CassetteSecretError extends ErrnoError {
  constructor(what: string) {
    super(
      'EAIUNAVAIL',
      { reason: 'upstream' },
      `refusing to write a cassette that contains ${what}`,
    );
    this.name = 'CassetteSecretError';
  }
}

// ---------------------------------------------------------------------------------------------
// Canonical JSON and the key
// ---------------------------------------------------------------------------------------------

/** JSON with object keys sorted at every level; `undefined` members are dropped (as JSON does). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

/** The body fields that decide the answer, as an object (the cassette's canonicalBody). */
export function keyedBody(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of CASSETTE_KEY_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

export function cassetteKey(body: Readonly<Record<string, unknown>>, beta: string | null): string {
  return createHash('sha256')
    .update(canonicalJson({ body: keyedBody(body), beta }))
    .digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------------------------

const CREDENTIAL_FIELD =
  /^(?:x-api-key|authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|anthropic[-_]api[-_]key)$/i;
const SK_ANT = /sk-ant-/i;

/** A deep copy without any object member whose NAME is a credential header or key field. */
export function scrubCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubCredentials);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!CREDENTIAL_FIELD.test(k)) out[k] = scrubCredentials(v);
    }
    return out;
  }
  return value;
}

/** Throws CassetteSecretError when `serialised` contains the key's value or an `sk-ant-` string. */
export function assertNoSecrets(serialised: string, apiKey: string | undefined): void {
  if (apiKey !== undefined && apiKey.length >= 8 && serialised.includes(apiKey)) {
    throw new CassetteSecretError('the API key');
  }
  if (SK_ANT.test(serialised)) throw new CassetteSecretError('an sk-ant- string');
}

// ---------------------------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------------------------

const KEY_RE = /^[0-9a-f]{64}$/;

/** Cassettes as `<dir>/<key>.json` (ai/eval/cassettes/<suite>/ in the repository). */
export class FsCassetteStore implements CassetteStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async get(key: string): Promise<Cassette | null> {
    if (!KEY_RE.test(key)) return null;
    let text: string;
    try {
      text = await readFile(join(this.dir, `${key}.json`), 'utf8');
    } catch (e) {
      if ((e as { code?: unknown }).code === 'ENOENT') return null;
      throw e;
    }
    const c = JSON.parse(text) as Cassette;
    return c.requestSha256 === key ? c : null;
  }

  async put(cassette: Cassette): Promise<void> {
    if (!KEY_RE.test(cassette.requestSha256)) throw new RangeError('bad cassette key');
    await mkdir(this.dir, { recursive: true });
    const final = join(this.dir, `${cassette.requestSha256}.json`);
    const tmp = `${final}.${uuidv7()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(cassette, null, 2)}\n`, { mode: 0o644 });
    await rename(tmp, final);
  }
}

/** Cassettes in memory (tests). */
export class MemoryCassetteStore implements CassetteStore {
  readonly cassettes = new Map<string, Cassette>();

  get(key: string): Promise<Cassette | null> {
    return Promise.resolve(this.cassettes.get(key) ?? null);
  }

  put(cassette: Cassette): Promise<void> {
    this.cassettes.set(cassette.requestSha256, cassette);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------------
// Reading a response body (usage and served model)
// ---------------------------------------------------------------------------------------------

interface WireUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function usageFrom(u: WireUsage | undefined, prev: CassetteUsage | null): CassetteUsage | null {
  if (u === undefined) return prev;
  return {
    input: u.input_tokens ?? prev?.input ?? 0,
    output: u.output_tokens ?? prev?.output ?? 0,
    cacheRead: u.cache_read_input_tokens ?? prev?.cacheRead ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? prev?.cacheWrite ?? 0,
  };
}

/** The served model and final usage of a Messages response body (SSE or JSON). */
export function summarizeResponse(body: string): {
  model: string | null;
  usage: CassetteUsage | null;
} {
  let model: string | null = null;
  let usage: CassetteUsage | null = null;
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const m = JSON.parse(trimmed) as { model?: string; usage?: WireUsage };
      return { model: m.model ?? null, usage: usageFrom(m.usage, null) };
    } catch {
      return { model: null, usage: null };
    }
  }
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let ev: {
      type?: string;
      message?: { model?: string; usage?: WireUsage };
      usage?: WireUsage;
      content_block?: { type?: string; to?: { model?: string } };
    };
    try {
      ev = JSON.parse(line.slice(5).trim()) as typeof ev;
    } catch {
      continue;
    }
    if (ev.type === 'message_start') {
      model = ev.message?.model ?? model;
      usage = usageFrom(ev.message?.usage, usage);
    } else if (ev.type === 'message_delta') {
      usage = usageFrom(ev.usage, usage);
    } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'fallback') {
      model = ev.content_block.to?.model ?? model; // the final hop names the serving model
    }
  }
  return { model, usage };
}

// ---------------------------------------------------------------------------------------------
// The fetch wrapper
// ---------------------------------------------------------------------------------------------

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CassetteFetchOptions {
  readonly mode: 'replay' | 'record';
  readonly store: CassetteStore;
  /** record: the real fetch. Replay never calls it. */
  readonly upstream?: FetchLike;
  /** Used only to refuse writing a cassette that contains it. */
  readonly apiKey?: string;
  /** record: LLM_RECORD_BUDGET_USD in micro-USD; calls stop once it is spent. */
  readonly recordBudgetMicroUsd?: number;
  readonly pricing?: Pricing;
  readonly provider?: string;
  readonly now?: () => number;
}

export interface CassetteFetch extends FetchLike {
  /** record: micro-USD spent by recorded calls so far. */
  readonly spentMicroUsd: () => number;
}

function urlOf(input: string | URL | Request): URL {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function allowListed(get: (name: string) => string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of CASSETTE_RESPONSE_HEADERS) {
    const v = get(h);
    if (v !== null) out[h] = v;
  }
  return out;
}

export function createCassetteFetch(opts: CassetteFetchOptions): CassetteFetch {
  let spent = 0;
  const now = opts.now ?? (() => Date.now());

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (!/\/v1\/messages$/.test(url.pathname)) {
      throw new ErrnoError(
        'EAIUNAVAIL',
        { reason: 'upstream' },
        `cassettes cover POST /v1/messages only, not ${url.pathname}`,
      );
    }
    if (typeof init?.body !== 'string') {
      throw new ErrnoError(
        'EAIUNAVAIL',
        { reason: 'upstream' },
        'cassette request body must be JSON text',
      );
    }
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const beta = new Headers(init.headers).get('anthropic-beta');
    const key = cassetteKey(body, beta);

    if (opts.mode === 'replay') {
      const c = await opts.store.get(key);
      if (c === null) throw new CassetteMiss(key, canonicalJson(keyedBody(body)).slice(0, 300));
      return new Response(c.response.sse, {
        status: c.response.status,
        headers: { ...c.response.headers },
      });
    }

    // record
    if (opts.upstream === undefined) {
      throw new ErrnoError('EAIUNAVAIL', { reason: 'no-key' }, 'record mode needs the real fetch');
    }
    if (opts.recordBudgetMicroUsd !== undefined && spent >= opts.recordBudgetMicroUsd) {
      throw new ErrnoError('EAIUNAVAIL', { reason: 'budget' }, 'LLM_RECORD_BUDGET_USD is spent');
    }
    const res = await opts.upstream(input, init);
    const text = await res.text();
    const headers = allowListed((h) => res.headers.get(h));
    if (res.status >= 200 && res.status < 300) {
      const requested = typeof body['model'] === 'string' ? body['model'] : '';
      const { model: served, usage } = summarizeResponse(text);
      const cost =
        usage === null || opts.pricing === undefined
          ? 0
          : opts.pricing.costMicroUsd(served ?? requested, usageToTokens(usage));
      spent += cost;
      const cassette: Cassette = {
        version: CASSETTE_VERSION,
        requestSha256: key,
        recordedAt: new Date(now()).toISOString(),
        provider: opts.provider ?? 'anthropic',
        request: { canonicalBody: scrubCredentials(sortKeysDeep(keyedBody(body))), beta },
        response: { status: res.status, headers, sse: text },
        model: { requested, served },
        usage,
        costMicroUsd: cost,
      };
      assertNoSecrets(JSON.stringify(cassette), opts.apiKey);
      await opts.store.put(cassette);
    }
    return new Response(text, { status: res.status, headers });
  };

  return Object.assign(handler, { spentMicroUsd: () => spent });
}

export function usageToTokens(u: CassetteUsage): TokenUsage {
  return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
}
