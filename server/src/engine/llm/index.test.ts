import { describe, expect, it, vi } from 'vitest';

import type { LlmConfig } from '../../config.ts';
import { MemoryBudgetStore } from './budget-memory.ts';
import { MemoryCassetteStore, type FetchLike } from './cassette.ts';
import { createLlmEngine, DEFAULT_CASSETTE_DIR, type LlmCall } from './index.ts';
import { sseFor } from './tests/fixtures.ts';

const LLM: LlmConfig = {
  mode: 'live',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  effort: 'medium',
  fallbackModel: 'claude-opus-5',
  temperature: undefined,
  maxTokens: 8000,
  timeoutMs: 45_000,
  maxInflight: 4,
  apiKey: undefined,
  recordBudgetUsd: undefined,
  budget: {
    monthUsd: 50,
    totalUsd: 250,
    userUsdDay: 2,
    demoUsdDay: 3,
    demoCallsDay: 20,
    examinerUsdDay: 15,
    examinerCallsDay: 100,
  },
  upstreamUrl: undefined,
  upstreamToken: undefined,
  upstreamAcceptHashes: [],
};

const CALL: LlmCall = {
  caller: { uid: 1001, kind: 'user' },
  purpose: 'answer',
  system: 'Answer from the cited chunks only.',
  tools: [],
  messages: [{ role: 'user', content: 'what is in notes.md?' }],
  expectToolCall: false,
};

describe('The LLM engine factory (backend-api.md §3.13; AI=1 only)', () => {
  it('AIS-06 live mode without a key is degraded no-key; the rest of the server is unaffected', () => {
    const e = createLlmEngine({ llm: LLM, timeZone: 'Asia/Karachi', db: null });
    expect(e.mode).toBe('live');
    expect(e.provider).toBeNull();
    expect(e.gateway.state).toBe('no-key');
    expect(DEFAULT_CASSETTE_DIR).toMatch(/ai\/eval\/cassettes\/gateway\/$/);
  });

  it('AIS-07 a developer recording is replayed in CI with no key and no network, logging status replayed at zero cost', async () => {
    const cassettes = new MemoryCassetteStore();
    const upstream = vi.fn<FetchLike>(() =>
      Promise.resolve(
        new Response(
          sseFor({ text: 'notes.md lists groceries', usage: { input: 900, output: 30 } }),
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'request-id': 'req_live' },
          },
        ),
      ),
    );
    const recorder = createLlmEngine({
      llm: { ...LLM, mode: 'record', apiKey: `sk-ant-api03-${'k'.repeat(40)}`, recordBudgetUsd: 1 },
      timeZone: 'Asia/Karachi',
      db: null,
      cassettes,
      fetch: upstream,
    });
    const live = await recorder.gateway.call(CALL);
    expect(live.text).toBe('notes.md lists groceries');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(cassettes.cassettes.size).toBe(1);
    expect(JSON.stringify([...cassettes.cassettes.values()])).not.toMatch(/sk-ant-/);

    const budget = new MemoryBudgetStore();
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const ci = createLlmEngine({
        llm: { ...LLM, mode: 'replay' },
        timeZone: 'Asia/Karachi',
        db: null,
        cassettes,
        budget,
      });
      expect(ci.gateway.state).toBe('available');
      const replayed = await ci.gateway.call(CALL);
      expect(replayed.text).toBe('notes.md lists groceries');
      expect(replayed.replayed).toBe(true);
      expect(replayed.requestIdUpstream).toBe('req_live');
      expect([...budget.requests.values()][0]).toMatchObject({
        status: 'replayed',
        costMicroUsd: 0,
        inputTokens: 900,
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it('AIS-06 live mode with a key calls the provider through the configured fetch only', async () => {
    const fetch = vi.fn<FetchLike>((_input, init) => {
      expect(new Headers(init?.headers).get('x-api-key')).toBe('configured-key');
      return Promise.resolve(
        new Response(sseFor({ text: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    });
    const e = createLlmEngine({
      llm: { ...LLM, apiKey: 'configured-key' },
      timeZone: 'UTC',
      db: null,
      fetch,
    });
    const r = await e.gateway.call(CALL);
    expect(r.text).toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(1);
    const input = fetch.mock.calls[0]?.[0];
    expect(input instanceof Request ? input.url : String(input)).toBe(
      'https://api.anthropic.com/v1/messages?beta=true',
    );
  });
});
