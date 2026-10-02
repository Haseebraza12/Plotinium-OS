import { AuthenticationError, BadRequestError, RateLimitError } from '@anthropic-ai/sdk';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';

import { HttpError } from '../../http/errors.ts';
import { RateLimiter } from '../../ratelimit/limiter.ts';
import { AnthropicProvider, type BetaTool, type LlmProvider } from './anthropic.ts';
import { MemoryBudgetStore } from './budget-memory.ts';
import type { BudgetAlert, BudgetLimits, BudgetStore } from './budget.ts';
import {
  LlmGateway,
  MAX_TOKENS_RETRY,
  TOOL_REMINDER,
  type GatewayConfig,
  type GatewayDeps,
  type GatewayTool,
  type LlmCall,
} from './gateway.ts';
import { FakeSdk, fakeMessage, hangUntilAborted } from './tests/fixtures.ts';

// 2026-09-25 12:00 in Asia/Karachi (UTC+5)
const NOW = Date.UTC(2026, 8, 25, 7, 0, 0);
const TZ = 'Asia/Karachi';

const LIMITS: BudgetLimits = {
  monthUsd: 50,
  totalUsd: 250,
  userUsdDay: 2,
  demoUsdDay: 3,
  demoCallsDay: 20,
  examinerUsdDay: 15,
  examinerCallsDay: 100,
};

const CONFIG: GatewayConfig = {
  mode: 'live',
  model: 'claude-opus-5-5',
  fallbackModel: 'claude-opus-5',
  effort: 'medium',
  temperature: undefined,
  maxTokens: 8000,
  timeoutMs: 45_000,
  maxInflight: 4,
  budget: LIMITS,
};

const FS_FIND: BetaTool = {
  name: 'fs_find',
  description: 'Find entries',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'path'],
    properties: {
      path: { type: 'string' },
      name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
  },
};
const FS_FIND_SCHEMA = v.strictObject({
  path: v.pipe(v.string(), v.startsWith('/')),
  name: v.optional(v.string()),
});
const TOOLS: GatewayTool[] = [{ definition: FS_FIND, schema: FS_FIND_SCHEMA }];

function setup(
  script: ConstructorParameters<typeof FakeSdk>[0],
  over: Omit<Partial<GatewayDeps>, 'config'> & { config?: Partial<GatewayConfig> } = {},
) {
  const sdk = new FakeSdk(script);
  const budget =
    over.budget instanceof MemoryBudgetStore ? over.budget : new MemoryBudgetStore(() => NOW);
  const alerts: BudgetAlert[] = [];
  const bugs: unknown[] = [];
  let id = 0;
  const gateway = new LlmGateway({
    timeZone: TZ,
    provider: new AnthropicProvider(sdk),
    budget,
    now: () => NOW,
    newId: () => `00000000-0000-7000-8000-${String(++id).padStart(12, '0')}`,
    observer: { onAlert: (a) => alerts.push(a), onBug: (e) => bugs.push(e) },
    ...over,
    config: { ...CONFIG, ...over.config },
  });
  return { sdk, budget, gateway, alerts, bugs };
}

const call = (over: Partial<LlmCall> = {}): LlmCall => ({
  caller: { uid: 1001, kind: 'user', osSessionId: '0192f2a0-0000-7000-8000-0000000000aa', pid: 7 },
  purpose: 'plan',
  promptId: '0192f2a0-0000-7000-8000-0000000000bb',
  turn: 1,
  system: 'You are the Plotinium planner.',
  tools: TOOLS,
  messages: [{ role: 'user', content: 'find my notes' }],
  ...over,
});

async function httpErrorOf(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error('expected an HttpError');
}

