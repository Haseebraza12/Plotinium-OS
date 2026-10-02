/**
 * Tier-2 write-behind upload queue (specs/03-kernel/memory-and-paging.md §3.11, MEM-04, KMM-09).
 *
 * While online every verified tier-1 page-out is also uploaded, and the local copy is kept as a
 * cache. The queue:
 *   - holds only keys; a job re-reads its page from tier 1 when its turn comes, so no page is held
 *     in memory while it waits (the in-flight buffers are reported on the Kernel line);
 *   - runs UPLOAD_CONCURRENCY (2) uploads at once, window-process checkpoints first, then the rest
 *     in page-out order; a newer generation of a page supersedes a queued older one;
 *   - retries with back-off 1, 2, 4 … 60 s, honours HTTP 429 `retryAfterMs`, pauses on 401 or
 *     offline until `setOnline(true)`, and marks a copy `failed` after 5 attempts.
 * The remote copy becomes `acked` only when the server returned the same hash (INV-M6); that check
 * lives in the RemoteSwap client, which reports `ok` only then.
 */
import { joinPageFile } from './codec.ts';
import type { MmClock } from './reserve.ts';
import { swapKeyId } from './swap.ts';
import type { RemoteSwap, SwapKey } from './swap.ts';

export interface WriteBehindParams {
  readonly uploadConcurrency: number;
  readonly uploadBackoffMaxMs: number;
  readonly uploadMaxAttempts: number;
}

export interface WriteBehindCallbacks {
  /** Generation `gen` of `key` is stored remotely with the same hash. */
  acked(key: SwapKey, gen: number, sha256: string, bytes: number): void;
  /** Upload attempts are exhausted: the page stays local-only. */
  failed(key: SwapKey, gen: number): void;
  /** One attempt failed (klog `upload-fail`). */
  attemptFailed?(key: SwapKey, gen: number, status: number, attempt: number): void;
}

/** Reads the verified tier-1 copy (header and body), or null when it is gone or superseded. */
export type PageReader = (
  key: SwapKey,
  gen: number,
  sha256: string,
) => Promise<{ header: ArrayBuffer; body: ArrayBuffer } | null>;

interface Job {
  key: SwapKey;
  id: string;
  gen: number;
  sha256: string;
  window: boolean;
  attempts: number;
  notBefore: number;
  seq: number;
}

export class WriteBehindQueue {
  private readonly queued = new Map<string, Job>();
  private active = 0;
  private online = false;
  private paused = false;
  private seq = 0;
  private cancelWake: (() => void) | null = null;
  private inflight = 0;
  private uploadedBytes = 0;
  private failedCount = 0;
  private readonly idle: Array<() => void> = [];

  private readonly remote: RemoteSwap;
  private readonly read: PageReader;
  private readonly clock: MmClock;
  private readonly params: WriteBehindParams;
  private readonly cb: WriteBehindCallbacks;

  constructor(
    remote: RemoteSwap,
    read: PageReader,
    clock: MmClock,
    params: WriteBehindParams,
    cb: WriteBehindCallbacks,
  ) {
    this.remote = remote;
    this.read = read;
    this.clock = clock;
    this.params = params;
    this.cb = cb;
  }

  /** Queue an upload of generation `gen`; supersedes a queued older generation of the page. */
  enqueue(key: SwapKey, gen: number, sha256: string, opts: { window?: boolean } = {}): void {
    const id = swapKeyId(key);
    const old = this.queued.get(id);
    if (old) {
      if (old.gen > gen) return;
      old.gen = gen;
      old.sha256 = sha256;
      old.attempts = 0;
      old.notBefore = 0;
      old.window ||= opts.window === true;
    } else {
      this.queued.set(id, {
        key: { ...key },
        id,
        gen,
        sha256,
        window: opts.window === true,
        attempts: 0,
        notBefore: 0,
        seq: this.seq++,
      });
    }
    this.pump();
  }

  /** Forget a queued upload (the page was freed or its process exited). */
  remove(key: SwapKey): void {
    this.queued.delete(swapKeyId(key));
  }

