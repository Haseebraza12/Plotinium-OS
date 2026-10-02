import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  AnthropicProvider,
  buildMessageParams,
  classifyProviderError,
  createAnthropicClient,
  toolCallOf,
} from './anthropic.ts';
import {
  assertNoSecrets,
  canonicalJson,
  cassetteKey,
  CassetteMiss,
  CassetteSecretError,
  createCassetteFetch,
  FsCassetteStore,
  MemoryCassetteStore,
  scrubCredentials,
  summarizeResponse,
  type Cassette,
  type FetchLike,
} from './cassette.ts';
import { createPricing } from './pricing.ts';
import { sseFor } from './tests/fixtures.ts';

const FAKE_KEY = `sk-ant-api03-${'x'.repeat(40)}`;

const PARAMS = buildMessageParams({
  model: 'claude-opus-5-5',
  maxTokens: 8000,
  effort: 'medium',
  system: 'You are the Plotinium planner.',
  tools: [
    {
      name: 'fs_find',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
    },
  ],
  messages: [{ role: 'user', content: 'find my notes' }],
  fallbacks: true,
});

function cassetteFor(key: string, sse: string, beta: string | null): Cassette {
  return {
    version: 1,
    requestSha256: key,
    recordedAt: '2026-09-24T00:00:00.000Z',
    provider: 'anthropic',
    request: { canonicalBody: {}, beta },
    response: {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'request-id': 'req_cassette' },
      sse,
    },
    model: { requested: 'claude-opus-5-5', served: 'claude-opus-5-5' },
    usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
    costMicroUsd: 8000,
  };
}

/** The body the SDK sends for PARAMS (betas travel as the anthropic-beta header). */
function wireBody(): Record<string, unknown> {
  const { betas: _betas, ...body } = PARAMS;
  return { ...body, stream: true };
}

let networkSpy: MockInstance<typeof globalThis.fetch> | undefined;
beforeEach(() => {
  networkSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('the network must not be used');
  });
});
afterEach(() => {
  networkSpy?.mockRestore();
});

