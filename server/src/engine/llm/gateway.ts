/**
 * The LLM gateway pipeline (backend-api.md §3.13.1; agentic-shell.md §3.8, §3.20, §4.3;
 * ai-safety-and-evaluation.md §3.12; spec §12.6).
 *
 * One `call()`:
 *   1. per-uid token buckets (the route's `llm` class runs in the preValidation hook; this adds
 *      `llm-hour` and the examiner or shared demo pool) and the in-flight semaphore
 *      (LLM_MAX_INFLIGHT)                                  -> 429 EAIUNAVAIL 'rate' + retryAfterMs
 *   2. gateway state: no provider (no key in live mode)  -> 503 EAIUNAVAIL 'no-key'
 *   3. RESERVE in a short transaction                     -> 429 EAIUNAVAIL 'budget'
 *   4. the provider call OUTSIDE any transaction, with the caller's AbortSignal and the per-turn
 *      deadline (LLM_TIMEOUT_MS)                           -> 504 'timeout' / 503 'upstream' / 'no-key'
 *   5. SETTLE in a second short transaction (unconditional; no usage -> the reservation is
 *      charged) and one llm_requests row per provider call, refused and failed calls included
 *   6. stop_reason is checked BEFORE content: 'refusal' -> 422 EAIREFUSED {category};
 *      'max_tokens' -> the response is discarded and the call retried once with 16,000 tokens;
 *      a text-only reply when a tool call was expected -> one retry with the fixed reminder as a
 *      new user turn (agentic-shell.md §3.8 step 6)
 *   7. the tool input is re-parsed with its Valibot schema (nulls mapped to absent) -> 422 EINVAL
 * Alerts at 50, 80 and 100 % of the global caps are logged at warn and reported to the observer;
 * at 100 % the reservation itself refuses every call.
 */
import * as v from 'valibot';

import { HttpError } from '../../http/errors.ts';
import type { RateLimiter } from '../../ratelimit/limiter.ts';
import type { RateClassName } from '../../ratelimit/classes.ts';
import { uuidv7 } from '../../util/uuidv7.ts';
import {
  buildMessageParams,
  classifyProviderError,
  parseEffort,
  textOf,
  toolCallOf,
  usageOf,
  type BetaMessage,
  type BetaMessageParam,
  type BetaMessageStreamParams,
  type BetaTool,
  type LlmProvider,
  type ToolCall,
} from './anthropic.ts';
import {
  budgetLeft,
  chargedRows,
  crossedAlerts,
  localClock,
  type AccountKind,
  type BudgetAlert,
  type BudgetLimits,
  type BudgetRow,
  type BudgetStore,
  type LlmPurpose,
  type Settlement,
} from './budget.ts';
import { createPricing, type Pricing, type TokenUsage } from './pricing.ts';
import { nullsToAbsent } from './strict-tools.ts';

/** agentic-shell.md §3.8 step 6. */
export const TOOL_REMINDER = 'Respond by calling exactly one of the provided tools.';
export const MAX_TOKENS_RETRY = 16_000;
/** Reservations older than this are abandoned by the sweeper (backend-api.md §3.13.2). */
export const ABANDON_AFTER_MS = 10 * 60 * 1000;

export interface GatewayConfig {
  readonly mode: 'live' | 'record' | 'replay';
  readonly model: string;
  readonly fallbackModel: string;
  readonly effort: string;
  readonly temperature: number | undefined;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly maxInflight: number;
  readonly budget: BudgetLimits;
}

export interface LlmCaller {
  readonly uid: number;
  readonly kind: AccountKind;
  readonly osSessionId?: string | null;
  readonly pid?: number | null;
}

/** A tool the model may call, with the Valibot schema its input is re-parsed with. */
export interface GatewayTool {
  readonly definition: BetaTool;
  readonly schema?: v.GenericSchema;
}

