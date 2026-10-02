/**
 * The kernel seams ai/ registers (architecture.md §3.10, §4.4; C12), with the EXACT shapes that
 * `@plotinium/kernel/hooks` exports:
 *
 *   SchedulerHints    onIdle(idleMs) → the pre-fetch policy runs (PRE-04); residencyHint() → the
 *                     top-1 app whose pages reclaim skips once per pass for 60 s (AIN-C4)
 *   ShellNL           available() → whether the natural-language `ai` command can run now
 *   FsSemanticSearch  available() → 'semantic' | 'keyword' | 'none' (RAG-06 fallback)
 *
 * The kernel ships no-op defaults, so the AI-off litmus build (`__AI__=false`, ARC-06) boots
 * without this package; `installAi` (kernel/install.ts) calls `registerAiHooks` at `ai.runtime`
 * start and the returned function resets the seams when AI stops.
 *
 * The richer AI decisions (the confirmation predicate, the pre-fetch decision, semsearch itself)
 * stay inside ai/ and reach the OS only through syscalls: the seams carry signals, not policy.
 */
import type {
  FsSemanticSearch,
  KernelHooks,
  SchedulerHints,
  ShellNL,
} from '@plotinium/kernel/hooks';

export type { FsSemanticSearch, KernelHooks, SchedulerHints, ShellNL };

/** Where each seam's answer comes from (any may be absent: that seam keeps the kernel default). */
export interface AiHookSources {
  /** The prediction service (kernel/predict-service.ts). */
  predict?: {
    onIdle(idleMs: number): void;
    residencyHint(): { app: string; ttlMs: number } | null;
  };
  /** The agent's handlers are registered and the gateway is not known to be down. */
  readonly agentAvailable?: () => boolean;
  /** The search runtime's current answer. */
  readonly searchAvailable?: () => 'semantic' | 'keyword' | 'none';
}

/** The seams to register; only the sources that exist become hooks. */
export function createAiHooks(src: AiHookSources): Partial<KernelHooks> {
  const hooks: { scheduler?: SchedulerHints; shell?: ShellNL; search?: FsSemanticSearch } = {};
  const predict = src.predict;
  if (predict !== undefined) {
    hooks.scheduler = {
      onIdle: (idleMs) => {
        predict.onIdle(idleMs);
      },
      residencyHint: () => predict.residencyHint(),
    };
  }
  const agent = src.agentAvailable;
  if (agent !== undefined) hooks.shell = { available: () => agent() };
  const search = src.searchAvailable;
  if (search !== undefined) hooks.search = { available: () => search() };
  return hooks;
}

/** The kernel's `HookRegistry` as ai/ sees it. */
export interface HookRegistryLike {
  register(partial: Partial<KernelHooks>): void;
  reset(): void;
}

/** Register the seams; the result puts the kernel's no-op defaults back. */
export function registerAiHooks(registry: HookRegistryLike, src: AiHookSources): () => void {
  registry.register(createAiHooks(src));
  return () => {
    registry.reset();
  };
}