describe('Cassettes (backend-api.md §3.13.5; ai-safety-and-evaluation.md §3.11)', () => {
  it('AIS-07 the key is the SHA-256 of the canonical request: key order and non-decisive fields do not change it, the beta header does', () => {
    const a = cassetteKey(
      { model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] },
      null,
    );
    const b = cassetteKey(
      {
        messages: [{ content: 'x', role: 'user' }],
        max_tokens: 5,
        model: 'm',
        stream: true,
        metadata: { u: 1 },
      },
      null,
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(cassetteKey({ model: 'm', max_tokens: 5 }, 'server-side-fallback-2026-07-01')).not.toBe(
      cassetteKey({ model: 'm', max_tokens: 5 }, null),
    );
    expect(cassetteKey({ model: 'm', max_tokens: 5, temperature: 0 }, null)).not.toBe(
      cassetteKey({ model: 'm', max_tokens: 5 }, null),
    );
    expect(canonicalJson({ b: [{ d: 1, c: undefined }], a: null })).toBe(
      '{"a":null,"b":[{"d":1}]}',
    );
  });

  it('AIS-07 replay: the real SDK parses the recorded SSE stream and nothing reaches the network', async () => {
    const store = new MemoryCassetteStore();
    const key = cassetteKey(wireBody(), 'server-side-fallback-2026-07-01');
    await store.put(
      cassetteFor(
        key,
        sseFor({
          tool: { name: 'fs_find', input: { path: '/home/alice' } },
          usage: { input: 1234, output: 56 },
        }),
        'server-side-fallback-2026-07-01',
      ),
    );
    const client = createAnthropicClient({
      apiKey: 'replay-mode-no-credential',
      fetch: createCassetteFetch({ mode: 'replay', store }),
      maxRetries: 0,
    });
    const provider = new AnthropicProvider(client, 0);
    const reply = await provider.send(PARAMS, {
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
    expect(reply.message.stop_reason).toBe('tool_use');
    expect(toolCallOf(reply.message)).toEqual({
      id: 'toolu_01',
      name: 'fs_find',
      input: { path: '/home/alice' },
    });
    expect(reply.message.usage.input_tokens).toBe(1234);
    expect(reply.message.usage.output_tokens).toBe(56);
    expect(reply.requestId).toBe('req_cassette');
    expect(networkSpy).not.toHaveBeenCalled();
  });

  it('AIS-07 a replay miss throws CassetteMiss, never calls the network, and the gateway maps it to 503 EAIUNAVAIL upstream', async () => {
    const client = createAnthropicClient({
      apiKey: 'replay-mode-no-credential',
      fetch: createCassetteFetch({ mode: 'replay', store: new MemoryCassetteStore() }),
      maxRetries: 0,
    });
    const provider = new AnthropicProvider(client, 0);
    let caught: unknown;
    try {
      await provider.send(PARAMS, { signal: new AbortController().signal, timeoutMs: 5000 });
    } catch (e) {
      caught = e;
    }
    const { error } = classifyProviderError(caught, { deadline: false, cancelled: false });
    expect([error.status, error.errno, error.reason]).toEqual([503, 'EAIUNAVAIL', 'upstream']);
    expect(error.message).toMatch(/cassette miss [0-9a-f]{64} — re-record with LLM_MODE=record/);
    expect(networkSpy).not.toHaveBeenCalled();
  });

  it('AIS-08 record writes the request body only: no x-api-key, authorization or other request header, and the key value never appears', async () => {
    const store = new MemoryCassetteStore();
    const seen: Headers[] = [];
    const upstream: FetchLike = (_input, init) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(
        new Response(sseFor({ text: 'hello', usage: { input: 1000, output: 100 } }), {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'request-id': 'req_rec',
            'set-cookie': 'x=1',
            'anthropic-organization-id': 'org',
          },
        }),
      );
    };
    const fetch = createCassetteFetch({
      mode: 'record',
      store,
      upstream,
      apiKey: FAKE_KEY,
      pricing: createPricing(),
      now: () => 0,
    });
    const client = createAnthropicClient({ apiKey: FAKE_KEY, fetch, maxRetries: 0 });
    const reply = await new AnthropicProvider(client, 0).send(PARAMS, {
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
    expect(reply.message.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(seen[0]?.get('x-api-key')).toBe(FAKE_KEY); // the real request carried the key ...
    const [c] = [...store.cassettes.values()];
    const text = JSON.stringify(c);
    expect(text).not.toContain(FAKE_KEY); // ... the cassette does not
    expect(text).not.toMatch(/x-api-key|authorization|set-cookie|anthropic-organization-id/i);
    expect(c?.response.headers).toEqual({
      'content-type': 'text/event-stream',
      'request-id': 'req_rec',
    });
    expect(c?.request.beta).toBe('server-side-fallback-2026-07-01');
    expect(c?.request.canonicalBody).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 8000 });
    expect(c?.model).toEqual({ requested: 'claude-opus-5-5', served: 'claude-opus-5-5' });
    expect(c?.usage).toEqual({ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });
    expect(c?.costMicroUsd).toBe(1000 * 4 + 100 * 20);
    expect(fetch.spentMicroUsd()).toBe(6000);
    // what was recorded replays byte-identically
    const replayClient = createAnthropicClient({
      apiKey: 'replay-mode-no-credential',
      fetch: createCassetteFetch({ mode: 'replay', store }),
      maxRetries: 0,
    });
    const again = await new AnthropicProvider(replayClient, 0).send(PARAMS, {
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
    expect(again.message.content).toEqual(reply.message.content);
  });

  it('AIS-08 the recorder refuses to write a cassette containing the key or an sk-ant- string', async () => {
    const leaky =
      (body: string): FetchLike =>
      () =>
        Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        );
    const init = {
      method: 'POST',
      body: JSON.stringify({ model: 'm', max_tokens: 1, messages: [] }),
      headers: {},
    };
    const url = 'https://api.anthropic.com/v1/messages';
    const store = new MemoryCassetteStore();
    const withKey = createCassetteFetch({
      mode: 'record',
      store,
      upstream: leaky(`{"model":"m","echo":"${FAKE_KEY}"}`),
      apiKey: 'plain-secret-value',
    });
    await expect(withKey(url, init)).rejects.toBeInstanceOf(CassetteSecretError);
    const withValue = createCassetteFetch({
      mode: 'record',
      store,
      upstream: leaky('{"model":"m","echo":"plain-secret-value"}'),
      apiKey: 'plain-secret-value',
    });
    await expect(withValue(url, init)).rejects.toThrow(/the API key/);
    expect(store.cassettes.size).toBe(0);
    expect(() => assertNoSecrets('{"ok":true}', undefined)).not.toThrow();
  });

  it('AIS-08 credential-named fields are scrubbed at any depth', () => {
    expect(
      scrubCredentials({
        a: 1,
        Authorization: 'Bearer x',
        nested: [{ 'x-api-key': 'k', cookie: 'c', keep: 'v' }],
        api_key: 'z',
      }),
    ).toEqual({ a: 1, nested: [{ keep: 'v' }] });
  });

  it('AIS-09 record mode stops at LLM_RECORD_BUDGET_USD and never records a non-2xx response', async () => {
    const store = new MemoryCassetteStore();
    let status = 200;
    const upstream: FetchLike = () =>
      Promise.resolve(
        new Response(sseFor({ text: 'x', usage: { input: 1000, output: 1000 } }), {
          status,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    const f = createCassetteFetch({
      mode: 'record',
      store,
      upstream,
      pricing: createPricing(),
      recordBudgetMicroUsd: 20_000,
    });
    const init = (n: number) => ({
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: n, messages: [] }),
    });
    status = 500;
    const r = await f('https://api.anthropic.com/v1/messages', init(1));
    expect(r.status).toBe(500);
    expect(store.cassettes.size).toBe(0);
    status = 200;
    await f('https://api.anthropic.com/v1/messages', init(2)); // 24,000 micro-USD
    await expect(f('https://api.anthropic.com/v1/messages', init(3))).rejects.toMatchObject({
      errno: 'EAIUNAVAIL',
      reason: 'budget',
    });
    const noUpstream = createCassetteFetch({ mode: 'record', store });
    await expect(
      noUpstream('https://api.anthropic.com/v1/messages', init(1)),
    ).rejects.toMatchObject({ reason: 'no-key' });
  });

  it('AIS-07 the cassette fetch covers POST /v1/messages with a JSON body only', async () => {
    const f = createCassetteFetch({ mode: 'replay', store: new MemoryCassetteStore() });
    await expect(f('https://api.anthropic.com/v1/models', {})).rejects.toThrow(
      /cover POST \/v1\/messages only/,
    );
    await expect(f(new URL('https://api.anthropic.com/v1/messages'), {})).rejects.toThrow(
      /JSON text/,
    );
    await expect(
      f(new Request('https://api.anthropic.com/v1/messages', { method: 'POST' }), {
        body: '{"model":"m"}',
      }),
    ).rejects.toBeInstanceOf(CassetteMiss);
  });

  it('AIS-07 FsCassetteStore writes <key>.json atomically and reads it back; unknown and malformed keys miss', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plt-cassettes-'));
    try {
      const store = new FsCassetteStore(join(dir, 'gateway'));
      const key = 'a'.repeat(64);
      await store.put(cassetteFor(key, 'event: message_stop\ndata: {}\n\n', null));
      expect(await readdir(join(dir, 'gateway'))).toEqual([`${key}.json`]);
      expect((await readFile(join(dir, 'gateway', `${key}.json`), 'utf8')).endsWith('\n')).toBe(
        true,
      );
      expect((await store.get(key))?.requestSha256).toBe(key);
      expect(await store.get('b'.repeat(64))).toBeNull();
      expect(await store.get('../../etc/passwd')).toBeNull();
      await expect(
        store.put({ ...cassetteFor(key, '', null), requestSha256: 'nope' }),
      ).rejects.toThrow(RangeError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('AIS-09 summarizeResponse reads the served model and usage from SSE (fallback hops included) and from JSON', () => {
    const sse = sseFor({
      text: 'x',
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    }).replace(
      'event: message_delta',
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'fallback', to: { model: 'claude-opus-5' } } })}\n\nevent: message_delta`,
    );
    expect(summarizeResponse(sse)).toEqual({
      model: 'claude-opus-5',
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    });
    expect(summarizeResponse('{"model":"m","usage":{"input_tokens":1,"output_tokens":2}}')).toEqual(
      {
        model: 'm',
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    );
    expect(summarizeResponse('{not json')).toEqual({ model: null, usage: null });
    expect(summarizeResponse('data: {broken\n\n')).toEqual({ model: null, usage: null });
  });
});
