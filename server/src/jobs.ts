/**
 * Background jobs (backend-api.md §3.18.2 step 5): periodic, in-process, one run at a time per job,
 * timers unref'd so they never keep the process alive, stopped on close (§3.17 step 4).
 *
 *   blob-tmp          hourly    upload leftovers tmp/*.part older than 1 h (FsBlobStore)
 *   swap-retention    daily     pages of OS sessions not updated for 30 days (swap engine)
 *   llm-abandoned     startup + every 5 min   stale LLM reservations settled (§3.13.2)
 *   telemetry         daily     events older than TELEMETRY_RETENTION_DAYS
 * The blob row GC, the feed/op_log pruning and the nightly guest cleanup are R5's (TODO below).
 */
export interface JobHandle {
  stop(): void;
}

export interface JobOptions {
  readonly onError?: (job: string, err: unknown) => void;
  readonly onRun?: (job: string, result: 'ok' | 'error') => void;
  readonly setTimer?: (fn: () => void, ms: number) => { unref?(): unknown };
  readonly clearTimer?: (t: { unref?(): unknown }) => void;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export class Jobs implements JobHandle {
  readonly #timers: { unref?(): unknown }[] = [];
  readonly #running = new Set<string>();
  readonly #o: JobOptions;
  #stopped = false;

  constructor(options: JobOptions = {}) {
    this.#o = options;
  }

  /** Runs `fn` every `everyMs` (and once shortly after start when `atStart`). */
  every(name: string, everyMs: number, fn: () => Promise<unknown>, atStart = false): void {
    const run = (): void => {
      if (this.#stopped || this.#running.has(name)) return;
      this.#running.add(name);
      fn().then(
        () => {
          this.#running.delete(name);
          this.#o.onRun?.(name, 'ok');
        },
        (err: unknown) => {
          this.#running.delete(name);
          this.#o.onRun?.(name, 'error');
          this.#o.onError?.(name, err);
        },
      );
    };
    const set =
      this.#o.setTimer ??
      ((f: () => void, ms: number) => {
        const t = setInterval(f, ms);
        t.unref();
        return t;
      });
    this.#timers.push(set(run, everyMs));
    if (atStart) {
      const once = setTimeout(run, 1_000);
      once.unref();
      this.#timers.push(once);
    }
  }

  stop(): void {
    this.#stopped = true;
    const clear =
      this.#o.clearTimer ??
      ((t: { unref?(): unknown }) => {
        clearInterval(t as ReturnType<typeof setInterval>);
        clearTimeout(t as ReturnType<typeof setTimeout>);
      });
    for (const t of this.#timers) clear(t);
    this.#timers.length = 0;
  }
}
