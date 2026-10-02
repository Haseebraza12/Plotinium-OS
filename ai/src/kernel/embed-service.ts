/**
 * The kernel's side of the `ai.embed` special worker (rag-semantic-search.md §3.2.5, §3.7, §3.8,
 * §3.12; MEM-06, BOOT-10, RAG-06).
 *
 * - Lifecycle: the worker is spawned and told to `load` on the FIRST of desktop-interactive + 2 s
 *   idle, a search box gaining focus, or the first semantic query (`ensureLoaded`); never on the
 *   boot path (I-A8). Its state is published as `ai.model` events.
 * - Queue: two levels, query jobs ALWAYS first, at most ONE job in flight (Transformers.js
 *   serialises inference; batch size 1, I-A7). While a search UI is focused, index (doc) jobs are
 *   held, so a query waits for at most one in-flight chunk.
 * - Eviction: WebAssembly memory never shrinks, so eviction is `worker.terminate()` (MEM-06). The
 *   model is pinned while a query runs or a search box is focused; `evict()` refuses then.
 * - Failure: a crash or a failed load marks the model `failed`; one automatic retry after 30 s,
 *   then it stays failed (degraded) and search answers from the keyword path (RAG-06).
 */
import type { Errno } from '@plotinium/protocol';

import { FALLBACK, PRIMARY, type ModelConfig, modelKey } from '../embed/config.ts';
import type { EmbedKind, FromEmbedWorker, ToEmbedWorker } from '../embed/protocol.ts';
import { type Result, fail, ok } from '../util/errors.ts';

export type ModelState = 'absent' | 'loading' | 'ready' | 'evicted' | 'failed';

