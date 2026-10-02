/**
 * @plotinium/kernel/hooks: the kernel's AI seams (architecture.md §3.10 and §4.4; C12).
 *
 * ai/* may import this subpath and nothing else from the kernel (architecture.md §3.7). The
 * kernel ships no-op implementations, so the litmus build (`__AI__=false`, ARC-06) boots and passes
 * every non-AI suite; `ai.runtime` registers the real ones at service start. The module is pure:
 * no kernel state, no platform objects, safe to import from any thread.
 */

/** Scheduler seam: idle notifications in, a residency hint out (predictive-prefetch). */
export interface SchedulerHints {
  onIdle(idleMs: number): void;
  residencyHint(): { app: string; ttlMs: number } | null;
}

/** Shell seam: whether the natural-language `ai` command is present. */
export interface ShellNL {
  available(): boolean;
}

/** File-system seam: which search mode `ai.semsearch` can offer now (RAG-06 keyword fallback). */
export interface FsSemanticSearch {
  available(): 'semantic' | 'keyword' | 'none';
}

export interface KernelHooks {
  readonly scheduler: SchedulerHints;
  readonly shell: ShellNL;
  readonly search: FsSemanticSearch;
}

export const NOOP_SCHEDULER_HINTS: SchedulerHints = Object.freeze({
  onIdle(_idleMs: number): void {
    // Nothing to do without AI.
  },
  residencyHint: (): null => null,
});

export const NOOP_SHELL_NL: ShellNL = Object.freeze({ available: () => false });

export const NOOP_FS_SEMANTIC_SEARCH: FsSemanticSearch = Object.freeze({
  available: (): 'none' => 'none',
});

export const NOOP_HOOKS: KernelHooks = Object.freeze({
  scheduler: NOOP_SCHEDULER_HINTS,
  shell: NOOP_SHELL_NL,
  search: NOOP_FS_SEMANTIC_SEARCH,
});

/**
 * The live hook set of one kernel. `register` replaces individual seams (the rest keep their
 * current implementation); `reset` goes back to the no-ops (used when `ai.runtime` stops).
 */
export class HookRegistry {
  private current: KernelHooks = NOOP_HOOKS;

  get hooks(): KernelHooks {
    return this.current;
  }

  register(partial: Partial<KernelHooks>): void {
    this.current = Object.freeze({ ...this.current, ...partial });
  }

  reset(): void {
    this.current = NOOP_HOOKS;
  }
}
