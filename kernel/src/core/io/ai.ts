/**
 * The AI services as the kernel runs them (C12; boot-and-services.md §3.3 `ai.runtime`,
 * `ai.indexer`, `ai.predictor`, `ai.agent`).
 *
 * The kernel may not import ai/, so the host links it (`IoDeps.ai`, built with `installAi` from
 * `@plotinium/ai/kernel`): the linked service implementations register the `ai.*` calls and the
 * `@plotinium/kernel/hooks` seams themselves when they start. This module picks, per service, the
 * linked implementation or the clean DEGRADED fallback (no link, the `__AI__=false` build, or
 * safe mode), so the desktop always boots and every non-AI feature works (ARC-06 litmus).
 */
import type {
  AiPort,
  AiServiceName,
  AiStart,
  BootProfile,
  ServiceContext,
  ServiceImpl,
} from '@plotinium/services';
import { aiService } from '@plotinium/services';

import type { ArgsOf } from '@plotinium/protocol';

import { KernelError } from '../errors.ts';
import type { Caller } from '../ipc/ports.ts';
import type { AiLink, AiLinkContext } from './types.ts';

export const AI_SERVICE_NAMES: readonly AiServiceName[] = [
  'ai.runtime',
  'ai.indexer',
  'ai.predictor',
  'ai.agent',
];

export const AI_OFF_REASON = 'AI is not part of this build';
export const AI_UNLINKED_REASON = 'AI runtime not linked';

/**
 * Services whose process needs `svc:ai.runtime` to spawn although their manifest (the §3.3 table)
 * does not require `ai.runtime`. With a resumed session `login` can settle before `mm`, and so
 * before `ai.runtime`: spawning then failed with "service ai.runtime is down" and the desktop
 * showed "ai.predictor stopped" on every boot (UI-134).
 */
const NEEDS_RUNTIME: ReadonlySet<AiServiceName> = new Set(['ai.predictor']);
/** How long such a service waits for `ai.runtime` to settle before it spawns anyway (UI-134). */
export const AI_RUNTIME_WAIT_MS = 1_200;
const AI_RUNTIME_POLL_MS = 20;

/** Resolves once `ai.runtime` is no longer pending or starting (or after the wait, or on abort). */
export function aiRuntimeSettled(ctx: ServiceContext): Promise<void> {
  const unsettled = (): boolean => {
    const st = ctx.depState('ai.runtime');
    return st === 'pending' || st === 'starting';
  };
  if (!unsettled()) return Promise.resolve();
  const end = ctx.timers.now() + AI_RUNTIME_WAIT_MS;
  return new Promise<void>((resolve) => {
    const tick = (): void => {
      if (!unsettled() || ctx.signal.aborted || ctx.timers.now() >= end) {
        resolve();
        return;
      }
      ctx.timers.at(ctx.timers.now() + AI_RUNTIME_POLL_MS, tick);
    };
    tick();
  });
}

/** The fallback port: every service reports why it is not running. */
export class AiFallbackPort implements AiPort {
  private readonly enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  start(name: AiServiceName, profile: BootProfile): Promise<AiStart> {
    if (profile === 'safe')
      return Promise.resolve({
        status: 'degraded',
        reason: 'safe mode: AI is off',
        selfHeals: false,
      });
    return Promise.resolve({
      status: 'degraded',
      reason: `${this.enabled ? AI_UNLINKED_REASON : AI_OFF_REASON} (${name})`,
      selfHeals: false,
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

export class AiIo {
  readonly port: AiFallbackPort;
  private readonly spec: AiLink | ((ctx: AiLinkContext) => AiLink) | undefined;
  private readonly ctx: AiLinkContext;
  private linkRef: AiLink | null = null;
  private failed = false;
  private readonly enabled: boolean;
  private readonly log: (msg: string) => void;

  constructor(opts: {
    readonly enabled: boolean;
    readonly link: AiLink | ((ctx: AiLinkContext) => AiLink) | undefined;
    readonly ctx: AiLinkContext;
    readonly log: (msg: string) => void;
  }) {
    this.enabled = opts.enabled;
    this.spec = opts.enabled ? opts.link : undefined;
    this.ctx = opts.ctx;
    this.port = new AiFallbackPort(opts.enabled);
    this.log = opts.log;
  }

  /** The host's link, built on first use (so it can reach the mounted file system). */
  get link(): AiLink | null {
    if (this.linkRef !== null || this.failed || this.spec === undefined) return this.linkRef;
    try {
      this.linkRef = typeof this.spec === 'function' ? this.spec(this.ctx) : this.spec;
    } catch (e) {
      this.failed = true;
      this.log(`AI link failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return this.linkRef;
  }

  /** The service implementation of `name`: linked (resolved at start) or the degraded fallback. */
  service(name: AiServiceName): ServiceImpl {
    const fallback = aiService(name, this.port);
    return {
      start: async (ctx) => {
        if (ctx.profile === 'safe' || !this.enabled) return fallback.start(ctx);
        const impl = this.link?.services[name];
        if (impl === undefined) return fallback.start(ctx);
        if (NEEDS_RUNTIME.has(name)) await aiRuntimeSettled(ctx);
        return impl.start(ctx);
      },
      stop: (ctx, reason) => {
        const impl = this.linkRef?.services[name];
        return impl === undefined ? fallback.stop(ctx, reason) : impl.stop(ctx, reason);
      },
    };
  }

  /** The agent `batch` gate for `registerFsSyscalls` (AGT-03); agent batches need a link. */
  verifyPlanToken(): (caller: Caller, args: ArgsOf<'batch'>) => KernelError | null {
    return (caller, args) => {
      const link = this.link;
      if (link?.verifyPlanToken === undefined)
        return new KernelError('EPERM', { reason: 'no-token' }, 'no agent runtime');
      const e = link.verifyPlanToken(caller, args);
      if (e === null) return null;
      return e instanceof KernelError
        ? e
        : new KernelError('EPERM', { reason: 'token' }, e.message.slice(0, 256));
    };
  }

  processExit(pid: number): void {
    this.linkRef?.onProcessExit?.(pid);
  }

  desktopInteractive(): void {
    this.link?.desktopInteractive?.();
  }

  noteInput(): void {
    this.linkRef?.noteInput?.();
  }
}