/** The part of `Worker` the service uses (a nested module worker in the kernel worker). */
export interface EmbedWorkerLike {
  postMessage(msg: ToEmbedWorker): void;
  terminate(): void;
  onmessage: ((ev: { readonly data: FromEmbedWorker }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface EmbedTimers {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface EmbedServiceDeps {
  /** `new Worker(embedWorkerUrl, {type: 'module', name: 'ai.embed'})`. */
  spawn(): EmbedWorkerLike;
  /** `ortThreads(crossOriginIsolated, hardwareConcurrency)` (§3.7). */
  readonly threads: number;
  readonly model?: 'primary' | 'fallback';
  now(): number;
  readonly timers: EmbedTimers;
  /** `ai.model` events and the Task Manager line. */
  onState?(state: ModelState, info: { loadedBytes?: number; totalBytes?: number }): void;
  log?(level: 'info' | 'warn' | 'degraded', msg: string): void;
}

/** One automatic retry after a crash or a failed load (§3.12). */
export const RETRY_AFTER_MS = 30_000;
/** A job with no answer after this long fails with EIO (a hung worker is terminated). */
export const JOB_TIMEOUT_MS = 30_000;
/** A load with no progress or answer after this long fails (missing weights, blocked /models). */
export const LOAD_TIMEOUT_MS = 120_000;
/** Declared size of the model page (§3.8, re-measured by the router when available). */
export const EMBED_PAGE_BYTES = 100 * 1_048_576;

interface Job {
  id: number;
  kind: EmbedKind;
  header: string;
  text: string;
  resolve(r: Result<Float32Array>): void;
}

export class EmbedService {
  private readonly deps: EmbedServiceDeps;
  private readonly config: ModelConfig;
  private worker: EmbedWorkerLike | null = null;
  private st: ModelState = 'absent';
  private readonly queries: Job[] = [];
  private readonly docs: Job[] = [];
  private inFlight: Job | null = null;
  private jobTimer: number | null = null;
  private loadTimer: number | null = null;
  private retryTimer: number | null = null;
  private retried = false;
  private nextId = 1;
  private pins = 0;
  private holdDocs = 0;
  private loaded = 0;
  private total = 0;
  private lastError: string | undefined;
  /** Waiters for the end of a load (doc jobs block on it). */
  private readonly loadWaiters: Array<(ready: boolean) => void> = [];
  /** Last completed embed duration (the indexer's duty-cycle sleep). */
  lastEmbedMs = 0;

  constructor(deps: EmbedServiceDeps) {
    this.deps = deps;
    this.config = deps.model === 'fallback' ? FALLBACK : PRIMARY;
  }

  get state(): ModelState {
    return this.st;
  }

  get modelKey(): string {
    return modelKey(this.config);
  }

  get pinned(): boolean {
    return this.pins > 0;
  }

  get progress(): { loadedBytes: number; totalBytes: number; lastError?: string } {
    const p: { loadedBytes: number; totalBytes: number; lastError?: string } = {
      loadedBytes: this.loaded,
      totalBytes: this.total,
    };
    if (this.lastError !== undefined) p.lastError = this.lastError;
    return p;
  }

  /** Bytes to show in `free` / the Task Manager: the declared page while resident. */
  get residentBytes(): number {
    return this.st === 'ready' || this.st === 'loading' ? EMBED_PAGE_BYTES : 0;
  }

  private setState(state: ModelState): void {
    this.st = state;
    const info: { loadedBytes?: number; totalBytes?: number } = {};
    if (this.total > 0) {
      info.loadedBytes = this.loaded;
      info.totalBytes = this.total;
    }
    this.deps.onState?.(state, info);
  }

  /** Start (or re-start after eviction) the worker and the model load. Idempotent. */
  ensureLoaded(reason: string): void {
    if (this.st === 'ready' || this.st === 'loading') return;
    // After a failure there is exactly ONE automatic retry, 30 s later (§3.12): a search box or
    // a query before then does not restart the load.
    if (this.st === 'failed' && (this.retried || this.retryTimer !== null)) return;
    this.startWorker(reason);
  }

  private startWorker(reason: string): void {
    this.stopWorker();
    this.loaded = 0;
    this.total = 0;
    let w: EmbedWorkerLike;
    try {
      w = this.deps.spawn();
    } catch (e) {
      this.onFailure(`spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.worker = w;
    w.onmessage = (ev) => {
      this.onMessage(w, ev.data);
    };
    w.onerror = (ev) => {
      if (this.worker !== w) return;
      const msg =
        typeof ev === 'object' && ev !== null && 'message' in ev && typeof ev.message === 'string'
          ? ev.message
          : 'worker error';
      this.onFailure(`ai.embed crashed: ${msg}`);
    };
    this.deps.log?.(
      'info',
      `ai.embed: loading ${this.modelKey} (${reason}, ${String(this.deps.threads)} thread(s))`,
    );
    this.setState('loading');
    this.armLoadTimer();
    w.postMessage({ t: 'load', model: this.deps.model ?? 'primary', threads: this.deps.threads });
  }

  private armLoadTimer(): void {
    if (this.loadTimer !== null) this.deps.timers.clear(this.loadTimer);
    this.loadTimer = this.deps.timers.set(() => {
      this.loadTimer = null;
      if (this.st === 'loading') this.onFailure('model load timed out');
    }, LOAD_TIMEOUT_MS);
  }

  private stopWorker(): void {
    const w = this.worker;
    this.worker = null;
    if (w !== null) {
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    }
    if (this.jobTimer !== null) this.deps.timers.clear(this.jobTimer);
    if (this.loadTimer !== null) this.deps.timers.clear(this.loadTimer);
    this.jobTimer = null;
    this.loadTimer = null;
  }

  private settleLoad(ready: boolean): void {
    for (const w of this.loadWaiters.splice(0)) w(ready);
  }

  private onFailure(message: string): void {
    this.lastError = message.slice(0, 256);
    this.stopWorker();
    const failed = this.inFlight;
    this.inFlight = null;
    failed?.resolve(fail('EIO', 'model', undefined, message));
    for (const j of this.queries.splice(0)) j.resolve(fail('EIO', 'model', undefined, message));
    for (const j of this.docs.splice(0)) j.resolve(fail('EIO', 'model', undefined, message));
    this.setState('failed');
    this.settleLoad(false);
    this.deps.log?.('degraded', `ai.embed: ${message}`);
    if (!this.retried && this.retryTimer === null) {
      this.retryTimer = this.deps.timers.set(() => {
        this.retryTimer = null;
        this.retried = true;
        this.startWorker('automatic retry');
      }, RETRY_AFTER_MS);
    }
  }

  private onMessage(w: EmbedWorkerLike, msg: FromEmbedWorker): void {
    if (this.worker !== w) return;
    switch (msg.t) {
      case 'progress':
        this.loaded = msg.loadedBytes;
        this.total = msg.totalBytes;
        this.armLoadTimer();
        this.setState('loading');
        return;
      case 'ready':
        if (this.loadTimer !== null) this.deps.timers.clear(this.loadTimer);
        this.loadTimer = null;
        this.lastError = undefined;
        this.retried = false;
        this.setState('ready');
        this.deps.log?.(
          'info',
          `ai.embed: ${msg.modelKey} ready (${String(msg.threads)} thread(s))`,
        );
        this.settleLoad(true);
        this.pump();
        return;
      case 'vector':
      case 'error': {
        if (msg.t === 'error' && msg.id === undefined) {
          this.onFailure(msg.message);
          return;
        }
        const job = this.inFlight;
        if (job === null || job.id !== msg.id) return;
        this.inFlight = null;
        if (this.jobTimer !== null) this.deps.timers.clear(this.jobTimer);
        this.jobTimer = null;
        if (msg.t === 'vector') {
          this.lastEmbedMs = msg.ms;
          job.resolve(ok(msg.vector));
        } else job.resolve(fail(msg.errno, 'embed', undefined, msg.message));
        this.pump();
        return;
      }
    }
  }

  private pump(): void {
    if (this.inFlight !== null || this.st !== 'ready' || this.worker === null) return;
    const job = this.queries.shift() ?? (this.holdDocs > 0 ? undefined : this.docs.shift());
    if (job === undefined) return;
    this.inFlight = job;
    const w = this.worker;
    this.jobTimer = this.deps.timers.set(() => {
      this.jobTimer = null;
      if (this.inFlight === job) this.onFailure('embedding timed out');
    }, JOB_TIMEOUT_MS);
    w.postMessage({ t: 'embed', id: job.id, kind: job.kind, header: job.header, text: job.text });
  }

  private waitReady(): Promise<boolean> {
    if (this.st === 'ready') return Promise.resolve(true);
    return new Promise((resolve) => this.loadWaiters.push(resolve));
  }

  /**
   * Embed one input. Query jobs never wait for a load: if the model is not ready they fail at
   * once with `unavailable` (the caller answers from the keyword path and the load starts). Doc
   * jobs wait for the load (the indexer is BLOCKED on `ai:embed`).
   */
  async embed(kind: EmbedKind, header: string, text: string): Promise<Result<Float32Array>> {
    if (kind === 'query' && this.st !== 'ready') {
      this.ensureLoaded('query');
      return fail('EAIUNAVAIL', this.st === 'loading' ? 'loading' : 'unavailable');
    }
    if (this.st !== 'ready') {
      this.ensureLoaded('index');
      if (this.st === 'failed') return fail('EIO', 'model', undefined, this.lastError);
      const ready = await this.waitReady();
      if (!ready)
        return this.st === 'evicted'
          ? fail('ECANCELED', 'evicted')
          : fail('EIO', 'model', undefined, this.lastError);
    }
    return new Promise((resolve) => {
      const job: Job = { id: this.nextId++, kind, header, text, resolve };
      (kind === 'query' ? this.queries : this.docs).push(job);
      this.pump();
    });
  }

  /** Search focus (reference-counted): pin the model and hold index jobs (§3.2.6, §3.5 step 1). */
  focus(on: boolean): void {
    if (on) {
      this.pins++;
      this.holdDocs++;
      this.ensureLoaded('search focus');
    } else {
      this.pins = Math.max(0, this.pins - 1);
      this.holdDocs = Math.max(0, this.holdDocs - 1);
      this.pump();
    }
  }

  /** Memory pressure: drop the model (`worker.terminate()`); refused while pinned. */
  evict(): boolean {
    if (this.pins > 0 || (this.st !== 'ready' && this.st !== 'loading')) return false;
    const failedJob = this.inFlight;
    this.inFlight = null;
    this.stopWorker();
    // Every waiting job fails with ECANCELED `evicted` (an errno `ai.index.embed` lists): a query
    // falls back to keywords, and the indexer re-queues its file and re-triggers the load with its
    // next embed (the page-in).
    failedJob?.resolve(fail('ECANCELED', 'evicted'));
    for (const j of this.queries.splice(0)) j.resolve(fail('ECANCELED', 'evicted'));
    for (const j of this.docs.splice(0)) j.resolve(fail('ECANCELED', 'evicted'));
    this.setState('evicted');
    this.settleLoad(false);
    this.deps.log?.('info', 'ai.embed: evicted (worker terminated)');
    return true;
  }

  /** Shutdown: terminate without a retry. */
  stop(): void {
    if (this.retryTimer !== null) this.deps.timers.clear(this.retryTimer);
    this.retryTimer = null;
    this.retried = true;
    const job = this.inFlight;
    this.inFlight = null;
    this.stopWorker();
    job?.resolve(fail('ECANCELED', 'signal'));
    for (const j of [...this.queries.splice(0), ...this.docs.splice(0)])
      j.resolve(fail('ECANCELED', 'signal'));
    this.settleLoad(false);
    if (this.st !== 'absent') this.setState('evicted');
  }

  /** Availability as `chooseMode` and `SemsearchResult.model.state` see it. */
  availability(): 'ready' | 'loading' | 'unavailable' {
    if (this.st === 'ready') return 'ready';
    return this.st === 'failed' ? 'unavailable' : 'loading';
  }

  /** Errno of a failed embed, for handlers. */
  static errnoOf(r: Result<Float32Array>): Errno | undefined {
    return r.ok ? undefined : r.error.errno;
  }
}
