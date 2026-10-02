/**
 * The LLM engine: one factory that assembles the gateway from the server configuration
 * (backend-api.md §3.13; the plugin server/src/llm/routes.ts calls it once, only when AI=1).
 *
 *   LLM_MODE=live     the SDK client with the platform fetch; no key -> degraded 'no-key'
 *   LLM_MODE=replay   the SDK client over a replay cassette fetch: no key, no network (CI)
 *   LLM_MODE=record   the SDK client over a recording cassette fetch (developer machines only;
 *                     config.ts refuses it in production and CI), capped by LLM_RECORD_BUDGET_USD
 */
import { fileURLToPath } from 'node:url';

import type { Kysely } from 'kysely';

import type { LlmConfig } from '../../config.ts';
import type { DB } from '../../db/types.gen.ts';
import type { RateLimiter } from '../../ratelimit/limiter.ts';
import { AnthropicProvider, createAnthropicClient, type LlmProvider } from './anthropic.ts';
import { MemoryBudgetStore } from './budget-memory.ts';
import type { BudgetStore } from './budget.ts';
import {
  createCassetteFetch,
  FsCassetteStore,
  type CassetteStore,
  type FetchLike,
} from './cassette.ts';
import { LlmGateway, type GatewayLogger, type GatewayObserver } from './gateway.ts';
import { KyselyBudgetStore } from './kysely-budget.ts';
import { createPricing, usdToMicro, type Pricing } from './pricing.ts';

export { LlmGateway } from './gateway.ts';
export type { LlmCall, LlmCaller, LlmTurnResult, GatewayTool, LlmHealth } from './gateway.ts';

/** Default cassette directory: ai/eval/cassettes/gateway/ in the repository. */
export const DEFAULT_CASSETTE_DIR = fileURLToPath(
  new URL('../../../../ai/eval/cassettes/gateway/', import.meta.url),
);
/** Placeholder credential for replay: the cassette fetch never sends anything. */
const REPLAY_API_KEY = 'replay-mode-no-credential';

export interface LlmEngineOptions {
  readonly llm: LlmConfig;
  readonly timeZone: string;
  /** null: no database (tests and tools) -> an in-memory budget. */
  readonly db: Kysely<DB> | null;
  readonly limiter?: RateLimiter;
  readonly logger?: GatewayLogger;
  readonly observer?: GatewayObserver;
  readonly cassettes?: CassetteStore;
  /** The platform fetch in live and record modes (tests inject one). */
  readonly fetch?: FetchLike;
  readonly budget?: BudgetStore;
  readonly pricing?: Pricing;
}

export interface LlmEngine {
  readonly gateway: LlmGateway;
  readonly mode: LlmConfig['mode'];
  readonly provider: LlmProvider | null;
}

export function createLlmEngine(o: LlmEngineOptions): LlmEngine {
  const cfg = o.llm;
  const pricing = o.pricing ?? createPricing();
  let provider: LlmProvider | null = null;
  if (cfg.mode === 'replay') {
    const store = o.cassettes ?? new FsCassetteStore(DEFAULT_CASSETTE_DIR);
    const client = createAnthropicClient({
      apiKey: REPLAY_API_KEY,
      fetch: createCassetteFetch({ mode: 'replay', store }),
      maxRetries: 0,
      timeoutMs: cfg.timeoutMs,
    });
    provider = new AnthropicProvider(client, 0);
  } else if (cfg.apiKey !== undefined) {
    const fetch =
      cfg.mode === 'record'
        ? createCassetteFetch({
            mode: 'record',
            store: o.cassettes ?? new FsCassetteStore(DEFAULT_CASSETTE_DIR),
            upstream: o.fetch ?? ((input, init) => globalThis.fetch(input, init)),
            apiKey: cfg.apiKey,
            pricing,
            ...(cfg.recordBudgetUsd === undefined
              ? {}
              : { recordBudgetMicroUsd: usdToMicro(cfg.recordBudgetUsd) }),
          })
        : o.fetch;
    const client = createAnthropicClient({
      apiKey: cfg.apiKey,
      ...(fetch === undefined ? {} : { fetch }),
      maxRetries: 1,
      timeoutMs: cfg.timeoutMs,
    });
    provider = new AnthropicProvider(client, 1);
  }
  const budget =
    o.budget ?? (o.db === null ? new MemoryBudgetStore() : new KyselyBudgetStore(o.db));
  const gateway = new LlmGateway({
    config: {
      mode: cfg.mode,
      model: cfg.model,
      fallbackModel: cfg.fallbackModel,
      effort: cfg.effort,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      timeoutMs: cfg.timeoutMs,
      maxInflight: cfg.maxInflight,
      budget: cfg.budget,
    },
    timeZone: o.timeZone,
    provider,
    budget,
    pricing,
    ...(o.limiter === undefined ? {} : { limiter: o.limiter }),
    ...(o.logger === undefined ? {} : { logger: o.logger }),
    ...(o.observer === undefined ? {} : { observer: o.observer }),
  });
  return { gateway, mode: cfg.mode, provider };
}
