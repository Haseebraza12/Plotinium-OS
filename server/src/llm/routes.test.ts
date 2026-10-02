import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { pluginApp } from '../../tests/plugin-app.ts';
import { AnthropicProvider, type BetaMessage } from '../engine/llm/anthropic.ts';
import { MemoryBudgetStore } from '../engine/llm/budget-memory.ts';
import { LlmGateway } from '../engine/llm/gateway.ts';
import { FakeSdk, fakeMessage } from '../engine/llm/tests/fixtures.ts';
import { uuidv7 } from '../util/uuidv7.ts';
import { llmPlugin, promptHash, SYSTEM_V1 } from './routes.ts';
import { TranscriptStore } from './transcripts.ts';

const ALICE = { 'x-test-uid': '1001' };
const BOB = { 'x-test-uid': '1002' };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

function gatewayWith(script: (BetaMessage | Error)[], provider = true) {
  const sdk = new FakeSdk(script);
  const gateway = new LlmGateway({
    timeZone: 'Asia/Karachi',
    provider: provider ? new AnthropicProvider(sdk) : null,
    budget: new MemoryBudgetStore(),
    config: {
      mode: 'live',
      model: 'claude-opus-5-5',
      fallbackModel: 'claude-opus-5',
      effort: 'medium',
      temperature: undefined,
      maxTokens: 8000,
      timeoutMs: 45_000,
      maxInflight: 4,
      budget: {
        monthUsd: 50,
        totalUsd: 250,
        userUsdDay: 2,
        demoUsdDay: 3,
        demoCallsDay: 20,
        examinerUsdDay: 15,
        examinerCallsDay: 100,
      },
    },
  });
  return { sdk, gateway };
}

async function make(script: (BetaMessage | Error)[], provider = true) {
  const { sdk, gateway } = gatewayWith(script, provider);
  const logs: Record<string, unknown>[] = [];
  const app = await pluginApp((a) =>
    llmPlugin(a, { gateway, transcripts: new TranscriptStore(), log: (f) => logs.push(f) }),
  );
  apps.push(app);
  return { app, sdk, logs };
}

const plan = (app: FastifyInstance, body: unknown, headers: Record<string, string> = ALICE) =>
  app.inject({ method: 'POST', url: '/api/llm/plan', headers, payload: body as object });

