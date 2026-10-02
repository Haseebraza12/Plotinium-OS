/**
 * Concurrency: the run-token semaphore (specs/03-kernel/processes-and-scheduling.md §3.13, KPS-05).
 *
 * Isolation (which realm a process may share) and concurrency (how many slices run at once) are
 * separate limits. Isolation executors are bounded by MAX_EXECUTORS; concurrently RUNNING slices by
 * RUN_TOKENS = clamp(hwc − 2 − (embedActive ? ortThreads : 0), 1, 6). One token = one busy core.
 *
 * When the capacity drops below the number of held tokens (ai.embed became active), nothing is
 * pre-empted: tokens are simply not re-issued until the held count falls (§3.13, §6).
 * INV-P2: tokensFree + running slices = RUN_TOKENS whenever RUN_TOKENS has been stable.
 */
import { EMBED_ACTIVE_WINDOW_MS, normaliseHwc, runTokensFor } from './params.ts';

export class RunTokens {
  private cap: number;
  private inUse = 0;

  constructor(capacity: number) {
    this.cap = RunTokens.check(capacity);
  }

  private static check(capacity: number): number {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError('RUN_TOKENS must be an integer ≥ 1');
    return capacity;
  }

  /** RUN_TOKENS. */
  get capacity(): number {
    return this.cap;
  }

  /** Tokens held by running slices. */
  get held(): number {
    return this.inUse;
  }

  /** tokensFree (never negative, even right after the capacity dropped). */
  get free(): number {
    return Math.max(0, this.cap - this.inUse);
  }

  tryAcquire(): boolean {
    if (this.inUse >= this.cap) return false;
    this.inUse++;
    return true;
  }

  release(): void {
    if (this.inUse === 0) throw new Error('run token released twice');
    this.inUse--;
  }

  /** New RUN_TOKENS; never pre-empts (held may exceed capacity until slices end). */
  setCapacity(capacity: number): void {
    this.cap = RunTokens.check(capacity);
  }
}

/**
 * `embedActive` (§3.13): true while ai.embed is resident AND has run a job in the last 2 s. The
 * kernel recomputes RUN_TOKENS whenever this changes; `nextChangeAt` gives the timer deadline.
 */
export class EmbedActivity {
  private resident = false;
  private lastJobAt = Number.NEGATIVE_INFINITY;
  private readonly windowMs: number;

  constructor(windowMs = EMBED_ACTIVE_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  setResident(resident: boolean): void {
    this.resident = resident;
  }

  /** Called when ai.embed starts or finishes a job. */
  jobRan(now: number): void {
    this.lastJobAt = now;
  }

  isActive(now: number): boolean {
    return this.resident && now - this.lastJobAt < this.windowMs;
  }

  /** When `isActive` turns false on its own (null if it is not active). */
  nextChangeAt(now: number): number | null {
    return this.isActive(now) ? this.lastJobAt + this.windowMs : null;
  }
}

/** RUN_TOKENS for the machine and the current embed activity. */
export function currentRunTokens(hwc: number, embed: EmbedActivity, now: number): number {
  return runTokensFor(normaliseHwc(hwc), embed.isActive(now));
}
