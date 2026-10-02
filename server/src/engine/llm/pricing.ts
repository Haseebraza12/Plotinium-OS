/**
 * The LLM price table and cost arithmetic (backend-api.md §3.13.2; ai-safety-and-evaluation.md
 * §3.9, §3.12; spec §12.6 "log tokens and cost for every request").
 *
 * Money is integer micro-USD everywhere (database.md §3.21). Prices are quoted in US$ per million
 * tokens, which is numerically the same as micro-USD per token. To keep the arithmetic exact they
 * are stored as integer NANO-USD per token (US$/MTok x 1000): $0.20/MTok -> 200, $4/MTok -> 4000.
 * cost_microusd = ceil(sum(tokens x nano) / 1000).
 *
 * The table is versioned: `PRICING_VERSION` is written to llm_requests.pricing_version so the cost
 * report can tell which table priced a row. Checked against the Claude API reference on 2026-09-24.
 * Configuration may override or add rows (`createPricing`); an unknown model is priced at the most
 * expensive known row, so an unexpected served model can never make the budget look cheaper.
 */

export const PRICING_VERSION = '2026-09-24';

/** US$ per million tokens for one model. */
export interface ModelPriceUsd {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** 5-minute TTL cache writes: 1.25 x input (the gateway only uses the default TTL). */
  readonly cacheWrite5m: number;
  /** 1-hour TTL cache writes: 2 x input. */
  readonly cacheWrite1h: number;
}

/** backend-api.md §3.13.2 table, plus the evaluation-only rows of ai-safety-and-evaluation.md §3.9. */
export const PRICE_TABLE_USD: Readonly<Record<string, ModelPriceUsd>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
  },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};

/** Integer nano-USD per token. */
export interface ModelPrice {
  readonly model: string;
  readonly known: boolean;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

/** Token counts of one provider response (usage), in the gateway's own names. */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** All cache-creation tokens; `cacheWrite1h` of them were written with the 1-hour TTL. */
  readonly cacheWrite: number;
  readonly cacheWrite1h?: number;
}

export interface Pricing {
  readonly version: string;
  priceOf(model: string): ModelPrice;
  /** Actual cost of a response, priced by the SERVED model (backend-api.md §3.13.2 settle). */
  costMicroUsd(model: string, usage: TokenUsage): number;
  /**
   * The reservation (§3.13.2 reserve): input tokens x input price + max_tokens x output price,
   * taken at the most expensive of `models` (the requested model and, when refusal fallbacks are
   * on, the model the server may fall back to).
   */
  reserveMicroUsd(models: readonly string[], inputTokens: number, maxTokens: number): number;
}

const nano = (usdPerMTok: number): number => {
  if (!Number.isFinite(usdPerMTok) || usdPerMTok < 0) {
    throw new RangeError(`price must be a non-negative number, got ${usdPerMTok}`);
  }
  return Math.round(usdPerMTok * 1000);
};

const count = (n: number | undefined): number =>
  n === undefined || !Number.isFinite(n) || n < 0 ? 0 : Math.floor(n);

export function createPricing(
  overrides: Readonly<Record<string, ModelPriceUsd>> = {},
  version: string = PRICING_VERSION,
): Pricing {
  const table = new Map<string, ModelPrice>();
  for (const [model, p] of Object.entries({ ...PRICE_TABLE_USD, ...overrides })) {
    table.set(model, {
      model,
      known: true,
      input: nano(p.input),
      output: nano(p.output),
      cacheRead: nano(p.cacheRead),
      cacheWrite5m: nano(p.cacheWrite5m),
      cacheWrite1h: nano(p.cacheWrite1h),
    });
  }
  // The most expensive row (by output, then input) prices unknown models conservatively.
  let dearest: ModelPrice | undefined;
  for (const p of table.values()) {
    if (
      dearest === undefined ||
      p.output > dearest.output ||
      (p.output === dearest.output && p.input > dearest.input)
    ) {
      dearest = p;
    }
  }
  if (dearest === undefined) throw new RangeError('the price table is empty');
  const fallback = dearest;

  const priceOf = (model: string): ModelPrice => {
    const p = table.get(model);
    return p ?? { ...fallback, model, known: false };
  };

  return {
    version,
    priceOf,
    costMicroUsd(model, usage) {
      const p = priceOf(model);
      const write1h = Math.min(count(usage.cacheWrite1h), count(usage.cacheWrite));
      const write5m = count(usage.cacheWrite) - write1h;
      const totalNano =
        count(usage.input) * p.input +
        count(usage.output) * p.output +
        count(usage.cacheRead) * p.cacheRead +
        write5m * p.cacheWrite5m +
        write1h * p.cacheWrite1h;
      return Math.ceil(totalNano / 1000);
    },
    reserveMicroUsd(models, inputTokens, maxTokens) {
      let worst = 0;
      for (const model of models.length > 0 ? models : ['']) {
        const p = priceOf(model);
        const nanoUsd = count(inputTokens) * p.input + count(maxTokens) * p.output;
        worst = Math.max(worst, Math.ceil(nanoUsd / 1000));
      }
      return worst;
    },
  };
}

/** US$ (a configuration value such as LLM_USER_USD_DAY) to integer micro-USD. */
export function usdToMicro(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`bad US$ amount: ${usd}`);
  return Math.round(usd * 1_000_000);
}