describe('SRV-13 /api/llm routes over the gateway (backend-api.md §3.13; agentic-shell.md §3.8)', () => {
  it('AGT-01 a plan conversation stays on the server: observe, then clarify, then cannot, with an append-only transcript', async () => {
    const { app, sdk, logs } = await make([
      fakeMessage({ tool: { id: 'toolu_a', name: 'fs_readdir', input: { path: '/home/alice' } } }),
      fakeMessage({
        tool: {
          id: 'toolu_b',
          name: 'ask_clarification',
          input: { question: 'Which notes?', options: ['a', 'b'], reason: 'ambiguous_target' },
        },
      }),
      fakeMessage({
        tool: { id: 'toolu_c', name: 'cannot_comply', input: { reason: 'no such notes' } },
      }),
    ]);
    expect(logs[0]).toMatchObject({ system: promptHash(SYSTEM_V1).slice(0, 16) });
    const requestId = uuidv7();

    const t1 = await plan(app, { requestId, turn: 1, userTurn: 'tidy my notes' });
    expect(t1.statusCode, t1.body).toBe(200);
    expect(t1.json()).toMatchObject({
      kind: 'observe',
      toolUseId: 'toolu_a',
      payload: { toolUseId: 'toolu_a', call: 'fs_readdir', args: { path: '/home/alice' } },
      model: { requested: 'claude-opus-5-5' },
    });

    const t2 = await plan(app, {
      requestId,
      turn: 2,
      toolResult: { toolUseId: 'toolu_a', content: 'notes.md\nplan.md' },
    });
    expect(t2.statusCode, t2.body).toBe(200);
    expect(t2.json()).toMatchObject({
      kind: 'clarify',
      payload: { question: 'Which notes?', reason: 'ambiguous_target' },
    });

    const t3 = await plan(app, { requestId, turn: 3, userTurn: 'the first one' });
    expect(t3.json()).toMatchObject({ kind: 'cannot', payload: { reason: 'no such notes' } });

    // The third provider call saw the whole transcript, in order, with tool_result answers.
    const messages = sdk.calls[2]?.params.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(JSON.stringify(messages[2])).toContain('"tool_use_id":"toolu_a"');
    expect(JSON.stringify(messages[4])).toContain('"tool_use_id":"toolu_b"');
    expect(sdk.calls[0]?.params.system).toBeDefined();
  });

  it('AGT-01 turn ordering, the pending tool call and ownership are enforced; an unknown conversation has expired', async () => {
    const { app } = await make([
      fakeMessage({ tool: { id: 'toolu_a', name: 'fs_stat', input: { path: '/etc' } } }),
    ]);
    const requestId = uuidv7();
    const expired = await plan(app, { requestId, turn: 2, userTurn: 'hello' });
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toMatchObject({ errno: 'EAIUNAVAIL', reason: 'expired' });

    expect((await plan(app, { requestId, turn: 1, userTurn: 'stat etc' })).statusCode).toBe(200);
    const skip = await plan(app, { requestId, turn: 3, userTurn: 'x' });
    expect(skip.statusCode).toBe(409);
    expect(skip.json()).toMatchObject({ errno: 'EINVAL', reason: 'turn-order' });
    const wrongCall = await plan(app, {
      requestId,
      turn: 2,
      toolResult: { toolUseId: 'toolu_zzz', content: 'x' },
    });
    expect(wrongCall.statusCode).toBe(400);
    // Another user cannot continue alice's conversation.
    const foreign = await plan(app, { requestId, turn: 2, userTurn: 'x' }, BOB);
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json()).toMatchObject({ reason: 'expired' });
  });

  it('SRV-05 the plan body is validated before any provider call: exactly one of userTurn and toolResult, turn 1 carries userTurn', async () => {
    const { app, sdk } = await make([]);
    const requestId = uuidv7();
    for (const body of [
      { requestId, turn: 1 },
      { requestId, turn: 1, toolResult: { toolUseId: 'toolu_a', content: 'x' } },
      { requestId, turn: 1, userTurn: 'a', toolResult: { toolUseId: 'toolu_a', content: 'x' } },
      { requestId: 'not-a-uuid', turn: 1, userTurn: 'a' },
    ]) {
      const res = await plan(app, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ errno: 'EINVAL' });
    }
    expect(sdk.calls).toHaveLength(0);
    expect((await plan(app, { requestId, turn: 1, userTurn: 'x' }, {})).statusCode).toBe(401);
  });

  it('AGT-01 a tool input that fails the original Valibot schema is 422 EINVAL, and an unknown tool is 422 too', async () => {
    const { app } = await make([
      fakeMessage({ tool: { name: 'fs_readdir', input: { path: 42 } } }),
      fakeMessage({ tool: { name: 'rm_rf', input: {} } }),
    ]);
    const bad = await plan(app, { requestId: uuidv7(), turn: 1, userTurn: 'list' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ errno: 'EINVAL', detail: { tool: 'fs_readdir' } });
    const unknown = await plan(app, { requestId: uuidv7(), turn: 1, userTurn: 'list' });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ errno: 'EINVAL', detail: { tool: 'rm_rf' } });
  });

  it('AGT-01 a reply without a tool call is retried once with the reminder, then answered 503 EAIUNAVAIL upstream', async () => {
    const { app, sdk } = await make([
      fakeMessage({ text: 'I would rather chat.' }),
      fakeMessage({ text: 'Still chatting.' }),
    ]);
    const res = await plan(app, { requestId: uuidv7(), turn: 1, userTurn: 'hi' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errno: 'EAIUNAVAIL', reason: 'upstream' });
    expect(sdk.calls).toHaveLength(2);
    // The retry carried the discarded text and the fixed reminder (append-only transcript).
    expect(sdk.calls[1]?.params.messages.length).toBe(3);
  });

  it('RAG-05 extract returns only the quarantined items and answer returns cited sentences', async () => {
    const { app } = await make([
      fakeMessage({ tool: { name: 'return_items', input: { items: ['alpha.txt', 'beta.txt'] } } }),
      fakeMessage({
        tool: {
          name: 'answer',
          input: { sentences: [{ text: 'LRU evicts the oldest.', chunk_ids: ['c1'] }] },
        },
      }),
    ]);
    const extract = await app.inject({
      method: 'POST',
      url: '/api/llm/extract',
      headers: ALICE,
      payload: {
        requestId: uuidv7(),
        toolUseId: 'toolu_x',
        source: { path: '/home/alice/list.txt' },
        text: '«alpha.txt beta.txt»',
        what: 'file names',
      },
    });
    expect(extract.statusCode, extract.body).toBe(200);
    expect(extract.json()).toMatchObject({ items: ['alpha.txt', 'beta.txt'] });
    const answer = await app.inject({
      method: 'POST',
      url: '/api/llm/answer',
      headers: ALICE,
      payload: { requestId: uuidv7(), question: 'what is lru?', passages: '[c1] LRU ...' },
    });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json()).toMatchObject({
      sentences: [{ text: 'LRU evicts the oldest.', chunk_ids: ['c1'] }],
    });
  });

  it('SRV-13 without a key the gateway is degraded: health says no-key and a plan is 503 EAIUNAVAIL', async () => {
    const { app } = await make([], false);
    const health = await app.inject({ method: 'GET', url: '/api/llm/health', headers: ALICE });
    expect(health.json()).toMatchObject({ ok: false, degradedReason: 'no-key' });
    const res = await plan(app, { requestId: uuidv7(), turn: 1, userTurn: 'hi' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errno: 'EAIUNAVAIL' });
  });
});