describe('LLM gateway: reserve, call outside any transaction, settle (backend-api.md §3.13)', () => {
  it('AIS-09 a successful call reserves, calls and settles, writing one llm_requests row with tokens, cost and both models', async () => {
    const order: string[] = [];
    const inner = new MemoryBudgetStore(() => NOW);
    const budget: BudgetStore = {
      reserve: (rows, req) => (order.push('reserve'), inner.reserve(rows, req)),
      settle: (keys, r, s) => (order.push('settle'), inner.settle(keys, r, s)),
      sweepAbandoned: (ms) => inner.sweepAbandoned(ms),
      pools: (keys) => inner.pools(keys),
    };
    const reply = fakeMessage({
      tool: { name: 'fs_find', input: { path: '/home/alice', name: null } },
      usage: { input: 1200, output: 300, cacheRead: 5000, cacheWrite: 100 },
    });
    const sdk = new FakeSdk([
      () => {
        order.push('provider');
        return Promise.resolve(reply);
      },
    ]);
    const gateway = new LlmGateway({
      config: CONFIG,
      timeZone: TZ,
      provider: new AnthropicProvider(sdk),
      budget,
      now: () => NOW,
    });
    const r = await gateway.call(call());

    expect(order).toEqual(['reserve', 'provider', 'settle']); // no transaction spans the provider call
    expect(r.toolCall).toEqual({ id: 'toolu_01', name: 'fs_find', input: { path: '/home/alice' } }); // null -> absent
    expect(r.model).toEqual({ requested: 'claude-opus-5-5', served: 'claude-opus-5-5' });
    // 1200*4 + 300*20 + 5000*0.2 + 100*5 = 4800 + 6000 + 1000 + 500 micro-USD
    expect(r.costMicroUsd).toBe(12_300);
    expect(r.requestIdUpstream).toBe('req_1');
    expect(r.usage).toEqual({ input: 1200, cacheWrite: 100, cacheRead: 5000, output: 300 });
    expect(inner.requests.size).toBe(1);
    const row = [...inner.requests.values()][0];
    expect(row).toMatchObject({
      status: 'ok',
      uid: 1001,
      purpose: 'plan',
      turn: 1,
      requestedModel: 'claude-opus-5-5',
      servedModel: 'claude-opus-5-5',
      stopReason: 'tool_use',
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 5000,
      cacheWriteTokens: 100,
      costMicroUsd: 12_300,
      pricingVersion: '2026-09-24',
      osSessionId: '0192f2a0-0000-7000-8000-0000000000aa',
      pid: 7,
    });
    expect(row?.reservedMicroUsd).toBeGreaterThan(8000 * 25); // max_tokens at the dearer fallback price
    expect(row?.chargedKeys).toEqual([
      'global/month/2026-09-01',
      'global/semester/2026-08-01',
      'uid:1001/day/2026-09-25',
    ]);
    for (const k of row?.chargedKeys ?? []) {
      const [pool, period, periodStart] = k.split('/') as [string, string, string];
      const p = inner.pool({ pool: pool as 'global', period: period as 'day', periodStart });
      expect(p?.reservedMicroUsd).toBe(0); // INV-SRV-6
      expect(p?.spentMicroUsd).toBe(12_300);
      expect(p?.calls).toBe(1);
    }
  });

  it('AIS-06 the request is strict, cached, effort medium, auto tool choice without parallel calls, with refusal fallbacks', async () => {
    const { sdk, gateway } = setup([
      fakeMessage({ tool: { name: 'fs_find', input: { path: '/x', name: 'a' } } }),
    ]);
    await gateway.call(call());
    const p = sdk.calls[0]?.params;
    expect(p?.model).toBe('claude-opus-5-5');
    expect(p?.output_config).toEqual({ effort: 'medium' });
    expect(p?.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(p?.tools?.[0]).toMatchObject({
      name: 'fs_find',
      strict: true,
      cache_control: { type: 'ephemeral' },
    });
    expect(p?.system).toEqual([
      {
        type: 'text',
        text: 'You are the Plotinium planner.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(p?.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(p?.fallbacks).toBe('default');
    expect(p && 'temperature' in p).toBe(false);
    expect(sdk.calls[0]?.options).toMatchObject({ timeout: 45_000, maxRetries: 1 });
    expect(sdk.calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('AIS-06 evaluation calls omit the refusal fallbacks (not accepted by batch evaluation)', async () => {
    const { sdk, gateway } = setup([fakeMessage({ text: 'ok' })]);
    await gateway.call(call({ purpose: 'eval', tools: [], expectToolCall: false }));
    expect(sdk.calls[0]?.params.betas).toBeUndefined();
    expect(sdk.calls[0]?.params.fallbacks).toBeUndefined();
    expect(sdk.calls[0]?.params.tools).toBeUndefined();
  });

  it('AIS-09 a call that would pass the per-user daily cap is refused with EAIUNAVAIL budget before the provider is called', async () => {
    const { sdk, gateway, budget } = setup([fakeMessage({ text: 'never' })], {
      config: { budget: { ...LIMITS, userUsdDay: 0.01 } },
    });
    const e = await httpErrorOf(gateway.call(call()));
    expect(e.status).toBe(429);
    expect(e.errno).toBe('EAIUNAVAIL');
    expect(e.reason).toBe('budget');
    expect(e.detail['pools']).toEqual(['uid:1001/day']);
    expect(e.retryAfterMs).toBe(12 * 3600 * 1000); // until the next budget day in PLOTINIUM_TZ
    expect(sdk.calls).toHaveLength(0);
    expect(budget.requests.size).toBe(0); // the reservation rolled back entirely
  });

  it('AIS-09 the project hard cap refuses every call once the semester budget is spent, and alerts fire at 50, 80 and 100 %', async () => {
    // Month cap $1: each call costs ~ $0.30 (input 50,000 x $4 + output 5,000 x $20 = $0.30).
    const reply = () => fakeMessage({ text: 'ok', usage: { input: 50_000, output: 5000 } });
    const { gateway, alerts } = setup([reply(), reply(), reply(), reply()], {
      config: { budget: { ...LIMITS, monthUsd: 1, totalUsd: 250, userUsdDay: 100 }, maxTokens: 10 },
      estimateInputTokens: () => 0,
    });
    const plain = call({ tools: [], expectToolCall: false });
    await gateway.call(plain); // 30 %
    expect(alerts).toEqual([]);
    await gateway.call(plain); // 60 % -> 50 %
    expect(alerts.map((a) => [a.period, a.threshold])).toEqual([['month', 0.5]]);
    await gateway.call(plain); // 90 % -> 80 %
    expect(alerts.map((a) => a.threshold)).toEqual([0.5, 0.8]);
    await gateway.call(plain); // 120 % -> 100 % (the settle is unconditional: the money is spent)
    expect(alerts.map((a) => a.threshold)).toEqual([0.5, 0.8, 1]);
    const e = await httpErrorOf(gateway.call(plain));
    expect(e.reason).toBe('budget');
    expect(e.detail['pools']).toEqual(['global/month']);
  });

  it('AIS-09 guests and the demo account share one demo pool with a call cap; examiners have their own pool', async () => {
    const replies = Array.from({ length: 6 }, () => fakeMessage({ text: 'ok' }));
    const { gateway, budget } = setup(replies, {
      config: { budget: { ...LIMITS, demoCallsDay: 2 } },
    });
    const plain = { tools: [], expectToolCall: false } as const;
    await gateway.call(call({ ...plain, caller: { uid: 60001, kind: 'guest' } }));
    await gateway.call(call({ ...plain, caller: { uid: 900, kind: 'demo' } }));
    const e = await httpErrorOf(
      gateway.call(call({ ...plain, caller: { uid: 60002, kind: 'guest' } })),
    );
    expect(e.reason).toBe('budget');
    expect(e.detail['pools']).toEqual(['demo/day']);
    // examiners are charged to their own day row and the examiners pool, never the demo pool
    await gateway.call(call({ ...plain, caller: { uid: 2001, kind: 'examiner' } }));
    const examinerRow = [...budget.requests.values()].find((r) => r.uid === 2001);
    expect(examinerRow?.chargedKeys).toEqual([
      'global/month/2026-09-01',
      'global/semester/2026-08-01',
      'uid:2001/day/2026-09-25',
      'examiners/day/2026-09-25',
    ]);
    expect(
      budget.pool({ pool: 'examiners', period: 'day', periodStart: '2026-09-25' }),
    ).toMatchObject({
      limitMicroUsd: 15_000_000,
      callLimit: 100,
      calls: 1,
    });
  });

  it('AIS-02 a refusal is checked before content and maps to 422 EAIREFUSED with the category, logged as refused', async () => {
    const { gateway, budget } = setup([
      fakeMessage({
        stopReason: 'refusal',
        category: 'cyber',
        text: 'partial',
        usage: { input: 10, output: 5 },
      }),
    ]);
    const e = await httpErrorOf(gateway.call(call()));
    expect(e.status).toBe(422);
    expect(e.errno).toBe('EAIREFUSED');
    expect(e.detail['category']).toBe('cyber');
    const row = [...budget.requests.values()][0];
    expect(row).toMatchObject({
      status: 'refused',
      refusalCategory: 'cyber',
      stopReason: 'refusal',
      costMicroUsd: 10 * 4 + 5 * 20,
    });
  });

  it('AIS-09 a server-side fallback is logged with the served model and priced at its rates', async () => {
    const { gateway, budget } = setup([
      fakeMessage({ model: 'claude-opus-5', text: 'ok', usage: { input: 100, output: 100 } }),
    ]);
    const r = await gateway.call(call({ tools: [], expectToolCall: false }));
    expect(r.model).toEqual({ requested: 'claude-opus-5-5', served: 'claude-opus-5' });
    expect(r.costMicroUsd).toBe(100 * 5 + 100 * 25);
    expect([...budget.requests.values()][0]?.servedModel).toBe('claude-opus-5');
  });

  it('AGT-01 max_tokens discards the reply and retries once with 16,000 tokens; each provider call has its own row', async () => {
    const { sdk, gateway, budget } = setup([
      fakeMessage({ stopReason: 'max_tokens', text: 'cut', usage: { input: 10, output: 8000 } }),
      fakeMessage({
        tool: { name: 'fs_find', input: { path: '/a', name: null } },
        usage: { input: 10, output: 10 },
      }),
    ]);
    const r = await gateway.call(call());
    expect(sdk.calls.map((c) => c.params.max_tokens)).toEqual([8000, MAX_TOKENS_RETRY]);
    expect(sdk.calls[1]?.params.messages).toHaveLength(1); // the cut reply is NOT appended
    expect(r.appended).toEqual([]);
    expect(budget.requests.size).toBe(2);
    expect(r.costMicroUsd).toBe(10 * 4 + 8000 * 20 + 10 * 4 + 10 * 20);
  });

  it('AGT-01 a text-only reply gets one retry with the fixed reminder appended as a new user turn', async () => {
    const { sdk, gateway } = setup([
      fakeMessage({ text: 'I would search your home.' }),
      fakeMessage({ tool: { name: 'fs_find', input: { path: '/home', name: null } } }),
    ]);
    const r = await gateway.call(call());
    expect(r.appended).toHaveLength(2);
    expect(r.appended[0]?.role).toBe('assistant');
    expect(r.appended[1]).toEqual({ role: 'user', content: TOOL_REMINDER });
    expect(sdk.calls[1]?.params.messages).toHaveLength(3); // append-only transcript
    expect(r.toolCall?.name).toBe('fs_find');
  });

  it('AGT-01 a second text-only reply gives up with EAIUNAVAIL upstream', async () => {
    const { gateway } = setup([fakeMessage({ text: 'a' }), fakeMessage({ text: 'b' })]);
    const e = await httpErrorOf(gateway.call(call()));
    expect(e.status).toBe(503);
    expect(e.reason).toBe('upstream');
  });

  it('AGT-01 a tool input that fails its Valibot re-parse is 422 EINVAL; an unknown tool is 422 too', async () => {
    const bad = setup([
      fakeMessage({ tool: { name: 'fs_find', input: { path: 'relative', name: null } } }),
    ]);
    const e1 = await httpErrorOf(bad.gateway.call(call()));
    expect([e1.status, e1.errno, e1.detail['field']]).toEqual([422, 'EINVAL', 'path']);
    const unknown = setup([fakeMessage({ tool: { name: 'rm_rf', input: {} } })]);
    const e2 = await httpErrorOf(unknown.gateway.call(call()));
    expect([e2.status, e2.errno, e2.detail['tool']]).toEqual([422, 'EINVAL', 'rm_rf']);
    // both calls were still settled: the money is spent
    expect([...bad.budget.requests.values()][0]?.status).toBe('ok');
  });

  it('AIS-09 a provider error is settled at the reservation and mapped: 429 upstream, 401 no-key, 400 is a bug', async () => {
    const rate = setup([
      new RateLimitError(429, {}, 'slow down', new Headers({ 'retry-after': '3' })),
    ]);
    const e1 = await httpErrorOf(rate.gateway.call(call()));
    expect([e1.status, e1.errno, e1.reason, e1.retryAfterMs]).toEqual([
      503,
      'EAIUNAVAIL',
      'upstream',
      3000,
    ]);
    const row = [...rate.budget.requests.values()][0];
    expect(row?.status).toBe('error');
    expect(row?.costMicroUsd).toBe(row?.reservedMicroUsd); // no usage came back: charged
    expect(row?.error).toBe('EAIUNAVAIL upstream');

    const auth = setup([new AuthenticationError(401, {}, 'bad key', new Headers())]);
    const e2 = await httpErrorOf(auth.gateway.call(call()));
    expect([e2.status, e2.reason]).toEqual([503, 'no-key']);
    expect(auth.bugs).toHaveLength(1);

    const bad = setup([new BadRequestError(400, {}, 'bad', new Headers())]);
    const e3 = await httpErrorOf(bad.gateway.call(call()));
    expect([e3.status, e3.reason]).toEqual([503, 'upstream']);
    expect(bad.bugs).toHaveLength(1);
  });

  it('AIS-09 the per-turn deadline aborts the provider call: 504 timeout, reservation charged', async () => {
    const { gateway, budget } = setup([hangUntilAborted], { config: { timeoutMs: 20 } });
    const e = await httpErrorOf(gateway.call(call()));
    expect([e.status, e.errno, e.reason]).toEqual([504, 'EAIUNAVAIL', 'timeout']);
    expect([...budget.requests.values()][0]?.status).toBe('error');
  });

  it('AGT-09 a killed agent aborts the provider call through its signal: ECANCELED, reservation charged', async () => {
    const { gateway, budget } = setup([hangUntilAborted]);
    const ctl = new AbortController();
    const p = gateway.call(call({ signal: ctl.signal }));
    setTimeout(() => ctl.abort(), 5);
    const e = await httpErrorOf(p);
    expect(e.errno).toBe('ECANCELED');
    const row = [...budget.requests.values()][0];
    expect(row?.costMicroUsd).toBe(row?.reservedMicroUsd);
  });

  it('AIS-06 without a provider key the gateway is degraded no-key and reserves nothing', async () => {
    const budget = new MemoryBudgetStore(() => NOW);
    const gateway = new LlmGateway({
      config: CONFIG,
      timeZone: TZ,
      provider: null,
      budget,
      now: () => NOW,
    });
    expect(gateway.state).toBe('no-key');
    const e = await httpErrorOf(gateway.call(call()));
    expect([e.status, e.errno, e.reason]).toEqual([503, 'EAIUNAVAIL', 'no-key']);
    expect(budget.transactions).toBe(0);
    expect(await gateway.health({ uid: 1001, kind: 'user' })).toEqual({
      ok: false,
      model: 'claude-opus-5-5',
      degradedReason: 'no-key',
      budgetLeftMicroUsd: 2_000_000,
    });
  });

  it('AIS-09 health reports the budget left and degrades to budget when a charged pool is empty', async () => {
    const { gateway, budget } = setup(
      [fakeMessage({ text: 'ok', usage: { input: 0, output: 100_000 } })],
      {
        config: { budget: { ...LIMITS, userUsdDay: 2 } },
        estimateInputTokens: () => 0,
      },
    );
    expect((await gateway.health({ uid: 1001, kind: 'user' })).ok).toBe(true);
    await gateway.call(call({ tools: [], expectToolCall: false, maxTokens: 10 })); // $2.00 spent
    expect(
      budget.pool({ pool: 'uid:1001', period: 'day', periodStart: '2026-09-25' })?.spentMicroUsd,
    ).toBe(2_000_000);
    expect(await gateway.health({ uid: 1001, kind: 'user' })).toMatchObject({
      ok: false,
      degradedReason: 'budget',
      budgetLeftMicroUsd: 0,
    });
  });

  it('AIS-09 the llm-hour bucket and the shared demo-day bucket refuse with EAIUNAVAIL rate and retryAfterMs', async () => {
    const limiter = new RateLimiter({
      now: () => NOW,
      overrides: {
        'llm-hour': { spec: { ratePerMs: 1 / 3_600_000, capacity: 1 } },
        'llm-demo-day': { spec: { ratePerMs: 1 / 86_400_000, capacity: 1 } },
      },
    });
    const { gateway } = setup([fakeMessage({ text: 'ok' }), fakeMessage({ text: 'ok' })], {
      limiter,
    });
    const plain = { tools: [], expectToolCall: false } as const;
    await gateway.call(call(plain));
    const e = await httpErrorOf(gateway.call(call(plain)));
    expect([e.status, e.errno, e.reason]).toEqual([429, 'EAIUNAVAIL', 'rate']);
    expect(e.retryAfterMs).toBeGreaterThan(0);
    await gateway.call(call({ ...plain, caller: { uid: 60001, kind: 'guest' } }));
    const e2 = await httpErrorOf(
      gateway.call(call({ ...plain, caller: { uid: 60002, kind: 'guest' } })),
    );
    expect(e2.reason).toBe('rate');
  });

  it('AIS-09 at most LLM_MAX_INFLIGHT provider calls run at once; the next gets 429 rate', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { gateway } = setup([async () => (await gate, fakeMessage({ text: 'ok' }))], {
      config: { maxInflight: 1 },
    });
    const first = gateway.call(call({ tools: [], expectToolCall: false }));
    await vi.waitFor(() => undefined);
    const e = await httpErrorOf(gateway.call(call({ tools: [], expectToolCall: false })));
    expect([e.status, e.reason, e.retryAfterMs]).toEqual([429, 'rate', 1000]);
    release();
    await expect(first).resolves.toMatchObject({ text: 'ok' });
  });

  it('AIS-07 replay mode logs status replayed at zero cost and reserves nothing', async () => {
    const { gateway, budget } = setup([fakeMessage({ text: 'ok' })], {
      config: { mode: 'replay' },
    });
    const r = await gateway.call(call({ tools: [], expectToolCall: false }));
    expect(r.replayed).toBe(true);
    expect(r.costMicroUsd).toBe(0);
    expect([...budget.requests.values()][0]).toMatchObject({
      status: 'replayed',
      costMicroUsd: 0,
      reservedMicroUsd: 0,
    });
  });

  it('AIS-09 the sweeper abandons stale reservations and settles them at the estimate', async () => {
    let t = NOW;
    const budget = new MemoryBudgetStore(() => t);
    const provider: LlmProvider = { name: 'never', send: () => new Promise(() => undefined) };
    const gateway = new LlmGateway({
      config: CONFIG,
      timeZone: TZ,
      provider,
      budget,
      now: () => t,
    });
    void gateway.call(call()).catch(() => undefined); // crashes "mid-call": never settles
    await vi.waitFor(() => expect(budget.requests.size).toBe(1));
    t += 11 * 60 * 1000;
    expect(await gateway.sweepAbandoned()).toBe(1);
    const row = [...budget.requests.values()][0];
    expect(row?.status).toBe('abandoned');
    expect(row?.costMicroUsd).toBe(row?.reservedMicroUsd);
    expect(
      budget.pool({ pool: 'uid:1001', period: 'day', periodStart: '2026-09-25' })?.reservedMicroUsd,
    ).toBe(0);
  });
});