export interface LlmCall {
  readonly caller: LlmCaller;
  readonly purpose: LlmPurpose;
  /** The agent requestId (joins llm_requests to audit_log). */
  readonly promptId?: string | null;
  /** 1..6 (the observation-loop cap). */
  readonly turn?: number;
  readonly system: string;
  readonly tools: readonly GatewayTool[];
  /** The transcript so far (append-only). */
  readonly messages: readonly BetaMessageParam[];
  readonly maxTokens?: number;
  /** Aborts the provider call (client disconnect, agent killed). */
  readonly signal?: AbortSignal;
  /** Server-side refusal fallbacks; default on, except for 'eval' and 'bakeoff'. */
  readonly fallbacks?: boolean;
  /** Retry once on a text-only reply with the fixed reminder; default: when tools are given. */
  readonly expectToolCall?: boolean;
}

export interface LlmTurnResult {
  /** The assistant message; the caller appends `message.content` unchanged to its transcript. */
  readonly message: BetaMessage;
  /**
   * Turns the gateway added before `message` (the discarded-text reply and the reminder of a
   * retry); the caller appends them first so its transcript stays append-only.
   */
  readonly appended: readonly BetaMessageParam[];
  readonly toolCall: ToolCall | null;
  readonly text: string;
  readonly model: { readonly requested: string; readonly served: string };
  readonly requestIdUpstream: string | null;
  readonly usage: {
    readonly input: number;
    readonly cacheWrite: number;
    readonly cacheRead: number;
    readonly output: number;
  };
  /** Sum over every provider call this turn made (retries included). */
  readonly costMicroUsd: number;
  readonly latencyMs: number;
  readonly replayed: boolean;
  /** llm_requests.request_id of the provider call that produced `message`. */
  readonly llmRequestId: string;
}

export interface LlmRequestEvent {
  readonly model: string;
  readonly status: Settlement['status'];
  readonly costMicroUsd: number;
  readonly latencyMs: number;
  readonly tokens: TokenUsage | null;
}

/** Metrics hooks (plotinium_llm_* in backend-api.md §3.16); all optional. */
export interface GatewayObserver {
  onRequest?(e: LlmRequestEvent): void;
  onBudgetRatio?(scope: string, ratio: number): void;
  onAlert?(a: BudgetAlert): void;
  onBug?(err: unknown): void;
}

export interface GatewayLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface GatewayDeps {
  readonly config: GatewayConfig;
  readonly timeZone: string;
  /** null: no key in live mode, the gateway is degraded ('no-key'). */
  readonly provider: LlmProvider | null;
  readonly budget: BudgetStore;
  readonly limiter?: RateLimiter;
  readonly pricing?: Pricing;
  readonly observer?: GatewayObserver;
  readonly logger?: GatewayLogger;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Input-token estimate for the reservation; default: UTF-8 bytes of the request / 2, rounded up. */
  readonly estimateInputTokens?: (params: BetaMessageStreamParams) => number;
  /** Overrides the semester period start (default: Fall = Aug..Jan, Spring = Feb..Jul). */
  readonly semesterStart?: string;
}

export interface LlmHealth {
  readonly ok: boolean;
  readonly model: string;
  readonly degradedReason?: 'no-key' | 'budget';
  readonly budgetLeftMicroUsd: number;
}

/** A conservative token estimate: no Claude token is shorter than two bytes of JSON on average. */
export function defaultInputEstimate(params: BetaMessageStreamParams): number {
  const text = JSON.stringify({ s: params.system, t: params.tools, m: params.messages });
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 2);
}

class Semaphore {
  #free: number;
  constructor(n: number) {
    this.#free = Math.max(1, n);
  }
  tryAcquire(): boolean {
    if (this.#free === 0) return false;
    this.#free--;
    return true;
  }
  release(): void {
    this.#free++;
  }
}

interface Attempt {
  readonly message: BetaMessage;
  readonly requestId: string | null;
  readonly llmRequestId: string;
  readonly costMicroUsd: number;
  readonly latencyMs: number;
}

export class LlmGateway {
  readonly #d: GatewayDeps;
  readonly #pricing: Pricing;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #inflight: Semaphore;