  /** `syncd` LIVE and the auth session can act as the owner: uploads run; else they wait. */
  setOnline(online: boolean): void {
    this.online = online;
    if (online) this.paused = false;
    this.pump();
  }

  get isOnline(): boolean {
    return this.online && !this.paused;
  }
  get pending(): number {
    return this.queued.size + this.active;
  }
  get failed(): number {
    return this.failedCount;
  }
  /** Bytes of upload buffers in flight (the Kernel line of `free`). */
  get inflightBytes(): number {
    return this.inflight;
  }
  /** Cumulative bytes uploaded (vmstat `ro`). */
  get bytesUploaded(): number {
    return this.uploadedBytes;
  }

  /** Resolves when nothing is queued or in flight (tests and shutdown). */
  drain(): Promise<void> {
    if (this.queued.size === 0 && this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  /** Start as many ready jobs as the concurrency allows; arm a timer for the next retry. */
  pump(): void {
    if (!this.online || this.paused) return;
    while (this.active < this.params.uploadConcurrency) {
      const job = this.next();
      if (!job) break;
      this.queued.delete(job.id);
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
        this.pump();
        this.checkIdle();
      });
    }
    this.armRetry();
    this.checkIdle();
  }

  private next(): Job | undefined {
    const now = this.clock.now();
    let best: Job | undefined;
    for (const j of this.queued.values()) {
      if (j.notBefore > now) continue;
      if (!best || (j.window && !best.window) || (j.window === best.window && j.seq < best.seq))
        best = j;
    }
    return best;
  }

  private armRetry(): void {
    this.cancelWake?.();
    this.cancelWake = null;
    if (!this.online || this.paused || this.queued.size === 0) return;
    const now = this.clock.now();
    let soonest = Number.POSITIVE_INFINITY;
    for (const j of this.queued.values())
      if (j.notBefore > now) soonest = Math.min(soonest, j.notBefore);
    if (Number.isFinite(soonest))
      this.cancelWake = this.clock.schedule(soonest - now, () => this.pump());
  }

  private checkIdle(): void {
    if (this.queued.size !== 0 || this.active !== 0) return;
    for (const resolve of this.idle.splice(0)) resolve();
  }

  private requeue(job: Job, delayMs: number, countAttempt: boolean): void {
    if (countAttempt) job.attempts++;
    job.notBefore = this.clock.now() + delayMs;
    const newer = this.queued.get(job.id);
    if (newer && newer.gen >= job.gen) return; // superseded while in flight
    this.queued.set(job.id, job);
  }

  private backoff(attempts: number): number {
    return Math.min(this.params.uploadBackoffMaxMs, 1_000 * 2 ** Math.max(0, attempts - 1));
  }

  private async run(job: Job): Promise<void> {
    const page = await this.read(job.key, job.gen, job.sha256).catch(() => null);
    if (!page) return; // gone, superseded or unreadable: nothing to upload
    const file = joinPageFile(page.header, page.body);
    this.inflight += file.byteLength;
    let status: number;
    let retryAfterMs: number | undefined;
    let ok = false;
    try {
      const res = await this.remote.put(job.key, job.gen, file, job.sha256);
      ok = res.ok;
      status = res.status;
      retryAfterMs = res.retryAfterMs;
    } catch {
      status = 0;
    } finally {
      this.inflight -= file.byteLength;
    }
    if (ok) {
      this.uploadedBytes += file.byteLength;
      this.cb.acked(job.key, job.gen, job.sha256, page.body.byteLength);
      return;
    }
    if (status === 401) {
      // Session expired: pause until syncd is LIVE again; not counted as an attempt.
      this.paused = true;
      this.requeue(job, 0, false);
      return;
    }
    if (status === 429) {
      this.requeue(job, retryAfterMs ?? this.backoff(job.attempts + 1), false);
      return;
    }
    const attempt = job.attempts + 1;
    this.cb.attemptFailed?.(job.key, job.gen, status, attempt);
    if (attempt >= this.params.uploadMaxAttempts) {
      this.failedCount++;
      this.cb.failed(job.key, job.gen);
      return;
    }
    this.requeue(job, this.backoff(attempt), true);
  }
}