  constructor(deps: GatewayDeps) {
    this.#d = deps;
    this.#pricing = deps.pricing ?? createPricing();
    this.#now = deps.now ?? (() => Date.now());
    this.#newId = deps.newId ?? (() => uuidv7());
    this.#inflight = new Semaphore(deps.config.maxInflight);
  }

  /** 'available' or the reason the gateway is degraded before any budget check. */
  get state(): 'available' | 'no-key' {
    return this.#d.provider === null ? 'no-key' : 'available';
  }

  /** GET /api/llm/health (agentic-shell.md §4.3): {ok, model, degradedReason?, budgetLeftMicroUsd}. */
  async health(caller: LlmCaller): Promise<LlmHealth> {
    const rows = this.#rows(caller);
    const left = budgetLeft(rows, await this.#d.budget.pools(rows));
    const model = this.#d.config.model;
    if (this.#d.provider === null)
      return { ok: false, model, degradedReason: 'no-key', budgetLeftMicroUsd: left };
    if (left <= 0) return { ok: false, model, degradedReason: 'budget', budgetLeftMicroUsd: left };
    return { ok: true, model, budgetLeftMicroUsd: left };
  }

  /** The crash-recovery sweeper (startup and a periodic job). */
  sweepAbandoned(olderThanMs: number = ABANDON_AFTER_MS): Promise<number> {
    return this.#d.budget.sweepAbandoned(olderThanMs);
  }

  async call(req: LlmCall): Promise<LlmTurnResult> {
    this.#takeRate(req.caller);
    const provider = this.#d.provider;
    if (provider === null) {
      throw new HttpError(503, 'EAIUNAVAIL', 'agent unavailable (model service)', {
        reason: 'no-key',
      });
    }
    if (!this.#inflight.tryAcquire()) {
      throw new HttpError(
        429,
        'EAIUNAVAIL',
        'agent busy — too many model calls in flight',
        { reason: 'rate' },
        1000,
      );
    }
    try {
      return await this.#turn(provider, req);
    } finally {
      this.#inflight.release();
    }
  }

  async #turn(provider: LlmProvider, req: LlmCall): Promise<LlmTurnResult> {
    const cfg = this.#d.config;
    const tools = req.tools.map((t) => t.definition);
    const expectTool = req.expectToolCall ?? tools.length > 0;
    const fallbacks = req.fallbacks ?? (req.purpose !== 'eval' && req.purpose !== 'bakeoff');
    const effort = parseEffort(cfg.effort);
    let messages: BetaMessageParam[] = [...req.messages];
    const appended: BetaMessageParam[] = [];
    let maxTokens = req.maxTokens ?? cfg.maxTokens;
    let totalCost = 0;
    let totalLatency = 0;
    let retriedMaxTokens = false;
    let retriedReminder = false;

    for (;;) {
      const params = buildMessageParams({
        model: cfg.model,
        maxTokens,
        effort,
        system: req.system,
        tools,
        messages,
        fallbacks,
        temperature: cfg.temperature,
      });
      const attempt = await this.#attempt(provider, req, params, fallbacks);
      totalCost += attempt.costMicroUsd;
      totalLatency += attempt.latencyMs;
      const msg = attempt.message;

      // stop_reason BEFORE content (§3.13.1 step 8)
      if (msg.stop_reason === 'refusal') {
        const category = msg.stop_details?.category ?? null;
        throw new HttpError(422, 'EAIREFUSED', 'the model declined this request', {
          category,
          model: msg.model,
        });
      }
      if (msg.stop_reason === 'max_tokens' && !retriedMaxTokens) {
        retriedMaxTokens = true; // discard the response (it is NOT appended) and retry once
        maxTokens = Math.max(maxTokens, MAX_TOKENS_RETRY);
        continue;
      }
      const call = toolCallOf(msg);
      if (call === null && expectTool && msg.stop_reason === 'end_turn' && !retriedReminder) {
        retriedReminder = true;
        const turns: BetaMessageParam[] = [
          { role: 'assistant', content: msg.content },
          { role: 'user', content: TOOL_REMINDER },
        ];
        appended.push(...turns);
        messages = [...messages, ...turns];
        continue;
      }
      if (msg.stop_reason === 'max_tokens' || (call === null && expectTool)) {
        throw new HttpError(503, 'EAIUNAVAIL', 'agent unavailable (no usable model reply)', {
          reason: 'upstream',
          stopReason: msg.stop_reason,
        });
      }
      const toolCall = call === null ? null : this.#parseTool(call, req.tools);
      const usage = usageOf(msg);
      return {
        message: msg,
        appended,
        toolCall,
        text: textOf(msg),
        model: { requested: cfg.model, served: msg.model },
        requestIdUpstream: attempt.requestId,
        usage: {
          input: usage.input,
          cacheWrite: usage.cacheWrite,
          cacheRead: usage.cacheRead,
          output: usage.output,
        },
        costMicroUsd: totalCost,
        latencyMs: totalLatency,
        replayed: cfg.mode === 'replay',
        llmRequestId: attempt.llmRequestId,
      };
    }
  }

  /** One provider call: reserve, call outside any transaction, settle. */
  async #attempt(
    provider: LlmProvider,
    req: LlmCall,
    params: BetaMessageStreamParams,
    fallbacks: boolean,
  ): Promise<Attempt> {
    const cfg = this.#d.config;
    const replay = cfg.mode === 'replay';
    const rows = this.#rows(req.caller);
    const models = fallbacks ? [cfg.model, cfg.fallbackModel] : [cfg.model];
    const estimateInput = this.#d.estimateInputTokens ?? defaultInputEstimate;
    const reserved = replay
      ? 0
      : this.#pricing.reserveMicroUsd(models, estimateInput(params), params.max_tokens);
    const llmRequestId = this.#newId();

    const outcome = await this.#d.budget.reserve(rows, {
      requestId: llmRequestId,
      uid: req.caller.uid,
      osSessionId: req.caller.osSessionId ?? null,
      pid: req.caller.pid ?? null,
      promptId: req.promptId ?? null,
      turn: req.turn ?? 1,
      purpose: req.purpose,
      requestedModel: cfg.model,
      effort: cfg.effort,
      pricingVersion: this.#pricing.version,
      reservedMicroUsd: reserved,
    });
    if (!outcome.ok) {
      const clock = localClock(this.#now(), this.#d.timeZone);
      throw new HttpError(
        429,
        'EAIUNAVAIL',
        "today's AI budget is used up",
        { reason: 'budget', pools: outcome.exhausted.map((k) => `${k.pool}/${k.period}`) },
        clock.msToNextDay,
      );
    }

    // The provider call: no transaction is open here (INV-SRV-3).
    const ctl = new AbortController();
    let deadline = false;
    const timer = setTimeout(() => {
      deadline = true;
      ctl.abort(new Error('deadline'));
    }, cfg.timeoutMs);
    const onAbort = (): void => ctl.abort(req.signal?.reason);
    if (req.signal !== undefined) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }
    const started = this.#now();
    let reply: Awaited<ReturnType<LlmProvider['send']>>;
    try {
      reply = await provider.send(params, { signal: ctl.signal, timeoutMs: cfg.timeoutMs });
    } catch (e) {
      const latencyMs = this.#now() - started;
      const failure = classifyProviderError(e, {
        deadline,
        cancelled: req.signal?.aborted === true,
      });
      await this.#settle(
        rows,
        reserved,
        {
          requestId: llmRequestId,
          status: 'error',
          servedModel: null,
          stopReason: null,
          refusalCategory: null,
          providerRequestId: null,
          tokens: null,
          costMicroUsd: reserved, // no usage came back: the reservation is charged
          latencyMs,
          error: `${failure.error.errno}${failure.error.reason === undefined ? '' : ` ${failure.error.reason}`}`,
        },
        cfg.model,
        null,
      );
      if (failure.bug) {
        this.#d.logger?.error({ err: e, llmRequestId }, 'provider call failed (request rejected)');
        this.#d.observer?.onBug?.(e);
      }
      throw failure.error;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }

    const latencyMs = this.#now() - started;
    const msg = reply.message;
    const usage = usageOf(msg);
    const cost = replay ? 0 : this.#pricing.costMicroUsd(msg.model, usage);
    await this.#settle(
      rows,
      reserved,
      {
        requestId: llmRequestId,
        status: replay ? 'replayed' : msg.stop_reason === 'refusal' ? 'refused' : 'ok',
        servedModel: msg.model,
        stopReason: msg.stop_reason,
        refusalCategory:
          msg.stop_reason === 'refusal' ? (msg.stop_details?.category ?? null) : null,
        providerRequestId: reply.requestId,
        tokens: {
          input: usage.input,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          output: usage.output,
        },
        costMicroUsd: cost,
        latencyMs,
        error: null,
      },
      msg.model,
      usage,
    );
    return {
      message: msg,
      requestId: reply.requestId,
      llmRequestId,
      costMicroUsd: cost,
      latencyMs,
    };
  }

  async #settle(
    rows: readonly BudgetRow[],
    reserved: number,
    s: Settlement,
    model: string,
    tokens: TokenUsage | null,
  ): Promise<void> {
    const after = await this.#d.budget.settle(rows, reserved, s);
    this.#d.observer?.onRequest?.({
      model,
      status: s.status,
      costMicroUsd: s.costMicroUsd,
      latencyMs: s.latencyMs,
      tokens,
    });
    for (const row of after) {
      if (row.pool === 'global' && row.limitMicroUsd > 0) {
        this.#d.observer?.onBudgetRatio?.(
          `global/${row.period}`,
          row.spentMicroUsd / row.limitMicroUsd,
        );
      }
    }
    for (const alert of crossedAlerts(after, s.costMicroUsd)) {
      this.#d.logger?.warn(
        { pool: alert.pool, period: alert.period, threshold: alert.threshold, ratio: alert.ratio },
        `LLM budget ${Math.round(alert.threshold * 100)}% of the ${alert.period} cap reached`,
      );
      this.#d.observer?.onAlert?.(alert);
    }
  }

  #parseTool(call: ToolCall, tools: readonly GatewayTool[]): ToolCall {
    const tool = tools.find((t) => t.definition.name === call.name);
    if (tool === undefined) {
      throw new HttpError(422, 'EINVAL', 'the model called an unknown tool', {
        field: 'tool',
        tool: call.name,
      });
    }
    if (tool.schema === undefined) return call;
    const parsed = v.safeParse(tool.schema, nullsToAbsent(call.input));
    if (!parsed.success) {
      const issue = parsed.issues[0];
      const field = issue?.path?.map((p) => String(p.key)).join('.') ?? '';
      throw new HttpError(422, 'EINVAL', 'the model returned an invalid tool input', {
        field,
        tool: call.name,
      });
    }
    return { id: call.id, name: call.name, input: parsed.output };
  }

  #takeRate(caller: LlmCaller): void {
    const limiter = this.#d.limiter;
    if (limiter === undefined) return;
    const classes: [RateClassName, string][] = [['llm-hour', String(caller.uid)]];
    if (caller.kind === 'examiner') classes.push(['llm-examiner-day', String(caller.uid)]);
    if (caller.kind === 'guest' || caller.kind === 'demo') classes.push(['llm-demo-day', 'global']);
    for (const [name, key] of classes) {
      const r = limiter.take(name, key);
      if (!r.ok) {
        throw new HttpError(
          429,
          'EAIUNAVAIL',
          'agent busy (rate limit)',
          { reason: 'rate' },
          r.retryAfterMs,
        );
      }
    }
  }

  #rows(caller: LlmCaller): BudgetRow[] {
    const clock = localClock(this.#now(), this.#d.timeZone);
    return chargedRows(caller, clock, this.#d.config.budget, this.#d.semesterStart);
  }
}
